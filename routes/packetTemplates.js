const express = require('express');
const router = express.Router();
const PacketTemplate = require('../models/PacketTemplate');
const ProductType = require('../models/ProductType');
const Supplier = require('../models/Supplier');
const auth = require('../middleware/auth');
const Joi = require('joi');

// Helper function to check if user can modify a template
async function canModifyTemplate(user, template) {
  if (user.role === 'super-admin') {
    // Admins can modify global templates only
    return template.isGlobal;
  } else if (user.role === 'supplier') {
    // Suppliers can modify their own templates only
    if (template.isGlobal) return false;  // Cannot modify global templates
    
    const supplier = await Supplier.findOne({ userId: user._id });
    return supplier && template.supplier && template.supplier.toString() === supplier._id.toString();
  }
  return false;
}

// Validation schema
const packetTemplateSchema = Joi.object({
  name: Joi.string().required().trim(),
  productType: Joi.string().required(),
  totalItemsPerPacket: Joi.number().min(1).required(),
  composition: Joi.array().items(
    Joi.object({
      size: Joi.string().required().trim(),
      color: Joi.string().required().trim(),
      quantity: Joi.number().min(1).required()
    })
  ).min(1).required(),
  description: Joi.string().optional().trim(),
  isActive: Joi.boolean().optional()
});

// Get all packet templates
router.get('/', auth, async (req, res) => {
  try {
    const { productType, isActive } = req.query;
    const filter = {};
    
    if (productType) {
      filter.productType = productType;
    }
    
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }
    
    // Filter based on user role
    if (req.user.role === 'supplier') {
      // Suppliers see: global templates + their own templates
      const Supplier = require('../models/Supplier');
      const supplier = await Supplier.findOne({ userId: req.user._id });
      
      filter.$or = [
        { isGlobal: true },  // Global templates
        { supplier: supplier ? supplier._id : null }  // Their own templates
      ];
    } else if (req.user.role === 'super-admin') {
      // Admins see all templates (no additional filter)
    }
    
    const templates = await PacketTemplate.find(filter)
      .populate('productType', 'name category')
      .populate('supplier', 'name company')
      .populate('createdBy', 'name')
      .sort({ isGlobal: -1, createdAt: -1 });  // Global first, then by date
    
    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    console.error('Get packet templates error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Get packet template by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const template = await PacketTemplate.findById(req.params.id)
      .populate('productType', 'name category')
      .populate('createdBy', 'name');
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Packet template not found'
      });
    }
    
    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    console.error('Get packet template error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Get templates by product type
router.get('/by-product-type/:typeId', auth, async (req, res) => {
  try {
    const templates = await PacketTemplate.find({
      productType: req.params.typeId,
      isActive: true
    })
      .populate('productType', 'name category')
      .populate('createdBy', 'name')
      .sort({ name: 1 });
    
    res.json({
      success: true,
      data: templates
    });
  } catch (error) {
    console.error('Get templates by product type error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Create packet template (Admin creates global, Supplier creates own)
router.post('/', auth, async (req, res) => {
  try {
    // Only admin and supplier can create templates
    if (req.user.role !== 'super-admin' && req.user.role !== 'supplier') {
      return res.status(403).json({
        success: false,
        message: 'Only admins and suppliers can create packet templates'
      });
    }
    
    const { error, value } = packetTemplateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }
    
    // Verify product type exists
    const productType = await ProductType.findById(value.productType);
    if (!productType) {
      return res.status(404).json({
        success: false,
        message: 'Product type not found'
      });
    }
    
    // Validate composition totals match totalItemsPerPacket
    const compositionTotal = value.composition.reduce((sum, item) => sum + item.quantity, 0);
    if (compositionTotal !== value.totalItemsPerPacket) {
      return res.status(400).json({
        success: false,
        message: `Composition total (${compositionTotal}) must equal totalItemsPerPacket (${value.totalItemsPerPacket})`
      });
    }
    
    // Determine template ownership
    let templateData = {
      ...value,
      createdBy: req.user._id
    };
    
    if (req.user.role === 'super-admin') {
      // Admin creates global templates
      templateData.isGlobal = true;
      templateData.supplier = null;
    } else if (req.user.role === 'supplier') {
      // Supplier creates own templates
      const Supplier = require('../models/Supplier');
      const supplier = await Supplier.findOne({ userId: req.user._id });
      if (!supplier) {
        return res.status(404).json({
          success: false,
          message: 'Supplier profile not found'
        });
      }
      templateData.isGlobal = false;
      templateData.supplier = supplier._id;
    }
    
    const template = new PacketTemplate(templateData);
    await template.save();
    
    await template.populate([
      { path: 'productType', select: 'name category' },
      { path: 'supplier', select: 'name company' },
      { path: 'createdBy', select: 'name' }
    ]);
    
    res.status(201).json({
      success: true,
      message: 'Packet template created successfully',
      data: template
    });
  } catch (error) {
    console.error('Create packet template error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Update packet template (Owner only: admin for global, supplier for own)
router.put('/:id', auth, async (req, res) => {
  try {
    const existingTemplate = await PacketTemplate.findById(req.params.id);
    if (!existingTemplate) {
      return res.status(404).json({
        success: false,
        message: 'Packet template not found'
      });
    }
    
    // Check ownership
    const canUpdate = await canModifyTemplate(req.user, existingTemplate);
    if (!canUpdate) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to update this template'
      });
    }
    
    const { error, value } = packetTemplateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }
    
    // Verify product type exists
    const productType = await ProductType.findById(value.productType);
    if (!productType) {
      return res.status(404).json({
        success: false,
        message: 'Product type not found'
      });
    }
    
    // Validate composition totals match totalItemsPerPacket
    const compositionTotal = value.composition.reduce((sum, item) => sum + item.quantity, 0);
    if (compositionTotal !== value.totalItemsPerPacket) {
      return res.status(400).json({
        success: false,
        message: `Composition total (${compositionTotal}) must equal totalItemsPerPacket (${value.totalItemsPerPacket})`
      });
    }
    
    // Preserve ownership fields
    const updateData = {
      ...value,
      isGlobal: existingTemplate.isGlobal,
      supplier: existingTemplate.supplier
    };
    
    const template = await PacketTemplate.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('productType', 'name category')
      .populate('supplier', 'name company')
      .populate('createdBy', 'name');
    
    res.json({
      success: true,
      message: 'Packet template updated successfully',
      data: template
    });
  } catch (error) {
    console.error('Update packet template error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Delete packet template (Owner only: admin for global, supplier for own)
router.delete('/:id', auth, async (req, res) => {
  try {
    const existingTemplate = await PacketTemplate.findById(req.params.id);
    if (!existingTemplate) {
      return res.status(404).json({
        success: false,
        message: 'Packet template not found'
      });
    }
    
    // Check ownership
    const canDelete = await canModifyTemplate(req.user, existingTemplate);
    if (!canDelete) {
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to delete this template'
      });
    }
    
    await PacketTemplate.findByIdAndDelete(req.params.id);
    
    res.json({
      success: true,
      message: 'Packet template deleted successfully'
    });
  } catch (error) {
    console.error('Delete packet template error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Toggle template active status (Admin only)
router.patch('/:id/toggle-active', auth, async (req, res) => {
  try {
    // Only admin can toggle status
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can toggle template status'
      });
    }
    
    const template = await PacketTemplate.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Packet template not found'
      });
    }
    
    template.isActive = !template.isActive;
    await template.save();
    
    await template.populate([
      { path: 'productType', select: 'name category' },
      { path: 'createdBy', select: 'name' }
    ]);
    
    res.json({
      success: true,
      message: `Packet template ${template.isActive ? 'activated' : 'deactivated'} successfully`,
      data: template
    });
  } catch (error) {
    console.error('Toggle template status error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;

