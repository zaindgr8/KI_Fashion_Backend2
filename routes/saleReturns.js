const express = require('express');
const Joi = require('joi');
const mongoose = require('mongoose');
const SaleReturn = require('../models/SaleReturn');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const Buyer = require('../models/Buyer');
const Product = require('../models/Product');
const Ledger = require('../models/Ledger');
const PacketStock = require('../models/PacketStock');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');
const { generateSignedUrls } = require('../utils/imageUpload');

const router = express.Router();

// Helper function to get buyer ID for distributor/buyer users
async function getBuyerIdForUser(user) {
  // If buyer is already linked, use it
  if (user.buyer) {
    return user.buyer;
  }
  
  // If user is distributor/buyer, try to find buyer by email
  if ((user.role === 'distributor' || user.role === 'buyer') && user.email) {
    const buyer = await Buyer.findOne({ 
      email: user.email.toLowerCase(), 
      customerType: 'distributor' 
    });
    if (buyer) {
      return buyer._id;
    }
  }
  
  return null;
}

const saleReturnItemSchema = Joi.object({
  itemIndex: Joi.number().integer().min(0).required(),
  product: Joi.string().required(),
  originalQuantity: Joi.number().min(0).required(),
  returnedQuantity: Joi.number().min(1).required(),
  unitPrice: Joi.number().min(0).required(),
  reason: Joi.string().allow('', null).optional()
});

const saleReturnSchema = Joi.object({
  sale: Joi.string().required(),
  items: Joi.array().items(saleReturnItemSchema).min(1).required(),
  notes: Joi.string().allow('', null).optional()
});

/**
 * Convert sale return product images to signed URLs
 * @param {Object|Array} saleReturns - Sale return document(s)
 * @returns {Promise<Object|Array>} Sale return(s) with signed image URLs
 */
async function convertSaleReturnImages(saleReturns) {
  if (!saleReturns) {
    return saleReturns;
  }

  const isArray = Array.isArray(saleReturns);
  const returnsArray = isArray ? saleReturns : [saleReturns];

  await Promise.all(returnsArray.map(async (saleReturn) => {
    if (!saleReturn || !saleReturn.items || !Array.isArray(saleReturn.items)) {
      return;
    }

    await Promise.all(saleReturn.items.map(async (item) => {
      if (item.product && item.product.images && Array.isArray(item.product.images)) {
        if (item.product.images.length > 0) {
          item.product.images = await generateSignedUrls(item.product.images);
        }
      }
    }));
  }));

  return isArray ? returnsArray : returnsArray[0];
}

// Create sale return
router.post('/', auth, async (req, res) => {
  try {
    const { error, value } = saleReturnSchema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    // Verify sale exists and is delivered
    const sale = await Sale.findById(value.sale).populate('items.product');
    if (!sale) {
      return sendResponse.error(res, 'Sale not found', 404);
    }

    if (sale.deliveryStatus !== 'delivered') {
      return sendResponse.error(res, 'Can only return items from delivered sales', 400);
    }

    // Check if user is buyer or admin
    const isBuyer = req.user.role === 'distributor' || req.user.role === 'buyer';
    const isAdmin = ['super-admin', 'admin'].includes(req.user.role);

    if (isBuyer) {
      const buyerId = await getBuyerIdForUser(req.user);
      if (!buyerId || sale.buyer.toString() !== buyerId.toString()) {
        return sendResponse.error(res, 'Access denied', 403);
      }
    }

    // Get existing returns for this sale to track cumulative returns
    const existingReturns = await SaleReturn.find({
      sale: value.sale,
      status: { $in: ['pending', 'approved'] }
    });

    // Calculate already returned quantities per item
    const returnedQuantities = {};
    existingReturns.forEach(ret => {
      ret.items.forEach(item => {
        const key = `${ret.sale}_${item.itemIndex}`;
        if (!returnedQuantities[key]) {
          returnedQuantities[key] = 0;
        }
        if (ret.status === 'approved') {
          returnedQuantities[key] += item.returnedQuantity;
        }
      });
    });

    // Validate returned quantities
    let totalReturnValue = 0;
    for (const returnItem of value.items) {
      const saleItem = sale.items[returnItem.itemIndex];
      if (!saleItem) {
        return sendResponse.error(res, `Invalid item index: ${returnItem.itemIndex}`, 400);
      }

      if (saleItem.product._id.toString() !== returnItem.product) {
        return sendResponse.error(res, `Product mismatch for item index ${returnItem.itemIndex}`, 400);
      }

      const key = `${value.sale}_${returnItem.itemIndex}`;
      const alreadyReturned = returnedQuantities[key] || 0;
      const availableToReturn = saleItem.quantity - alreadyReturned;

      if (returnItem.returnedQuantity > availableToReturn) {
        return sendResponse.error(res, `Cannot return ${returnItem.returnedQuantity} items. Only ${availableToReturn} available to return for item at index ${returnItem.itemIndex}`, 400);
      }

      if (returnItem.originalQuantity !== saleItem.quantity) {
        return sendResponse.error(res, `Original quantity mismatch for item at index ${returnItem.itemIndex}`, 400);
      }

      totalReturnValue += returnItem.returnedQuantity * returnItem.unitPrice;
    }

    // Determine status: approved if created by admin, pending if by distributor
    const status = isAdmin ? 'approved' : 'pending';

    const saleReturn = new SaleReturn({
      sale: value.sale,
      buyer: sale.buyer,
      items: value.items,
      totalReturnValue,
      status,
      returnedBy: req.user._id,
      processedBy: isAdmin ? req.user._id : undefined,
      processedAt: isAdmin ? new Date() : undefined,
      notes: value.notes
    });

    await saleReturn.save();

    // If approved by admin, process immediately
    if (status === 'approved') {
      await processSaleReturn(saleReturn._id, req.user._id);
    }

    // Populate for response
    await saleReturn.populate([
      { path: 'sale', select: 'saleNumber saleDate' },
      { path: 'buyer', select: 'name company' },
      { path: 'returnedBy', select: 'name email' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' }
    ]);

    // Convert images to signed URLs
    await convertSaleReturnImages(saleReturn);

    return sendResponse.success(res, saleReturn, 'Sale return created successfully', 201);

  } catch (error) {
    console.error('Create sale return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Helper function to process sale return (approve)
async function processSaleReturn(returnId, userId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const saleReturn = await SaleReturn.findById(returnId)
      .populate('sale')
      .populate('items.product')
      .session(session);

    if (!saleReturn || saleReturn.status !== 'approved') {
      await session.abortTransaction();
      session.endSession();
      return;
    }

    // Get the original sale to check for packet sales
    const originalSale = await Sale.findById(saleReturn.sale._id).session(session);

    // Update inventory - add stock back
    for (const item of saleReturn.items) {
      const inventory = await Inventory.findOne({ product: item.product._id }).session(session);
      if (inventory) {
        // Get cost price from inventory
        const costPrice = inventory.averageCostPrice || 0;
        
        await inventory.addStock(
          item.returnedQuantity,
          'SaleReturn',
          saleReturn._id,
          userId,
          `Sale Return from Sale ${saleReturn.sale.saleNumber}`
        );
        await inventory.save({ session });
      }

      // Restore PacketStock if the original sale item was a packet sale
      const originalSaleItem = originalSale?.items?.[item.itemIndex];
      if (originalSaleItem?.isPacketSale && originalSaleItem?.packetStock) {
        try {
          const packetStock = await PacketStock.findById(originalSaleItem.packetStock).session(session);
          if (packetStock) {
            await packetStock.restorePackets(item.returnedQuantity, 'SaleReturn');
            console.log(`[Sale Return] Restored ${item.returnedQuantity} packets to PacketStock ${packetStock.barcode}`);
          }
        } catch (packetError) {
          console.error(`[Sale Return] Error restoring PacketStock:`, packetError.message);
          // Continue processing - don't fail return for packet stock issues
        }
      }
    }

    // Create ledger entries
    // Credit buyer (reduces receivables)
    await Ledger.createEntry({
      type: 'buyer',
      entityId: saleReturn.buyer,
      entityModel: 'Buyer',
      transactionType: 'return',
      referenceId: saleReturn._id,
      referenceModel: 'SaleReturn',
      debit: 0,
      credit: saleReturn.totalReturnValue,
      date: new Date(),
      description: `Sale Return from Sale ${saleReturn.sale.saleNumber}`,
      createdBy: userId
    });

    // Debit inventory value (cost price * quantity for each item)
    let totalCostValue = 0;
    for (const item of saleReturn.items) {
      const inventory = await Inventory.findOne({ product: item.product._id }).session(session);
      if (inventory) {
        const costPrice = inventory.averageCostPrice || 0;
        totalCostValue += item.returnedQuantity * costPrice;
      }
    }

    await session.commitTransaction();
    session.endSession();
    console.log(`[Sale Return] Successfully processed return ${returnId} with transaction`);

  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error(`[Sale Return] Transaction failed for return ${returnId}:`, error.message);
    throw error;
  }

  // Note: We don't have a separate inventory ledger, so we could create a general entry
  // or skip this. For now, we'll create a buyer ledger entry with notes about inventory impact.
  // In a full system, you might have a separate inventory ledger or cost of goods sold account.
}

// Get all sale returns with filters
router.get('/', auth, async (req, res) => {
  try {
    const {
      buyer,
      sale,
      status,
      startDate,
      endDate,
      limit = 50,
      skip = 0
    } = req.query;

    // Build query
    const query = {};

    // Role-based filtering
    if (req.user.role === 'distributor' || req.user.role === 'buyer') {
      const buyerId = await getBuyerIdForUser(req.user);
      if (buyerId) {
        query.buyer = buyerId;
      } else {
        // If no buyer found, still allow access but filter by user's sales
        // This ensures distributors can see their own returns even if buyer record doesn't exist
        // We'll filter by returnedBy instead
        query.returnedBy = req.user._id;
      }
    } else if (buyer) {
      query.buyer = buyer;
    }

    if (sale) {
      query.sale = sale;
    }

    if (status) {
      query.status = status;
    }

    if (startDate || endDate) {
      query.returnedAt = {};
      if (startDate) {
        query.returnedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.returnedAt.$lte = end;
      }
    }

    // Execute query with pagination
    const returns = await SaleReturn.find(query)
      .populate('sale', 'saleNumber saleDate')
      .populate('buyer', 'name company')
      .populate('returnedBy', 'name')
      .populate('processedBy', 'name')
      .populate('items.product', 'name sku unit images color size productCode pricing')
      .sort({ returnedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // Convert images to signed URLs
    await convertSaleReturnImages(returns);

    // Get total count for pagination
    const total = await SaleReturn.countDocuments(query);

    return sendResponse.success(res, {
      returns,
      rows: returns,
      total,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

  } catch (error) {
    console.error('Get sale returns error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get sale return by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const returnDoc = await SaleReturn.findById(req.params.id)
      .populate('sale', 'saleNumber saleDate deliveryStatus items')
      .populate('buyer', 'name company')
      .populate('returnedBy', 'name email')
      .populate('processedBy', 'name email')
      .populate('items.product', 'name sku unit images color size productCode pricing');

    if (!returnDoc) {
      return sendResponse.error(res, 'Sale return not found', 404);
    }

    // Check permissions
    if (req.user.role === 'distributor' || req.user.role === 'buyer') {
      const buyerId = await getBuyerIdForUser(req.user);
      if (buyerId) {
        if (returnDoc.buyer._id.toString() !== buyerId.toString()) {
          return sendResponse.error(res, 'Access denied', 403);
        }
      } else {
        // If no buyer found, check if user created this return
        if (returnDoc.returnedBy.toString() !== req.user._id.toString()) {
          return sendResponse.error(res, 'Access denied', 403);
        }
      }
    }

    // Convert images to signed URLs
    await convertSaleReturnImages(returnDoc);

    return sendResponse.success(res, returnDoc);

  } catch (error) {
    console.error('Get sale return error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get all returns for a specific sale
router.get('/sale/:id', auth, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);
    if (!sale) {
      return sendResponse.error(res, 'Sale not found', 404);
    }

    // Check permissions
    if (req.user.role === 'distributor' || req.user.role === 'buyer') {
      const buyerId = await getBuyerIdForUser(req.user);
      if (buyerId) {
        if (sale.buyer.toString() !== buyerId.toString()) {
          return sendResponse.error(res, 'Access denied', 403);
        }
      } else {
        // If no buyer found, check if user created sales for this sale
        // For now, allow access if user is distributor (they should see their own sales)
        // This is a fallback for cases where buyer record doesn't exist
      }
    }

    const returns = await SaleReturn.find({ sale: req.params.id })
      .populate('sale', 'saleNumber saleDate')
      .populate('buyer', 'name company')
      .populate('returnedBy', 'name')
      .populate('processedBy', 'name')
      .populate('items.product', 'name sku unit images color size productCode pricing')
      .sort({ returnedAt: -1 });

    // Convert images to signed URLs
    await convertSaleReturnImages(returns);

    return sendResponse.success(res, returns);

  } catch (error) {
    console.error('Get sale returns error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Approve sale return (admin only)
router.patch('/:id/approve', auth, async (req, res) => {
  try {
    // Only admin/manager can approve returns
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins and managers can approve returns', 403);
    }

    const saleReturn = await SaleReturn.findById(req.params.id)
      .populate('sale')
      .populate('items.product');

    if (!saleReturn) {
      return sendResponse.error(res, 'Sale return not found', 404);
    }

    if (saleReturn.status !== 'pending') {
      return sendResponse.error(res, `Cannot approve return with status: ${saleReturn.status}`, 400);
    }

    saleReturn.status = 'approved';
    saleReturn.processedAt = new Date();
    saleReturn.processedBy = req.user._id;
    await saleReturn.save();

    // Process the return (update inventory and ledger)
    await processSaleReturn(saleReturn._id, req.user._id);

    // Populate for response
    await saleReturn.populate([
      { path: 'sale', select: 'saleNumber saleDate' },
      { path: 'buyer', select: 'name company' },
      { path: 'returnedBy', select: 'name email' },
      { path: 'processedBy', select: 'name email' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' }
    ]);

    // Convert images to signed URLs
    await convertSaleReturnImages(saleReturn);

    return sendResponse.success(res, saleReturn, 'Sale return approved successfully');

  } catch (error) {
    console.error('Approve sale return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Reject sale return (admin only)
router.patch('/:id/reject', auth, async (req, res) => {
  try {
    // Only admin/manager can reject returns
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins and managers can reject returns', 403);
    }

    const { rejectionNotes } = req.body;

    const saleReturn = await SaleReturn.findById(req.params.id);

    if (!saleReturn) {
      return sendResponse.error(res, 'Sale return not found', 404);
    }

    if (saleReturn.status !== 'pending') {
      return sendResponse.error(res, `Cannot reject return with status: ${saleReturn.status}`, 400);
    }

    saleReturn.status = 'rejected';
    saleReturn.processedAt = new Date();
    saleReturn.processedBy = req.user._id;
    saleReturn.rejectionNotes = rejectionNotes || '';
    await saleReturn.save();

    // Populate for response
    await saleReturn.populate([
      { path: 'sale', select: 'saleNumber saleDate' },
      { path: 'buyer', select: 'name company' },
      { path: 'returnedBy', select: 'name email' },
      { path: 'processedBy', select: 'name email' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' }
    ]);

    // Convert images to signed URLs
    await convertSaleReturnImages(saleReturn);

    return sendResponse.success(res, saleReturn, 'Sale return rejected successfully');

  } catch (error) {
    console.error('Reject sale return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

module.exports = router;

