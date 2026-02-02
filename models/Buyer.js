const mongoose = require('mongoose');

const buyerSchema = new mongoose.Schema({
  buyerId: {
    type: String,
    unique: true,
    sparse: true
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  company: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    trim: true
  },
  phoneAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  alternatePhone: {
    type: String,
    trim: true
  },
  alternatePhoneAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  landline: {
    type: String,
    trim: true
  },
  landlineAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  contactPerson: {
    type: String,
    trim: true
  },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: { type: String, default: 'Pakistan' }
  },
  taxNumber: {
    type: String,
    trim: true
  },
  paymentTerms: {
    type: String,
    enum: ['cash', 'net15', 'net30', 'net45', 'net60'],
    default: 'cash'
  },
  creditLimit: {
    type: Number,
    default: 0
  },
  // DEPRECATED: currentBalance is kept for backward compatibility.
  // All balance calculations should use BalanceService.getBuyerBalance() (SSOT from Ledger).
  // This field will be removed in a future version after migration is complete.
  currentBalance: {
    type: Number,
    default: 0
  }, // DEPRECATED: Use BalanceService.getBuyerBalance()
  totalSales: {
    type: Number,
    default: 0
  },
  discountRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  customerType: {
    type: String,
    enum: ['retail', 'wholesale', 'distributor'],
    default: 'retail'
  },
  notes: {
    type: String,
    trim: true
  },
  isActive: {
    type: Boolean,
    default: true
  },
  deliveryAddresses: [{
    label: {
      type: String,
      trim: true,
      default: 'Home'
    },
    street: {
      type: String,
      trim: true
    },
    city: {
      type: String,
      trim: true
    },
    state: {
      type: String,
      trim: true
    },
    zipCode: {
      type: String,
      trim: true
    },
    country: {
      type: String,
      default: 'Pakistan'
    },
    phone: {
      type: String,
      trim: true
    },
    phoneAreaCode: {
      type: String,
      trim: true,
      maxlength: 5
    },
    isDefault: {
      type: Boolean,
      default: false
    }
  }],
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  // Metadata for migration tracking and verification
  metadata: {
    isMigrated: {
      type: Boolean,
      default: false
    },
    migratedAt: {
      type: Date
    },
    requiresVerification: {
      type: Boolean,
      default: false
    },
    needsContactUpdate: {
      type: Boolean,
      default: false
    },
    verifiedAt: {
      type: Date
    },
    legacyId: {
      type: String,
      trim: true
    }
  }
}, {
  timestamps: true
});

// Performance indexes for frequently queried fields
buyerSchema.index({ email: 1 });
buyerSchema.index({ isActive: 1 });
buyerSchema.index({ customerType: 1, isActive: 1 });
buyerSchema.index({ 'address.city': 1 });
buyerSchema.index({ createdAt: -1 });
buyerSchema.index({ createdBy: 1 });

// Indexes for migration tracking
buyerSchema.index({ 'metadata.isMigrated': 1 });
buyerSchema.index({ 'metadata.requiresVerification': 1 });
buyerSchema.index({ 'metadata.needsContactUpdate': 1 });
buyerSchema.index({ 'metadata.isMigrated': 1, 'metadata.needsContactUpdate': 1 }); // Compound index for admin queries

module.exports = mongoose.model('Buyer', buyerSchema);