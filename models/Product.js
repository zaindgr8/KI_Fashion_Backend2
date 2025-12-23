const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  sku: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
  },
  description: {
    type: String,
    trim: true
  },
  productType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProductType',
    required: true
  },
  category: {
    type: String,
    required: true,
    trim: true,
    index: true
  },
  brand: {
    type: String,
    trim: true,
    index: true
  },
  color: {
    type: String,
    trim: true
  },
  size: {
    type: String,
    trim: true
  },
  productCode: {
    type: String,
    trim: true,
    index: true
  },
  unit: {
    type: String,
    enum: ['piece', 'kg', 'g', 'liter', 'ml', 'meter', 'cm', 'dozen', 'box', 'pack'],
    default: 'piece'
  },
  pricing: {
    costPrice: {
      type: Number,
      required: true,
      min: 0
    },
    sellingPrice: {
      type: Number,
      required: true,
      min: 0
    },
    wholesalePrice: {
      type: Number,
      min: 0
    },
    minSellingPrice: {
      type: Number,
      min: 0
    }
  },
  inventory: {
    currentStock: {
      type: Number,
      default: 0,
      min: 0
    },
    minStockLevel: {
      type: Number,
      default: 0
    },
    maxStockLevel: {
      type: Number,
      default: 1000
    },
    reorderLevel: {
      type: Number,
      default: 10
    }
  },
  suppliers: [{
    supplier: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Supplier'
    },
    supplierPrice: Number,
    isPrimary: { type: Boolean, default: false }
  }],
  specifications: {
    weight: Number,
    dimensions: {
      length: Number,
      width: Number,
      height: Number
    },
    color: String,
    material: String
  },
  images: [String],
  barcode: { type: String, index: true },
  qrCode: {
    dataUrl: String,
    payload: mongoose.Schema.Types.Mixed,
    generatedAt: Date,
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  taxRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  variantTracking: {
    enabled: {
      type: Boolean,
      default: false
    },
    availableSizes: [{
      type: String,
      trim: true
    }],
    availableColors: [{
      type: String,
      trim: true
    }],
    variants: [{
      size: {
        type: String,
        trim: true
      },
      color: {
        type: String,
        trim: true
      },
      sku: {
        type: String,
        trim: true,
        uppercase: true
      },
      currentStock: {
        type: Number,
        default: 0,
        min: 0
      }
    }]
  },
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

productSchema.virtual('profit').get(function () {
  return this.pricing.sellingPrice - this.pricing.costPrice;
});

productSchema.virtual('profitMargin').get(function () {
  return this.pricing.costPrice > 0 ? ((this.pricing.sellingPrice - this.pricing.costPrice) / this.pricing.costPrice) * 100 : 0;
});

// Virtual for primary image (first image only) - reduces payload for list views
productSchema.virtual('primaryImage').get(function () {
  return this.images && this.images.length > 0 ? this.images[0] : null;
});

// Performance indexes for frequently queried fields
productSchema.index({ productType: 1, isActive: 1 });
productSchema.index({ sku: 1, isActive: 1 });
productSchema.index({ isActive: 1, createdAt: -1 });
productSchema.index({ 'suppliers.supplier': 1 });

module.exports = mongoose.model('Product', productSchema);