const express = require('express');
const Joi = require('joi');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

// Middleware: require admin or super-admin role
function requireAdmin(req, res, next) {
  if (!req.user || (req.user.role !== 'admin' && req.user.role !== 'super-admin')) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  next();
}

const userSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid('super-admin', 'admin', 'employee', 'accountant').default('employee'),
  phone: Joi.string().optional(),
  phoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string().valid('users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery')).optional(),
  isActive: Joi.boolean().default(true)
});

const updateUserSchema = Joi.object({
  name: Joi.string().min(2).max(100).optional(),
  email: Joi.string().email().optional(),
  role: Joi.string().valid('super-admin', 'admin', 'employee', 'accountant').optional(),
  phone: Joi.string().optional(),
  phoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string().valid('users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery')).optional(),
  isActive: Joi.boolean().optional()
});

// Create user (admin only)
router.post('/', auth, requireAdmin, async (req, res) => {
  try {
    const { error } = userSchema.validate(req.body, { allowUnknown: true });
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    const { name, email, password, role, phone, phoneAreaCode, address, permissions } = req.body;

    // Only super-admin can create super-admin or admin accounts
    if ((role === 'super-admin' || role === 'admin') && req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Only super-admin can create admin accounts' });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ success: false, message: 'User with this email already exists' });
    }

    const user = new User({
      name,
      email,
      password,
      role: role || 'employee',
      phone,
      phoneAreaCode,
      address,
      permissions: permissions || [],
      signupSource: 'crm'
    });

    await user.save();

    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(201).json({
      success: true,
      message: 'Employee created successfully',
      data: userResponse
    });

  } catch (error) {
    console.error('Create user error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get all users (admin only)
router.get('/', auth, requireAdmin, async (req, res) => {
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
        .skip((page - 1) * limit)
        .lean();
    } else {
      users = await User.find(query)
        .select('-password')
        .sort({ createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit)
        .lean();
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

// Get user by ID (admin only)
router.get('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate(['supplier', 'buyer'])
      .select('-password')
      .lean();

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

// Update user (admin only, whitelisted fields)
router.put('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { error } = updateUserSchema.validate(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error.details[0].message });
    }

    // Only super-admin can change roles
    if (req.body.role && req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Only super-admin can change user roles' });
    }

    const allowedFields = ['name', 'email', 'phone', 'phoneAreaCode', 'address', 'permissions', 'isActive'];
    if (req.user.role === 'super-admin') allowedFields.push('role');
    const updates = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      updates,
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

// Deactivate user (admin only)
router.patch('/:id/deactivate', auth, requireAdmin, async (req, res) => {
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
    if (req.user.role !== 'super-admin') {
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