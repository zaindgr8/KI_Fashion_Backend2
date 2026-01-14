const mongoose = require('mongoose');

const ledgerSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['supplier', 'buyer', 'logistics'],
    required: true
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    refPath: 'entityModel'
  },
  entityModel: {
    type: String,
    required: true,
    enum: ['Supplier', 'Buyer', 'LogisticsCompany']
  },
  transactionType: {
    type: String,
    enum: ['purchase', 'payment', 'sale', 'receipt', 'adjustment', 'return', 'charge', 'credit_application'],
    required: true
  },
  referenceId: {
    type: mongoose.Schema.Types.ObjectId
  },
  referenceModel: {
    type: String,
    enum: ['Purchase', 'Sale', 'Payment', 'Receipt', 'DispatchOrder', 'Return', 'SaleReturn']
  },
  debit: {
    type: Number,
    default: 0,
    min: 0
  },
  credit: {
    type: Number,
    default: 0,
    min: 0
  },
  // DEPRECATED: Running balance is kept for backward compatibility.
  // All balance calculations should use Ledger.getBalance() static method (aggregation-based).
  // This field will be removed in a future version after migration is complete.
  balance: {
    type: Number,
    default: 0
  }, // DEPRECATED: Use Ledger.getBalance() static method instead
  date: {
    type: Date,
    required: true,
    default: Date.now
  },
  description: {
    type: String,
    trim: true
  },
  remarks: String,
  paymentMethod: {
    type: String,
    enum: ['cash', 'bank'],
    required: false,
    // No default - when omitted, field will be undefined (Mongoose enum skips validation for undefined)
    // This makes the field optional: only payment entries need it, purchase entries can omit it
    // Future transaction types can optionally include payment method without breaking existing code
  },
  // DEPRECATED: paymentDetails.remainingBalance is redundant with calculated values.
  // Use Ledger.getOrderPayments() for payment totals per order.
  paymentDetails: {
    cashPayment: { type: Number, default: 0 }, // Keep for individual entry tracking
    bankPayment: { type: Number, default: 0 }, // Keep for individual entry tracking
    remainingBalance: { type: Number, default: 0 } // DEPRECATED: Calculate from aggregation
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  entryNumber: {
    type: String,
    unique: true,
    index: true,
    sparse: true // Allow null/undefined for existing entries during migration
  }
}, {
  timestamps: true
});

// =====================================================
// INDEXES - Optimized for aggregation queries (SSOT refactor)
// =====================================================

// Primary index for entity balance queries (most common use case)
ledgerSchema.index({ entityId: 1, date: -1 });
ledgerSchema.index({ type: 1, entityId: 1 });

// Compound index for entity balance aggregation (covers 90% of queries)
// Used by: getBalance, getSupplierDashboardStats, etc.
ledgerSchema.index({ type: 1, entityId: 1, transactionType: 1, date: -1 });

// Index for order-specific payment lookups
// Used by: getOrderPayments, enrichOrderWithPaymentStatus
ledgerSchema.index({ referenceId: 1, referenceModel: 1, transactionType: 1 });

// Index for payment method aggregations  
// Used by: Dashboard stats for cash/bank payment totals
ledgerSchema.index({ type: 1, entityId: 1, transactionType: 1, paymentMethod: 1 });

// Legacy performance indexes (kept for backward compatibility)
ledgerSchema.index({
  type: 1,
  entityId: 1,
  referenceModel: 1,
  referenceId: 1,
  transactionType: 1
});

// Index for getting latest balance efficiently
ledgerSchema.index({
  type: 1,
  entityId: 1,
  date: -1,
  createdAt: -1
});

// Explicit index for entryNumber (unique index already created via schema, but explicit is good)
ledgerSchema.index({ entryNumber: 1 });

// =====================================================
// ENTRY NUMBER GENERATION - Atomic Counter
// =====================================================

/**
 * Get next entry number atomically using counter collection
 * Uses MongoDB's findOneAndUpdate with $inc for atomic increment
 * This prevents race conditions when multiple entries are created simultaneously
 */
ledgerSchema.statics.getNextEntryNumber = async function (session = null) {
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
      { _id: 'ledgerEntryNumber' },
      { $inc: { seq: 1 } },
      options
    );
    
    return counter.value.seq;
  } catch (error) {
    // Fallback: if counter collection fails, find max entryNumber
    console.warn('Counter collection access failed, falling back to max entryNumber:', error.message);
    
    let query = this.findOne().sort({ entryNumber: -1 }).select('entryNumber');
    if (session) {
      query = query.session(session);
    }
    
    const lastEntry = await query;
    const lastNumber = lastEntry?.entryNumber ? parseInt(lastEntry.entryNumber) : 0;
    return lastNumber + 1;
  }
};

// Pre-save hook to auto-generate entryNumber for new entries
ledgerSchema.pre('save', async function (next) {
  // Only generate entryNumber if it doesn't exist
  if (!this.entryNumber) {
    try {
      // Access session from the save options if available
      // When save({ session }) is called, the session is available via this.$session()
      let session = null;
      if (typeof this.$session === 'function') {
        session = this.$session();
      } else if (this.$session) {
        session = this.$session;
      }
      
      const nextNumber = await this.constructor.getNextEntryNumber(session);
      this.entryNumber = String(nextNumber).padStart(7, '0');
    } catch (error) {
      // If generation fails, try one more time with retry logic
      console.warn('Entry number generation failed, retrying:', error.message);
      try {
        let session = null;
        if (typeof this.$session === 'function') {
          session = this.$session();
        } else if (this.$session) {
          session = this.$session;
        }
        const nextNumber = await this.constructor.getNextEntryNumber(session);
        this.entryNumber = String(nextNumber).padStart(7, '0');
      } catch (retryError) {
        return next(new Error(`Failed to generate entry number: ${retryError.message}`));
      }
    }
  }
  next();
});

ledgerSchema.statics.createEntry = async function (entryData, session = null) {
  // Validate entryData
  if (!entryData || !entryData.type || !entryData.entityId) {
    throw new Error('Invalid entryData: type and entityId are required');
  }

  const entryDate = entryData.date ? new Date(entryData.date) : new Date();

  // Find the entry that immediately precedes this new one in the timeline
  let findPreviousQuery = this.findOne({
    type: entryData.type,
    entityId: entryData.entityId,
    date: { $lte: entryDate }
  }).sort({ date: -1, createdAt: -1 });

  if (session) {
    findPreviousQuery = findPreviousQuery.session(session);
  }

  const previousEntry = await findPreviousQuery;
  const previousBalance = previousEntry ? previousEntry.balance : 0;

  const debit = Number(entryData.debit) || 0;
  const credit = Number(entryData.credit) || 0;
  const newBalance = previousBalance + debit - credit;

  const entry = new this({
    ...entryData,
    date: entryDate,
    balance: newBalance
  });

  const savedEntry = session ? await entry.save({ session }) : await entry.save();

  // Check if there are entries AFTER this one that need re-calculation
  let findNextQuery = this.findOne({
    type: entryData.type,
    entityId: entryData.entityId,
    $or: [
      { date: { $gt: entryDate } },
      { date: entryDate, createdAt: { $gt: savedEntry.createdAt } }
    ]
  });

  if (session) {
    findNextQuery = findNextQuery.session(session);
  }

  const nextEntry = await findNextQuery;
  if (nextEntry) {
    // There are entries in the future, trigger re-calculation
    await this.recalculateBalances(entryData.type, entryData.entityId, entryDate, session);
  }

  return savedEntry;
};

/**
 * Re-calculate all balances for an entity starting from a specific date
 * Useful when a backdated entry is inserted or an existing entry is edited/deleted
 */
ledgerSchema.statics.recalculateBalances = async function (type, entityId, startDate, session = null) {
  // 1. Find all entries for this entity from startDate onwards
  let findQuery = this.find({
    type,
    entityId,
    date: { $gte: new Date(startDate) }
  }).sort({ date: 1, createdAt: 1 });

  if (session) {
    findQuery = findQuery.session(session);
  }

  const entriesToUpdate = await findQuery;
  if (entriesToUpdate.length === 0) return;

  // 2. Find the base balance (the entry immediately BEFORE the first one in entriesToUpdate)
  const firstEntry = entriesToUpdate[0];
  let findBaseQuery = this.findOne({
    type,
    entityId,
    $or: [
      { date: { $lt: firstEntry.date } },
      { date: firstEntry.date, createdAt: { $lt: firstEntry.createdAt } }
    ]
  }).sort({ date: -1, createdAt: -1 });

  if (session) {
    findBaseQuery = findBaseQuery.session(session);
  }

  const baseEntry = await findBaseQuery;
  let currentBalance = baseEntry ? baseEntry.balance : 0;

  // 3. Update each entry sequentially
  for (const entry of entriesToUpdate) {
    currentBalance = Number((currentBalance + (entry.debit || 0) - (entry.credit || 0)).toFixed(2));
    entry.balance = currentBalance;

    if (session) {
      await entry.save({ session });
    } else {
      await entry.save();
    }
  }
};

// =====================================================
// STATIC METHODS - Single Source of Truth (SSOT) refactor
// =====================================================

/**
 * Get current balance for an entity using aggregation (SSOT)
 * Balance = Sum of debits - Sum of credits
 * Positive balance = Entity owes us / We owe entity (depending on context)
 */
ledgerSchema.statics.getBalance = async function (type, entityId) {
  const result = await this.aggregate([
    { $match: { type, entityId: new mongoose.Types.ObjectId(entityId) } },
    {
      $group: {
        _id: null,
        totalDebit: { $sum: '$debit' },
        totalCredit: { $sum: '$credit' }
      }
    }
  ]);

  const totalDebit = result[0]?.totalDebit || 0;
  const totalCredit = result[0]?.totalCredit || 0;

  const balance = totalDebit - totalCredit;

  console.log("Total Debit:", totalDebit);
  console.log("Total Credit:", totalCredit);
  console.log("Balance:", balance);

  return balance;
};



/**
 * Get balance using the legacy method (for validation during migration)
 * Falls back to last entry's running balance
 */
ledgerSchema.statics.getBalanceLegacy = async function (type, entityId) {
  const lastEntry = await this.findOne({ type, entityId }).sort({ date: -1, createdAt: -1 });
  return lastEntry ? lastEntry.balance : 0;
};

/**
 * Get payment summary for a specific order/reference
 * Returns: { cash: amount, bank: amount, total: amount }
 * @param {ObjectId} referenceId - The order/reference ID
 * @param {Object} session - Optional MongoDB session for transaction support
 */
ledgerSchema.statics.getOrderPayments = async function (referenceId, session = null) {
  const aggregation = this.aggregate([
    {
      $match: {
        referenceId: new mongoose.Types.ObjectId(referenceId),
        transactionType: 'payment'
      }
    },
    {
      $group: {
        _id: '$paymentMethod',
        amount: { $sum: '$credit' }
      }
    }
  ]);

  // Add session to aggregation if provided
  if (session) {
    aggregation.session(session);
  }

  const result = await aggregation;

  const payments = {
    cash: 0,
    bank: 0,
    total: 0
  };

  for (const item of result) {
    if (item._id === 'cash') payments.cash = item.amount;
    else if (item._id === 'bank') payments.bank = item.amount;
    payments.total += item.amount;
  }

  return payments;
};

/**
 * Get total payments by method for an entity
 * Returns: { cash: totalCash, bank: totalBank }
 */
ledgerSchema.statics.getPaymentTotalsByMethod = async function (type, entityId) {
  const result = await this.aggregate([
    {
      $match: {
        type,
        entityId: new mongoose.Types.ObjectId(entityId),
        transactionType: 'payment'
      }
    },
    {
      $group: {
        _id: '$paymentMethod',
        total: { $sum: '$credit' }
      }
    }
  ]);

  const totals = { cash: 0, bank: 0 };
  for (const item of result) {
    if (item._id === 'cash') totals.cash = item.total;
    else if (item._id === 'bank') totals.bank = item.total;
  }

  return totals;
};

/**
 * Get purchase total for a specific order (debit entries)
 */
ledgerSchema.statics.getOrderPurchaseTotal = async function (referenceId) {
  const result = await this.aggregate([
    {
      $match: {
        referenceId: new mongoose.Types.ObjectId(referenceId),
        transactionType: 'purchase'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$debit' }
      }
    }
  ]);

  return result[0]?.total || 0;
};

/**
 * Get return total for a specific order (credit entries from returns)
 */
/**
 * Get total return value for a specific order
 * @param {ObjectId} referenceId - The order/reference ID
 * @param {Object} session - Optional MongoDB session for transaction support
 */
ledgerSchema.statics.getOrderReturnTotal = async function (referenceId, session = null) {
  const aggregation = this.aggregate([
    {
      $match: {
        referenceId: new mongoose.Types.ObjectId(referenceId),
        transactionType: 'return'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$credit' }
      }
    }
  ]);

  // Add session to aggregation if provided
  if (session) {
    aggregation.session(session);
  }

  const result = await aggregation;

  return result[0]?.total || 0;
};

module.exports = mongoose.model('Ledger', ledgerSchema);