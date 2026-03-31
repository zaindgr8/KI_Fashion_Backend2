const express = require('express');
const AuditLog = require('../models/AuditLog');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * Middleware: require super-admin role only
 */
function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super-admin') {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied: Only super-admin can view audit logs' 
    });
  }
  next();
}

/**
 * @route GET /api/audit-logs
 * @desc Get all audit logs with pagination and filtering
 * @access Private (Super Admin Only)
 */
router.get('/', auth, requireSuperAdmin, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      userEmail, 
      resource, 
      action, 
      startDate, 
      endDate,
      search 
    } = req.query;

    const query = {};

    // Filtering by user email
    if (userEmail) {
      query.userEmail = { $regex: userEmail, $options: 'i' };
    }

    // Filtering by resource
    if (resource) {
      query.resource = resource;
    }

    // Filtering by action
    if (action) {
      query.action = action;
    }

    // Filtering by date range
    if (startDate || endDate) {
      query.timestamp = {};
      if (startDate) query.timestamp.$gte = new Date(startDate);
      if (endDate) query.timestamp.$lte = new Date(endDate);
    }

    // General search in description or user name
    if (search) {
      query.$or = [
        { userName: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    const logs = await AuditLog.find(query)
      .sort({ timestamp: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await AuditLog.countDocuments(query);

    res.json({
      success: true,
      data: logs,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Fetch audit logs error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Server error while fetching audit logs' 
    });
  }
});

/**
 * @route GET /api/audit-logs/:id
 * @desc Get detailed audit log by ID
 * @access Private (Super Admin Only)
 */
router.get('/:id', auth, requireSuperAdmin, async (req, res) => {
  try {
    const log = await AuditLog.findById(req.params.id).lean();
    if (!log) {
      return res.status(404).json({ success: false, message: 'Log not found' });
    }
    res.json({ success: true, data: log });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
