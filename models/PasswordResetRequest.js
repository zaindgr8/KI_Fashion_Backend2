const mongoose = require('mongoose');

const STATUS_OPTIONS = ['pending', 'completed', 'cancelled'];
const PORTAL_SOURCE_OPTIONS = ['supplier-portal', 'distributor-portal', 'app-supplier'];

const passwordResetRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  status: {
    type: String,
    enum: STATUS_OPTIONS,
    default: 'pending',
    index: true
  },
  portalSource: {
    type: String,
    enum: PORTAL_SOURCE_OPTIONS,
    required: true
  },
  requestedAt: {
    type: Date,
    default: Date.now
  },
  completedAt: {
    type: Date
  },
  completedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Index for efficient queries
passwordResetRequestSchema.index({ email: 1, status: 1 });
passwordResetRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('PasswordResetRequest', passwordResetRequestSchema);

