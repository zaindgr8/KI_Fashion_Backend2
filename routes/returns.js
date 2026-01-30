const express = require('express');
const mongoose = require('mongoose');
const Return = require('../models/Return');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Ledger = require('../models/Ledger');
const PacketStock = require('../models/PacketStock');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

// Get products available for return from a specific supplier
// OPTIMIZED: Uses Inventory.purchaseBatches for direct supplier lookup (indexed field)
// FIXED: Now handles both string and ObjectId formats for supplierId to include manual buying entries
router.get('/products-for-return', auth, async (req, res) => {
  try {
    const { search = '', supplierId, limit = 50, skip = 0 } = req.query;

    if (!supplierId) {
      return sendResponse.error(res, 'Supplier ID is required', 400);
    }

    const mongoose = require('mongoose');
    const supplierObjectId = new mongoose.Types.ObjectId(supplierId);
    const supplierIdString = supplierId.toString();

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
      // Handle both ObjectId and string formats for supplierId (for backward compatibility with manual entries)
      {
        $match: {
          $or: [
            { 'purchaseBatches.supplierId': supplierObjectId },
            { 'purchaseBatches.supplierId': supplierIdString }
          ],
          isActive: true
        }
      },

      // Stage 2: Unwind batches to filter by supplier
      { $unwind: '$purchaseBatches' },

      // Stage 3: Filter only batches from this supplier with remaining stock
      // Handle both ObjectId and string formats
      {
        $match: {
          $or: [
            { 'purchaseBatches.supplierId': supplierObjectId },
            { 'purchaseBatches.supplierId': supplierIdString }
          ],
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
          variantComposition: { $first: '$variantComposition' },
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
          variantComposition: { $first: '$variantComposition' },
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
          variantComposition: 1,
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

    console.log(`[Returns] Found ${result.length} products for supplier ${supplierId} (searched both ObjectId and string formats)`);

    // If no results, log additional debug info
    if (result.length === 0) {
      const totalInventoryCount = await Inventory.countDocuments({ isActive: true });
      const batchCount = await Inventory.countDocuments({
        isActive: true,
        'purchaseBatches.0': { $exists: true }
      });
      console.log(`[Returns] Debug: Total active inventories: ${totalInventoryCount}, With batches: ${batchCount}`);
    }

    return sendResponse.success(res, result);

  } catch (error) {
    console.error('Get products for return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Get packet stocks available for return from a specific supplier
// Returns both full packets and loose items that can be returned
router.get('/packet-stocks-for-return', auth, async (req, res) => {
  try {
    const { supplierId, productId, search = '', includeLoose = 'true' } = req.query;

    if (!supplierId) {
      return sendResponse.error(res, 'Supplier ID is required', 400);
    }

    const query = {
      supplier: supplierId,
      isActive: true,
      availablePackets: { $gt: 0 }
    };

    // Optionally filter by product
    if (productId) {
      query.product = productId;
    }

    // Optionally filter out loose items
    if (includeLoose === 'false') {
      query.isLoose = false;
    }

    const packetStocks = await PacketStock.find(query)
      .populate('product', 'name sku productCode images')
      .sort({ isLoose: 1, barcode: 1 }) // Full packets first, then loose
      .lean();

    // Add search filtering
    let filteredResults = packetStocks;
    if (search) {
      const searchLower = search.toLowerCase();
      filteredResults = packetStocks.filter(ps =>
        ps.barcode?.toLowerCase().includes(searchLower) ||
        ps.product?.name?.toLowerCase().includes(searchLower) ||
        ps.product?.productCode?.toLowerCase().includes(searchLower) ||
        ps.product?.sku?.toLowerCase().includes(searchLower)
      );
    }

    // Transform for frontend
    const result = filteredResults.map(ps => ({
      _id: ps._id,
      barcode: ps.barcode,
      product: ps.product,
      isLoose: ps.isLoose,
      composition: ps.composition,
      totalItemsPerPacket: ps.totalItemsPerPacket,
      availablePackets: ps.availablePackets,
      costPricePerPacket: ps.costPricePerPacket,
      landedPricePerPacket: ps.landedPricePerPacket,
      // Calculate total items available
      totalItemsAvailable: ps.isLoose
        ? ps.availablePackets
        : ps.availablePackets * ps.totalItemsPerPacket
    }));

    console.log(`[Returns] Found ${result.length} packet stocks for supplier ${supplierId}`);
    return sendResponse.success(res, result);

  } catch (error) {
    console.error('Get packet stocks for return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Create a packet-level supplier return (returns full packets or loose items)
// Updates both PacketStock AND Inventory
router.post('/packet-return', auth, async (req, res) => {
  try {
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins can create packet returns', 403);
    }

    const {
      supplierId,
      packetStockId,
      quantity,
      returnType = 'full', // 'full' for full packets, 'partial' for breaking
      itemsToReturn = [],   // For partial returns: [{size, color, quantity}]
      reason = '',
      notes = ''
    } = req.body;

    if (!supplierId || !packetStockId) {
      return sendResponse.error(res, 'Supplier ID and Packet Stock ID are required', 400);
    }

    // Verify supplier exists
    const supplier = await Supplier.findById(supplierId);
    if (!supplier) {
      return sendResponse.error(res, 'Supplier not found', 404);
    }

    // Get packet stock
    const packetStock = await PacketStock.findById(packetStockId).populate('product');
    if (!packetStock) {
      return sendResponse.error(res, 'Packet stock not found', 404);
    }

    if (packetStock.supplier.toString() !== supplierId) {
      return sendResponse.error(res, 'Packet stock does not belong to this supplier', 400);
    }

    let totalItemsReturned = 0;
    let returnValue = 0;
    const processedItems = [];
    let breakResult = null;

    if (returnType === 'partial' && !packetStock.isLoose) {
      // Breaking a packet for partial return
      if (!itemsToReturn || itemsToReturn.length === 0) {
        return sendResponse.error(res, 'Items to return are required for partial returns', 400);
      }

      breakResult = await packetStock.breakForSupplierReturn(
        itemsToReturn,
        req.user._id
      );

      totalItemsReturned = breakResult.totalItemsReturned;
      returnValue = totalItemsReturned * (packetStock.landedPricePerPacket / packetStock.totalItemsPerPacket);

      processedItems.push({
        packetStockId: packetStock._id,
        barcode: packetStock.barcode,
        isLoose: false,
        returnType: 'partial',
        items: itemsToReturn,
        quantity: totalItemsReturned,
        costPrice: packetStock.landedPricePerPacket / packetStock.totalItemsPerPacket
      });

    } else if (packetStock.isLoose) {
      // Returning loose items
      if (!quantity || quantity <= 0) {
        return sendResponse.error(res, 'Quantity is required for loose item returns', 400);
      }

      await packetStock.returnLooseToSupplier(quantity);
      totalItemsReturned = quantity;
      returnValue = quantity * (packetStock.landedPricePerPacket || packetStock.costPricePerPacket);

      processedItems.push({
        packetStockId: packetStock._id,
        barcode: packetStock.barcode,
        isLoose: true,
        returnType: 'loose',
        quantity: quantity,
        costPrice: packetStock.landedPricePerPacket || packetStock.costPricePerPacket
      });

    } else {
      // Returning full packets
      if (!quantity || quantity <= 0) {
        return sendResponse.error(res, 'Quantity is required for full packet returns', 400);
      }

      await packetStock.returnToSupplier(quantity);
      totalItemsReturned = quantity * packetStock.totalItemsPerPacket;
      returnValue = quantity * packetStock.landedPricePerPacket;

      processedItems.push({
        packetStockId: packetStock._id,
        barcode: packetStock.barcode,
        isLoose: false,
        returnType: 'full',
        packetsReturned: quantity,
        quantity: totalItemsReturned,
        costPrice: packetStock.landedPricePerPacket
      });
    }

    // Update Inventory (reduce stock)
    const productId = packetStock.product._id || packetStock.product;
    const inventory = await Inventory.findOne({ product: productId });

    if (inventory) {
      // Reduce current stock
      inventory.currentStock = Math.max(0, inventory.currentStock - totalItemsReturned);

      // Calculate variant reductions
      const variantReductions = [];

      if (returnType === 'partial') {
        itemsToReturn.forEach(item => {
          variantReductions.push({ size: item.size, color: item.color, quantity: item.quantity });
        });
      } else {
        const multiplier = returnType === 'loose' ? quantity : quantity;
        if (packetStock.composition && packetStock.composition.length > 0) {
          packetStock.composition.forEach(comp => {
            variantReductions.push({
              size: comp.size,
              color: comp.color,
              quantity: comp.quantity * multiplier
            });
          });
        }
      }

      inventory.reduceVariantStockForReturn(variantReductions);

      // Add stock movement
      inventory.stockMovements.push({
        type: 'out',
        quantity: totalItemsReturned,
        reference: 'SupplierReturn-Packet',
        referenceId: null, // Will update after creating Return doc
        user: req.user._id,
        notes: `Packet return - ${packetStock.barcode}${reason ? ` - ${reason}` : ''}`,
        date: new Date()
      });

      // Reduce from batches (FIFO)
      let remainingToReduce = totalItemsReturned;
      for (const batch of inventory.purchaseBatches) {
        if (remainingToReduce <= 0) break;
        if (batch.supplierId?.toString() === supplierId && batch.remainingQuantity > 0) {
          const reduceAmount = Math.min(batch.remainingQuantity, remainingToReduce);
          batch.remainingQuantity -= reduceAmount;
          remainingToReduce -= reduceAmount;
        }
      }

      inventory.recalculateAverageCost();
      await inventory.save();
    }

    // Create Return document
    const returnDoc = new Return({
      supplier: supplierId,
      returnType: 'product-level',
      items: [{
        itemIndex: 0,
        product: productId,
        productName: packetStock.product.name,
        productCode: packetStock.product.productCode || packetStock.product.sku,
        originalQuantity: totalItemsReturned,
        returnedQuantity: totalItemsReturned,
        costPrice: returnValue / totalItemsReturned,
        reason: reason
      }],
      totalReturnValue: returnValue,
      returnedAt: new Date(),
      returnedBy: req.user._id,
      notes: `${notes}${breakResult ? ` | Packet broken, remaining items moved to loose stock` : ''}`
    });

    await returnDoc.save();

    // Update stock movement with Return ID
    if (inventory) {
      const lastMovement = inventory.stockMovements[inventory.stockMovements.length - 1];
      if (lastMovement) {
        lastMovement.referenceId = returnDoc._id;
        await inventory.save();
      }
    }

    // Create ledger entry
    const currentSupplierBalance = await BalanceService.getSupplierBalance(supplierId);
    const newSupplierBalance = currentSupplierBalance - returnValue;

    await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'return',
      referenceId: returnDoc._id,
      referenceModel: 'Return',
      debit: 0,
      credit: returnValue,
      date: returnDoc.returnedAt,
      description: `Packet Return - ${packetStock.barcode} (${totalItemsReturned} items) worth £${returnValue.toFixed(2)}`,
      remarks: `Return ID: ${returnDoc._id}`,
      createdBy: req.user._id,
      paymentDetails: {
        cashPayment: 0,
        bankPayment: 0,
        remainingBalance: newSupplierBalance
      }
    });

    // Update supplier balance
    await Supplier.findByIdAndUpdate(
      supplierId,
      { $inc: { currentBalance: -returnValue } }
    );

    // Populate for response
    await returnDoc.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'returnedBy', select: 'name' },
      { path: 'items.product', select: 'name sku productCode' }
    ]);

    return sendResponse.success(res, {
      return: returnDoc,
      packetDetails: {
        barcode: packetStock.barcode,
        returnType,
        totalItemsReturned,
        returnValue,
        breakResult: breakResult || null
      }
    }, 'Packet return created successfully', 201);

  } catch (error) {
    console.error('Create packet return error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Create product-level supplier return (batch-aware)
// Uses specific batch data for accurate cost tracking and FIFO inventory management
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

    // Process each item with batch-specific data
    const processedItems = [];
    let totalReturnValue = 0;
    let commonDispatchOrderId = null; // Track the dispatch order for all items

    for (const item of items) {
      const { productId, batchId, quantity, reason, returnComposition } = item;

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

      // Find the specific batch if batchId is provided
      let batch = null;
      let costPrice = inventory.averageCostPrice || 0; // Fallback to average
      let dispatchOrderId = null;

      if (batchId) {
        // Find the exact batch by batchId
        batch = inventory.purchaseBatches.find(b => b._id.toString() === batchId);

        if (!batch) {
          return sendResponse.error(res, `Batch not found for product: ${product.name}. BatchId: ${batchId}`, 404);
        }

        if (batch.remainingQuantity < quantity) {
          return sendResponse.error(res,
            `Insufficient batch quantity for ${product.name}. Available in batch: ${batch.remainingQuantity}, Requested: ${quantity}`,
            400
          );
        }

        // Use batch-specific data
        costPrice = batch.costPrice || costPrice;
        dispatchOrderId = batch.dispatchOrderId;

        // Validate all items are from the same dispatch order
        if (commonDispatchOrderId === null) {
          commonDispatchOrderId = dispatchOrderId;
        } else if (dispatchOrderId && commonDispatchOrderId.toString() !== dispatchOrderId.toString()) {
          return sendResponse.error(res, 'All items must be from the same Dispatch Order', 400);
        }

        // Reduce the specific batch's remainingQuantity (FIFO tracking)
        batch.remainingQuantity -= quantity;
      }

      // Check overall stock
      if (inventory.currentStock < quantity) {
        return sendResponse.error(res,
          `Insufficient stock for ${product.name}. Available: ${inventory.currentStock}, Requested: ${quantity}`,
          400
        );
      }

      const itemTotalCost = quantity * costPrice;

      // Add stock movement
      inventory.stockMovements.push({
        type: 'out',
        quantity: quantity,
        reference: 'SupplierReturn',
        referenceId: null, // Will be updated after Return document is created
        user: req.user._id,
        notes: `Return - ${reason || 'No reason'}${batch ? ` (Batch: ${batchId})` : ''}`,
        date: new Date()
      });

      // Reduce variant stock if composition provided
      if (returnComposition && Array.isArray(returnComposition) && returnComposition.length > 0) {
        // Validate total quantity matches
        const totalVariantQty = returnComposition.reduce((sum, v) => sum + (v.quantity || 0), 0);
        if (Math.abs(totalVariantQty - quantity) > 0.01) {
          return sendResponse.error(res, `Variant composition total (${totalVariantQty}) does not match item quantity (${quantity}) for product ${product.name}`, 400);
        }

        try {
          inventory.reduceVariantStockForReturn(returnComposition);
        } catch (err) {
          return sendResponse.error(res, err.message, 400);
        }
      }

      // Reduce inventory
      inventory.currentStock -= quantity;
      inventory.lastStockUpdate = new Date();
      await inventory.save();

      processedItems.push({
        product: productId,
        dispatchOrderId: dispatchOrderId,
        batchId: batch ? batch._id : null,
        productName: product.name,
        productCode: product.productCode || product.sku,
        quantity: quantity,
        costPrice: costPrice,
        totalCost: itemTotalCost,
        reason: reason || '',
        returnComposition
      });

      totalReturnValue += itemTotalCost;
    }

    // Create Return document with proper dispatchOrder reference
    const returnDoc = new Return({
      supplier: supplierId,
      dispatchOrder: commonDispatchOrderId || null, // Set from batch data, not hardcoded null
      items: processedItems.map((item, index) => ({
        itemIndex: index,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        originalQuantity: item.quantity,
        returnedQuantity: item.quantity,
        costPrice: item.costPrice,
        reason: item.reason,
        // Track which batch was deducted for audit purposes
        batchDeductions: item.batchId ? [{
          batchId: item.batchId,
          dispatchOrderId: item.dispatchOrderId,
          quantity: item.quantity,
          costPrice: item.costPrice
        }] : [],
        returnComposition: item.returnComposition
      })),
      totalReturnValue: totalReturnValue,
      returnedAt: returnDate ? new Date(returnDate) : new Date(),
      returnedBy: req.user._id,
      notes: notes || '',
      returnType: 'product-level'
    });

    await returnDoc.save();

    // Update stock movement references with the Return document ID
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
    // Get current supplier balance using BalanceService (accurate aggregation-based calculation)
    const currentSupplierBalance = await BalanceService.getSupplierBalance(supplierId);
    const newSupplierBalance = currentSupplierBalance - totalReturnValue;

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
      description: `Product Return - ${processedItems.length} item(s) worth £${totalReturnValue.toFixed(2)}${commonDispatchOrderId ? ` (Order: ${commonDispatchOrderId})` : ''}`,
      remarks: `Return ID: ${returnDoc._id}`,
      createdBy: req.user._id,
      paymentDetails: {
        cashPayment: 0,
        bankPayment: 0,
        remainingBalance: newSupplierBalance
      }
    });

    // Update supplier balance (reduce what we owe them)
    await Supplier.findByIdAndUpdate(
      supplierId,
      { $inc: { currentBalance: -totalReturnValue } }
    );

    // Populate for response
    await returnDoc.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'dispatchOrder', select: 'orderNumber' },
      { path: 'returnedBy', select: 'name' },
      { path: 'items.product', select: 'name sku productCode' }
    ]);

    return sendResponse.success(res, {
      return: returnDoc,
      summary: {
        totalItems: processedItems.length,
        totalQuantity: processedItems.reduce((sum, i) => sum + i.quantity, 0),
        totalReturnValue: totalReturnValue,
        supplierBalanceAdjustment: -totalReturnValue,
        dispatchOrderId: commonDispatchOrderId
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
        select: 'orderNumber purchaseDate dispatchDate confirmedAt createdAt',
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

