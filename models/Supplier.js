const mongoose = require('mongoose');

const supplierSchema = new mongoose.Schema({
  supplierId: {
    type: String,
    unique: true,
    sparse: true
  },
  name: {
    type: String,
    required: true
  },
  company: String,
  email: String,
  phone: {
    type: String,
    required: true
  },
  phoneAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  alternatePhone: String,
  alternatePhoneAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: {
      type: String,
      default: 'Pakistan'
    }
  },
  taxNumber: String,
  paymentTerms: {
    type: String,
    enum: ['cash', 'net15', 'net30', 'net45', 'net60'],
    default: 'net30'
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  notes: String,
  supplierType: {
    type: String,
    enum: ['wholesale', 'retail', 'manufacturer', 'distributor'],
    default: 'wholesale'
  },
  discountRate: {
    type: Number,
    default: 0
  },
  // DEPRECATED: currentBalance is kept for backward compatibility.
  // All balance calculations should use BalanceService.getSupplierBalance() (SSOT from Ledger).
  // This field will be removed in a future version after migration is complete.
  currentBalance: {
    type: Number,
    default: 0
  }, // DEPRECATED: Use BalanceService.getSupplierBalance()
  isActive: {
    type: Boolean,
    default: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    index: true
  }
}, {
  timestamps: true,
  optimisticConcurrency: true,  // Enable optimistic locking for concurrent payment handling
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Generate supplier ID before saving
supplierSchema.pre('save', async function(next) {
  if (!this.supplierId) {
    // Find the highest existing supplierId
    const lastSupplier = await this.constructor.findOne({
      supplierId: { $regex: /^SUP\d{6}$/ }
    }).sort({ supplierId: -1 });
    
    let nextNumber = 1;
    if (lastSupplier && lastSupplier.supplierId) {
      const lastNumber = parseInt(lastSupplier.supplierId.slice(3)) || 0;
      nextNumber = lastNumber + 1;
    }
    
    this.supplierId = `SUP${String(nextNumber).padStart(6, '0')}`;
  }
  next();
});

// Virtual for balance calculation
supplierSchema.virtual('balance').get(function() {
  return this.currentBalance || 0;
});

// Performance indexes for frequently queried fields
supplierSchema.index({ isActive: 1 });
supplierSchema.index({ supplierType: 1 });
supplierSchema.index({ createdAt: -1 });
supplierSchema.index({ email: 1 });
supplierSchema.index({ createdBy: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);