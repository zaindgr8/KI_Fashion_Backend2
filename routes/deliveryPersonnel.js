const express = require('express');
const Joi = require('joi');
const DeliveryPersonnel = require('../models/DeliveryPersonnel');
const auth = require('../middleware/auth');

const router = express.Router();

const deliveryPersonnelSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  employeeId: Joi.string().required().uppercase(),
  phone: Joi.string().required(),
  phoneAreaCode: Joi.string().max(5).optional(),
  alternatePhone: Joi.string().optional(),
  alternatePhoneAreaCode: Joi.string().max(5).optional(),
  email: Joi.string().email().optional(),
  address: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan')
  }).optional(),
  licenseNumber: Joi.string().optional(),
  licenseExpiry: Joi.date().optional(),
  vehicleInfo: Joi.object({
    type: Joi.string().optional(),
    model: Joi.string().optional(),
    plateNumber: Joi.string().optional(),
    capacity: Joi.number().optional()
  }).optional(),
  salary: Joi.number().min(0).default(0),
  commissionRate: Joi.number().min(0).max(100).default(0),
  workingAreas: Joi.array().items(Joi.string()).optional(),
  emergencyContact: Joi.object({
    name: Joi.string().optional(),
    phone: Joi.string().optional(),
    phoneAreaCode: Joi.string().max(5).optional(),
    relation: Joi.string().optional()
  }).optional(),
  joiningDate: Joi.date().default(Date.now)
});

// Create delivery personnel
router.post('/', auth, async (req, res) => {
  try {
    const { error } = deliveryPersonnelSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if employee ID already exists
    const existingPersonnel = await DeliveryPersonnel.findOne({
      employeeId: req.body.employeeId.toUpperCase()
    });
    if (existingPersonnel) {
      return res.status(400).json({
        success: false,
        message: 'Employee ID already exists'
      });
    }

    const deliveryPersonnel = new DeliveryPersonnel({
      ...req.body,
      employeeId: req.body.employeeId.toUpperCase(),
      createdBy: req.user._id
    });

    await deliveryPersonnel.save();

    res.status(201).json({
      success: true,
      message: 'Delivery personnel created successfully',
      data: deliveryPersonnel
    });

  } catch (error) {
    console.error('Create delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all delivery personnel
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, isActive, area } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { employeeId: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } }
      ];
    }

    if (isActive !== undefined) query.isActive = isActive === 'true';
    if (area) query.workingAreas = { $in: [area] };

    const deliveryPersonnel = await DeliveryPersonnel.find(query)
      .populate('createdBy', 'name')
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await DeliveryPersonnel.countDocuments(query);

    res.json({
      success: true,
      data: deliveryPersonnel,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get delivery personnel by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const deliveryPersonnel = await DeliveryPersonnel.findById(req.params.id)
      .populate('createdBy', 'name');

    if (!deliveryPersonnel) {
      return res.status(404).json({
        success: false,
        message: 'Delivery personnel not found'
      });
    }

    res.json({
      success: true,
      data: deliveryPersonnel
    });

  } catch (error) {
    console.error('Get delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update delivery personnel
router.put('/:id', auth, async (req, res) => {
  try {
    const updateSchema = deliveryPersonnelSchema.fork(['employeeId'], (schema) => schema.optional());
    const { error } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if employee ID is being updated and if it already exists
    if (req.body.employeeId) {
      const existingPersonnel = await DeliveryPersonnel.findOne({
        employeeId: req.body.employeeId.toUpperCase(),
        _id: { $ne: req.params.id }
      });

      if (existingPersonnel) {
        return res.status(400).json({
          success: false,
          message: 'Employee ID already exists'
        });
      }
      req.body.employeeId = req.body.employeeId.toUpperCase();
    }

    const deliveryPersonnel = await DeliveryPersonnel.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!deliveryPersonnel) {
      return res.status(404).json({
        success: false,
        message: 'Delivery personnel not found'
      });
    }

    res.json({
      success: true,
      message: 'Delivery personnel updated successfully',
      data: deliveryPersonnel
    });

  } catch (error) {
    console.error('Update delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update delivery statistics
router.patch('/:id/stats', auth, async (req, res) => {
  try {
    const { totalDeliveries, successfulDeliveries, rating } = req.body;

    const deliveryPersonnel = await DeliveryPersonnel.findById(req.params.id);
    if (!deliveryPersonnel) {
      return res.status(404).json({
        success: false,
        message: 'Delivery personnel not found'
      });
    }

    if (totalDeliveries !== undefined) deliveryPersonnel.totalDeliveries = totalDeliveries;
    if (successfulDeliveries !== undefined) deliveryPersonnel.successfulDeliveries = successfulDeliveries;
    if (rating !== undefined && rating >= 1 && rating <= 5) deliveryPersonnel.rating = rating;

    await deliveryPersonnel.save();

    res.json({
      success: true,
      message: 'Delivery statistics updated successfully',
      data: deliveryPersonnel
    });

  } catch (error) {
    console.error('Update delivery stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete delivery personnel
router.delete('/:id', auth, async (req, res) => {
  try {
    const deliveryPersonnel = await DeliveryPersonnel.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!deliveryPersonnel) {
      return res.status(404).json({
        success: false,
        message: 'Delivery personnel not found'
      });
    }

    res.json({
      success: true,
      message: 'Delivery personnel deactivated successfully'
    });

  } catch (error) {
    console.error('Delete delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get available delivery personnel for an area
router.get('/available/:area', auth, async (req, res) => {
  try {
    const deliveryPersonnel = await DeliveryPersonnel.find({
      workingAreas: { $in: [req.params.area] },
      isActive: true
    }).select('name employeeId phone rating successRate');

    res.json({
      success: true,
      data: deliveryPersonnel
    });

  } catch (error) {
    console.error('Get available delivery personnel error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;