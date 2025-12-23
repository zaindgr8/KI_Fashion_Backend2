const mongoose = require('mongoose');

const deliveryPersonnelSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  employeeId: {
    type: String,
    required: true,
    unique: true,
    uppercase: true
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
  email: {
    type: String,
    lowercase: true,
    trim: true
  },
  address: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: { type: String, default: 'Pakistan' }
  },
  licenseNumber: {
    type: String,
    trim: true
  },
  licenseExpiry: {
    type: Date
  },
  vehicleInfo: {
    type: String,
    model: String,
    plateNumber: String,
    capacity: Number
  },
  salary: {
    type: Number,
    default: 0
  },
  commissionRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  workingAreas: [String],
  emergencyContact: {
    name: String,
    phone: String,
    phoneAreaCode: {
      type: String,
      trim: true,
      maxlength: 5
    },
    relation: String
  },
  totalDeliveries: {
    type: Number,
    default: 0
  },
  successfulDeliveries: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: 5
  },
  isActive: {
    type: Boolean,
    default: true
  },
  joiningDate: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

deliveryPersonnelSchema.virtual('successRate').get(function() {
  return this.totalDeliveries > 0 ? (this.successfulDeliveries / this.totalDeliveries) * 100 : 0;
});

module.exports = mongoose.model('DeliveryPersonnel', deliveryPersonnelSchema);