const mongoose = require('mongoose');

const logisticsCompanySchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  code: {
    type: String,
    unique: true,
    sparse: true,
    uppercase: true
  },
  contactInfo: {
    phone: String,
    phoneAreaCode: {
      type: String,
      trim: true,
      maxlength: 5
    },
    email: String,
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: { type: String, default: 'Pakistan' }
    }
  },
  serviceAreas: [{
    city: String,
    state: String,
    deliveryDays: Number // Expected delivery days for this area
  }],
  rates: {
    perKg: { type: Number, default: 0 },
    baseRate: { type: Number, default: 0 },
    expressRate: { type: Number, default: 0 },
    boxRate: { type: Number, default: 0 }, // Rate per box for payment calculation
    currency: { type: String, default: 'PKR' }
  },
  isActive: {
    type: Boolean,
    default: true
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  notes: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Auto-generate code before saving
logisticsCompanySchema.pre('save', async function(next) {
  if (!this.code) {
    const count = await this.constructor.countDocuments();
    this.code = `LOG${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('LogisticsCompany', logisticsCompanySchema);
