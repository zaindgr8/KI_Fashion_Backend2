const mongoose = require('mongoose');

const saleReturnItemSchema = new mongoose.Schema({
  itemIndex: { type: Number, required: true },
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true
  },
  originalQuantity: { type: Number, required: true, min: 0 },
  returnedQuantity: { type: Number, required: true, min: 0 },
  unitPrice: { type: Number, required: true, min: 0 },
  reason: { type: String },
  returnComposition: [{
    size: String,
    color: String,
    quantity: Number
  }]
}, { _id: true });

const saleReturnSchema = new mongoose.Schema({
  sale: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Sale',
    required: true
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: true
  },
  items: [saleReturnItemSchema],
  totalReturnValue: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  returnedAt: {
    type: Date,
    default: Date.now
  },
  returnedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  processedAt: {
    type: Date
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectionNotes: {
    type: String
  },
  notes: { type: String }
}, {
  timestamps: true
});

saleReturnSchema.index({ sale: 1, returnedAt: -1 });
saleReturnSchema.index({ buyer: 1, returnedAt: -1 });
saleReturnSchema.index({ status: 1, returnedAt: -1 });

module.exports = mongoose.model('SaleReturn', saleReturnSchema);

