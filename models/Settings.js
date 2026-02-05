const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  // There should only be one settings document
  _id: {
    type: String,
    default: 'system_settings'
  },
  
  // Tax Settings
  vat: {
    enabled: {
      type: Boolean,
      default: true
    },
    rate: {
      type: Number,
      default: 20.0, // 20% default VAT
      min: 0,
      max: 100
    }
  },
  
  // Shipping Settings
  shipping: {
    freeShippingEnabled: {
      type: Boolean,
      default: true
    },
    freeShippingThreshold: {
      type: Number,
      default: 0
    },
    flatRate: {
      type: Number,
      default: 0
    }
  },
  
  // Currency Settings
  currency: {
    code: {
      type: String,
      default: 'GBP'
    },
    symbol: {
      type: String,
      default: '£'
    }
  },
  
  // Payment Settings
  payment: {
    stripeEnabled: {
      type: Boolean,
      default: true
    },
    cashOnDeliveryEnabled: {
      type: Boolean,
      default: false
    }
  },
  
  // Business Information
  businessInfo: {
    name: {
      type: String,
      default: 'KI Fashion'
    },
    taxNumber: {
      type: String
    },
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    },
    phone: String,
    email: String
  },
  
  // Last updated tracking
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Ensure only one settings document exists
settingsSchema.statics.getSettings = async function() {
  let settings = await this.findById('system_settings');
  if (!settings) {
    settings = await this.create({ _id: 'system_settings' });
  }
  return settings;
};

// Update settings (always updates the single document)
settingsSchema.statics.updateSettings = async function(updates, userId) {
  let settings = await this.findById('system_settings');
  if (!settings) {
    settings = await this.create({ _id: 'system_settings', ...updates, updatedBy: userId });
  } else {
    Object.assign(settings, updates);
    settings.updatedBy = userId;
    await settings.save();
  }
  return settings;
};

module.exports = mongoose.model('Settings', settingsSchema);
