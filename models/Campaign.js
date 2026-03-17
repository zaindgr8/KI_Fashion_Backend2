const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    index: true,
  },
  slug: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true,
    index: true,
  },
  campaignType: {
    type: String,
    enum: ['discount', 'clearance'],
    default: 'discount',
    index: true,
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'expired', 'archived'],
    default: 'draft',
    index: true,
  },
  isActive: {
    type: Boolean,
    default: false,
    index: true,
  },
  discountType: {
    type: String,
    enum: ['percentage', 'fixed'],
    required: true,
  },
  discountValue: {
    type: Number,
    required: true,
    min: 0,
  },
  startAt: {
    type: Date,
    required: true,
    index: true,
  },
  endAt: {
    type: Date,
    required: true,
    index: true,
  },
  timezone: {
    type: String,
    default: 'UTC',
  },
  productIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    index: true,
  }],
  filters: {
    categories: [{ type: String, trim: true }],
    brands: [{ type: String, trim: true }],
    seasons: [{ type: String, trim: true }],
    supplierIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier',
    }],
    skus: [{ type: String, trim: true, uppercase: true }],
    stockState: {
      type: String,
      enum: ['any', 'in-stock', 'low-stock', 'out-of-stock'],
      default: 'any',
    },
  },
  badgeText: {
    type: String,
    trim: true,
    default: '',
  },
  badgeVariant: {
    type: String,
    trim: true,
    default: 'sale',
  },
  priority: {
    type: Number,
    default: 100,
    min: 0,
  },
  notes: {
    type: String,
    trim: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

campaignSchema.index({ isActive: 1, status: 1, startAt: 1, endAt: 1 });
campaignSchema.index({ campaignType: 1, status: 1, isActive: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
