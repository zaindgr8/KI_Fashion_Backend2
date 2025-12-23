const express = require('express');
const Joi = require('joi');
const CostType = require('../models/CostType');
const auth = require('../middleware/auth');

const router = express.Router();

const costTypeSchema = Joi.object({
  id: Joi.string().required().uppercase(),
  name: Joi.string().min(2).max(100).required(),
  description: Joi.string().optional(),
  category: Joi.string().valid('operational', 'administrative', 'marketing', 'inventory', 'utilities', 'maintenance', 'other').default('operational')
});

// Create cost type
router.post('/', auth, async (req, res) => {
  try {
    const { error } = costTypeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if cost type ID already exists
    const existingCostType = await CostType.findOne({ id: req.body.id.toUpperCase() });
    if (existingCostType) {
      return res.status(400).json({
        success: false,
        message: 'Cost type ID already exists'
      });
    }

    const costType = new CostType({
      ...req.body,
      id: req.body.id.toUpperCase(),
      createdBy: req.user._id
    });

    await costType.save();

    res.status(201).json({
      success: true,
      message: 'Cost type created successfully',
      data: costType
    });

  } catch (error) {
    console.error('Create cost type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all cost types
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, category, isActive } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { id: { $regex: search, $options: 'i' } },
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (category) query.category = category;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const costTypes = await CostType.find(query)
      .populate('createdBy', 'name')
      .sort({ id: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await CostType.countDocuments(query);

    res.json({
      success: true,
      data: costTypes,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get cost types error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get cost type by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const costType = await CostType.findOne({ id: req.params.id.toUpperCase() })
      .populate('createdBy', 'name');

    if (!costType) {
      return res.status(404).json({
        success: false,
        message: 'Cost type not found'
      });
    }

    res.json({
      success: true,
      data: costType
    });

  } catch (error) {
    console.error('Get cost type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update cost type
router.put('/:id', auth, async (req, res) => {
  try {
    const updateSchema = Joi.object({
      name: Joi.string().min(2).max(100).optional(),
      description: Joi.string().optional(),
      category: Joi.string().valid('operational', 'administrative', 'marketing', 'inventory', 'utilities', 'maintenance', 'other').optional(),
      isActive: Joi.boolean().optional()
    });

    const { error } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const costType = await CostType.findOneAndUpdate(
      { id: req.params.id.toUpperCase() },
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!costType) {
      return res.status(404).json({
        success: false,
        message: 'Cost type not found'
      });
    }

    res.json({
      success: true,
      message: 'Cost type updated successfully',
      data: costType
    });

  } catch (error) {
    console.error('Update cost type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete cost type
router.delete('/:id', auth, async (req, res) => {
  try {
    const costType = await CostType.findOneAndUpdate(
      { id: req.params.id.toUpperCase() },
      { isActive: false },
      { new: true }
    );

    if (!costType) {
      return res.status(404).json({
        success: false,
        message: 'Cost type not found'
      });
    }

    res.json({
      success: true,
      message: 'Cost type deactivated successfully'
    });

  } catch (error) {
    console.error('Delete cost type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get cost type categories
router.get('/meta/categories', auth, async (req, res) => {
  try {
    const categories = ['operational', 'administrative', 'marketing', 'inventory', 'utilities', 'maintenance', 'other'];

    res.json({
      success: true,
      data: categories
    });

  } catch (error) {
    console.error('Get categories error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;