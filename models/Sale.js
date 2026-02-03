const mongoose = require('mongoose');

const saleSchema = new mongoose.Schema({
  saleNumber: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: false,
    index: true
  },
  manualCustomer: {
    name: {
      type: String,
      required: function () {
        return !this.buyer;
      },
      trim: true
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
      country: String
    }
  },
  isManualSale: {
    type: Boolean,
    default: false
  },
  saleDate: {
    type: Date,
    required: true,
    default: Date.now,
    index: true
  },
  deliveryDate: {
    type: Date
  },
  deliveryAddress: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: String
  },
  deliveryPersonnel: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DeliveryPersonnel'
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    unitPrice: {
      type: Number,
      required: true,
      min: 0
    },
    discount: {
      type: Number,
      default: 0,
      min: 0
    },
    taxRate: {
      type: Number,
      default: 0,
      min: 0
    },
    totalPrice: {
      type: Number,
      required: true
    },
    variant: {
      size: {
        type: String,
        trim: true
      },
      color: {
        type: String,
        trim: true
      }
    },
    // Packet-based selling fields
    packetStock: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PacketStock'
    },
    isPacketSale: {
      type: Boolean,
      default: false
    },
    packetBarcode: {
      type: String,
      trim: true
    },
    packetComposition: [{
      size: String,
      color: String,
      quantity: Number
    }],
    totalItemsPerPacket: {
      type: Number,
      min: 1
    }
  }],
  subtotal: {
    type: Number,
    required: true,
    min: 0
  },
  totalDiscount: {
    type: Number,
    default: 0,
    min: 0
  },
  totalTax: {
    type: Number,
    default: 0,
    min: 0
  },
  totalVAT: {
    type: Number,
    default: 0,
    min: 0
  },
  vatRate: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  shippingCost: {
    type: Number,
    default: 0,
    min: 0
  },
  grandTotal: {
    type: Number,
    required: true,
    min: 0
  },
  cashPayment: {
    type: Number,
    default: 0,
    min: 0
  },
  bankPayment: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'refunded', 'awaiting_payment', 'failed'],
    default: 'pending',
    index: true
  },
  paymentMethod: {
    type: String,
    enum: ['cash', 'card', 'bank_transfer', 'cheque', 'online', 'credit', 'stripe']
  },
  // Stripe payment fields
  stripeSessionId: {
    type: String,
    index: true
  },
  stripePaymentIntentId: {
    type: String,
    index: true
  },
  // Stock reservation tracking
  stockReserved: {
    type: Boolean,
    default: false
  },
  reservationExpiresAt: {
    type: Date,
    index: true
  },
  deliveryStatus: {
    type: String,
    enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'],
    default: 'pending'
  },
  saleType: {
    type: String,
    enum: ['retail', 'wholesale', 'bulk'],
    default: 'retail'
  },
  invoiceNumber: {
    type: String,
    trim: true
  },
  receiptNumber: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  attachments: [String],
  qrCode: {
    dataUrl: String,
    payload: mongoose.Schema.Types.Mixed,
    generatedAt: Date,
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  invoicePdf: {
    url: String,
    generatedAt: Date,
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

saleSchema.virtual('profit').get(function () {
  let totalCost = 0;
  this.items.forEach(item => {
    if (item.product && item.product.pricing) {
      totalCost += item.quantity * item.product.pricing.costPrice;
    }
  });
  return this.grandTotal - totalCost;
});

module.exports = mongoose.model('Sale', saleSchema);