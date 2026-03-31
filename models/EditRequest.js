const mongoose = require('mongoose');

const editRequestSchema = new mongoose.Schema({
  // Sequential request number: REQ-000001
  requestNumber: {
    type: String,
    unique: true,
    index: true,
    required: true
  },

  // Entity being edited/deleted/created
  entityType: {
    type: String,
    enum: ['dispatch-order', 'sale', 'payment', 'supplier-payment', 'expense', 'return', 'sale-return'],
    required: true
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false, // Optional for 'create'
    refPath: 'entityModel'
  },
  entityModel: {
    type: String,
    enum: ['DispatchOrder', 'Sale', 'Payment', 'SupplierPaymentReceipt', 'Expense', 'Return', 'SaleReturn'],
    required: true
  },

  // Request type
  requestType: {
    type: String,
    enum: ['edit', 'delete', 'create'],
    required: true
  },

  // Status workflow: pending → approved | rejected
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
    required: true
  },

  // For edits: { fieldPath: { from: oldValue, to: newValue } }
  // For deletes/creates: null
  requestedChanges: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  // The exact payload to pass to the existing creation/mutation logic on approval
  rawPayload: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },

  // Requester justification
  reason: {
    type: String,
    required: true,
    trim: true
  },

  // Full snapshot of entity at request time (for conflict detection)
  // Null for creation requests
  entitySnapshot: {
    type: mongoose.Schema.Types.Mixed,
    required: false
  },

  // Who submitted the request
  requestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },

  // Reviewer info (set on approve/reject)
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  reviewedAt: Date,
  reviewNote: {
    type: String,
    trim: true
  },

  // True when auto-created for super-admin direct edits (audit trail)
  directEdit: {
    type: Boolean,
    default: false
  },

  // For notification dismissal
  acknowledged: {
    type: Boolean,
    default: false
  },

  // Human-readable entity reference (e.g. order number, sale number)
  entityRef: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes
editRequestSchema.index({ status: 1, createdAt: -1 });
editRequestSchema.index({ entityType: 1, entityId: 1, status: 1 });
editRequestSchema.index({ requestedBy: 1, status: 1 });
editRequestSchema.index({ acknowledged: 1, requestedBy: 1, status: 1 });

/**
 * Generate next sequential request number: REQ-000001
 */
editRequestSchema.statics.getNextRequestNumber = async function(session = null) {
  const countersCollection = mongoose.connection.db.collection('counters');
  const options = { upsert: true, returnDocument: 'after' };
  if (session) options.session = session;

  const counter = await countersCollection.findOneAndUpdate(
    { _id: 'editRequestNumber' },
    { $inc: { seq: 1 } },
    options
  );

  const seq = counter.value?.seq || counter.seq || 1;
  return `REQ-${String(seq).padStart(6, '0')}`;
};

module.exports = mongoose.model('EditRequest', editRequestSchema);
