const mongoose = require('mongoose');

const packetTemplateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  productType: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ProductType',
    required: true
  },
  totalItemsPerPacket: {
    type: Number,
    required: true,
    min: 1
  },
  composition: [{
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
      min: 1
    }
  }],
  description: {
    type: String,
    trim: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    default: null  // null for admin/global templates
  },
  isGlobal: {
    type: Boolean,
    default: false  // true for admin templates, false for supplier templates
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

// Validate that composition quantities sum to totalItemsPerPacket
packetTemplateSchema.pre('save', function(next) {
  const totalComposition = this.composition.reduce((sum, item) => sum + item.quantity, 0);
  if (totalComposition !== this.totalItemsPerPacket) {
    return next(new Error(`Composition total (${totalComposition}) must equal totalItemsPerPacket (${this.totalItemsPerPacket})`));
  }
  next();
});

module.exports = mongoose.model('PacketTemplate', packetTemplateSchema);

