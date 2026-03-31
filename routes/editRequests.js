const express = require('express');
const mongoose = require('mongoose');
const EditRequest = require('../models/EditRequest');
const auth = require('../middleware/auth');
const EditRequestService = require('../services/EditRequestService');
const { logActivity } = require('../utils/auditLogger');

const router = express.Router();

// ==========================================
// POST / — Submit a new edit/delete request
// Non-super-admin users submit requests here
// ==========================================
router.post('/', auth, async (req, res) => {
  try {
    const { entityType, entityId, requestType, requestedChanges, rawPayload, reason, entityRef } = req.body;

    if (!entityType || !entityId || !requestType || !reason) {
      return res.status(400).json({
        success: false,
        message: 'entityType, entityId, requestType, and reason are required'
      });
    }

    if (!['edit', 'delete'].includes(requestType)) {
      return res.status(400).json({ success: false, message: 'requestType must be "edit" or "delete"' });
    }

    if (!['dispatch-order', 'sale', 'payment', 'supplier-payment'].includes(entityType)) {
      return res.status(400).json({ success: false, message: 'Invalid entityType' });
    }

    if (requestType === 'edit' && (!requestedChanges || Object.keys(requestedChanges).length === 0)) {
      return res.status(400).json({ success: false, message: 'requestedChanges required for edit requests' });
    }

    const editRequest = await EditRequestService.submitRequest({
      entityType,
      entityId,
      requestType,
      requestedChanges,
      rawPayload,
      reason,
      requestedBy: req.user._id,
      entityRef
    });

    // Log the activity
    await logActivity(req, {
      action: 'CREATE',
      resource: 'EditRequest',
      resourceId: editRequest._id,
      description: `Submitted ${requestType} request ${editRequest.requestNumber} for ${entityType} (${entityRef || entityId})`,
      changes: { old: null, new: editRequest.toObject() }
    });

    res.status(201).json({
      success: true,
      message: `${requestType === 'edit' ? 'Edit' : 'Delete'} request ${editRequest.requestNumber} submitted for approval`,
      data: editRequest
    });
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({
      success: false,
      message: error.message || 'Failed to submit request',
      existingRequestNumber: error.existingRequestNumber
    });
  }
});

// ==========================================
// GET /pending/count — Badge count for sidebar
// Super-admin only
// ==========================================
router.get('/pending/count', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Super-admin only' });
    }

    const count = await EditRequest.countDocuments({ status: 'pending' });
    res.json({ success: true, data: { count } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// GET /unacknowledged — Notification check for current user
// Returns unacknowledged resolved requests for the current user
// ==========================================
router.get('/unacknowledged', auth, async (req, res) => {
  try {
    const requests = await EditRequest.find({
      requestedBy: req.user._id,
      status: { $in: ['approved', 'rejected'] },
      acknowledged: false,
      directEdit: { $ne: true }
    })
      .sort({ reviewedAt: -1 })
      .limit(20)
      .select('requestNumber entityType entityRef requestType status reviewNote reviewedAt')
      .lean();

    res.json({ success: true, data: requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// GET / — List edit requests
// Super-admin sees all; others see only their own
// ==========================================
router.get('/', auth, async (req, res) => {
  try {
    const { status, entityType, page = 1, limit = 20, mine } = req.query;
    const filter = {};

    // Non-super-admin can only see own requests; super-admin sees all unless mine=true
    if (req.user.role !== 'super-admin' || mine === 'true') {
      filter.requestedBy = req.user._id;
    }

    if (status) filter.status = status;
    if (entityType) filter.entityType = entityType;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [requests, total] = await Promise.all([
      EditRequest.find(filter)
        .populate('requestedBy', 'name email role')
        .populate('reviewedBy', 'name email role')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      EditRequest.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: {
        rows: requests,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// GET /:id — Get single request with populated entity
// ==========================================
router.get('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }

    const editRequest = await EditRequest.findById(req.params.id)
      .populate('requestedBy', 'name email role')
      .populate('reviewedBy', 'name email role')
      .lean();

    if (!editRequest) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    // Non-super-admin can only see own requests
    if (req.user.role !== 'super-admin' && editRequest.requestedBy._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized to view this request' });
    }

    // Fetch current entity for diff comparison
    let currentEntity = null;
    try {
      const Model = mongoose.model(editRequest.entityModel);
      currentEntity = await Model.findById(editRequest.entityId).lean();
    } catch { /* entity may have been deleted */ }

    // Get cascading impact for delete requests
    let cascadingImpact = null;
    if (editRequest.requestType === 'delete' && editRequest.status === 'pending') {
      cascadingImpact = await EditRequestService.getCascadingImpact(editRequest.entityType, editRequest.entityId);
    }

    res.json({
      success: true,
      data: {
        ...editRequest,
        currentEntity,
        cascadingImpact
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// PATCH /:id/approve — Approve + apply change
// Super-admin only
// ==========================================
router.patch('/:id/approve', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Only super-admin can approve requests' });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }

    const { reviewNote, forceApprove } = req.body;

    const result = await EditRequestService.approveRequest(
      req.params.id,
      req.user._id,
      reviewNote,
      forceApprove === true
    );

    if (!result.success) {
      const status = result.conflict ? 409 : 400;
      return res.status(status).json(result);
    }

    // Log the activity
    await logActivity(req, {
      action: 'STATUS_CHANGE',
      resource: 'EditRequest',
      resourceId: req.params.id,
      description: `Approved request ${result.editRequest.requestNumber} for ${result.editRequest.entityType}`,
      changes: { old: 'pending', new: 'approved', reviewNote }
    });

    res.json({
      success: true,
      message: `Request ${result.editRequest.requestNumber} approved and applied`,
      data: result.data,
      editRequest: result.editRequest
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// PATCH /:id/reject — Reject a request
// Super-admin only
// ==========================================
router.patch('/:id/reject', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({ success: false, message: 'Only super-admin can reject requests' });
    }

    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }

    const { reviewNote } = req.body;
    if (!reviewNote || reviewNote.trim() === '') {
      return res.status(400).json({ success: false, message: 'Rejection reason is required' });
    }

    const result = await EditRequestService.rejectRequest(
      req.params.id,
      req.user._id,
      reviewNote
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    // Log the activity
    await logActivity(req, {
      action: 'STATUS_CHANGE',
      resource: 'EditRequest',
      resourceId: req.params.id,
      description: `Rejected request ${result.editRequest.requestNumber} for ${result.editRequest.entityType}`,
      changes: { old: 'pending', new: 'rejected', reviewNote }
    });

    res.json({
      success: true,
      message: `Request ${result.editRequest.requestNumber} rejected`,
      data: result.editRequest
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// PATCH /:id/acknowledge — Mark notification as seen
// ==========================================
router.patch('/:id/acknowledge', auth, async (req, res) => {
  try {
    const editRequest = await EditRequest.findOneAndUpdate(
      { _id: req.params.id, requestedBy: req.user._id },
      { acknowledged: true },
      { new: true }
    );

    if (!editRequest) {
      return res.status(404).json({ success: false, message: 'Request not found' });
    }

    res.json({ success: true, data: editRequest });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==========================================
// DELETE /:id — Cancel own pending request
// ==========================================
router.delete('/:id', auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: 'Invalid request ID' });
    }

    const editRequest = await EditRequest.findOne({
      _id: req.params.id,
      requestedBy: req.user._id,
      status: 'pending'
    });

    if (!editRequest) {
      return res.status(404).json({
        success: false,
        message: 'Pending request not found or not owned by you'
      });
    }

    await EditRequest.findByIdAndDelete(req.params.id);

    // Log the activity
    await logActivity(req, {
      action: 'DELETE',
      resource: 'EditRequest',
      resourceId: editRequest._id,
      description: `Cancelled request ${editRequest.requestNumber}`,
      changes: { old: editRequest.toObject(), new: null }
    });

    res.json({
      success: true,
      message: `Request ${editRequest.requestNumber} cancelled`
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
