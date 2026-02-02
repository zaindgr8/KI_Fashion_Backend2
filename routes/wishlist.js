const express = require('express');
const Joi = require('joi');
const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const auth = require('../middleware/auth');
const { generateSignedUrls } = require('../utils/imageUpload');

const router = express.Router();

/**
 * @route   GET /api/wishlist
 * @desc    Get current user's wishlist
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  try {
    let wishlist = await Wishlist.findOne({ userId: req.user._id })
      .populate({
        path: 'items.product',
        select: 'name sku productCode images pricing brand season isActive'
      })
      .lean();

    if (!wishlist) {
      return res.json({
        success: true,
        data: {
          items: [],
          itemCount: 0
        }
      });
    }

    // Filter out inactive products or deleted products
    wishlist.items = wishlist.items.filter(item => 
      item.product && item.product.isActive !== false
    );

    // Convert product images to signed URLs
    await Promise.all(wishlist.items.map(async (item) => {
      if (item.product && item.product.images && item.product.images.length > 0) {
        try {
          item.product.images = await generateSignedUrls(item.product.images);
        } catch (err) {
          console.warn('Failed to generate signed URLs for wishlist item:', err.message);
        }
      }
    }));

    res.json({
      success: true,
      data: {
        items: wishlist.items,
        itemCount: wishlist.items.length
      }
    });

  } catch (error) {
    console.error('Get wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   POST /api/wishlist/items
 * @desc    Add product to wishlist
 * @access  Private
 */
router.post('/items', auth, async (req, res) => {
  try {
    const schema = Joi.object({
      productId: Joi.string().length(24).hex().required()
    });

    const { error } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { productId } = req.body;

    // Check if product exists and is active
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (product.isActive === false) {
      return res.status(400).json({
        success: false,
        message: 'This product is no longer available'
      });
    }

    // Find or create wishlist
    let wishlist = await Wishlist.findOne({ userId: req.user._id });

    if (!wishlist) {
      wishlist = new Wishlist({
        userId: req.user._id,
        items: []
      });
    }

    // Check if product already in wishlist
    const existingIndex = wishlist.items.findIndex(
      item => item.product.toString() === productId
    );

    if (existingIndex >= 0) {
      return res.status(400).json({
        success: false,
        message: 'Product already in wishlist'
      });
    }

    // Add product to wishlist
    wishlist.items.push({
      product: productId,
      addedAt: new Date()
    });

    await wishlist.save();

    res.json({
      success: true,
      message: 'Product added to wishlist',
      data: {
        itemCount: wishlist.items.length
      }
    });

  } catch (error) {
    console.error('Add to wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   DELETE /api/wishlist/items/:productId
 * @desc    Remove product from wishlist
 * @access  Private
 */
router.delete('/items/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    const wishlist = await Wishlist.findOne({ userId: req.user._id });

    if (!wishlist) {
      return res.status(404).json({
        success: false,
        message: 'Wishlist not found'
      });
    }

    // Remove product from wishlist
    const initialLength = wishlist.items.length;
    wishlist.items = wishlist.items.filter(
      item => item.product.toString() !== productId
    );

    if (wishlist.items.length === initialLength) {
      return res.status(404).json({
        success: false,
        message: 'Product not found in wishlist'
      });
    }

    await wishlist.save();

    res.json({
      success: true,
      message: 'Product removed from wishlist',
      data: {
        itemCount: wishlist.items.length
      }
    });

  } catch (error) {
    console.error('Remove from wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   DELETE /api/wishlist
 * @desc    Clear entire wishlist
 * @access  Private
 */
router.delete('/', auth, async (req, res) => {
  try {
    const wishlist = await Wishlist.findOne({ userId: req.user._id });

    if (!wishlist) {
      return res.json({
        success: true,
        message: 'Wishlist already empty'
      });
    }

    wishlist.items = [];
    await wishlist.save();

    res.json({
      success: true,
      message: 'Wishlist cleared',
      data: {
        itemCount: 0
      }
    });

  } catch (error) {
    console.error('Clear wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * @route   GET /api/wishlist/check/:productId
 * @desc    Check if product is in wishlist
 * @access  Private
 */
router.get('/check/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID'
      });
    }

    const wishlist = await Wishlist.findOne({ userId: req.user._id });

    if (!wishlist) {
      return res.json({
        success: true,
        data: {
          inWishlist: false
        }
      });
    }

    const inWishlist = wishlist.items.some(
      item => item.product.toString() === productId
    );

    res.json({
      success: true,
      data: {
        inWishlist
      }
    });

  } catch (error) {
    console.error('Check wishlist error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;
