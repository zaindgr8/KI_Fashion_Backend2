const AuditLog = require('../models/AuditLog');

/**
 * Log a user activity in the audit trail.
 * 
 * @param {Object} req - The Express request object containing user and metadata.
 * @param {Object} data - The logging data.
 * @param {string} data.action - Action performed (CREATE, UPDATE, DELETE, etc.).
 * @param {string} data.resource - Name of the resource (e.g., Sale, Product).
 * @param {string} [data.resourceId] - ID of the affected resource.
 * @param {string} data.description - Human-readable description of the action.
 * @param {Object} [data.changes] - The changes made (old/new snapshots).
 */
const logActivity = async (req, { action, resource, resourceId, description, changes }) => {
  try {
    // Basic validation
    if (!req.user) {
      // In some cases (like login flow) req.user might not be set yet 
      // but we might want to log. For now, we skip or handle based on specific needs.
      return;
    }

    const logEntry = new AuditLog({
      user: req.user._id,
      userEmail: req.user.email,
      userName: req.user.name,
      action,
      resource,
      resourceId,
      description,
      changes: changes || { old: null, new: null },
      ipAddress: req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress,
      userAgent: req.headers['user-agent']
    });

    await logEntry.save();
  } catch (error) {
    // Secure core logic: auditing failing should not block the user's action
    console.error('CRITICAL: Audit logging failed:', error.message);
  }
};

module.exports = { logActivity };
