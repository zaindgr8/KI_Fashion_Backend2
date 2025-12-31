const mongoose = require('mongoose');

const boxSchema = new mongoose.Schema({
  boxNumber: { type: Number, required: true },
  itemsPerBox: { type: Number, required: false },
  weight: { type: Number, default: 0 }, // Weight in kg
  dimensions: {
    length: Number, // in cm
    width: Number,
    height: Number
  }
}, { _id: false });

const packetSchema = new mongoose.Schema({
  packetNumber: { type: Number, required: true },
  totalItems: { type: Number, required: true },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PacketTemplate'
  },
  composition: [{
    size: { type: String, required: true, trim: true },
    color: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 1 }
  }],
  isLoose: { type: Boolean, default: false }
}, { _id: false });

const dispatchItemSchema = new mongoose.Schema({
  // Product reference (for manual entries)
  product: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  // Product details (for supplier portal entries)
  productName: { type: String },
  productCode: { type: String },
  season: [{ type: String, enum: ['winter', 'summer', 'spring', 'autumn', 'all_season'] }],
  costPrice: { type: Number, min: 0 },
  primaryColor: [{ type: String }],
  size: [{ type: String }],
  material: { type: String },
  description: { type: String },
  productImage: { type: [String], default: [] }, // Array of image URLs or file paths
  quantity: { type: Number, required: true, min: 1 },
  boxes: [boxSchema], // Dynamic boxes configuration (for supplier portal entries)
  totalBoxes: { type: Number, default: 0 },
  unitWeight: { type: Number, default: 0 }, // Weight per item in kg
  totalWeight: { type: Number, default: 0 }, // Total weight for this item
  supplierPaymentAmount: { type: Number }, // Cost price × exchange rate (NO profit margin) - what admin pays supplier
  landedPrice: { type: Number }, // Cost price × exchange rate × (1 + profit%) - for inventory valuation
  landedTotal: { type: Number }, // For manual entries (product reference + landedTotal)
  notes: String,
  // Packet Management
  useVariantTracking: { type: Boolean, default: false },
  packets: [packetSchema]
}, { _id: true });

const dispatchOrderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  supplierUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User' // The user who created this order
  },
  logisticsCompany: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LogisticsCompany',
    required: false // Optional - only required for supplier portal entries
  },
  exchangeRate: { type: Number, default: 1.0 }, // EUR to GBP exchange rate
  percentage: { type: Number, default: 0 }, // Percentage markup/adjustment
  items: [dispatchItemSchema],
  totalQuantity: { type: Number, default: 0 }, // Made optional with default (calculated in pre-save)
  totalBoxes: { type: Number, default: 0 }, // Made optional with default (calculated in pre-save)
  totalWeight: { type: Number, default: 0 }, // Total weight of entire order
  estimatedCost: { type: Number, default: 0 }, // Estimated logistics cost
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'picked_up', 'in_transit', 'delivered', 'cancelled'],
    default: 'pending',
    index: true
  },
  confirmedAt: Date,
  confirmedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paymentDetails: {
    cashPayment: { type: Number, default: 0 },
    bankPayment: { type: Number, default: 0 },
    creditApplied: { type: Number, default: 0 }, // Credit automatically applied from supplier's debt to admin
    remainingBalance: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ['pending', 'partial', 'paid'],
      default: 'pending'
    }
  },
  confirmedQuantities: [{
    itemIndex: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 0 }
  }],
  returnedItems: [{
    itemIndex: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 0 },
    reason: { type: String },
    returnedAt: { type: Date, default: Date.now },
    returnedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  dispatchDate: Date,
  expectedDeliveryDate: Date,
  actualDeliveryDate: Date,
  trackingInfo: {
    trackingNumber: String,
    carrier: String,
    updates: [{
      status: String,
      location: String,
      timestamp: Date,
      notes: String
    }]
  },
  pickupAddress: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: { type: String, default: 'Pakistan' },
    contactPerson: String,
    contactPhone: String,
    contactPhoneAreaCode: {
      type: String,
      trim: true,
      maxlength: 5
    }
  },
  deliveryAddress: {
    street: String,
    city: String,
    state: String,
    zipCode: String,
    country: { type: String, default: 'Pakistan' },
    contactPerson: String,
    contactPhone: String,
    contactPhoneAreaCode: {
      type: String,
      trim: true,
      maxlength: 5
    }
  },
  specialInstructions: String,
  notes: String,
  // Purchase-specific fields (for manual entries)
  invoiceNumber: { type: String, trim: true },
  paymentTerms: {
    type: String,
    enum: ['cash', 'net15', 'net30', 'net45', 'net60'],
    default: 'net30'
  },
  dueDate: Date,
  // Financial fields (for manual entries)
  subtotal: { type: Number, default: 0, min: 0 },
  totalTax: { type: Number, default: 0, min: 0 },
  totalDiscount: { type: Number, default: 0, min: 0 },
  shippingCost: { type: Number, default: 0, min: 0 },
  supplierPaymentTotal: { type: Number, default: 0, min: 0 }, // Total amount to pay supplier (cost × exchange rate, NO profit)
  grandTotal: { type: Number, default: 0, min: 0 }, // Landed total (for inventory valuation)
  // Flat payment fields (in addition to nested paymentDetails)
  cashPayment: { type: Number, default: 0, min: 0 },
  bankPayment: { type: Number, default: 0, min: 0 },
  remainingBalance: { type: Number, default: 0 },
  paymentStatus: {
    type: String,
    enum: ['pending', 'partial', 'paid', 'overdue'],
    default: 'pending'
  },
  // Quality checks, fulfillment, delivery confirmations, attachments
  qualityChecks: [{
    qaStatus: {
      type: String,
      enum: ['pass', 'fail'],
      required: true
    },
    notes: String,
    checkedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    checkedAt: {
      type: Date,
      default: Date.now
    }
  }],
  fulfillment: {
    status: {
      type: String,
      enum: ['pending', 'ready', 'shipped', 'delivered'],
      default: 'pending'
    },
    carrier: String,
    trackingNumber: String,
    shipmentDate: Date,
    dispatchedAt: Date,
    notes: String,
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    updatedAt: Date,
    history: [{
      status: {
        type: String,
        enum: ['pending', 'ready', 'shipped', 'delivered']
      },
      carrier: String,
      trackingNumber: String,
      shipmentDate: Date,
      notes: String,
      updatedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      updatedAt: {
        type: Date,
        default: Date.now
      }
    }]
  },
  deliveryConfirmations: [{
    confirmedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    confirmedAt: {
      type: Date,
      default: Date.now
    },
    notes: String,
    receivedBy: String,
    discrepancies: String
  }],
  attachments: [String],
  qrCode: {
    dataUrl: String,
    payload: {
      type: Object,
      default: {}
    },
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
  timestamps: true,
  optimisticConcurrency: true  // Enable optimistic locking for concurrent payment handling
});

// Indexes for performance optimization
dispatchOrderSchema.index({ supplierUser: 1, status: 1 }); // For filtering manual vs dispatch
dispatchOrderSchema.index({ dispatchDate: -1, createdAt: -1 }); // For sorting
dispatchOrderSchema.index({ 'paymentDetails.paymentStatus': 1 }); // For payment filtering
dispatchOrderSchema.index({ supplier: 1, status: 1 }); // For supplier filtering

// Auto-generate order number before saving
dispatchOrderSchema.pre('save', async function (next) {
  if (!this.orderNumber) {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');

    const datePrefix = `DSP${year}${month}${day}`;

    // Find the highest existing number for today
    const existingOrders = await this.constructor.find({
      orderNumber: { $regex: `^${datePrefix}` }
    }).select('orderNumber');

    const todayNumbers = existingOrders
      .map(order => parseInt(order.orderNumber.slice(-4)) || 0)
      .sort((a, b) => b - a);

    const nextSequence = (todayNumbers[0] || 0) + 1;
    this.orderNumber = `${datePrefix}${String(nextSequence).padStart(4, '0')}`;
  }
  next();
});

// Calculate totals before saving
dispatchOrderSchema.pre('save', function (next) {
  this.totalQuantity = this.items.reduce((sum, item) => sum + item.quantity, 0);
  // Only recalculate totalBoxes if not already set (Supplier Portal sets it explicitly)
  const calculatedBoxes = this.items.reduce((sum, item) => sum + (item.totalBoxes || 0), 0);
  if (!this.totalBoxes || this.totalBoxes === 0) {
    this.totalBoxes = calculatedBoxes;
  }
  // If calculated is greater than current (items were added), update
  if (calculatedBoxes > this.totalBoxes) {
    this.totalBoxes = calculatedBoxes;
  }
  this.totalWeight = this.items.reduce((sum, item) => sum + item.totalWeight, 0);

  // Calculate dueDate from paymentTerms if not set
  if (this.paymentTerms && this.dispatchDate && !this.dueDate) {
    const days = {
      'cash': 0,
      'net15': 15,
      'net30': 30,
      'net45': 45,
      'net60': 60
    };
    if (days[this.paymentTerms] !== undefined) {
      this.dueDate = new Date(this.dispatchDate.getTime() + (days[this.paymentTerms] * 24 * 60 * 60 * 1000));
    }
  }

  next();
});

module.exports = mongoose.model('DispatchOrder', dispatchOrderSchema);
