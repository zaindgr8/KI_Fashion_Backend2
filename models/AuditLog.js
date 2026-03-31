const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userEmail: {
    type: String,
    required: true
  },
  userName: {
    type: String,
    required: true
  },
  action: {
    type: String,
    enum: ['CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'APPROVE', 'REJECT', 'STATUS_CHANGE', 'PASSWORD_RESET', 'DEACTIVATE'],
    required: true
  },
  resource: {
    type: String,
    required: true,
    index: true
  },
  resourceId: {
    type: mongoose.Schema.Types.ObjectId,
    index: true
  },
  description: {
    type: String,
    required: true
  },
  changes: {
    old: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    },
    new: {
      type: mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  ipAddress: String,
  userAgent: String,
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, { 
  timestamps: true,
  // Industry standard: logs should be hard to delete/modify via standard app logic
  // We don't add specific restrictions here but will enforce via API
});

// Index for faster searching by user and date
auditLogSchema.index({ userEmail: 1, timestamp: -1 });
auditLogSchema.index({ resource: 1, resourceId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
