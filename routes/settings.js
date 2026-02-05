const express = require('express');
const router = express.Router();
const Joi = require('joi');
const Settings = require('../models/Settings');
const auth = require('../middleware/auth');

/**
 * @route   GET /api/settings
 * @desc    Get system settings (public for certain fields like VAT)
 * @access  Public (limited fields) / Private (full fields)
 */
router.get('/', async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    
    // If not authenticated, only return public settings
    if (!req.headers.authorization) {
      return res.json({
        success: true,
        data: {
          vat: settings.vat,
          currency: settings.currency,
          shipping: {
            freeShippingEnabled: settings.shipping.freeShippingEnabled,
            freeShippingThreshold: settings.shipping.freeShippingThreshold,
            flatRate: settings.shipping.flatRate
          }
        }
      });
    }
    
    // Return full settings for authenticated users
    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   GET /api/settings/vat
 * @desc    Get VAT settings (public endpoint)
 * @access  Public
 */
router.get('/vat', async (req, res) => {
  try {
    const settings = await Settings.getSettings();
    
    res.json({
      success: true,
      data: {
        enabled: settings.vat.enabled,
        rate: settings.vat.rate
      }
    });
  } catch (error) {
    console.error('Get VAT settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   PUT /api/settings
 * @desc    Update system settings
 * @access  Private (Admin only)
 */
router.put('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin' && !req.user.permissions.includes('settings')) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update settings'
      });
    }

    const schema = Joi.object({
      vat: Joi.object({
        enabled: Joi.boolean(),
        rate: Joi.number().min(0).max(100)
      }),
      shipping: Joi.object({
        freeShippingEnabled: Joi.boolean(),
        freeShippingThreshold: Joi.number().min(0),
        flatRate: Joi.number().min(0)
      }),
      currency: Joi.object({
        code: Joi.string().length(3),
        symbol: Joi.string().max(5)
      }),
      payment: Joi.object({
        stripeEnabled: Joi.boolean(),
        cashOnDeliveryEnabled: Joi.boolean()
      }),
      businessInfo: Joi.object({
        name: Joi.string(),
        taxNumber: Joi.string().allow(''),
        address: Joi.object({
          street: Joi.string().allow(''),
          city: Joi.string().allow(''),
          state: Joi.string().allow(''),
          zipCode: Joi.string().allow(''),
          country: Joi.string().allow('')
        }),
        phone: Joi.string().allow(''),
        email: Joi.string().email().allow('')
      })
    });

    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const settings = await Settings.updateSettings(req.body, req.user._id);

    res.json({
      success: true,
      message: 'Settings updated successfully',
      data: settings
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   PUT /api/settings/vat
 * @desc    Update VAT settings
 * @access  Private (Admin only)
 */
router.put('/vat', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin' && !req.user.permissions.includes('settings')) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update VAT settings'
      });
    }

    const schema = Joi.object({
      enabled: Joi.boolean(),
      rate: Joi.number().min(0).max(100)
    });

    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const settings = await Settings.getSettings();
    
    if (req.body.enabled !== undefined) {
      settings.vat.enabled = req.body.enabled;
    }
    if (req.body.rate !== undefined) {
      settings.vat.rate = req.body.rate;
    }
    
    settings.updatedBy = req.user._id;
    await settings.save();

    res.json({
      success: true,
      message: 'VAT settings updated successfully',
      data: {
        vat: settings.vat
      }
    });
  } catch (error) {
    console.error('Update VAT settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
