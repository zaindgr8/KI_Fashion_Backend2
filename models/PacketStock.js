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

  // Barcode image data for label printing
  barcodeImage: {
    dataUrl: String,
    format: String,  // e.g., 'code128'
    generatedAt: Date
  },

  // Break history - tracks when packets are broken and items sold individually
  breakHistory: [{
    brokenAt: {
      type: Date,
      default: Date.now
    },
    brokenBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    itemsSold: [{
      size: String,
      color: String,
      quantity: Number
    }],
    remainingItems: [{
      size: String,
      color: String,
      quantity: Number
    }],
    // DEPRECATED: Use loosePacketStocksCreated instead (kept for backward compatibility)
    loosePacketStockCreated: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PacketStock'
    },
    // Array of loose stocks created - one per unique variant (size/color)
    loosePacketStocksCreated: [{
      looseStockId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'PacketStock'
      },
      barcode: String,
      size: String,
      color: String,
      quantity: Number
    }],
    saleReference: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sale'
    },
    notes: String
  }],

  // Reference to parent packet if this is a broken/orphan stock
  parentPacketStock: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PacketStock'
  },

  // Status
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Compound indexes for faster lookups
packetStockSchema.index({ product: 1, supplier: 1, barcode: 1 });
packetStockSchema.index({ barcode: 1, isActive: 1 });
// Index for low stock queries
packetStockSchema.index({ isActive: 1, availablePackets: 1 });
// Index for product-specific packet lookups
packetStockSchema.index({ product: 1, isActive: 1, availablePackets: -1 });
// Index for supplier packet lookups
packetStockSchema.index({ supplier: 1, isActive: 1 });

// Virtual for available stock (packets not reserved)
packetStockSchema.virtual('actualAvailable').get(function () {
  return Math.max(0, this.availablePackets - this.reservedPackets);
});

// Method to add stock
packetStockSchema.methods.addStock = function (quantity, dispatchOrderId, costPrice, landedPrice) {
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
packetStockSchema.methods.reservePackets = function (quantity) {
  const actualAvailable = this.availablePackets - this.reservedPackets;
  if (actualAvailable < quantity) {
    throw new Error(`Insufficient packets available. Available: ${actualAvailable}, Requested: ${quantity}`);
  }
  this.reservedPackets += quantity;
  return this.save();
};

// Method to release reserved packets (sale cancelled)
packetStockSchema.methods.releaseReservedPackets = function (quantity) {
  this.reservedPackets = Math.max(0, this.reservedPackets - quantity);
  return this.save();
};

// Method to sell packets (after delivery confirmation)
packetStockSchema.methods.sellPackets = function (quantity) {
  if (this.availablePackets < quantity) {
    throw new Error(`Insufficient packets available. Available: ${this.availablePackets}, Requested: ${quantity}`);
  }
  this.availablePackets -= quantity;
  this.reservedPackets = Math.max(0, this.reservedPackets - quantity);
  this.soldPackets += quantity;
  return this.save();
};

// Method to restore packets (for sale returns)
packetStockSchema.methods.restorePackets = function (quantity, reason = 'SaleReturn') {
  this.availablePackets += quantity;
  // Decrement soldPackets if the reason is a return
  if (reason === 'SaleReturn' && this.soldPackets >= quantity) {
    this.soldPackets -= quantity;
  }
  return this.save();
};

// Method to add loose items back (for returns to existing loose stock)
packetStockSchema.methods.addLooseItems = function (quantity, reason = 'SaleReturn') {
  if (!this.isLoose) {
    throw new Error('Cannot add loose items to a packet stock. Use restorePackets instead.');
  }
  this.availablePackets += quantity;
  return this.save();
};

// Method to return full packets to supplier (reduces available packets)
packetStockSchema.methods.returnToSupplier = function (quantity, returnId = null) {
  if (this.availablePackets < quantity) {
    throw new Error(`Insufficient packets for supplier return. Available: ${this.availablePackets}, Requested: ${quantity}`);
  }
  this.availablePackets -= quantity;
  return this.save();
};

// Method to return loose items to supplier (for isLoose = true stocks)
packetStockSchema.methods.returnLooseToSupplier = function (quantity, returnId = null) {
  if (!this.isLoose) {
    throw new Error('Use returnToSupplier for full packet stock returns.');
  }
  if (this.availablePackets < quantity) {
    throw new Error(`Insufficient loose items for return. Available: ${this.availablePackets}, Requested: ${quantity}`);
  }
  this.availablePackets -= quantity;
  return this.save();
};

// Method to break a packet for partial supplier return
// Returns specified items to supplier, creates loose stock for remaining items
// [IMPROVED] Now supports MongoDB sessions for atomic operations to prevent race conditions
packetStockSchema.methods.breakForSupplierReturn = async function (itemsToReturn, userId, returnId = null, session = null) {
  const QRCode = require('qrcode');
  const { generatePacketBarcode } = require('../utils/barcodeGenerator');

  if (this.isLoose) {
    throw new Error('Cannot break a loose stock entry. Use returnLooseToSupplier instead.');
  }

  if (this.availablePackets < 1) {
    throw new Error('No packets available to break for return.');
  }

  // Validate items to return exist in composition
  for (const returnItem of itemsToReturn) {
    const compItem = this.composition.find(
      c => c.size === returnItem.size && c.color === returnItem.color
    );
    if (!compItem) {
      throw new Error(`Item ${returnItem.color}/${returnItem.size} not found in packet composition.`);
    }
    if (returnItem.quantity > compItem.quantity) {
      throw new Error(`Cannot return ${returnItem.quantity} of ${returnItem.color}/${returnItem.size}. Packet only contains ${compItem.quantity}.`);
    }
  }

  // [IMPROVED] Use atomic findOneAndUpdate to prevent race conditions on availablePackets
  const updated = await this.constructor.findOneAndUpdate(
    { _id: this._id, availablePackets: { $gte: 1 } },
    { $inc: { availablePackets: -1 } },
    { new: true, session }
  );

  if (!updated) {
    throw new Error('Packet no longer available for breaking (concurrent operation detected). Please refresh and try again.');
  }

  // Calculate remaining items after return
  const remainingItems = this.composition.map(c => {
    const returnedItem = itemsToReturn.find(
      r => r.size === c.size && r.color === c.color
    );
    const returnedQty = returnedItem ? returnedItem.quantity : 0;
    return {
      size: c.size,
      color: c.color,
      quantity: c.quantity - returnedQty
    };
  }).filter(i => i.quantity > 0);

  // Create loose stock for remaining items if any
  const looseStocksCreated = [];

  if (remainingItems.length > 0) {
    // Create one loose stock per variant for better tracking
    for (const item of remainingItems) {
      const singleVariantComposition = [{
        size: item.size,
        color: item.color,
        quantity: 1
      }];

      const barcode = generatePacketBarcode(
        this.supplier.toString(),
        this.product.toString(),
        singleVariantComposition,
        true // isLoose
      );

      // Find or create loose stock for this variant (session-aware)
      let looseStock = await this.constructor.findOne({
        barcode,
        isActive: true
      }).session(session);

      if (looseStock) {
        looseStock.availablePackets += item.quantity;
        await looseStock.save({ session });
      } else {
        looseStock = new this.constructor({
          barcode,
          product: this.product,
          supplier: this.supplier,
          composition: singleVariantComposition,
          totalItemsPerPacket: 1,
          availablePackets: item.quantity,
          reservedPackets: 0,
          soldPackets: 0,
          isLoose: true,
          parentPacketStock: this._id,
          dispatchOrderHistory: []
        });

        // Generate QR code
        try {
          const qrDataUrl = await QRCode.toDataURL(barcode, {
            errorCorrectionLevel: 'M',
            type: 'image/png',
            scale: 6,
            margin: 1
          });
          looseStock.qrCode = {
            dataUrl: qrDataUrl,
            generatedAt: new Date()
          };
        } catch (qrError) {
          console.warn('[PacketStock] QR code generation failed:', qrError.message);
        }

        await looseStock.save({ session });
      }

      looseStocksCreated.push({
        looseStockId: looseStock._id,
        barcode: looseStock.barcode,
        size: item.size,
        color: item.color,
        quantity: item.quantity
      });
    }
  }

  // Record in break history
  this.breakHistory.push({
    brokenAt: new Date(),
    brokenBy: userId,
    itemsSold: itemsToReturn, // Items returned to supplier
    remainingItems,
    loosePacketStocksCreated: looseStocksCreated,
    saleReference: returnId, // Store return reference
    notes: 'Broken for supplier return'
  });

  // Save with session if provided
  if (session) {
    await this.save({ session });
  } else {
    await this.save();
  }

  return {
    remainingItems,
    looseStocksCreated,
    totalItemsReturned: itemsToReturn.reduce((sum, i) => sum + i.quantity, 0)
  };
};

// Static method to find or create loose stock for remaining items after breaking
packetStockSchema.statics.findOrCreateLooseStock = async function (productId, supplierId, composition, parentPacketStockId) {
  const { generatePacketBarcode } = require('../utils/barcodeGenerator');
  const QRCode = require('qrcode');

  // Generate barcode for this loose composition
  const barcode = generatePacketBarcode(supplierId.toString(), productId.toString(), composition, true);

  // Calculate total items
  const totalItems = composition.reduce((sum, item) => sum + item.quantity, 0);

  // Find existing loose stock with same barcode
  let looseStock = await this.findOne({ barcode, isActive: true });

  if (looseStock) {
    // Add to existing loose stock
    looseStock.availablePackets += 1;
    await looseStock.save();
    return { looseStock, isNew: false };
  }

  // Create new loose stock entry
  looseStock = new this({
    barcode,
    product: productId,
    supplier: supplierId,
    composition,
    totalItemsPerPacket: totalItems,
    availablePackets: 1,
    reservedPackets: 0,
    soldPackets: 0,
    isLoose: true,
    parentPacketStock: parentPacketStockId,
    dispatchOrderHistory: []
  });

  // Generate QR code
  try {
    const qrDataUrl = await QRCode.toDataURL(barcode, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      scale: 6,
      margin: 1
    });
    looseStock.qrCode = {
      dataUrl: qrDataUrl,
      generatedAt: new Date()
    };
  } catch (qrError) {
    console.warn('QR code generation failed for loose stock:', qrError.message);
  }

  await looseStock.save();
  return { looseStock, isNew: true };
};

// Pre-save: validate composition sum equals totalItemsPerPacket
packetStockSchema.pre('save', function (next) {
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
