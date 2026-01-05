const express = require('express');
const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Ledger = require('../models/Ledger');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

// Get products available for return from a specific supplier
// OPTIMIZED: Uses Inventory.purchaseBatches for direct supplier lookup (indexed field)
router.get('/products-for-return', auth, async (req, res) => {
  try {
    const { search = '', supplierId, limit = 50, skip = 0 } = req.query;

    if (!supplierId) {
      return sendResponse.error(res, 'Supplier ID is required', 400);
    }

    const mongoose = require('mongoose');
    const supplierObjectId = new mongoose.Types.ObjectId(supplierId);

    // Build search match for product lookup
    const searchMatch = search ? {
      $or: [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { productCode: { $regex: search, $options: 'i' } }
      ]
    } : {};

    const pipeline = [
      // Stage 1: Match inventories with batches from this supplier that have remaining stock
      {
        $match: {
          'purchaseBatches.supplierId': supplierObjectId,
          isActive: true
        }
      },

      // Stage 2: Unwind batches to filter by supplier
      { $unwind: '$purchaseBatches' },

      // Stage 3: Filter only batches from this supplier with remaining stock
      {
        $match: {
          'purchaseBatches.supplierId': supplierObjectId,
          'purchaseBatches.remainingQuantity': { $gt: 0 }
        }
      },

      // Stage 4: Group by product to aggregate all batches from this supplier
      {
        $group: {
          _id: '$product',
          inventoryId: { $first: '$_id' },
          totalStock: { $first: '$currentStock' },
          supplierStock: { $sum: '$purchaseBatches.remainingQuantity' },
          averageCostPrice: { $first: '$averageCostPrice' },
          // Calculate weighted sum for supplier-specific average cost
          supplierCostPriceSum: {
            $sum: {
              $multiply: ['$purchaseBatches.remainingQuantity', '$purchaseBatches.costPrice']
            }
          },
          batches: {
            $push: {
              batchId: '$purchaseBatches._id',
              dispatchOrderId: '$purchaseBatches.dispatchOrderId',
              remainingQuantity: '$purchaseBatches.remainingQuantity',
              costPrice: '$purchaseBatches.costPrice',
              purchaseDate: '$purchaseBatches.purchaseDate'
            }
          }
        }
      },

      // Stage 5: Lookup dispatch order details for batches
      {
        $unwind: '$batches'
      },
      {
        $addFields: {
          'batches.dispatchOrderId': { $toObjectId: '$batches.dispatchOrderId' }
        }
      },
      {
        $lookup: {
          from: 'dispatchorders',
          localField: 'batches.dispatchOrderId',
          foreignField: '_id',
          as: 'orderInfo'
        }
      },
      {
        $addFields: {
          'batches.orderNumber': { $arrayElemAt: ['$orderInfo.orderNumber', 0] },
          'batches.confirmedAt': { $arrayElemAt: ['$orderInfo.confirmedAt', 0] }
        }
      },
      {
        $group: {
          _id: '$_id',
          inventoryId: { $first: '$inventoryId' },
          totalStock: { $first: '$totalStock' },
          supplierStock: { $first: '$supplierStock' },
          averageCostPrice: { $first: '$averageCostPrice' },
          supplierCostPriceSum: { $first: '$supplierCostPriceSum' },
          batches: { $push: '$batches' }
        }
      },

      // Stage 5: Calculate supplier-specific average cost price
      {
        $addFields: {
          supplierAvgCostPrice: {
            $cond: {
              if: { $gt: ['$supplierStock', 0] },
              then: { $divide: ['$supplierCostPriceSum', '$supplierStock'] },
              else: '$averageCostPrice'
            }
          }
        }
      },

      // Stage 6: Lookup product details
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'product',
          pipeline: [
            {
              $match: {
                isActive: { $ne: false },
                ...searchMatch
              }
            },
            {
              $project: {
                name: 1,
                sku: 1,
                productCode: 1,
                images: { $slice: ['$images', 1] }, // Only first image for performance
                category: 1,
                brand: 1
              }
            }
          ]
        }
      },

      // Stage 7: Unwind product (also filters out products that don't match search)
      { $unwind: '$product' },

      // Stage 8: Final projection matching frontend expectations
      {
        $project: {
          _id: '$product._id',
          name: '$product.name',
          sku: '$product.sku',
          productCode: '$product.productCode',
          images: '$product.images',
          category: '$product.category',
          brand: '$product.brand',
          currentStock: '$supplierStock', // Stock from THIS supplier only
          availableForReturn: '$supplierStock',
          averageCostPrice: '$supplierAvgCostPrice', // Cost for THIS supplier
          // Include batch details for accurate return tracking
          batches: 1
        }
      },

      // Stage 9: Sort by product name
      { $sort: { name: 1 } },

      // Stage 10: Pagination
      { $skip: parseInt(skip) || 0 },
      { $limit: parseInt(limit) || 50 }
    ];

    const result = await Inventory.aggregate(pipeline);

    console.log(`Found ${result.length} products for supplier ${supplierId} via purchaseBatches`);

    return sendResponse.success(res, result);

  } catch (error) {
    console.error('Get products for return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Create product-level supplier return (simplified - no batches)
// Reduce inventory, create ledger entry, update supplier balance
router.post('/product-return', auth, async (req, res) => {
  try {
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins and managers can create returns', 403);
    }

    const {
      supplierId,
      items,
      notes,
      returnDate,
      accountCredit = 0
    } = req.body;

    if (!supplierId) {
      return sendResponse.error(res, 'Supplier ID is required', 400);
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return sendResponse.error(res, 'Items array is required', 400);
    }

    // Verify supplier exists
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return sendResponse.error(res, 'Supplier not found', 404);
    }

    // Process each item
    const processedItems = [];
    let totalReturnValue = 0;

    for (const item of items) {
      const { productId, quantity, reason } = item;

      if (!productId || !quantity || quantity <= 0) {
        return sendResponse.error(res, 'Each item must have productId and positive quantity', 400);
      }

      // Get product
      const product = await Product.findById(productId);
      if (!product) {
        return sendResponse.error(res, `Product not found: ${productId}`, 404);
      }

      // Get inventory
      const inventory = await Inventory.findOne({ product: productId });
      if (!inventory) {
        return sendResponse.error(res, `No inventory found for product: ${product.name}`, 404);
      }

      // Check stock
      if (inventory.currentStock < quantity) {
        return sendResponse.error(res,
          `Insufficient stock for ${product.name}. Available: ${inventory.currentStock}, Requested: ${quantity}`,
          400
        );
      }

      // Use averageCostPrice from inventory
      const costPrice = inventory.averageCostPrice || 0;
      const itemTotalCost = quantity * costPrice;

      // Add stock movement
      inventory.stockMovements.push({
        type: 'out',
        quantity: quantity,
        reference: 'SupplierReturn',
        referenceId: null,
        user: req.user._id,
        notes: `Return - ${reason || 'No reason'}`,
        date: new Date()
      });

      // Reduce inventory
      inventory.currentStock -= quantity;
      inventory.lastStockUpdate = new Date();
      await inventory.save();

      processedItems.push({
        product: productId,
        productName: product.name,
        productCode: product.productCode || product.sku,
        quantity: quantity,
        costPrice: costPrice,
        totalCost: itemTotalCost,
        reason: reason || ''
      });

      totalReturnValue += itemTotalCost;
    }

    // Create Return document
    const returnDoc = new Return({
      supplier: supplierId,
      dispatchOrder: null,
      items: processedItems.map((item, index) => ({
        itemIndex: index,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        originalQuantity: item.quantity,
        returnedQuantity: item.quantity,
        costPrice: item.costPrice,
        reason: item.reason
      })),
      totalReturnValue: totalReturnValue,
      returnedAt: returnDate ? new Date(returnDate) : new Date(),
      returnedBy: req.user._id,
      notes: notes || '',
      returnType: 'product-level'
    });

    await returnDoc.save();

    // Update stock movement references
    for (const item of processedItems) {
      const inventory = await Inventory.findOne({ product: item.product });
      if (inventory && inventory.stockMovements.length > 0) {
        const lastMovement = inventory.stockMovements[inventory.stockMovements.length - 1];
        if (lastMovement && lastMovement.reference === 'SupplierReturn') {
          lastMovement.referenceId = returnDoc._id;
          await inventory.save();
        }
      }
    }

    // Create ledger entry
    await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'return',
      referenceId: returnDoc._id,
      referenceModel: 'Return',
      debit: 0,
      credit: totalReturnValue,
      date: returnDoc.returnedAt,
      description: `Product Return - ${processedItems.length} item(s) worth £${totalReturnValue.toFixed(2)}`,
      remarks: `Return ID: ${returnDoc._id}`,
      createdBy: req.user._id
    });

    // Update supplier balance (reduce what we owe them)
    await Supplier.findByIdAndUpdate(
      supplierId,
      { $inc: { currentBalance: -totalReturnValue } }
    );

    // Populate for response
    await returnDoc.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'returnedBy', select: 'name' },
      { path: 'items.product', select: 'name sku productCode' }
    ]);

    return sendResponse.success(res, {
      return: returnDoc,
      summary: {
        totalItems: processedItems.length,
        totalQuantity: processedItems.reduce((sum, i) => sum + i.quantity, 0),
        totalReturnValue: totalReturnValue,
        supplierBalanceAdjustment: -totalReturnValue
      }
    }, 'Return created successfully', 201);

  } catch (error) {
    console.error('Create product return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Get all returns with optional filters
router.get('/', auth, async (req, res) => {
  try {
    const {
      supplier,
      dispatchOrder,
      startDate,
      endDate,
      limit = 50,
      skip = 0
    } = req.query;

    // Build query
    const query = {};

    if (supplier) {
      query.supplier = supplier;
    }

    if (dispatchOrder) {
      query.dispatchOrder = dispatchOrder;
    }

    if (startDate || endDate) {
      query.returnedAt = {};
      if (startDate) {
        query.returnedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        // Set end date to end of day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        query.returnedAt.$lte = end;
      }
    }

    // Execute query with pagination
    const returns = await Return.find(query)
      .populate('supplier', 'name company')
      .populate('returnedBy', 'name')
      .populate({
        path: 'dispatchOrder',
        select: 'orderNumber',
        populate: {
          path: 'items.product',
          select: 'name sku unit images color size productCode pricing'
        }
      })
      .sort({ returnedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    // Get total count for pagination
    const total = await Return.countDocuments(query);

    return sendResponse.success(res, {
      returns,
      rows: returns, // For compatibility with frontend
      total,
      limit: parseInt(limit),
      skip: parseInt(skip)
    });

  } catch (error) {
    console.error('Get returns error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get all returns for a dispatch order
router.get('/dispatch-order/:id', auth, async (req, res) => {
  try {
    const returns = await Return.find({ dispatchOrder: req.params.id })
      .populate('supplier', 'name company')
      .populate('returnedBy', 'name')
      .populate({
        path: 'dispatchOrder',
        select: 'orderNumber',
        populate: {
          path: 'items.product',
          select: 'name sku unit images color size productCode pricing'
        }
      })
      .sort({ returnedAt: -1 });

    return sendResponse.success(res, returns);

  } catch (error) {
    console.error('Get returns error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get return by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const returnDoc = await Return.findById(req.params.id)
      .populate('supplier', 'name company')
      .populate('returnedBy', 'name')
      .populate({
        path: 'dispatchOrder',
        select: 'orderNumber',
        populate: {
          path: 'items.product',
          select: 'name sku unit images color size productCode pricing'
        }
      });

    if (!returnDoc) {
      return sendResponse.error(res, 'Return not found', 404);
    }

    return sendResponse.success(res, returnDoc);

  } catch (error) {
    console.error('Get return error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

module.exports = router;

