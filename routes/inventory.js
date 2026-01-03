const express = require('express');
const Joi = require('joi');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Buyer = require('../models/Buyer');
const auth = require('../middleware/auth');
const { generateSignedUrls } = require('../utils/imageUpload');
const { generateCatalogQR } = require('../utils/qrCode');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

const stockAdjustmentSchema = Joi.object({
  product: Joi.string().required(),
  quantity: Joi.number().required(),
  type: Joi.string().valid('add', 'subtract', 'set').required(),
  reference: Joi.string().required(),
  notes: Joi.string().optional()
});

const stockTransferSchema = Joi.object({
  fromProduct: Joi.string().required(),
  toProduct: Joi.string().required(),
  quantity: Joi.number().min(1).required(),
  notes: Joi.string().optional()
});

/**
 * Convert product images to signed URLs in inventory items
 * Since bucket is public, we can use public URLs directly, but signed URLs provide better security
 * @param {Array|Object} inventoryItems - Inventory item(s)
 * @param {Boolean} usePublicUrls - If true, use public URLs directly instead of signed URLs
 * @returns {Promise<Array|Object>} Inventory item(s) with image URLs
 */
async function convertInventoryProductImages(inventoryItems, usePublicUrls = false) {
  if (!inventoryItems) {
    return inventoryItems;
  }

  const isArray = Array.isArray(inventoryItems);
  const itemsArray = isArray ? inventoryItems : [inventoryItems];

  await Promise.all(itemsArray.map(async (item) => {
    if (item && item.product) {
      // Ensure images array exists (initialize if missing)
      if (!item.product.images) {
        item.product.images = [];
      }

      // Ensure images is an array
      if (!Array.isArray(item.product.images)) {
        console.warn(`[Inventory] Product ${item.product.name || item.product._id} has non-array images:`, typeof item.product.images);
        item.product.images = [];
      }

      if (item.product.images.length > 0) {
        if (usePublicUrls) {
          // Use public URLs directly (bucket is public)
          // URLs are already in public format: https://storage.googleapis.com/bucket/path
          // No conversion needed - images are already public URLs
          console.log(`[Inventory] Using public URLs for product ${item.product.name || item.product._id}, ${item.product.images.length} images`);
        } else {
          // Generate signed URLs (more secure, but slower)
          const signedUrls = await generateSignedUrls(item.product.images);
          // If signed URL generation fails, fall back to public URLs
          if (signedUrls.length === item.product.images.length) {
            item.product.images = signedUrls;
            console.log(`[Inventory] Generated signed URLs for product ${item.product.name || item.product._id}`);
          } else {
            // Some signed URLs failed, use original public URLs
            console.warn(`[Inventory] Some signed URLs failed for product ${item.product.name || item.product._id}, using public URLs as fallback`);
          }
        }
      } else {
        console.log(`[Inventory] Product ${item.product.name || item.product._id} has no images`);
      }
    } else {
      console.warn(`[Inventory] Item missing product:`, item?._id || 'unknown');
    }
  }));

  return isArray ? itemsArray : itemsArray[0];
}

// Get all inventory
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      searchSku,
      searchProduct,
      searchSupplier,
      lowStock,
      needsReorder,
      category
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build Aggregation Pipeline
    const pipeline = [];

    // 1. Initial Match (Inventory level)
    const match = { isActive: true };
    if (needsReorder === 'true') {
      match.needsReorder = true;
    }
    pipeline.push({ $match: match });

    // Handle lowStock field comparison
    if (lowStock === 'true') {
      pipeline.push({
        $match: {
          $expr: { $lte: ['$currentStock', '$reorderLevel'] }
        }
      });
    }

    // 2. Lookup Product
    pipeline.push({
      $lookup: {
        from: 'products',
        localField: 'product',
        foreignField: '_id',
        as: 'product'
      }
    });

    // 3. Unwind Product (ensure it exists and is active)
    pipeline.push({ $unwind: '$product' });
    pipeline.push({ $match: { 'product.isActive': true } });

    // 4. Product Fields Filters
    if (category) {
      pipeline.push({ $match: { 'product.category': { $regex: category, $options: 'i' } } });
    }
    if (searchSku) {
      pipeline.push({ $match: { 'product.sku': { $regex: searchSku, $options: 'i' } } });
    }
    if (searchProduct) {
      pipeline.push({ $match: { 'product.name': { $regex: searchProduct, $options: 'i' } } });
    }

    // 5. Lookup Suppliers from batches
    // We join with suppliers collection using the supplierId in purchaseBatches
    pipeline.push({
      $lookup: {
        from: 'suppliers',
        localField: 'purchaseBatches.supplierId',
        foreignField: '_id',
        as: 'batchSuppliers'
      }
    });

    // 6. Unified Search and Supplier Search
    if (search || searchSupplier) {
      const searchConditions = [];

      if (search) {
        const searchRegex = { $regex: search, $options: 'i' };
        searchConditions.push(
          { 'product.name': searchRegex },
          { 'product.sku': searchRegex },
          { 'product.brand': searchRegex },
          { 'batchSuppliers.name': searchRegex },
          { 'batchSuppliers.company': searchRegex }
        );
      }

      if (searchSupplier) {
        const supRegex = { $regex: searchSupplier, $options: 'i' };
        searchConditions.push(
          { 'batchSuppliers.name': supRegex },
          { 'batchSuppliers.company': supRegex }
        );
      }

      if (searchConditions.length > 0) {
        pipeline.push({ $match: { $or: searchConditions } });
      }
    }

    // 7. Add Supplier Info to Product (to maintain compatibility with frontend)
    pipeline.push({
      $addFields: {
        'product.suppliers': {
          $map: {
            input: '$batchSuppliers',
            as: 'sup',
            in: {
              supplier: {
                _id: '$$sup._id',
                name: '$$sup.name',
                company: '$$sup.company',
                companyName: '$$sup.company' // Alias for frontend compatibility
              },
              isPrimary: false
            }
          }
        }
      }
    });

    // 8. Sorting
    pipeline.push({ $sort: { 'product.name': 1 } });

    // 9. Faceting for Total Count and Paginated Data
    pipeline.push({
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [{ $skip: skip }, { $limit: limitNum }]
      }
    });

    const result = await Inventory.aggregate(pipeline);

    const total = result[0].metadata[0]?.total || 0;
    const inventoryData = result[0].data;

    // Convert product images to signed URLs
    const usePublicUrls = process.env.GCS_USE_PUBLIC_URLS !== 'false';
    await convertInventoryProductImages(inventoryData, usePublicUrls);

    res.json({
      success: true,
      data: inventoryData,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum
      }
    });

  } catch (error) {
    console.error('Get inventory error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get inventory by product ID
router.get('/product/:productId', auth, async (req, res) => {
  try {
    const inventory = await Inventory.findOne({ product: req.params.productId })
      .populate('product', 'name sku category brand unit pricing images')
      .populate('stockMovements.user', 'name')
      .lean();

    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    // inventory is already a plain object from .lean()
    const inventoryData = inventory;

    // Convert product images to signed URLs (or use public URLs if bucket is public)
    const usePublicUrls = process.env.GCS_USE_PUBLIC_URLS !== 'false'; // Default to true (use public URLs for public bucket)
    await convertInventoryProductImages(inventoryData, usePublicUrls);

    res.json({
      success: true,
      data: inventoryData
    });

  } catch (error) {
    console.error('Get inventory by product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Add stock
router.post('/add-stock', auth, async (req, res) => {
  try {
    const { error } = stockAdjustmentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { product, quantity, reference, notes } = req.body;

    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be positive for adding stock'
      });
    }

    const inventory = await Inventory.findOne({ product });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    await inventory.addStock(quantity, reference, null, req.user._id, notes);

    const updatedInventory = await Inventory.findById(inventory._id)
      .populate('product', 'name sku');

    res.json({
      success: true,
      message: 'Stock added successfully',
      data: updatedInventory
    });

  } catch (error) {
    console.error('Add stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Reduce stock
router.post('/reduce-stock', auth, async (req, res) => {
  try {
    const { error } = stockAdjustmentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { product, quantity, reference, notes } = req.body;

    if (quantity <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Quantity must be positive for reducing stock'
      });
    }

    const inventory = await Inventory.findOne({ product });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    await inventory.reduceStock(quantity, reference, null, req.user._id, notes);

    const updatedInventory = await Inventory.findById(inventory._id)
      .populate('product', 'name sku');

    res.json({
      success: true,
      message: 'Stock reduced successfully',
      data: updatedInventory
    });

  } catch (error) {
    console.error('Reduce stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Adjust stock
router.post('/adjust-stock', auth, async (req, res) => {
  try {
    const adjustSchema = Joi.object({
      product: Joi.string().required(),
      newQuantity: Joi.number().min(0).required(),
      reference: Joi.string().required(),
      notes: Joi.string().optional()
    });

    const { error } = adjustSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { product, newQuantity, reference, notes } = req.body;

    const inventory = await Inventory.findOne({ product });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    await inventory.adjustStock(newQuantity, reference, req.user._id, notes);

    const updatedInventory = await Inventory.findById(inventory._id)
      .populate('product', 'name sku');

    res.json({
      success: true,
      message: 'Stock adjusted successfully',
      data: updatedInventory
    });

  } catch (error) {
    console.error('Adjust stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Transfer stock between products (if applicable)
router.post('/transfer-stock', auth, async (req, res) => {
  try {
    const { error } = stockTransferSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { fromProduct, toProduct, quantity, notes } = req.body;

    const fromInventory = await Inventory.findOne({ product: fromProduct });
    const toInventory = await Inventory.findOne({ product: toProduct });

    if (!fromInventory || !toInventory) {
      return res.status(404).json({
        success: false,
        message: 'One or both products not found in inventory'
      });
    }

    if (fromInventory.availableStock < quantity) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient stock for transfer'
      });
    }

    // Reduce from source
    await fromInventory.reduceStock(
      quantity,
      'Stock Transfer',
      null,
      req.user._id,
      `Transfer to ${toInventory.product}: ${notes || ''}`
    );

    // Add to destination
    await toInventory.addStock(
      quantity,
      'Stock Transfer',
      null,
      req.user._id,
      `Transfer from ${fromInventory.product}: ${notes || ''}`
    );

    res.json({
      success: true,
      message: 'Stock transferred successfully',
      data: {
        from: await Inventory.findById(fromInventory._id).populate('product', 'name sku'),
        to: await Inventory.findById(toInventory._id).populate('product', 'name sku')
      }
    });

  } catch (error) {
    console.error('Transfer stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Get stock movements for a product
router.get('/movements/:productId', auth, async (req, res) => {
  try {
    const { page = 1, limit = 50, type, startDate, endDate } = req.query;

    const inventory = await Inventory.findOne({ product: req.params.productId });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    let movements = inventory.stockMovements || [];

    // Filter by type
    if (type) {
      movements = movements.filter(movement => movement.type === type);
    }

    // Filter by date range
    if (startDate || endDate) {
      movements = movements.filter(movement => {
        const movementDate = new Date(movement.date);
        if (startDate && movementDate < new Date(startDate)) return false;
        if (endDate && movementDate > new Date(endDate)) return false;
        return true;
      });
    }

    // Sort by date (newest first)
    movements.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Pagination
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + parseInt(limit);
    const paginatedMovements = movements.slice(startIndex, endIndex);

    // Populate user information
    await Inventory.populate(paginatedMovements, {
      path: 'user',
      select: 'name'
    });

    res.json({
      success: true,
      data: paginatedMovements,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(movements.length / limit),
        totalItems: movements.length,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get stock movements error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get low stock report
router.get('/reports/low-stock', auth, async (req, res) => {
  try {
    const lowStockItems = await Inventory.aggregate([
      {
        $match: {
          isActive: true,
          $expr: { $lte: ['$currentStock', '$reorderLevel'] }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      {
        $unwind: '$productInfo'
      },
      {
        $project: {
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          category: '$productInfo.category',
          currentStock: 1,
          reorderLevel: 1,
          minStockLevel: 1,
          maxStockLevel: 1,
          totalValue: 1,
          lastStockUpdate: 1
        }
      },
      {
        $sort: { currentStock: 1 }
      }
    ]);

    res.json({
      success: true,
      data: lowStockItems
    });

  } catch (error) {
    console.error('Get low stock report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get inventory valuation report
router.get('/reports/valuation', auth, async (req, res) => {
  try {
    const valuation = await Inventory.aggregate([
      {
        $match: { isActive: true }
      },
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      {
        $unwind: '$productInfo'
      },
      {
        $project: {
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          category: '$productInfo.category',
          currentStock: 1,
          averageCostPrice: 1,
          totalValue: { $multiply: ['$currentStock', '$averageCostPrice'] },
          sellingPrice: '$productInfo.pricing.sellingPrice',
          potentialRevenue: { $multiply: ['$currentStock', '$productInfo.pricing.sellingPrice'] }
        }
      },
      {
        $group: {
          _id: '$category',
          items: { $push: '$$ROOT' },
          totalCostValue: { $sum: '$totalValue' },
          totalPotentialRevenue: { $sum: '$potentialRevenue' },
          itemCount: { $sum: 1 }
        }
      },
      {
        $sort: { totalCostValue: -1 }
      }
    ]);

    const summary = await Inventory.aggregate([
      {
        $match: { isActive: true }
      },
      {
        $group: {
          _id: null,
          totalInventoryValue: { $sum: '$totalValue' },
          totalItems: { $sum: 1 },
          averageStockLevel: { $avg: '$currentStock' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        categories: valuation,
        summary: summary[0] || {
          totalInventoryValue: 0,
          totalItems: 0,
          averageStockLevel: 0
        }
      }
    });

  } catch (error) {
    console.error('Get inventory valuation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update inventory settings
router.put('/:inventoryId/settings', auth, async (req, res) => {
  try {
    const settingsSchema = Joi.object({
      minStockLevel: Joi.number().min(0).optional(),
      maxStockLevel: Joi.number().min(0).optional(),
      reorderLevel: Joi.number().min(0).optional(),
      reorderQuantity: Joi.number().min(0).optional(),
      location: Joi.object({
        warehouse: Joi.string().optional(),
        section: Joi.string().optional(),
        shelf: Joi.string().optional(),
        bin: Joi.string().optional()
      }).optional()
    });

    const { error } = settingsSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const inventory = await Inventory.findByIdAndUpdate(
      req.params.inventoryId,
      req.body,
      { new: true, runValidators: true }
    ).populate('product', 'name sku');

    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found'
      });
    }

    res.json({
      success: true,
      message: 'Inventory settings updated successfully',
      data: inventory
    });

  } catch (error) {
    console.error('Update inventory settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Generate catalog QR code for distributor
router.get('/catalog-qr', auth, async (req, res) => {
  try {
    // Get buyer/distributor info from user
    const user = req.user;
    let buyerId = null;

    // Try to get buyer ID from user
    if (user.buyer) {
      buyerId = user.buyer._id || user.buyer;
    } else if (user.buyerId) {
      buyerId = user.buyerId;
    } else {
      // Try to find buyer by email
      const buyer = await Buyer.findOne({ email: user.email, customerType: 'distributor' });
      if (buyer) {
        buyerId = buyer._id;
      }
    }

    // Build catalog URL
    const baseUrl = process.env.FRONTEND_URL || process.env.DISTRIBUTOR_PORTAL_URL || 'https://catalog.example.com';
    const catalogUrl = `${baseUrl}/catalog`;

    // Generate QR code
    const qrCode = await generateCatalogQR(buyerId, catalogUrl, user._id);

    return sendResponse.success(res, qrCode, 'Catalog QR code generated successfully');
  } catch (error) {
    console.error('Generate catalog QR code error:', error);
    return sendResponse.error(res, error.message || 'Unable to generate catalog QR code', 500);
  }
});

// Get variant stock breakdown for a product
router.get('/:productId/variants', auth, async (req, res) => {
  try {
    const Product = require('../models/Product');

    const product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!product.variantTracking || !product.variantTracking.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Variant tracking is not enabled for this product'
      });
    }

    const inventory = await Inventory.findOne({ product: product._id });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    // Prepare variant data with stock levels
    const variantData = inventory.variantComposition.map(variant => ({
      size: variant.size,
      color: variant.color,
      quantity: variant.quantity,
      reservedQuantity: variant.reservedQuantity,
      availableQuantity: variant.quantity - variant.reservedQuantity
    }));

    res.json({
      success: true,
      data: {
        productId: product._id,
        productName: product.name,
        sku: product.sku,
        totalStock: inventory.currentStock,
        totalReserved: inventory.reservedStock,
        totalAvailable: inventory.availableStock,
        variants: variantData
      }
    });

  } catch (error) {
    console.error('Get variant stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Adjust variant stock (Admin only)
router.post('/adjust-variant', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can adjust variant stock'
      });
    }

    const adjustVariantSchema = Joi.object({
      productId: Joi.string().required(),
      size: Joi.string().required().trim(),
      color: Joi.string().required().trim(),
      newQuantity: Joi.number().min(0).required(),
      notes: Joi.string().optional()
    });

    const { error, value } = adjustVariantSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { productId, size, color, newQuantity, notes } = value;

    const Product = require('../models/Product');
    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!product.variantTracking || !product.variantTracking.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Variant tracking is not enabled for this product'
      });
    }

    const inventory = await Inventory.findOne({ product: product._id });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    // Find or create variant
    let variant = inventory.variantComposition.find(
      v => v.size === size && v.color === color
    );

    const oldQuantity = variant ? variant.quantity : 0;
    const difference = newQuantity - oldQuantity;

    if (variant) {
      variant.quantity = newQuantity;
    } else {
      inventory.variantComposition.push({
        size,
        color,
        quantity: newQuantity,
        reservedQuantity: 0
      });
    }

    // Adjust total stock
    inventory.currentStock += difference;

    // Add stock movement
    inventory.stockMovements.push({
      type: 'adjustment',
      quantity: difference,
      reference: 'VariantAdjustment',
      user: req.user._id,
      notes: `Variant ${color}-${size} adjusted from ${oldQuantity} to ${newQuantity}. ${notes || ''}`
    });

    inventory.lastStockUpdate = new Date();
    await inventory.save();

    res.json({
      success: true,
      message: 'Variant stock adjusted successfully',
      data: {
        size,
        color,
        oldQuantity,
        newQuantity,
        difference,
        totalStock: inventory.currentStock
      }
    });

  } catch (error) {
    console.error('Adjust variant stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;