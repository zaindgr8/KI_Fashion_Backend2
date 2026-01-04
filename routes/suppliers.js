const express = require('express');
const Joi = require('joi');
const Supplier = require('../models/Supplier');
const User = require('../models/User');
const Ledger = require('../models/Ledger');
const auth = require('../middleware/auth');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

const supplierSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  company: Joi.string().max(100).optional(),
  email: Joi.string().email().optional(),
  phone: Joi.string().required(),
  phoneAreaCode: Joi.string().max(5).optional(),
  alternatePhone: Joi.string().optional(),
  alternatePhoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan')
  }).optional(),
  taxNumber: Joi.string().optional(),
  paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').default('net30'),
  creditLimit: Joi.number().min(0).default(0),
  rating: Joi.number().min(1).max(5).default(3),
  notes: Joi.string().optional()
});

// Create supplier
router.post('/', auth, async (req, res) => {
  try {
    const { error } = supplierSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const supplier = new Supplier({
      ...req.body,
      createdBy: req.user._id
    });

    await supplier.save();

    if (req.user && req.user.role === 'supplier') {
      await User.findByIdAndUpdate(
        req.user._id,
        {
          supplier: supplier._id,
          $addToSet: { portalAccess: 'supplier' }
        },
        { new: true }
      );
    }

    res.status(201).json({
      success: true,
      message: 'Supplier created successfully',
      data: supplier
    });

  } catch (error) {
    console.error('Create supplier error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all suppliers
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10, search, paymentTerms, isActive, hasUser } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    if (paymentTerms) query.paymentTerms = paymentTerms;
    if (isActive !== undefined) query.isActive = isActive === 'true';
    
    let suppliers;
    
    // Filter suppliers with user accounts (from supplier portal)
    if (hasUser === 'true') {
      // Find all users who have a supplier field and role = 'supplier'
      const usersWithSuppliers = await User.find({
        supplier: { $exists: true, $ne: null },
        role: 'supplier',
        isActive: true
      }).select('supplier');
      
      const supplierIds = usersWithSuppliers.map(user => user.supplier);
      
      // Add supplier ID filter to query
      query._id = { $in: supplierIds };
      
      suppliers = await Supplier.find(query)
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
        
      // Populate user information for each supplier
      for (let supplier of suppliers) {
        const user = usersWithSuppliers.find(u => u.supplier.toString() === supplier._id.toString());
        if (user) {
          supplier.userInfo = user;
        }
      }
    } else {
      suppliers = await Supplier.find(query)
        .populate('createdBy', 'name')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
    }

    const total = await Supplier.countDocuments(query);

    // Calculate balance from ledger for each supplier (source of truth)
    const suppliersWithBalance = await Promise.all(
      suppliers.map(async (supplier) => {
        try {
          const ledgerBalance = await Ledger.getBalance('supplier', supplier._id);
          
          // Convert supplier to plain object to add balance field
          const supplierObj = supplier.toObject();
          return {
            ...supplierObj,
            balance: ledgerBalance
          };
        } catch (error) {
          console.error(`Error calculating balance for supplier ${supplier._id}:`, error);
          // Fallback to supplier's currentBalance if ledger calculation fails
          const supplierObj = supplier.toObject();
          return {
            ...supplierObj,
            balance: supplierObj.currentBalance || 0
          };
        }
      })
    );

    res.json({
      success: true,
      data: suppliersWithBalance,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get suppliers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get supplier by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const supplier = await Supplier.findById(req.params.id)
      .populate('createdBy', 'name');

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      data: supplier
    });

  } catch (error) {
    console.error('Get supplier error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update supplier
router.put('/:id', auth, async (req, res) => {
  try {
    // Use a more flexible schema for updates (all fields optional)
    const updateSupplierSchema = Joi.object({
      name: Joi.string().min(2).max(100).optional(),
      company: Joi.string().max(100).optional(),
      email: Joi.string().email().optional(),
      phone: Joi.string().optional(),
      phoneAreaCode: Joi.string().max(5).optional(),
      alternatePhone: Joi.string().optional(),
      alternatePhoneAreaCode: Joi.string().max(5).optional(),
      address: Joi.object({
        street: Joi.string().optional(),
        city: Joi.string().optional(),
        state: Joi.string().optional(),
        zipCode: Joi.string().optional(),
        country: Joi.string().default('Pakistan')
      }).optional(),
      taxNumber: Joi.string().optional(),
      paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').optional(),
      creditLimit: Joi.number().min(0).optional(),
      rating: Joi.number().min(1).max(5).optional(),
      notes: Joi.string().optional()
    });

    const { error } = updateSupplierSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      message: 'Supplier updated successfully',
      data: supplier
    });

  } catch (error) {
    console.error('Update supplier error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update supplier balance
router.patch('/:id/balance', auth, async (req, res) => {
  try {
    const { amount, operation } = req.body;

    if (!amount || !operation || !['add', 'subtract', 'set'].includes(operation)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount or operation'
      });
    }

    const supplier = await Supplier.findById(req.params.id);
    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    switch (operation) {
      case 'add':
        supplier.currentBalance += amount;
        break;
      case 'subtract':
        supplier.currentBalance -= amount;
        break;
      case 'set':
        supplier.currentBalance = amount;
        break;
    }

    await supplier.save();

    res.json({
      success: true,
      message: 'Supplier balance updated successfully',
      data: supplier
    });

  } catch (error) {
    console.error('Update supplier balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete supplier
router.delete('/:id', auth, async (req, res) => {
  try {
    const supplier = await Supplier.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!supplier) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    res.json({
      success: true,
      message: 'Supplier deactivated successfully'
    });

  } catch (error) {
    console.error('Delete supplier error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;