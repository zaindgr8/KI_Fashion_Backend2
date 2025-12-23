const express = require('express');
const Joi = require('joi');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

const userSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  role: Joi.string().valid('admin', 'manager', 'employee', 'accountant').default('employee'),
  phone: Joi.string().optional(),
  phoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string().valid('users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery')).optional(),
  isActive: Joi.boolean().default(true)
});

const updateUserSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  email: Joi.string().email().optional(),
  role: Joi.string().valid('admin', 'manager', 'employee', 'accountant').optional(),
  phone: Joi.string().optional(),
  phoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string().valid('users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery')).optional(),
  isActive: Joi.boolean().optional()
});

// Get all users
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 10, search, role, isActive } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    if (role) query.role = role;
    if (isActive !== undefined) query.isActive = isActive === 'true';

    let users;
    
    // For supplier role requests, populate the supplier profile
    if (role === 'supplier') {
      users = await User.find(query)
        .populate('supplier', 'name company email phone address')
        .select('-password')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
    } else {
      users = await User.find(query)
        .select('-password')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);
    }

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      data: users,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get user by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate(['supplier', 'buyer'])
      .select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      data: user
    });

  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update user
router.put('/:id', auth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User updated successfully',
      data: user
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Deactivate user
router.patch('/:id/deactivate', auth, async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: 'User deactivated successfully'
    });

  } catch (error) {
    console.error('Deactivate user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Regenerate password (admin only)
router.patch('/:id/regenerate-password', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can regenerate passwords'
      });
    }

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate random password (8-12 characters, alphanumeric + special chars)
    const generatePassword = () => {
      const length = Math.floor(Math.random() * 5) + 8; // 8-12 characters
      const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
      let password = '';
      for (let i = 0; i < length; i++) {
        password += charset.charAt(Math.floor(Math.random() * charset.length));
      }
      return password;
    };

    const newPassword = generatePassword();
    
    // Set password (will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    // Return plain password (only this time, for admin to copy)
    res.json({
      success: true,
      message: 'Password regenerated successfully',
      password: newPassword
    });

  } catch (error) {
    console.error('Regenerate password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;