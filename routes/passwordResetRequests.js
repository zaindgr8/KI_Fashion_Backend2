const express = require('express');
const Joi = require('joi');
const PasswordResetRequest = require('../models/PasswordResetRequest');
const User = require('../models/User');
const auth = require('../middleware/auth');

const router = express.Router();

// Generate random password (reused from users.js)
const generatePassword = () => {
  const length = Math.floor(Math.random() * 5) + 8; // 8-12 characters
  const charset = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*';
  let password = '';
  for (let i = 0; i < length; i++) {
    password += charset.charAt(Math.floor(Math.random() * charset.length));
  }
  return password;
};

// Get all password reset requests (admin only)
router.get('/', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can view password reset requests'
      });
    }

    const { page = 1, limit = 50, status, portalSource } = req.query;

    const query = {};

    if (status) {
      query.status = status;
    }

    if (portalSource) {
      query.portalSource = portalSource;
    }

    const requests = await PasswordResetRequest.find(query)
      .populate('userId', 'name email role')
      .populate('completedBy', 'name email')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await PasswordResetRequest.countDocuments(query);

    res.json({
      success: true,
      data: requests,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get password reset requests error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get single password reset request (admin only)
router.get('/:id', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can view password reset requests'
      });
    }

    const request = await PasswordResetRequest.findById(req.params.id)
      .populate('userId', 'name email role')
      .populate('completedBy', 'name email');

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Password reset request not found'
      });
    }

    res.json({
      success: true,
      data: request
    });

  } catch (error) {
    console.error('Get password reset request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Complete password reset request (admin only)
router.patch('/:id/complete', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can complete password reset requests'
      });
    }

    const request = await PasswordResetRequest.findById(req.params.id)
      .populate('userId');

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Password reset request not found'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Request is not pending'
      });
    }

    const user = await User.findById(request.userId._id || request.userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Generate new password
    const newPassword = generatePassword();
    
    // Set password (will be hashed by pre-save hook)
    user.password = newPassword;
    await user.save();

    // Update request status
    request.status = 'completed';
    request.completedAt = new Date();
    request.completedBy = req.user._id;
    await request.save();

    // Return plain password (only this time, for admin to copy)
    res.json({
      success: true,
      message: 'Password reset completed successfully',
      password: newPassword,
      data: request
    });

  } catch (error) {
    console.error('Complete password reset request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Cancel password reset request (admin only)
router.patch('/:id/cancel', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can cancel password reset requests'
      });
    }

    const request = await PasswordResetRequest.findById(req.params.id);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Password reset request not found'
      });
    }

    if (request.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending requests can be cancelled'
      });
    }

    request.status = 'cancelled';
    await request.save();

    res.json({
      success: true,
      message: 'Password reset request cancelled successfully',
      data: request
    });

  } catch (error) {
    console.error('Cancel password reset request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete password reset request (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Check if requester is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admin can delete password reset requests'
      });
    }

    const request = await PasswordResetRequest.findByIdAndDelete(req.params.id);

    if (!request) {
      return res.status(404).json({
        success: false,
        message: 'Password reset request not found'
      });
    }

    res.json({
      success: true,
      message: 'Password reset request deleted successfully'
    });

  } catch (error) {
    console.error('Delete password reset request error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;

