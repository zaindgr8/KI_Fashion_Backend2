const EditRequestService = require('../services/EditRequestService');

/**
 * Middleware to control backdated entries based on role
 * @param {Object} options 
 * @param {string} options.entityType - e.g., 'sale', 'dispatch-order', 'payment'
 * @param {string} options.dateField - field name in req.body containing the date (e.g., 'saleDate', 'date')
 * @param {string} options.requestType - 'create' or 'update'
 */
const dateControl = (options) => {
  return async (req, res, next) => {
    const { entityType, dateField = 'date', requestType = 'create' } = options;
    const userRole = req.user.role;
    const requestedDateStr = req.body[dateField];

    if (!requestedDateStr) {
      return next();
    }

    const requestedDate = new Date(requestedDateStr);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const isBackdated = requestedDate < today;

    // 1. Super-admin can do anything
    if (userRole === 'super-admin') {
      return next();
    }

    // 2. If not backdated, everyone can proceed (if they have normal permissions)
    if (!isBackdated) {
      return next();
    }

    // 3. If backdated:
    if (userRole === 'admin') {
      try {
        // Intercept and submit as Edit Request
        const result = await EditRequestService.submitRequest({
          entityType,
          entityId: req.params.id, // For updates
          requestType,
          rawPayload: req.body,
          reason: `Backdated ${requestType} by admin`,
          requestedBy: req.user._id,
          entityRef: req.body.orderNumber || req.body.saleNumber || req.body.paymentNumber || ''
        });

        return res.status(202).json({
          success: true,
          pendingApproval: true,
          message: 'Backdated entry submitted for super-admin approval',
          requestId: result._id
        });
      } catch (error) {
        console.error('DateControl Middleware Error:', error);
        return res.status(500).json({ success: false, message: 'Failed to process backdate request' });
      }
    }

    // 4. Employee cannot backdate
    return res.status(403).json({
      success: false,
      message: 'You do not have permission to select a previous date. Please contact a super-admin.'
    });
  };
};

module.exports = dateControl;
