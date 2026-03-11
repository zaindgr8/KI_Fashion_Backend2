const mongoose = require('mongoose');

const supplierPaymentDistributionSchema = new mongoose.Schema({
  dispatchOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'DispatchOrder'
  },
  orderNumber: String,
  amountApplied: {
    type: Number,
    required: true,
    min: 0
  },
  previousBalance: {
    type: Number,
    default: 0
  },
  newBalance: {
    type: Number,
    default: 0
  },
  ledgerEntryId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ledger'
  },
  isAdvance: {
    type: Boolean,
    default: false
  }
}, { _id: false });

const supplierPaymentReceiptSchema = new mongoose.Schema({
  receiptNumber: {
    type: String,
    unique: true,
    index: true,
    required: true
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier',
    required: true,
    index: true
  },
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },
  cashAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  bankAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  paymentMethodSummary: {
    type: String,
    trim: true,
    default: 'cash'
  },
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  notes: {
    type: String,
    trim: true
  },
  distributions: [supplierPaymentDistributionSchema],
  advanceAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  ordersAffected: {
    type: Number,
    default: 0,
    min: 0
  },
  balanceBefore: {
    type: Number,
    required: true
  },
  balanceAfter: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'reversed'],
    default: 'active'
  },
  reversalInfo: {
    reversedAt: Date,
    reversedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    reason: String,
    reversalLedgerEntries: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger'
    }]
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

supplierPaymentReceiptSchema.index({ supplierId: 1, paymentDate: -1 });
supplierPaymentReceiptSchema.index({ status: 1 });
supplierPaymentReceiptSchema.index({ createdAt: -1 });

supplierPaymentReceiptSchema.statics.getNextReceiptNumber = async function(session = null) {
  try {
    const countersCollection = mongoose.connection.db.collection('counters');
    const options = {
      upsert: true,
      returnDocument: 'after'
    };

    if (session) {
      options.session = session;
    }

    const counter = await countersCollection.findOneAndUpdate(
      { _id: 'supplierPaymentReceiptNumber' },
      { $inc: { seq: 1 } },
      options
    );

    const seq = counter.value?.seq || counter.seq || 1;
    return `SPR-${String(seq).padStart(6, '0')}`;
  } catch (error) {
    console.warn('Counter collection access failed for supplier receipt number, falling back to max receiptNumber:', error.message);

    let query = this.findOne().sort({ receiptNumber: -1 }).select('receiptNumber');
    if (session) {
      query = query.session(session);
    }

    const lastReceipt = await query;
    let lastNumber = 0;

    if (lastReceipt?.receiptNumber) {
      const match = lastReceipt.receiptNumber.match(/SPR-(\d+)/);
      if (match) {
        lastNumber = parseInt(match[1], 10);
      }
    }

    return `SPR-${String(lastNumber + 1).padStart(6, '0')}`;
  }
};

supplierPaymentReceiptSchema.statics.getSupplierReceipts = async function(supplierId, options = {}) {
  const { limit = 50, offset = 0 } = options;
  return this.find({ supplierId })
    .sort({ paymentDate: -1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .populate('supplierId', 'name company supplierId legacyId')
    .populate('createdBy', 'name')
    .lean();
};

supplierPaymentReceiptSchema.statics.getByReceiptNumber = async function(receiptNumber) {
  return this.findOne({ receiptNumber })
    .populate('supplierId', 'name company email phone address supplierId legacyId')
    .populate('createdBy', 'name')
    .populate('distributions.dispatchOrderId', 'orderNumber supplierPaymentTotal confirmedAt createdAt')
    .populate('distributions.ledgerEntryId', 'entryNumber date paymentMethod createdAt')
    .lean();
};

module.exports = mongoose.models.SupplierPaymentReceipt || mongoose.model('SupplierPaymentReceipt', supplierPaymentReceiptSchema);
