const mongoose = require('mongoose');

const packetStockSchema = new mongoose.Schema({
  // Unique barcode for this packet configuration
  barcode: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  
  // Product reference
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    index: true
  },
  
  // Supplier who provided these packets
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  
  // Packet composition (sizes, colors, quantities per packet)
  composition: [{
    size: {
      type: String,
      required: true
    },
    color: {
      type: String,
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    }
  }],
  
  // Total items in one packet (sum of composition quantities)
  totalItemsPerPacket: {
    type: Number,
    required: true,
    min: 1
  },
  
  // Stock tracking
  availablePackets: {
    type: Number,
    default: 0,
    min: 0
  },
  reservedPackets: {
    type: Number,
    default: 0,
    min: 0
  },
  soldPackets: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Pricing
  costPricePerPacket: {
    type: Number,
    default: 0,
    min: 0
  },
  landedPricePerPacket: {
    type: Number,
    default: 0,
    min: 0
  },
  suggestedSellingPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // Is this a loose item (single item, not a packet)?
  isLoose: {
    type: Boolean,
    default: false
  },
  
  // Track which dispatch orders added stock to this packet type
  dispatchOrderHistory: [{
    dispatchOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DispatchOrder'
    },
    quantity: Number,
    costPricePerPacket: Number,
    landedPricePerPacket: Number,
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  // QR Code data for label printing
  qrCode: {
    dataUrl: String,
    generatedAt: Date
  },
  
  // Status
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound index for faster lookups
packetStockSchema.index({ product: 1, supplier: 1, barcode: 1 });
packetStockSchema.index({ barcode: 1, isActive: 1 });

// Virtual for available stock (packets not reserved)
packetStockSchema.virtual('actualAvailable').get(function() {
  return Math.max(0, this.availablePackets - this.reservedPackets);
});

// Method to add stock
packetStockSchema.methods.addStock = function(quantity, dispatchOrderId, costPrice, landedPrice) {
  const previousTotal = this.availablePackets;
  this.availablePackets += quantity;
  
  // Update weighted average landed price
  if (previousTotal > 0 && this.landedPricePerPacket > 0) {
    const existingValue = previousTotal * this.landedPricePerPacket;
    const newValue = quantity * landedPrice;
    this.landedPricePerPacket = (existingValue + newValue) / this.availablePackets;
  } else {
    this.landedPricePerPacket = landedPrice;
  }
  
  this.costPricePerPacket = costPrice; // Keep latest cost price
  
  // Calculate suggested selling price (20% margin on landed)
  this.suggestedSellingPrice = this.landedPricePerPacket * 1.20;
  
  // Track history
  this.dispatchOrderHistory.push({
    dispatchOrderId,
    quantity,
    costPricePerPacket: costPrice,
    landedPricePerPacket: landedPrice,
    addedAt: new Date()
  });
  
  return this.save();
};

// Method to reserve packets for a pending sale
packetStockSchema.methods.reservePackets = function(quantity) {
  const actualAvailable = this.availablePackets - this.reservedPackets;
  if (actualAvailable < quantity) {
    throw new Error(`Insufficient packets available. Available: ${actualAvailable}, Requested: ${quantity}`);
  }
  this.reservedPackets += quantity;
  return this.save();
};

// Method to release reserved packets (sale cancelled)
packetStockSchema.methods.releaseReservedPackets = function(quantity) {
  this.reservedPackets = Math.max(0, this.reservedPackets - quantity);
  return this.save();
};

// Method to sell packets (after delivery confirmation)
packetStockSchema.methods.sellPackets = function(quantity) {
  if (this.availablePackets < quantity) {
    throw new Error(`Insufficient packets available. Available: ${this.availablePackets}, Requested: ${quantity}`);
  }
  this.availablePackets -= quantity;
  this.reservedPackets = Math.max(0, this.reservedPackets - quantity);
  this.soldPackets += quantity;
  return this.save();
};

// Pre-save: validate composition sum equals totalItemsPerPacket
packetStockSchema.pre('save', function(next) {
  if (this.composition && this.composition.length > 0) {
    const sum = this.composition.reduce((acc, item) => acc + item.quantity, 0);
    if (sum !== this.totalItemsPerPacket) {
      return next(new Error(`Composition sum (${sum}) must equal totalItemsPerPacket (${this.totalItemsPerPacket})`));
    }
  }
  next();
});

// Ensure virtuals are included in JSON
packetStockSchema.set('toJSON', { virtuals: true });
packetStockSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('PacketStock', packetStockSchema);
