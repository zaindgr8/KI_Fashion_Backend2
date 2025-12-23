const express = require('express');
const Joi = require('joi');
const ProductType = require('../models/ProductType');
const auth = require('../middleware/auth');

const router = express.Router();

const productTypeSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  description: Joi.string().optional(),
  category: Joi.string().optional(),
  attributes: Joi.array().items(Joi.object({
    name: Joi.string().required(),
    type: Joi.string().valid('text', 'number', 'boolean', 'date').required(),
    required: Joi.boolean().default(false)
  })).optional()
});

// Create product type
router.post('/', auth, async (req, res) => {
  try {
    const { error } = productTypeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const existingProductType = await ProductType.findOne({ name: req.body.name });
    if (existingProductType) {
      return res.status(400).json({
        success: false,
        message: 'Product type name already exists'
      });
    }

    const productType = new ProductType({
      ...req.body,
      createdBy: req.user._id
    });

    await productType.save();

    res.status(201).json({
      success: true,
      message: 'Product type created successfully',
      data: productType
    });

  } catch (error) {
    console.error('Create product type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all product types
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, search, category, isActive } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } }
      ];
    }

    if (category) query.category = category;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    const productTypes = await ProductType.find(query)
      .populate('createdBy', 'name')
      .sort({ name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await ProductType.countDocuments(query);

    res.json({
      success: true,
      data: productTypes,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get product types error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get product type by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const productType = await ProductType.findById(req.params.id)
      .populate('createdBy', 'name');

    if (!productType) {
      return res.status(404).json({
        success: false,
        message: 'Product type not found'
      });
    }

    res.json({
      success: true,
      data: productType
    });

  } catch (error) {
    console.error('Get product type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update product type
router.put('/:id', auth, async (req, res) => {
  try {
    const { error } = productTypeSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const existingProductType = await ProductType.findOne({
      name: req.body.name,
      _id: { $ne: req.params.id }
    });

    if (existingProductType) {
      return res.status(400).json({
        success: false,
        message: 'Product type name already exists'
      });
    }

    const productType = await ProductType.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!productType) {
      return res.status(404).json({
        success: false,
        message: 'Product type not found'
      });
    }

    res.json({
      success: true,
      message: 'Product type updated successfully',
      data: productType
    });

  } catch (error) {
    console.error('Update product type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete product type
router.delete('/:id', auth, async (req, res) => {
  try {
    const productType = await ProductType.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!productType) {
      return res.status(404).json({
        success: false,
        message: 'Product type not found'
      });
    }

    res.json({
      success: true,
      message: 'Product type deactivated successfully'
    });

  } catch (error) {
    console.error('Delete product type error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;