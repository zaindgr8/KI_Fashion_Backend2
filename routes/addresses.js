const express = require('express');
const Joi = require('joi');
const Buyer = require('../models/Buyer');
const auth = require('../middleware/auth');

const router = express.Router();

// Helper to get buyer ID for authenticated user
async function getBuyerIdForUser(user) {
  if (user.buyer) {
    return user.buyer;
  }

  if ((user.role === 'distributor' || user.role === 'buyer') && user.email) {
    const buyer = await Buyer.findOne({
      email: user.email.toLowerCase(),
      customerType: 'distributor'
    });
    return buyer?._id;
  }

  return null;
}

const addressSchema = Joi.object({
  label: Joi.string().trim().max(50).default('Home'),
  street: Joi.string().trim().optional().allow(''),
  city: Joi.string().trim().optional().allow(''),
  state: Joi.string().trim().optional().allow(''),
  zipCode: Joi.string().trim().optional().allow(''),
  country: Joi.string().trim().default('Pakistan'),
  phone: Joi.string().trim().optional().allow(''),
  phoneAreaCode: Joi.string().trim().max(5).optional().allow(''),
  isDefault: Joi.boolean().default(false)
});

/**
 * @route   GET /api/addresses
 * @desc    Get all addresses for current user's buyer profile
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  try {
    const buyerId = await getBuyerIdForUser(req.user);

    if (!buyerId) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const buyer = await Buyer.findById(buyerId).select('deliveryAddresses');

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    res.json({
      success: true,
      data: buyer.deliveryAddresses || []
    });

  } catch (error) {
    console.error('Get addresses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   POST /api/addresses
 * @desc    Add new address to user's buyer profile
 * @access  Private
 */
router.post('/', auth, async (req, res) => {
  try {
    const { error } = addressSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const buyerId = await getBuyerIdForUser(req.user);

    if (!buyerId) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const buyer = await Buyer.findById(buyerId);

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    // Initialize deliveryAddresses if not exists
    if (!buyer.deliveryAddresses) {
      buyer.deliveryAddresses = [];
    }

    // If this is set as default, unset other defaults
    if (req.body.isDefault) {
      buyer.deliveryAddresses.forEach(addr => {
        addr.isDefault = false;
      });
    }

    // If this is the first address, make it default
    if (buyer.deliveryAddresses.length === 0) {
      req.body.isDefault = true;
    }

    buyer.deliveryAddresses.push(req.body);
    await buyer.save();

    const newAddress = buyer.deliveryAddresses[buyer.deliveryAddresses.length - 1];

    res.status(201).json({
      success: true,
      message: 'Address added successfully',
      data: newAddress
    });

  } catch (error) {
    console.error('Add address error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   PUT /api/addresses/:addressId
 * @desc    Update an address
 * @access  Private
 */
router.put('/:addressId', auth, async (req, res) => {
  try {
    const { error } = addressSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const buyerId = await getBuyerIdForUser(req.user);

    if (!buyerId) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const buyer = await Buyer.findById(buyerId);

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const address = buyer.deliveryAddresses.id(req.params.addressId);

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    // If setting as default, unset other defaults
    if (req.body.isDefault && !address.isDefault) {
      buyer.deliveryAddresses.forEach(addr => {
        if (addr._id.toString() !== req.params.addressId) {
          addr.isDefault = false;
        }
      });
    }

    // Update address fields
    Object.keys(req.body).forEach(key => {
      address[key] = req.body[key];
    });

    await buyer.save();

    res.json({
      success: true,
      message: 'Address updated successfully',
      data: address
    });

  } catch (error) {
    console.error('Update address error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   DELETE /api/addresses/:addressId
 * @desc    Delete an address
 * @access  Private
 */
router.delete('/:addressId', auth, async (req, res) => {
  try {
    const buyerId = await getBuyerIdForUser(req.user);

    if (!buyerId) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const buyer = await Buyer.findById(buyerId);

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const address = buyer.deliveryAddresses.id(req.params.addressId);

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    const wasDefault = address.isDefault;
    address.remove();

    // If we deleted the default address, make the first remaining address default
    if (wasDefault && buyer.deliveryAddresses.length > 0) {
      buyer.deliveryAddresses[0].isDefault = true;
    }

    await buyer.save();

    res.json({
      success: true,
      message: 'Address deleted successfully'
    });

  } catch (error) {
    console.error('Delete address error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   PUT /api/addresses/:addressId/default
 * @desc    Set an address as default
 * @access  Private
 */
router.put('/:addressId/default', auth, async (req, res) => {
  try {
    const buyerId = await getBuyerIdForUser(req.user);

    if (!buyerId) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const buyer = await Buyer.findById(buyerId);

    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer profile not found'
      });
    }

    const address = buyer.deliveryAddresses.id(req.params.addressId);

    if (!address) {
      return res.status(404).json({
        success: false,
        message: 'Address not found'
      });
    }

    // Unset all defaults
    buyer.deliveryAddresses.forEach(addr => {
      addr.isDefault = false;
    });

    // Set this one as default
    address.isDefault = true;

    await buyer.save();

    res.json({
      success: true,
      message: 'Default address updated successfully',
      data: address
    });

  } catch (error) {
    console.error('Set default address error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
