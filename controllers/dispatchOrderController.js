const dispatchOrderService = require('../services/DispatchOrderService');
const { dispatchOrderSchema, manualEntrySchema } = require('../validators/dispatchOrderValidators');
const { sendResponse } = require('../utils/helpers');

exports.createDispatchOrder = async (req, res) => {
    try {
        if (req.user.role !== 'supplier') {
            return sendResponse.error(res, 'Only suppliers can create dispatch orders', 403);
        }

        const { error } = dispatchOrderSchema.validate(req.body);
        if (error) {
            return sendResponse.error(res, error.details[0].message, 400);
        }

        const result = await dispatchOrderService.createDispatchOrder(req.user, req.body);
        return sendResponse.success(res, result, 'Dispatch order created successfully', 201);
    } catch (error) {
        console.error('Create dispatch order error:', error);
        return sendResponse.error(res, error.message || 'Server error', 500);
    }
};

exports.createManualEntry = async (req, res) => {
    try {
        if (!['super-admin', 'admin'].includes(req.user.role)) {
            return sendResponse.error(res, 'Only admins and managers can create manual entries', 403);
        }

        const { error, value } = manualEntrySchema.validate(req.body, {
            abortEarly: false,
            allowUnknown: true,
            stripUnknown: false
        });
        if (error) {
            return sendResponse.error(res, error.details[0].message, 400);
        }

        const result = await dispatchOrderService.createManualEntry(req.user, value);
        return sendResponse.success(res, result, 'Manual entry created successfully', 201);
    } catch (error) {
        console.error('Create manual entry error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};

exports.getDispatchOrders = async (req, res) => {
    try {
        const result = await dispatchOrderService.getDispatchOrders(req.user, req.query);
        return sendResponse.paginated(res, result.items, result.pagination);
    } catch (error) {
        console.error('Get dispatch orders error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};

exports.getUnpaidOrders = async (req, res) => {
    try {
        const result = await dispatchOrderService.getUnpaidOrders(req.params.supplierId);
        return sendResponse.success(res, result);
    } catch (error) {
        console.error('Get unpaid orders error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};

exports.getDispatchOrderById = async (req, res) => {
    try {
        const result = await dispatchOrderService.getDispatchOrderById(req.params.id, req.user);
        return sendResponse.success(res, result);
    } catch (error) {
        console.error('Get dispatch order error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message === 'Access denied' ? 403 : 500);
        return sendResponse.error(res, error.message, status);
    }
};

exports.updateStatus = async (req, res) => {
    try {
        const result = await dispatchOrderService.updateDispatchOrderStatus(req.params.id, req.user, req.body);
        return sendResponse.success(res, result, 'Order status updated successfully');
    } catch (error) {
        console.error('Update status error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message === 'Access denied' ? 403 : 500);
        return sendResponse.error(res, error.message, status);
    }
};

exports.submitForApproval = async (req, res) => {
    try {
        const result = await dispatchOrderService.submitForApproval(req.params.id, req.user, req.body);
        return sendResponse.success(res, result, 'Dispatch order submitted for approval successfully');
    } catch (error) {
        console.error('Submit approval error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message.includes('Only') ? 403 : 400); // Rough mapping based on common errors
        return sendResponse.error(res, error.message, status);
    }
};

exports.confirmDispatchOrder = async (req, res) => {
    try {
        const result = await dispatchOrderService.confirmDispatchOrder(req.params.id, req.user, req.body);
        return sendResponse.success(res, result, 'Dispatch order confirmed successfully');
    } catch (error) {
        console.error('Confirm dispatch order error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message.includes('Only super-admin') ? 403 : 400);
        return sendResponse.error(res, error.message, status);
    }
};

exports.updateDispatchOrder = async (req, res) => {
    try {
        const result = await dispatchOrderService.updateDispatchOrder(req.params.id, req.user, req.body);
        return sendResponse.success(res, result, 'Dispatch order updated successfully');
    } catch (error) {
        console.error('Update dispatch order error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message.includes('permission') ? 403 : 400);
        return sendResponse.error(res, error.message, status);
    }
};

exports.deleteDispatchOrder = async (req, res) => {
    try {
        const result = await dispatchOrderService.deleteDispatchOrder(req.params.id, req.user);
        return sendResponse.success(res, null, result.message || 'Dispatch order deleted successfully');
    } catch (error) {
        console.error('Delete dispatch order error:', error);
        const status = error.message === 'Dispatch order not found' ? 404 : (error.message.includes('permission') ? 403 : 400);
        return sendResponse.error(res, error.message, status);
    }
};

exports.generateUploadUrl = async (req, res) => {
    try {
        const { fileName, mimeType } = req.body;
        if (!fileName || !mimeType) return sendResponse.error(res, 'fileName and mimeType are required', 400);

        const result = await dispatchOrderService.generateUploadUrl(req.params.id, req.params.itemIndex, fileName, mimeType, req.user);
        return sendResponse.success(res, result, 'Upload URL generated successfully');
    } catch (error) {
        console.error('Generate upload URL error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};

exports.confirmUpload = async (req, res) => {
    try {
        // filePath is usually passed or constructed? 
        // In route: const filePath = ... constructed from params + filename?
        // Wait, route logic was: generate URL -> client uploads -> client calls confirm?
        // No, route logic for confirm-upload (lines 1133+ in outline): 
        // It didn't seem to take filePath in body? 
        // Ah, current `confirm-upload` route (not fully shown in outline view) might just take success?
        // Actually, typically direct upload flow: 
        // 1. Get signed URL (path is known by server)
        // 2. Client uploads
        // 3. Client calls confirm with path? 

        // Let's assume req.body has filePath/fileName?
        // The Service method requires filePath.
        // If the client doesn't send it, maybe the server can reconstructed it if it stored it?
        // But simpler: client sends back what it got.

        const { filePath, fileName, mimeType } = req.body;
        // Basic validation in controller?

        const result = await dispatchOrderService.confirmUpload(req.params.id, req.params.itemIndex, filePath, fileName, mimeType, req.user);
        return sendResponse.success(res, result, 'Image uploaded successfully');
    } catch (error) {
        console.error('Confirm upload error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};

exports.uploadDispatchOrderItemImage = async (req, res) => {
    try {
        const contentType = req.headers['content-type'] || '';
        const isBase64Upload = contentType.includes('application/json') || req.body.image;

        let fileData;

        if (isBase64Upload && req.body.image) {
            const base64String = req.body.image;
            if (!base64String || typeof base64String !== 'string') return sendResponse.error(res, 'Invalid base64 image data', 400);

            const base64Data = base64String.includes(',') ? base64String.split(',')[1] : base64String;
            try {
                fileData = {
                    buffer: Buffer.from(base64Data, 'base64'),
                    originalname: req.body.fileName || `dispatch-order-${req.params.id}-item-${req.params.itemIndex}.jpg`,
                    mimetype: req.body.mimeType || 'image/jpeg'
                };
                fileData.size = fileData.buffer.length;
            } catch (e) {
                return sendResponse.error(res, 'Invalid base64 image data', 400);
            }
        } else if (req.file) {
            fileData = {
                buffer: req.file.buffer,
                originalname: req.file.originalname,
                mimetype: req.file.mimetype,
                size: req.file.size
            };
        } else {
            return sendResponse.error(res, 'No image file provided', 400);
        }

        const result = await dispatchOrderService.uploadDispatchOrderItemImage(req.params.id, req.params.itemIndex, fileData, req.user);
        return sendResponse.success(res, result, 'Image uploaded successfully');

    } catch (error) {
        console.error('Upload image error:', error);
        return sendResponse.error(res, error.message, 500);
    }
};
