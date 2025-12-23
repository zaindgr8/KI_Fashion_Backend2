const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema({
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product',
    required: true,
    unique: true
  },
  currentStock: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  reservedStock: {
    type: Number,
    default: 0,
    min: 0
  },
  availableStock: {
    type: Number,
    default: 0,
    min: 0
  },
  minStockLevel: {
    type: Number,
    required: true,
    min: 0
  },
  maxStockLevel: {
    type: Number,
    required: true,
    min: 0
  },
  reorderLevel: {
    type: Number,
    required: true,
    min: 0
  },
  reorderQuantity: {
    type: Number,
    default: 0,
    min: 0
  },
  location: {
    warehouse: String,
    section: String,
    shelf: String,
    bin: String
  },
  averageCostPrice: {
    type: Number,
    default: 0,
    min: 0
  },
  totalValue: {
    type: Number,
    default: 0,
    min: 0
  },
  // Purchase batch tracking for FIFO cost calculations
  // Each batch represents a purchase with specific cost price and quantity
  purchaseBatches: [{
    dispatchOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DispatchOrder'
    },
    supplierId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier'
    },
    purchaseDate: {
      type: Date,
      default: Date.now
    },
    quantity: {
      type: Number,
      required: true,
      min: 0
    },
    remainingQuantity: {
      type: Number,
      required: true,
      min: 0
    },
    costPrice: {
      type: Number,
      required: true,
      min: 0
    },
    landedPrice: {
      type: Number,
      min: 0
    },
    exchangeRate: {
      type: Number,
      default: 1.0
    },
    notes: String
  }],
  lastStockUpdate: {
    type: Date,
    default: Date.now
  },
  stockMovements: [{
    type: {
      type: String,
      enum: ['in', 'out', 'adjustment', 'transfer'],
      required: true
    },
    quantity: {
      type: Number,
      required: true
    },
    reference: {
      type: String,
      required: true
    },
    referenceId: {
      type: mongoose.Schema.Types.ObjectId
    },
    date: {
      type: Date,
      default: Date.now
    },
    notes: String,
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    }
  }],
  needsReorder: {
    type: Boolean,
    default: false
  },
  variantComposition: [{
    size: {
      type: String,
      required: true,
      trim: true
    },
    color: {
      type: String,
      required: true,
      trim: true
    },
    quantity: {
      type: Number,
      required: true,
      default: 0,
      min: 0
    },
    reservedQuantity: {
      type: Number,
      default: 0,
      min: 0
    }
  }],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

inventorySchema.pre('save', function(next) {
  this.availableStock = this.currentStock - this.reservedStock;
  this.needsReorder = this.currentStock <= this.reorderLevel;
  this.totalValue = this.currentStock * this.averageCostPrice;
  next();
});

inventorySchema.methods.addStock = function(quantity, reference, referenceId, user, notes = '') {
  this.stockMovements.push({
    type: 'in',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: notes
  });
  this.currentStock += quantity;
  this.lastStockUpdate = new Date();
  return this.save();
};

inventorySchema.methods.reduceStock = function(quantity, reference, referenceId, user, notes = '') {
  if (this.availableStock < quantity) {
    throw new Error('Insufficient stock available');
  }
  this.stockMovements.push({
    type: 'out',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: notes
  });
  this.currentStock -= quantity;
  this.lastStockUpdate = new Date();
  return this.save();
};

inventorySchema.methods.adjustStock = function(newQuantity, reference, user, notes = '') {
  const difference = newQuantity - this.currentStock;
  this.stockMovements.push({
    type: 'adjustment',
    quantity: difference,
    reference: reference,
    user: user,
    notes: notes
  });
  this.currentStock = newQuantity;
  this.lastStockUpdate = new Date();
  return this.save();
};

// Add stock with variant composition
inventorySchema.methods.addStockWithVariants = function(quantity, variantComposition, reference, referenceId, user, notes = '') {
  this.stockMovements.push({
    type: 'in',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: notes
  });
  this.currentStock += quantity;
  
  // Update variant composition
  if (variantComposition && variantComposition.length > 0) {
    variantComposition.forEach(incomingVariant => {
      const existingVariant = this.variantComposition.find(
        v => v.size === incomingVariant.size && v.color === incomingVariant.color
      );
      if (existingVariant) {
        existingVariant.quantity += incomingVariant.quantity;
      } else {
        this.variantComposition.push({
          size: incomingVariant.size,
          color: incomingVariant.color,
          quantity: incomingVariant.quantity,
          reservedQuantity: 0
        });
      }
    });
  }
  
  this.lastStockUpdate = new Date();
  return this.save();
};

// Reserve variant stock
inventorySchema.methods.reserveVariantStock = function(size, color, quantity) {
  const variant = this.variantComposition.find(
    v => v.size === size && v.color === color
  );
  if (!variant) {
    throw new Error(`Variant ${color}-${size} not found in inventory`);
  }
  const availableVariantStock = variant.quantity - variant.reservedQuantity;
  if (availableVariantStock < quantity) {
    throw new Error(`Insufficient stock for variant ${color}-${size}. Available: ${availableVariantStock}, Required: ${quantity}`);
  }
  variant.reservedQuantity += quantity;
  this.reservedStock += quantity;
  return this.save();
};

// Reduce variant stock
inventorySchema.methods.reduceVariantStock = function(size, color, quantity, reference, referenceId, user, notes = '') {
  const variant = this.variantComposition.find(
    v => v.size === size && v.color === color
  );
  if (!variant) {
    throw new Error(`Variant ${color}-${size} not found in inventory`);
  }
  if (variant.quantity < quantity) {
    throw new Error(`Insufficient stock for variant ${color}-${size}. Available: ${variant.quantity}, Required: ${quantity}`);
  }
  
  this.stockMovements.push({
    type: 'out',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: `${notes} - Variant: ${color}-${size}`
  });
  
  variant.quantity -= quantity;
  if (variant.reservedQuantity > 0) {
    variant.reservedQuantity = Math.max(0, variant.reservedQuantity - quantity);
  }
  this.currentStock -= quantity;
  this.reservedStock = Math.max(0, this.reservedStock - quantity);
  this.lastStockUpdate = new Date();
  
  return this.save();
};

// Get available stock for a specific variant
inventorySchema.methods.getVariantAvailableStock = function(size, color) {
  const variant = this.variantComposition.find(
    v => v.size === size && v.color === color
  );
  if (!variant) {
    return 0;
  }
  return variant.quantity - variant.reservedQuantity;
};

// Add stock with batch tracking (for FIFO cost calculation)
inventorySchema.methods.addStockWithBatch = function(quantity, batchInfo, reference, referenceId, user, notes = '') {
  // Add to purchase batches for FIFO tracking
  this.purchaseBatches.push({
    dispatchOrderId: batchInfo.dispatchOrderId || referenceId,
    supplierId: batchInfo.supplierId,
    purchaseDate: batchInfo.purchaseDate || new Date(),
    quantity: quantity,
    remainingQuantity: quantity,
    costPrice: batchInfo.costPrice,
    landedPrice: batchInfo.landedPrice,
    exchangeRate: batchInfo.exchangeRate || 1.0,
    notes: notes
  });

  // Add stock movement
  this.stockMovements.push({
    type: 'in',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: notes,
    date: new Date()
  });

  this.currentStock += quantity;
  this.lastStockUpdate = new Date();

  // Update average cost price using weighted average
  const totalValue = this.purchaseBatches.reduce((sum, batch) => {
    return sum + (batch.remainingQuantity * batch.costPrice);
  }, 0);
  const totalQuantity = this.purchaseBatches.reduce((sum, batch) => {
    return sum + batch.remainingQuantity;
  }, 0);
  this.averageCostPrice = totalQuantity > 0 ? totalValue / totalQuantity : batchInfo.costPrice;

  return this.save();
};

// Reduce stock using FIFO method and return the cost details
inventorySchema.methods.reduceStockFIFO = function(quantity, reference, referenceId, user, notes = '') {
  if (this.availableStock < quantity) {
    throw new Error(`Insufficient stock available. Available: ${this.availableStock}, Required: ${quantity}`);
  }

  let remainingToReduce = quantity;
  const costDetails = [];
  let totalCost = 0;

  // Sort batches by purchase date (oldest first - FIFO)
  const sortedBatches = this.purchaseBatches
    .filter(b => b.remainingQuantity > 0)
    .sort((a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate));

  for (const batch of sortedBatches) {
    if (remainingToReduce <= 0) break;

    const reduceFromBatch = Math.min(batch.remainingQuantity, remainingToReduce);
    batch.remainingQuantity -= reduceFromBatch;
    remainingToReduce -= reduceFromBatch;

    costDetails.push({
      batchId: batch._id,
      dispatchOrderId: batch.dispatchOrderId,
      supplierId: batch.supplierId,
      quantity: reduceFromBatch,
      costPrice: batch.costPrice,
      landedPrice: batch.landedPrice,
      totalCost: reduceFromBatch * batch.costPrice
    });

    totalCost += reduceFromBatch * batch.costPrice;
  }

  if (remainingToReduce > 0) {
    throw new Error(`Could not fulfill entire quantity from batches. Remaining: ${remainingToReduce}`);
  }

  // Add stock movement
  this.stockMovements.push({
    type: 'out',
    quantity: quantity,
    reference: reference,
    referenceId: referenceId,
    user: user,
    notes: notes,
    date: new Date()
  });

  this.currentStock -= quantity;
  this.lastStockUpdate = new Date();

  // Recalculate average cost price
  const totalValue = this.purchaseBatches.reduce((sum, batch) => {
    return sum + (batch.remainingQuantity * batch.costPrice);
  }, 0);
  const totalQuantity = this.purchaseBatches.reduce((sum, batch) => {
    return sum + batch.remainingQuantity;
  }, 0);
  this.averageCostPrice = totalQuantity > 0 ? totalValue / totalQuantity : this.averageCostPrice;

  return {
    save: () => this.save(),
    costDetails,
    totalCost,
    averageCostPerUnit: totalCost / quantity
  };
};

// Get available batches for return (shows where items came from)
inventorySchema.methods.getAvailableBatches = function() {
  return this.purchaseBatches
    .filter(b => b.remainingQuantity > 0)
    .sort((a, b) => new Date(a.purchaseDate) - new Date(b.purchaseDate))
    .map(batch => ({
      batchId: batch._id,
      dispatchOrderId: batch.dispatchOrderId,
      supplierId: batch.supplierId,
      purchaseDate: batch.purchaseDate,
      remainingQuantity: batch.remainingQuantity,
      costPrice: batch.costPrice,
      landedPrice: batch.landedPrice
    }));
};

// Get total available quantity across all batches
inventorySchema.methods.getTotalBatchQuantity = function() {
  return this.purchaseBatches.reduce((sum, batch) => sum + batch.remainingQuantity, 0);
};

// Performance indexes for frequently queried fields
inventorySchema.index({ isActive: 1 });
inventorySchema.index({ needsReorder: 1 });
inventorySchema.index({ currentStock: 1 });
inventorySchema.index({ isActive: 1, needsReorder: 1 });
inventorySchema.index({ updatedAt: -1 });
inventorySchema.index({ 'purchaseBatches.supplierId': 1 });
inventorySchema.index({ 'purchaseBatches.remainingQuantity': 1 });

module.exports = mongoose.model('Inventory', inventorySchema);