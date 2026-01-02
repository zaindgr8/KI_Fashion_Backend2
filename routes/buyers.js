const express = require('express');
const Joi = require('joi');
const Buyer = require('../models/Buyer');
const Ledger = require('../models/Ledger');
const auth = require('../middleware/auth');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

const buyerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  company: Joi.string().max(100).optional(),
  email: Joi.string().email().optional(),
  phone: Joi.string().required(),
  phoneAreaCode: Joi.string().max(5).optional(),
  alternatePhone: Joi.string().optional(),
  alternatePhoneAreaCode: Joi.string().max(5).optional(),
  landlineAreaCode: Joi.string().max(5).optional(),
  address: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan')
  }).optional(),
  taxNumber: Joi.string().optional(),
  paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').default('cash'),
  creditLimit: Joi.number().min(0).default(0),
  discountRate: Joi.number().min(0).max(100).default(0),
  customerType: Joi.string().valid('retail', 'wholesale', 'distributor').default('retail'),
  notes: Joi.string().optional()
});

// Create buyer
router.post('/', auth, async (req, res) => {
  try {
    const { error } = buyerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const buyer = new Buyer({
      ...req.body,
      createdBy: req.user._id
    });

    await buyer.save();

    res.status(201).json({
      success: true,
      message: 'Buyer created successfully',
      data: buyer
    });

  } catch (error) {
    console.error('Create buyer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all buyers
router.get('/', auth, async (req, res) => {
  try {
    const Ledger = require('../models/Ledger');
    const { page = 1, limit = 10, search, customerType, paymentTerms, isActive } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { company: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    if (customerType) query.customerType = customerType;
    if (paymentTerms) query.paymentTerms = paymentTerms;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const buyers = await Buyer.find(query)
      .populate('createdBy', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Buyer.countDocuments(query);

    // Calculate balance from ledger for each buyer (source of truth)
    // Note: Using lean() for performance - buyer is already a plain object
    const buyersWithBalance = await Promise.all(
      buyers.map(async (buyer) => {
        try {
          const ledgerBalance = await Ledger.getBalance('buyer', buyer._id);
          
          // Sync buyer's currentBalance with ledger balance if different (background update)
          if (buyer.currentBalance !== ledgerBalance) {
            // Use updateOne for background sync without blocking the response
            Buyer.updateOne({ _id: buyer._id }, { currentBalance: ledgerBalance }).exec();
          }

          // buyer is already a plain object from .lean()
          return {
            ...buyer,
            balance: ledgerBalance,
            currentBalance: ledgerBalance
          };
        } catch (error) {
          console.error(`Error calculating balance for buyer ${buyer._id}:`, error);
          return {
            ...buyer,
            balance: buyer.currentBalance || 0
          };
        }
      })
    );

    res.json({
      success: true,
      data: buyersWithBalance,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get buyers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get buyer by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const Ledger = require('../models/Ledger');
    const buyer = await Buyer.findById(req.params.id)
      .populate('createdBy', 'name')
      .lean();

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    // Calculate balance from ledger (source of truth)
    const ledgerBalance = await Ledger.getBalance('buyer', req.params.id);
    
    // Fetch ledger entries (transactions) for the buyer
    const ledgerEntries = await Ledger.find({
      type: 'buyer',
      entityId: req.params.id
    })
      .populate('createdBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .limit(100) // Limit to recent 100 entries
      .lean();

    // Sync buyer's currentBalance with ledger balance (background update)
    if (buyer.currentBalance !== ledgerBalance) {
      Buyer.updateOne({ _id: req.params.id }, { currentBalance: ledgerBalance }).exec();
    }

    // Calculate total payments from ledger entries
    const totalPayments = ledgerEntries
      .filter(entry => entry.transactionType === 'receipt')
      .reduce((sum, entry) => sum + (entry.credit || 0), 0);

    // Prepare response with ledger data (buyer is already plain object from .lean())
    const buyerData = {
      ...buyer,
      balance: ledgerBalance,
      currentBalance: ledgerBalance,
      transactions: ledgerEntries,
      totalPayments: totalPayments
    };

    res.json({
      success: true,
      data: buyerData
    });

  } catch (error) {
    console.error('Get buyer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update buyer
router.put('/:id', auth, async (req, res) => {
  try {
    const { error } = buyerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const buyer = await Buyer.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    res.json({
      success: true,
      message: 'Buyer updated successfully',
      data: buyer
    });

  } catch (error) {
    console.error('Update buyer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update buyer balance
router.patch('/:id/balance', auth, async (req, res) => {
  try {
    const { amount, operation } = req.body;

    if (!amount || !operation || !['add', 'subtract', 'set'].includes(operation)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid amount or operation'
      });
    }

    const buyer = await Buyer.findById(req.params.id);
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    switch (operation) {
      case 'add':
        buyer.currentBalance += amount;
        break;
      case 'subtract':
        buyer.currentBalance -= amount;
        break;
      case 'set':
        buyer.currentBalance = amount;
        break;
    }

    await buyer.save();

    res.json({
      success: true,
      message: 'Buyer balance updated successfully',
      data: buyer
    });

  } catch (error) {
    console.error('Update buyer balance error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete buyer
router.delete('/:id', auth, async (req, res) => {
  try {
    const buyer = await Buyer.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    res.json({
      success: true,
      message: 'Buyer deactivated successfully'
    });

  } catch (error) {
    console.error('Delete buyer error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;