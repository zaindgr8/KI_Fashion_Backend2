const EditRequestService = require('../services/EditRequestService');

/**
 * Middleware to control backdated entries based on role
 * @param {Object} options 
 * @param {string} options.entityType - e.g., 'sale', 'dispatch-order', 'payment'
 * @param {string} options.dateField - field name in req.body containing the date (e.g., 'saleDate', 'date')
 * @param {string} options.requestType - 'create' or 'update'
 * @param {boolean} [options.compareToExisting] - compare against stored date for updates
 * @param {string} [options.existingDateField] - stored date field name (defaults to dateField)
 * @param {Object} [options.entityModel] - Mongoose model for lookup when compareToExisting is true
 * @param {boolean} [options.fallbackToCreatedAt] - fallback to createdAt when stored date is missing
 */
const dateControl = (options) => {
  return async (req, res, next) => {
    const {
      entityType,
      dateField = 'date',
      requestType = 'create',
      compareToExisting = false,
      existingDateField = dateField,
      entityModel = null,
      fallbackToCreatedAt = true,
      allowAdminBypassWithBaseline = false
    } = options;
    const userRole = req.user.role;
    const requestedDateStr = req.body[dateField];

    if (!requestedDateStr) {
      return next();
    }

    const normalizeToDay = (date) => {
      if (!date || Number.isNaN(date.getTime())) return null;
      const normalized = new Date(date);
      normalized.setHours(0, 0, 0, 0);
      return normalized;
    };

    const requestedDate = normalizeToDay(new Date(requestedDateStr));
    if (!requestedDate) {
      return next();
    }

    let baselineDate = null;
    if (compareToExisting && requestType !== 'create' && entityModel && req.params.id) {
      try {
        const entity = await entityModel
          .findById(req.params.id)
          .select(`${existingDateField} createdAt`)
          .lean();

        const existingDateValue = entity?.[existingDateField];
        baselineDate = normalizeToDay(existingDateValue ? new Date(existingDateValue) : null);

        if (!baselineDate && fallbackToCreatedAt && entity?.createdAt) {
          baselineDate = normalizeToDay(new Date(entity.createdAt));
        }
      } catch (error) {
        console.error('DateControl baseline lookup error:', error);
      }
    }

    if (!baselineDate) {
      baselineDate = normalizeToDay(new Date());
    }

    const isBackdated = requestedDate < baselineDate;

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
      // If bypass enabled, allow admin to proceed with a "safe" date
      if (allowAdminBypassWithBaseline) {
        req.pendingBackdate = req.body[dateField];
        // Use baselineDate as the safe fallback (existing date for updates, Today for creations)
        const safeDate = baselineDate || new Date();
        req.body[dateField] = safeDate.toISOString(); 
        return next();
      }

      try {
        // Intercept and submit as Edit Request
        const approvalRequestType = requestType === 'update' ? 'edit' : requestType;
        const result = await EditRequestService.submitRequest({
          entityType,
          entityId: req.params.id, // For updates
          requestType: approvalRequestType,
          rawPayload: req.body,
          reason: `Backdated ${approvalRequestType} by admin`,
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
        // Log detailed error information for debugging
        console.error('DateControl Middleware Error:', {
          entityType,
          entityId: req.params.id,
          requestType,
          userId: req.user?._id,
          userName: req.user?.name,
          userRole,
          errorMessage: error.message,
          errorStatus: error.status,
          stack: error.stack
        });

        // Determine HTTP status code from error or default to 500
        const statusCode = error.status || 500;
        const errorMessage = error.message || 'Failed to process backdate request';

        // Map common error scenarios to user-friendly messages
        let userFriendlyMessage = errorMessage;
        if (errorMessage.includes('not found')) {
          userFriendlyMessage = `${entityType} not found. Please verify the ID and try again.`;
        } else if (errorMessage.includes('already exists')) {
          userFriendlyMessage = 'A pending approval request for this record already exists. Please wait for super-admin review or contact support.';
        } else if (errorMessage.includes('Unknown entity type')) {
          userFriendlyMessage = 'Invalid entity type for backdating. Please contact support.';
        } else if (errorMessage.includes('Cast to ObjectId failed')) {
          userFriendlyMessage = 'Invalid record ID format. Please verify and try again.';
        } else if (errorMessage.includes('required')) {
          userFriendlyMessage = 'Missing required information. Please provide all necessary details and try again.';
        }

        return res.status(statusCode).json({
          success: false,
          message: userFriendlyMessage,
          details: process.env.NODE_ENV === 'development' ? errorMessage : undefined,
          errorCode: error.code || 'BACKDATE_ERROR'
        });
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
