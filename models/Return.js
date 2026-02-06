const mongoose = require('mongoose');

const returnSchema = new mongoose.Schema({
  dispatchOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DispatchOrder',
    required: false // Now optional for product-level returns
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true
  },
  // Return type: 'order-level' (traditional) or 'product-level' (new)
  returnType: {
    type: String,
    enum: ['order-level', 'product-level'],
    default: 'order-level'
  },
  // Return mode: how items were identified for return
  // 'packet-barcode' = full packets returned via barcode scan
  // 'variant-specific' = individual items by color/size
  // 'mixed' = combination of both methods
  // 'legacy' = returns created before packet sync feature
  returnMode: {
    type: String,
    enum: ['packet-barcode', 'variant-specific', 'mixed', 'legacy'],
    default: 'legacy'
  },
  // Packet-level adjustments made during this return
  packetAdjustments: [{
    packetStockId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PacketStock'
    },
    barcode: String,
    adjustmentType: {
      type: String,
      enum: ['full-packet-return', 'partial-break', 'loose-return']
    },
    packetsReturned: { type: Number, default: 0 },
    itemsReturned: { type: Number, default: 0 },
    looseStocksCreated: [{
      looseStockId: mongoose.Schema.Types.ObjectId,
      barcode: String,
      size: String,
      color: String,
      quantity: Number
    }]
  }],
  items: [{
    itemIndex: { type: Number, required: false }, // For order-level returns
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: false // For product-level returns
    },
    productName: { type: String },
    productCode: { type: String },
    originalQuantity: { type: Number, required: true, min: 0 },
    returnedQuantity: { type: Number, required: true, min: 0 },
    costPrice: { type: Number, required: true, min: 0 }, // Actual cost price paid to supplier
    landedPrice: { type: Number, min: 0 }, // For reference only
    reason: { type: String },
    // Batch deduction details for product-level returns
    batchDeductions: [{
      batchId: mongoose.Schema.Types.ObjectId,
      dispatchOrderId: mongoose.Schema.Types.ObjectId,
      quantity: Number,
      costPrice: Number
    }],
    // Variant breakdown
    returnComposition: [{
      size: String,
      color: String,
      quantity: Number
    }]
  }],
  totalReturnValue: {
    type: Number,
    required: true,
    min: 0
  },
  // Payment handling for the return
  cashRefund: {
    type: Number,
    default: 0,
    min: 0
  },
  accountCredit: {
    type: Number,
    default: 0,
    min: 0
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
  notes: { type: String }
}, {
  timestamps: true
});

returnSchema.index({ dispatchOrder: 1, returnedAt: -1 });
returnSchema.index({ supplier: 1, returnedAt: -1 });
returnSchema.index({ returnType: 1 });
returnSchema.index({ returnMode: 1 });
returnSchema.index({ 'items.product': 1 });
returnSchema.index({ 'packetAdjustments.packetStockId': 1 });

module.exports = mongoose.model('Return', returnSchema);

