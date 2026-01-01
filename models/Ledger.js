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
  balance: {
    type: Number,
    default: 0
  },
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
  paymentDetails: {
    cashPayment: { type: Number, default: 0 },
    bankPayment: { type: Number, default: 0 },
    remainingBalance: { type: Number, default: 0 }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Existing indexes
ledgerSchema.index({ entityId: 1, date: -1 });
ledgerSchema.index({ type: 1, entityId: 1 });

// Performance indexes for payment queries
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

ledgerSchema.statics.createEntry = async function (entryData, session = null) {
  // Use session if provided to ensure transaction consistency
  const findOneQuery = this.findOne({
    type: entryData.type,
    entityId: entryData.entityId
  }).sort({ date: -1, createdAt: -1 });
  
  // Attach session to query if provided
  if (session) {
    findOneQuery.session(session);
  }
  
  const lastEntry = await findOneQuery;

  const previousBalance = lastEntry ? lastEntry.balance : 0;
  const newBalance = previousBalance + (entryData.debit || 0) - (entryData.credit || 0);

  const entry = new this({
    ...entryData,
    balance: newBalance
  });

  // Save with session if provided
  if (session) {
    return await entry.save({ session });
  }
  return await entry.save();
};

ledgerSchema.statics.getBalance = async function (type, entityId) {
  const lastEntry = await this.findOne({ type, entityId }).sort({ date: -1, createdAt: -1 });
  return lastEntry ? lastEntry.balance : 0;
};

module.exports = mongoose.model('Ledger', ledgerSchema);