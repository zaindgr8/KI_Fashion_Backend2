const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Joi = require('joi');
const User = require('../models/User');
const auth = require('../middleware/auth');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');
const PasswordResetRequest = require('../models/PasswordResetRequest');

const router = express.Router();

const ROLE_OPTIONS = ['super-admin', 'admin', 'employee', 'accountant', 'supplier', 'distributor', 'buyer'];
const PORTAL_ACCESS_OPTIONS = ['crm', 'supplier', 'distributor'];
const SIGNUP_SOURCES = ['crm', 'supplier-portal', 'distributor-portal', 'import'];

const registerSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  email: Joi.string().email().required(),
  password: Joi.string().min(6).required(),
  role: Joi.string().valid(...ROLE_OPTIONS).default('employee'),
  phone: Joi.string().optional(),
  phoneAreaCode: Joi.string().max(5).optional(),
  address: Joi.string().optional(),
  permissions: Joi.array().items(Joi.string().valid('users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery')).optional(),
  portalAccess: Joi.array().items(Joi.string().valid(...PORTAL_ACCESS_OPTIONS)).optional(),
  supplierId: Joi.string().length(24).hex().optional(),
  buyerId: Joi.string().length(24).hex().optional(),
  signupSource: Joi.string().valid(...SIGNUP_SOURCES).optional(),
  supplierProfile: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    company: Joi.string().max(100).allow(null, ''),
    email: Joi.string().email().allow(null, ''),
    phone: Joi.string().min(3).allow(null, ''),
    phoneAreaCode: Joi.string().max(5).allow(null, '').optional(),
    alternatePhone: Joi.string().allow(null, '').optional(),
    alternatePhoneAreaCode: Joi.string().max(5).allow(null, '').optional(),
    address: Joi.object({
      street: Joi.string().allow(null, ''),
      city: Joi.string().allow(null, ''),
      state: Joi.string().allow(null, ''),
      zipCode: Joi.string().allow(null, ''),
      country: Joi.string().default('Pakistan')
    }).optional(),
    paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').optional(),
    notes: Joi.string().allow(null, ''),
  }).optional(),
  distributorProfile: Joi.object({
    name: Joi.string().min(2).max(100).required(),
    company: Joi.string().max(100).allow(null, ''),
    email: Joi.string().email().allow(null, ''),
    phone: Joi.string().min(3).allow(null, ''),
    phoneAreaCode: Joi.string().max(5).allow(null, '').optional(),
    address: Joi.object({
      street: Joi.string().allow(null, ''),
      city: Joi.string().allow(null, ''),
      state: Joi.string().allow(null, ''),
      zipCode: Joi.string().allow(null, ''),
      country: Joi.string().default('Pakistan')
    }).optional(),
    taxNumber: Joi.string().allow(null, ''),
    notes: Joi.string().allow(null, ''),
  }).optional()
});

const loginSchema = Joi.object({
  email: Joi.string().email().required(),
  password: Joi.string().required()
});

const forgotPasswordSchema = Joi.object({
  email: Joi.string().email().required(),
  portalSource: Joi.string().valid('supplier-portal', 'distributor-portal', 'app-supplier').required()
});

// Register
router.post('/register', async (req, res) => {
  try {
    const { error } = registerSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const {
      name,
      email,
      password,
      role,
      phone,
      address,
      permissions,
      portalAccess,
      supplierId,
      buyerId,
      signupSource,
      supplierProfile,
      distributorProfile
    } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists'
      });
    }

    // Create new user
    const user = new User({
      name,
      email,
      password,
      role,
      phone,
      address,
      permissions: permissions || [],
      portalAccess: Array.isArray(portalAccess) && portalAccess.length ? portalAccess : undefined,
      supplier: supplierId || undefined,
      buyer: buyerId || undefined,
      signupSource: signupSource || (role === 'supplier' ? 'supplier-portal' : role === 'distributor' || role === 'buyer' ? 'distributor-portal' : 'crm')
    });

    await user.save();

    let supplierDoc;
    let buyerDoc;

    try {
      if (role === 'supplier' && supplierProfile) {
        const supplierPayload = {
          name: supplierProfile.name,
          company: supplierProfile.company || supplierProfile.name,
          email: supplierProfile.email || email,
          phone: supplierProfile.phone || phone,
          alternatePhone: supplierProfile.alternatePhone || undefined,
          address: supplierProfile.address,
          paymentTerms: supplierProfile.paymentTerms,
          notes: supplierProfile.notes,
          createdBy: user._id,
          userId: user._id, // Add explicit userId reference
        };

        supplierDoc = new Supplier(supplierPayload);
        await supplierDoc.save();

        user.supplier = supplierDoc._id;
        const portals = new Set([...(user.portalAccess || []), 'supplier']);
        user.portalAccess = Array.from(portals);
        await user.save();
      }

      if ((role === 'distributor' || role === 'buyer') && distributorProfile) {
        const buyerPayload = {
          name: distributorProfile.name,
          company: distributorProfile.company || distributorProfile.name,
          email: distributorProfile.email || email,
          phone: distributorProfile.phone || phone,
          address: distributorProfile.address,
          taxNumber: distributorProfile.taxNumber,
          notes: distributorProfile.notes,
          customerType: 'distributor',
          createdBy: user._id,
          userId: user._id, // Add explicit userId reference
        };

        buyerDoc = new Buyer(buyerPayload);
        await buyerDoc.save();

        user.buyer = buyerDoc._id;
        const portals = new Set([...(user.portalAccess || []), 'distributor']);
        user.portalAccess = Array.from(portals);
        await user.save();
      }
    } catch (profileError) {
      await User.findByIdAndDelete(user._id);
      if (supplierDoc?._id) {
        await Supplier.findByIdAndDelete(supplierDoc._id).catch(() => {});
      }
      if (buyerDoc?._id) {
        await Buyer.findByIdAndDelete(buyerDoc._id).catch(() => {});
      }
      return res.status(400).json({
        success: false,
        message: profileError.message || 'Unable to create linked profile',
      });
    }

    await user.populate(['supplier', 'buyer']);

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(201).json({
      success: true,
      message: 'User registered successfully',
      token,
      user: buildUserPayload(user)
    });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during registration'
    });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { error } = loginSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { email, password } = req.body;

    // Check if user exists
    const user = await User.findOne({ email, isActive: true })
      .populate(['supplier', 'buyer']);
    if (!user) {
      return res.status(400).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Verify password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Invalid credentials'
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: buildUserPayload(user)
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during login'
    });
  }
});

// Forgot password - Create reset request
router.post('/forgot-password', async (req, res) => {
  try {
    const { error } = forgotPasswordSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { email, portalSource } = req.body;

    // Check if user exists and is active
    const user = await User.findOne({ email: email.toLowerCase(), isActive: true });
    
    // Don't reveal if email exists (security best practice)
    // Always return success message to prevent email enumeration
    if (!user) {
      return res.json({
        success: true,
        message: 'If an account with that email exists, a password reset request has been created.'
      });
    }

    // Check for existing pending request
    const existingRequest = await PasswordResetRequest.findOne({
      email: email.toLowerCase(),
      status: 'pending'
    });

    if (existingRequest) {
      // Request already exists, return success without creating duplicate
      return res.json({
        success: true,
        message: 'If an account with that email exists, a password reset request has been created.'
      });
    }

    // Create new password reset request
    const resetRequest = new PasswordResetRequest({
      userId: user._id,
      email: email.toLowerCase(),
      portalSource,
      status: 'pending'
    });

    await resetRequest.save();

    res.json({
      success: true,
      message: 'If an account with that email exists, a password reset request has been created.'
    });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during password reset request'
    });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const freshUser = await User.findById(req.user._id)
      .populate(['supplier', 'buyer'])
      .select('-password');

    res.json({
      success: true,
      user: buildUserPayload(freshUser || req.user)
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Refresh token
router.post('/refresh', auth, async (req, res) => {
  try {
    const token = jwt.sign(
      { userId: req.user._id, role: req.user.role },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Token refreshed successfully',
      token
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

function buildUserPayload(userDoc) {
  if (!userDoc) return null;
  const user = userDoc.toObject ? userDoc.toObject() : userDoc;

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    phone: user.phone,
    phoneAreaCode: user.phoneAreaCode,
    address: user.address,
    portalAccess: user.portalAccess || [],
    supplierId: user.supplier?._id || user.supplier,
    buyerId: user.buyer?._id || user.buyer,
    supplier: simplifyRelated(user.supplier),
    buyer: simplifyRelated(user.buyer),
    lastLogin: user.lastLogin,
    createdAt: user.createdAt,
    signupSource: user.signupSource,
    invitedBy: user.invitedBy
  };
}

function simplifyRelated(related) {
  if (!related) return undefined;
  const obj = related.toObject ? related.toObject() : related;
  return {
    id: obj._id?.toString?.() || obj._id,
    name: obj.name,
    company: obj.company,
    email: obj.email,
    phone: obj.phone,
    phoneAreaCode: obj.phoneAreaCode
  };
}

// Update user (self-update or admin update)
router.put('/users/:id', auth, async (req, res) => {
  try {
    const userId = req.params.id;
    const requestingUserId = req.user._id.toString();
    
    // Users can only update themselves unless they're admin
    if (userId !== requestingUserId && req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'You can only update your own profile'
      });
    }

    const updateSchema = Joi.object({
      name: Joi.string().min(2).max(100).optional(),
      email: Joi.string().email().optional(),
      phone: Joi.string().optional(),
      phoneAreaCode: Joi.string().max(5).optional(),
      address: Joi.string().optional()
    });

    const { error } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if email is being changed and if it's already taken
    if (req.body.email) {
      const existingUser = await User.findOne({ 
        email: req.body.email.toLowerCase(),
        _id: { $ne: userId }
      });
      if (existingUser) {
        return res.status(400).json({
          success: false,
          message: 'Email already in use'
        });
      }
      req.body.email = req.body.email.toLowerCase();
    }

    const user = await User.findByIdAndUpdate(
      userId,
      req.body,
      { new: true, runValidators: true }
    )
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
      message: 'User updated successfully',
      data: buildUserPayload(user)
    });

  } catch (error) {
    console.error('Update user error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Change password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'Current password and new password are required'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'New password must be at least 6 characters long'
      });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Verify current password
    const isMatch = await user.comparePassword(currentPassword);
    if (!isMatch) {
      return res.status(400).json({
        success: false,
        message: 'Current password is incorrect'
      });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;