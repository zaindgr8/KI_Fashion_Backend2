const mongoose = require('mongoose');

/**
 * Payment Model - Tracks customer/buyer payment receipts
 * 
 * This model serves as a parent record for payment transactions, enabling:
 * - Payment receipt generation with unique payment numbers
 * - Tracking of how payment was distributed across multiple sales
 * - Payment reversal (void) functionality
 * - Audit trail for all payment operations
 * 
 * Each Payment record links to multiple Ledger entries that represent
 * the actual distribution of funds across sales.
 */
const paymentSchema = new mongoose.Schema({
  // Simple sequential payment number: PAY-000001
  paymentNumber: {
    type: String,
    unique: true,
    index: true,
    required: true
  },

  // Payment type: 'customer' for buyer payments, 'supplier' for supplier payments
  paymentType: {
    type: String,
    enum: ['customer', 'supplier'],
    default: 'customer',
    required: true
  },

  // Payment direction: 'credit' = customer pays us, 'debit' = we owe customer (refund/adjustment)
  paymentDirection: {
    type: String,
    enum: ['credit', 'debit'],
    default: 'credit',
    required: true
  },

  // Reason for debit transactions (required when paymentDirection is 'debit')
  debitReason: {
    type: String,
    enum: ['refund', 'credit_note', 'price_adjustment', 'goodwill', 'other'],
    required: function() { return this.paymentDirection === 'debit'; }
  },

  // Reference to the customer/buyer
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer',
    required: true
  },

  // Total payment amount received
  totalAmount: {
    type: Number,
    required: true,
    min: 0
  },

  // Breakdown by payment method
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

  // Primary payment method (cash or bank)
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank'],
    required: true
  },

  // Date the payment was received
  paymentDate: {
    type: Date,
    required: true,
    default: Date.now
  },

  // Optional description/notes
  description: {
    type: String,
    trim: true
  },

  // Distribution details - how payment was applied
  distributions: [{
    saleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Sale'
    },
    saleNumber: String,
    amountApplied: {
      type: Number,
      required: true,
      min: 0
    },
    previousBalance: Number,
    newBalance: Number,
    ledgerEntryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Ledger'
    },
    isAdvance: {
      type: Boolean,
      default: false
    }
  }],

  // Amount that went to advance/credit (no pending sales)
  advanceAmount: {
    type: Number,
    default: 0,
    min: 0
  },

  // Customer balance before and after payment
  balanceBefore: {
    type: Number,
    required: true
  },

  balanceAfter: {
    type: Number,
    required: true
  },

  // Payment status
  status: {
    type: String,
    enum: ['active', 'reversed', 'partially_reversed'],
    default: 'active'
  },

  // Reversal information (if reversed)
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

  // Who created this payment
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Indexes for efficient queries
paymentSchema.index({ customerId: 1, paymentDate: -1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ paymentType: 1 });
paymentSchema.index({ createdAt: -1 });

/**
 * Get next payment number atomically using counter collection
 */
paymentSchema.statics.getNextPaymentNumber = async function(session = null) {
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
      { _id: 'paymentNumber' },
      { $inc: { seq: 1 } },
      options
    );
    
    const seq = counter.value?.seq || counter.seq || 1;
    return `PAY-${String(seq).padStart(6, '0')}`;
  } catch (error) {
    console.warn('Counter collection access failed, falling back to max paymentNumber:', error.message);
    
    let query = this.findOne().sort({ paymentNumber: -1 }).select('paymentNumber');
    if (session) {
      query = query.session(session);
    }
    
    const lastPayment = await query;
    let lastNumber = 0;
    
    if (lastPayment?.paymentNumber) {
      const match = lastPayment.paymentNumber.match(/PAY-(\d+)/);
      if (match) {
        lastNumber = parseInt(match[1], 10);
      }
    }
    
    return `PAY-${String(lastNumber + 1).padStart(6, '0')}`;
  }
};

/**
 * Get payments for a specific customer
 */
paymentSchema.statics.getCustomerPayments = async function(customerId, options = {}) {
  const { limit = 50, offset = 0, status = 'active' } = options;
  
  const query = { customerId };
  if (status && status !== 'all') {
    query.status = status;
  }
  
  return await this.find(query)
    .sort({ paymentDate: -1, createdAt: -1 })
    .skip(offset)
    .limit(limit)
    .populate('createdBy', 'name')
    .populate('reversalInfo.reversedBy', 'name')
    .lean();
};

/**
 * Get payment by payment number
 */
paymentSchema.statics.getByPaymentNumber = async function(paymentNumber) {
  return await this.findOne({ paymentNumber })
    .populate('customerId', 'name company email phone')
    .populate('createdBy', 'name')
    .populate('reversalInfo.reversedBy', 'name')
    .lean();
};

module.exports = mongoose.model('Payment', paymentSchema);
