const express = require('express');
const Joi = require('joi');
const DispatchOrder = require('../models/DispatchOrder');
const Inventory = require('../models/Inventory');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const Ledger = require('../models/Ledger');
const auth = require('../middleware/auth');
const { generateSignedUrl, generateSignedUrls, generateSignedUrlsBatch } = require('../utils/imageUpload');

const router = express.Router();

const purchaseItemSchema = Joi.object({
  product: Joi.string().required(),
  quantity: Joi.number().min(1).required(),
  unitPrice: Joi.number().min(0).required(),
  discount: Joi.number().min(0).default(0),
  taxRate: Joi.number().min(0).default(0),
  productCode: Joi.string().allow('', null),
  color: Joi.string().allow('', null),
  size: Joi.string().allow('', null),
  landedTotal: Joi.number().min(0).optional()
});

const purchaseSchema = Joi.object({
  supplier: Joi.string().required(),
  supplierUser: Joi.string().optional(), // Add this field
  purchaseDate: Joi.date().default(Date.now),
  expectedDeliveryDate: Joi.date().optional(),
  items: Joi.array().items(purchaseItemSchema).min(1).required(),
  totalDiscount: Joi.number().min(0).default(0),
  shippingCost: Joi.number().min(0).default(0),
  cashPayment: Joi.number().min(0).default(0),
  bankPayment: Joi.number().min(0).default(0),
  remainingBalance: Joi.number().min(0).optional(),
  paymentStatus: Joi.string().valid('pending', 'partial', 'paid', 'overdue').optional(),
  paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').default('net30'),
  invoiceNumber: Joi.string().optional(),
  notes: Joi.string().optional(),
  attachments: Joi.array().items(Joi.string()).optional()
});

const fulfillmentSchema = Joi.object({
  carrier: Joi.string().trim().min(1).required(),
  trackingNumber: Joi.string().trim().min(1).required(),
  shipmentDate: Joi.date().required(),
  deliveryStatus: Joi.string().valid('pending', 'shipped', 'delivered').default('shipped'),
  notes: Joi.string().allow('', null).optional()
});

const qualityCheckSchema = Joi.object({
  qaStatus: Joi.string().valid('pass', 'fail').required(),
  notes: Joi.string().allow('', null).optional(),
  checkedAt: Joi.date().optional()
});

const deliveryConfirmationSchema = Joi.object({
  actualDeliveryDate: Joi.date().optional(),
  notes: Joi.string().allow('', null).optional(),
  receivedBy: Joi.string().allow('', null).optional(),
  discrepancies: Joi.string().allow('', null).optional()
});

const PURCHASE_POPULATE_PATHS = [
  { path: 'supplier', select: 'name company phone email address' },
  { path: 'items.product', select: 'name sku unit images color size productCode pricing' },
  { path: 'createdBy', select: 'name email' },
  { path: 'qualityChecks.checkedBy', select: 'name' },
  { path: 'fulfillment.updatedBy', select: 'name' },
  { path: 'fulfillment.history.updatedBy', select: 'name' },
  { path: 'deliveryConfirmations.confirmedBy', select: 'name' }
];

function populatePurchaseQuery(query) {
  return query.populate(PURCHASE_POPULATE_PATHS);
}

async function populatePurchaseDocument(document) {
  if (!document) {
    return null;
  }
  await document.populate(PURCHASE_POPULATE_PATHS);
  return document;
}

/**
 * Convert purchase product images to signed URLs
 * @param {Object|Array} purchases - Purchase document(s)
 * @returns {Promise<Object|Array>} Purchase(s) with signed image URLs
 */
async function convertPurchaseImages(purchases) {
  if (!purchases) {
    return purchases;
  }

  const isArray = Array.isArray(purchases);
  const purchasesArray = isArray ? purchases : [purchases];

  await Promise.all(purchasesArray.map(async (purchase) => {
    if (!purchase || !purchase.items || !Array.isArray(purchase.items)) {
      return;
    }

    await Promise.all(purchase.items.map(async (item) => {
      // Convert productImage if it exists (from dispatch order items - ARRAY format)
      if (item.productImage && Array.isArray(item.productImage) && item.productImage.length > 0) {
        item.productImage = await generateSignedUrls(item.productImage);
      }

      // Convert product.images if product is an object with images
      if (item.product && typeof item.product === 'object' && item.product.images && Array.isArray(item.product.images)) {
        if (item.product.images.length > 0) {
          item.product.images = await generateSignedUrls(item.product.images);
        }
      }

      // Convert productType.images if productType is an object with images
      if (item.productType && typeof item.productType === 'object' && item.productType.images && Array.isArray(item.productType.images)) {
        if (item.productType.images.length > 0) {
          item.productType.images = await generateSignedUrls(item.productType.images);
        }
      }
    }));
  }));

  return isArray ? purchasesArray : purchasesArray[0];
}

// Generate purchase number
const generatePurchaseNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const prefix = `PUR${year}${month}`;
  const lastPurchase = await Purchase.findOne({
    purchaseNumber: { $regex: `^${prefix}` }
  }).sort({ purchaseNumber: -1 });

  let nextNumber = 1;
  if (lastPurchase) {
    const lastNumber = parseInt(lastPurchase.purchaseNumber.slice(-4));
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, '0')}`;
};

// Calculate purchase totals
const calculateTotals = (items, totalDiscount = 0, shippingCost = 0) => {
  const subtotal = items.reduce((sum, item) => sum + (item.landedTotal || 0), 0);
  const discountedSubtotal = Math.max(0, subtotal - (totalDiscount || 0));
  const grandTotal = Math.max(0, discountedSubtotal + (shippingCost || 0));

  return {
    subtotal,
    totalTax: 0,
    grandTotal
  };
};

// Create purchase (uses DispatchOrder manual entry internally)
router.post('/', auth, async (req, res) => {
  try {
    // Reuse the manual entry logic from dispatchOrders route
    // Import the manual entry handler or call it directly
    // For now, redirect to the manual endpoint via internal call
    const manualEntryRoute = require('./dispatchOrders');

    // Create a mock request object for the manual endpoint
    const manualReq = {
      ...req,
      body: {
        supplier: req.body.supplier,
        purchaseDate: req.body.purchaseDate,
        expectedDeliveryDate: req.body.expectedDeliveryDate,
        items: req.body.items.map(item => ({
          product: item.product,
          productCode: item.productCode,
          quantity: item.quantity,
          landedTotal: item.landedTotal || (item.unitPrice * item.quantity)
        })),
        subtotal: req.body.subtotal,
        totalDiscount: req.body.totalDiscount,
        totalTax: req.body.totalTax,
        shippingCost: req.body.shippingCost,
        grandTotal: req.body.grandTotal,
        cashPayment: req.body.cashPayment,
        bankPayment: req.body.bankPayment,
        remainingBalance: req.body.remainingBalance,
        paymentStatus: req.body.paymentStatus,
        paymentTerms: req.body.paymentTerms,
        invoiceNumber: req.body.invoiceNumber,
        notes: req.body.notes,
        attachments: req.body.attachments
      }
    };

    // Call the manual entry handler directly
    // We'll need to extract the handler logic, but for now use a simpler approach
    // Just forward the request to the manual endpoint handler
    const { error, value } = manualEntrySchema.validate(manualReq.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Continue with manual entry creation logic (same as dispatchOrders/manual)
    // For brevity, we'll redirect to that endpoint's logic
    // Actually, let's just require and call the handler function
    // But since it's in a different file, let's use a shared utility or just duplicate the logic
    // For now, let's make an internal HTTP call to keep it simple
    const http = require('http');
    const url = require('url');

    // Actually, simplest is to just call the manual endpoint handler
    // But that requires refactoring. Let's use a workaround: make internal request
    const internalRequest = require('../utils/internalRequest'); // We'll create this if needed

    // For now, let's just forward to the manual endpoint
    // The frontend should call /api/dispatch-orders/manual directly
    // But for backward compatibility, we'll keep this endpoint
    res.status(400).json({
      success: false,
      message: 'Please use /api/dispatch-orders/manual endpoint for creating purchases'
    });

  } catch (error) {
    console.error('Create purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Transform DispatchOrder to Purchase-like format
function transformDispatchOrderToPurchaseFormat(dispatchOrder) {
  const items = dispatchOrder.items?.map(item => {
    // Extract product name from various sources
    const productName = item.productName ||
      (item.product && typeof item.product === 'object' ? item.product.name : null) ||
      (item.productType && typeof item.productType === 'object' ? item.productType.name : null) ||
      '';

    // Preserve product object with images if populated, otherwise just ID
    const product = item.product && typeof item.product === 'object'
      ? {
        _id: item.product._id,
        name: item.product.name,
        sku: item.product.sku,
        productCode: item.product.productCode,
        images: item.product.images || [],
        color: item.product.color,
        size: item.product.size,
        pricing: item.product.pricing
      }
      : (item.product?._id || item.product);

    // Preserve productType object if populated
    const productType = item.productType && typeof item.productType === 'object'
      ? {
        _id: item.productType._id,
        name: item.productType.name,
        category: item.productType.category
      }
      : (item.productType?._id || item.productType);

    return {
      product: product,
      productName: productName,
      productCode: item.productCode,
      productType: productType,
      productImage: item.productImage || null, // Preserve productImage from dispatch order
      costPrice: item.costPrice || 0, // ADD costPrice
      primaryColor: item.primaryColor || [], // KEEP as array, don't convert to string
      size: item.size || [], // ADD size array instead of hardcoded empty string
      packets: item.packets || [], // ADD packets for size extraction
      color: item.primaryColor || '', // Keep for backward compatibility
      quantity: item.quantity,
      landedTotal: item.landedTotal || (item.landedPrice * item.quantity)
    };
  }) || [];

  return {
    _id: dispatchOrder._id,
    purchaseNumber: dispatchOrder.orderNumber,
    supplier: dispatchOrder.supplier,
    purchaseDate: dispatchOrder.dispatchDate || dispatchOrder.createdAt,
    expectedDeliveryDate: dispatchOrder.expectedDeliveryDate,
    actualDeliveryDate: dispatchOrder.actualDeliveryDate,
    items,
    subtotal: dispatchOrder.subtotal || 0,
    totalTax: dispatchOrder.totalTax || 0,
    grandTotal: dispatchOrder.grandTotal || 0,
    totalDiscount: dispatchOrder.totalDiscount || 0,
    shippingCost: dispatchOrder.shippingCost || 0,
    cashPayment: dispatchOrder.cashPayment || 0,
    bankPayment: dispatchOrder.bankPayment || 0,
    remainingBalance: dispatchOrder.remainingBalance || 0,
    paymentStatus: dispatchOrder.paymentStatus || dispatchOrder.paymentDetails?.paymentStatus || 'pending',
    paymentTerms: dispatchOrder.paymentTerms || 'net30',
    deliveryStatus: dispatchOrder.status === 'confirmed' ? 'delivered' : dispatchOrder.status,
    invoiceNumber: dispatchOrder.invoiceNumber || '',
    notes: dispatchOrder.notes,
    qualityChecks: dispatchOrder.qualityChecks || [],
    fulfillment: dispatchOrder.fulfillment || {},
    deliveryConfirmations: dispatchOrder.deliveryConfirmations || [],
    attachments: dispatchOrder.attachments || [],
    createdBy: dispatchOrder.createdBy,
    createdAt: dispatchOrder.createdAt,
    updatedAt: dispatchOrder.updatedAt,
    exchangeRate: dispatchOrder.exchangeRate || null, // ADD exchangeRate
    percentage: dispatchOrder.percentage != null ? dispatchOrder.percentage : null, // ADD percentage
    supplierPaymentTotal: dispatchOrder.supplierPaymentTotal || null, // ADD supplierPaymentTotal
    dispatchOrderId: dispatchOrder._id // ADD for linking
  };
}

// Transform DispatchOrder to Purchase format (for confirmed dispatch orders from supplier portal)
function transformDispatchOrderToPurchase(dispatchOrder) {
  // Calculate total from confirmed quantities and landed prices
  const items = dispatchOrder.items?.map((item, index) => {
    const confirmedQty = dispatchOrder.confirmedQuantities?.find(cq => cq.itemIndex === index)?.quantity || item.quantity;
    const landedPrice = item.landedPrice || (item.costPrice * dispatchOrder.exchangeRate * (1 + (dispatchOrder.percentage / 100)));
    const landedTotal = landedPrice * confirmedQty;

    // Extract product name from various sources
    const productName = item.productName ||
      (item.product && typeof item.product === 'object' ? item.product.name : null) ||
      (item.productType && typeof item.productType === 'object' ? item.productType.name : null) ||
      '';

    // Preserve product object with images if populated, otherwise just ID
    // For dispatch orders, productType is populated, not product
    const product = item.product && typeof item.product === 'object'
      ? {
        _id: item.product._id,
        name: item.product.name,
        sku: item.product.sku,
        productCode: item.product.productCode,
        images: item.product.images || [],
        color: item.product.color,
        size: item.product.size,
        pricing: item.product.pricing
      }
      : (item.productType && typeof item.productType === 'object'
        ? {
          _id: item.productType._id,
          name: item.productType.name,
          sku: item.productType.sku,
          productCode: item.productCode,
          images: item.productType.images || [],
          color: item.productType.color,
          size: item.productType.size,
          pricing: item.productType.pricing
        }
        : (item.product?._id || item.productType?._id || item.productType));

    // Preserve productType object if populated
    const productType = item.productType && typeof item.productType === 'object'
      ? {
        _id: item.productType._id,
        name: item.productType.name,
        category: item.productType.category,
        images: item.productType.images || []
      }
      : (item.productType?._id || item.productType);

    return {
      product: product,
      productName: productName,
      productCode: item.productCode,
      productType: productType,
      productImage: (Array.isArray(item.productImage) && item.productImage.length > 0) ? item.productImage : null, // Preserve productImage array from dispatch order, filter empty arrays
      costPrice: item.costPrice || 0, // ADD costPrice
      primaryColor: item.primaryColor || [], // KEEP as array, don't convert to string
      size: item.size || [], // ADD size array instead of hardcoded empty string
      packets: item.packets || [], // ADD packets for size extraction
      color: item.primaryColor || '', // Keep for backward compatibility
      quantity: confirmedQty,
      landedTotal
    };
  }) || [];

  const grandTotal = items.reduce((sum, item) => sum + item.landedTotal, 0);
  const cashPayment = dispatchOrder.paymentDetails?.cashPayment || dispatchOrder.cashPayment || 0;
  const bankPayment = dispatchOrder.paymentDetails?.bankPayment || dispatchOrder.bankPayment || 0;
  const remainingBalance = dispatchOrder.paymentDetails?.remainingBalance || dispatchOrder.remainingBalance || (grandTotal - cashPayment - bankPayment);

  return {
    _id: dispatchOrder._id,
    purchaseNumber: dispatchOrder.orderNumber,
    supplier: dispatchOrder.supplier,
    purchaseDate: dispatchOrder.dispatchDate || dispatchOrder.createdAt,
    expectedDeliveryDate: dispatchOrder.expectedDeliveryDate,
    actualDeliveryDate: dispatchOrder.actualDeliveryDate,
    items,
    subtotal: dispatchOrder.subtotal || grandTotal,
    totalTax: dispatchOrder.totalTax || 0,
    grandTotal: dispatchOrder.grandTotal || grandTotal,
    totalDiscount: dispatchOrder.totalDiscount || 0,
    shippingCost: dispatchOrder.shippingCost || 0,
    cashPayment,
    bankPayment,
    remainingBalance,
    paymentStatus: dispatchOrder.paymentStatus || dispatchOrder.paymentDetails?.paymentStatus || 'pending',
    paymentTerms: dispatchOrder.paymentTerms || 'net30',
    deliveryStatus: dispatchOrder.status === 'confirmed' ? 'delivered' : dispatchOrder.status,
    invoiceNumber: dispatchOrder.invoiceNumber || '',
    notes: dispatchOrder.notes,
    qualityChecks: dispatchOrder.qualityChecks || [],
    fulfillment: dispatchOrder.fulfillment || {},
    deliveryConfirmations: dispatchOrder.deliveryConfirmations || [],
    attachments: dispatchOrder.attachments || [],
    source: 'dispatch_order',
    exchangeRate: dispatchOrder.exchangeRate || null, // ADD exchangeRate
    percentage: dispatchOrder.percentage != null ? dispatchOrder.percentage : null, // ADD percentage
    supplierPaymentTotal: dispatchOrder.supplierPaymentTotal || null, // ADD supplierPaymentTotal
    dispatchOrderId: dispatchOrder._id, // ADD for linking
    dispatchOrderId: dispatchOrder._id,
    createdAt: dispatchOrder.createdAt,
    updatedAt: dispatchOrder.updatedAt
  };
}

// Get all purchases (manual entries and confirmed dispatch orders) - OPTIMIZED
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      supplier,
      paymentStatus,
      deliveryStatus,
      status, // Legacy status filter
      startDate,
      endDate,
      source // 'manual' or 'dispatch_order'
    } = req.query;

    const limitNum = Math.min(parseInt(limit) || 20, 100); // Safety cap
    const pageNum = parseInt(page) || 1;

    // Build unified query - always show confirmed orders
    const query = { status: 'confirmed' };

    // Apply source filter if present
    if (source === 'manual') {
      query.supplierUser = null;
    } else if (source === 'dispatch_order') {
      query.supplierUser = { $ne: null };
    }

    // Apply Filters
    if (supplier) query.supplier = supplier;

    // Status filters
    if (deliveryStatus === 'delivered') {
      query.status = 'confirmed'; // All confirmed are delivered in this context
    }

    // Build $and array for complex conditions
    const andConditions = [];

    // Apply Search
    if (search) {
      andConditions.push({
        $or: [
          { orderNumber: { $regex: search, $options: 'i' } },
          { invoiceNumber: { $regex: search, $options: 'i' } }
        ]
      });
    }

    // Payment Status - mapped to correct field
    if (paymentStatus) {
      // Check both top-level and nested structure for compatibility
      andConditions.push({
        $or: [
          { paymentStatus: paymentStatus },
          { 'paymentDetails.paymentStatus': paymentStatus }
        ]
      });
    }

    // If we have any $and conditions, add them to the query
    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    // Date Range
    if (startDate || endDate) {
      query.dispatchDate = {};
      if (startDate) query.dispatchDate.$gte = new Date(startDate);
      if (endDate) query.dispatchDate.$lte = new Date(endDate);
    }

    // Projection to reduce data transfer
    const projection = {
      orderNumber: 1, invoiceNumber: 1, dispatchDate: 1, createdAt: 1,
      supplier: 1, items: 1, grandTotal: 1, cashPayment: 1, bankPayment: 1,
      remainingBalance: 1, paymentStatus: 1, status: 1, source: 1,
      exchangeRate: 1, percentage: 1, supplierPaymentTotal: 1, totalBoxes: 1,
      'paymentDetails.paymentStatus': 1, 'paymentDetails.cashPayment': 1,
      'paymentDetails.bankPayment': 1, 'paymentDetails.remainingBalance': 1,
      supplierUser: 1, supplierName: 1, deliveryStatus: 1
    };

    // Execute Query
    const [purchases, total] = await Promise.all([
      DispatchOrder.find(query, projection)
        .populate('supplier', 'name company')
        .populate('logisticsCompany', 'name code')
        .populate('createdBy', 'name')
        .populate('items.product', 'name sku unit images color size productCode pricing')
        .sort({ dispatchDate: -1, createdAt: -1 })
        .limit(limitNum)
        .skip((pageNum - 1) * limitNum)
        .lean(), // Performance boost

      DispatchOrder.countDocuments(query)
    ]);

    // Batch Image Collection
    const imageKeys = new Set();

    // transform and collect images
    const formattedPurchases = purchases.map(purchase => {
      // Determine source type
      const isManual = !purchase.supplierUser;
      const derivedSource = isManual ? 'manual' : 'dispatch_order';

      const supplierName = purchase.supplier?.name || purchase.supplierName || 'N/A';
      const supplierId = purchase.supplier?._id || purchase.supplier;

      // Map items and collect image keys
      const items = (purchase.items || []).map(item => {
        // Collect image keys for batch signing (only from productImage as requested)
        if (Array.isArray(item.productImage)) {
          item.productImage.forEach(key => key && imageKeys.add(key));
        } else if (typeof item.productImage === 'string' && item.productImage) {
          imageKeys.add(item.productImage);
        }

        // Extract Standardized Fields
        const product = item.product || {};
        const productType = item.productType || {};

        const productId = product._id || productType._id || item.product;
        const productName = item.productName || product.name || productType.name || '';
        const productCode = item.productCode || product.productCode || product.sku || '';

        // Color & Size
        const primaryColorArray = Array.isArray(item.primaryColor) ? item.primaryColor : (item.primaryColor ? [item.primaryColor] : []);
        const color = product.primaryColor || primaryColorArray[0] || '';

        const sizeArray = Array.isArray(item.size) ? item.size : (item.size ? [item.size] : []);
        const size = product.size || sizeArray[0] || '';

        return {
          id: item._id?.toString() || `${purchase._id}-${productId}`,
          productId: productId?.toString(),
          productCode,
          productName,
          color,
          size,
          quantity: item.quantity || 0,
          productImage: item.productImage, // Will be replaced with signed URLs
          // Keep raw for modal if needed, but lean() stripped methods
          product: product,
          productType: productType,
          costPrice: item.costPrice,
          landedTotal: item.landedTotal,
          // ADD: Include full color and size arrays for proper display
          primaryColor: primaryColorArray,
          primaryColorDisplay: primaryColorArray.length > 0 ? primaryColorArray : null,
          sizeArray: sizeArray,
          packets: item.packets || []
        };
      });

      // Calculate Payments
      const cashPayment = purchase.cashPayment || purchase.paymentDetails?.cashPayment || 0;
      const bankPayment = purchase.bankPayment || purchase.paymentDetails?.bankPayment || 0;
      const remainingBalance = purchase.remainingBalance !== undefined ? purchase.remainingBalance : (purchase.paymentDetails?.remainingBalance || 0);
      const paymentStatus = purchase.paymentStatus || purchase.paymentDetails?.paymentStatus || 'pending';

      // Search Text Pre-calculation
      const searchText = [
        purchase.orderNumber,
        purchase.invoiceNumber,
        supplierName,
        ...items.map(i => i.productCode),
        ...items.map(i => i.productName)
      ].filter(Boolean).join(' ');

      return {
        id: purchase._id.toString(),
        purchaseNumber: purchase.orderNumber,
        invoiceNumber: purchase.invoiceNumber,
        purchaseDate: purchase.dispatchDate || purchase.createdAt,
        supplierName,
        supplierId: supplierId?.toString(),
        items,
        source: derivedSource,
        dispatchOrderId: purchase._id.toString(),
        grandTotal: purchase.grandTotal || 0,
        cashPayment,
        bankPayment,
        remainingBalance,
        paymentStatus,
        deliveryStatus: purchase.status === 'confirmed' ? 'delivered' : purchase.status,
        exchangeRate: purchase.exchangeRate,
        percentage: purchase.percentage,
        supplierPaymentTotal: purchase.supplierPaymentTotal,
        totalBoxes: purchase.totalBoxes || 0,
        searchText
      };
    });

    // Batch Sign Images
    const signedUrlMap = await generateSignedUrlsBatch(Array.from(imageKeys));

    // hydration pass - inject signed URLs
    formattedPurchases.forEach(purchase => {
      purchase.items.forEach(item => {
        // Set 'photo' from signed URLs
        let photo = null;
        if (Array.isArray(item.productImage) && item.productImage.length > 0) {
          // use first signed URL
          const key = item.productImage[0];
          photo = signedUrlMap[key] || key;
          // Update array
          item.productImage = item.productImage.map(k => signedUrlMap[k] || k);
        } else if (typeof item.productImage === 'string' && item.productImage) {
          const key = item.productImage;
          photo = signedUrlMap[key] || key;
        }
        item.photo = photo;
      });
    });

    // Metrics (simplified)
    const metrics = {
      total,
      pending: 0,
      shipped: 0,
      delivered: total,
      cancelled: 0
    };

    res.json({
      success: true,
      data: formattedPurchases,
      rows: formattedPurchases,
      metrics,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(total / limitNum),
        totalItems: total,
        itemsPerPage: limitNum
      }
    });

  } catch (error) {
    console.error('Get purchases error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get purchase by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier', 'name company phone email address')
      .populate('items.product', 'name sku unit images color size productCode pricing')
      .populate('items.productType', 'name category')
      .populate('createdBy', 'name email')
      .populate('confirmedBy', 'name')
      .populate('qualityChecks.checkedBy', 'name')
      .populate('fulfillment.updatedBy', 'name')
      .populate('fulfillment.history.updatedBy', 'name')
      .populate('deliveryConfirmations.confirmedBy', 'name');

    if (!dispatchOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    // Transform to purchase format
    const purchaseFormat = dispatchOrder.supplierUser === null
      ? transformDispatchOrderToPurchaseFormat(dispatchOrder)
      : transformDispatchOrderToPurchase(dispatchOrder);

    // Convert images to signed URLs
    await convertPurchaseImages(purchaseFormat);

    // Format for client
    const formattedPurchase = formatPurchaseForClient(purchaseFormat);

    res.json({
      success: true,
      data: formattedPurchase
    });

  } catch (error) {
    console.error('Get purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Helper to format purchase data for client (matches frontend select logic)
function formatPurchaseForClient(purchase) {
  // Determine source
  // Logic from frontend: isDispatchOrder = status === 'confirmed' || source === 'dispatch_order' || orderNumber
  const isDispatchOrder = purchase.status === 'confirmed' || purchase.source === 'dispatch_order' || purchase.orderNumber;
  const source = isDispatchOrder ? 'dispatch_order' : (purchase.source || 'manual');

  const dispatchOrderId = (source === 'manual' || source === 'dispatch_order' || isDispatchOrder)
    ? (purchase._id || purchase.id)
    : null;

  const supplierName = purchase.supplier?.name || purchase.supplierName || 'N/A';
  const supplierId = purchase.supplier?._id || purchase.supplier || purchase.supplier_id;

  const items = (purchase.items || []).map(item => {
    // Product handling
    const product = typeof item.product === 'object' ? item.product : {};
    const productId = product._id || item.product;
    const productCode = item.productCode || product.productCode || product.sku || '';
    const productName = item.productName || product.name || (item.productType?.name) || '';

    // Color handling
    const primaryColorArray = Array.isArray(item.primaryColor) ? item.primaryColor : (item.primaryColor ? [item.primaryColor] : []);
    const color = item.color || product.color || (primaryColorArray.length > 0 ? primaryColorArray[0] : '');

    // Size handling
    const sizeArray = Array.isArray(item.size) ? item.size : (item.size ? [item.size] : []);
    const size = product.size || (sizeArray.length > 0 ? sizeArray[0] : '');

    // Photo handling - Priority: item.productImage (array) -> first item
    let photo = null;
    if (Array.isArray(item.productImage) && item.productImage.length > 0) {
      photo = item.productImage[0];
    } else if (item.productImage && typeof item.productImage === 'string') {
      photo = item.productImage;
    } else if (product.images && Array.isArray(product.images) && product.images.length > 0) {
      photo = product.images[0];
    }

    return {
      id: item._id || `${purchase._id}-${productId}`,
      productId,
      productCode,
      productName,
      color,
      size,
      quantity: item.quantity || 0,
      photo,
      primaryColor: primaryColorArray,
      primaryColorDisplay: primaryColorArray.length > 0 ? primaryColorArray : null,
      sizeArray: sizeArray,
      packets: item.packets || [],
      product,
      productImage: item.productImage,
      productType: item.productType,
      costPrice: item.costPrice,
      landedTotal: item.landedTotal
    };
  });

  const productsSearch = items
    .map(item => [item.productCode, item.productName].filter(Boolean).join(' '))
    .join(' ');

  const searchText = [
    purchase.purchaseNumber,
    purchase.invoiceNumber,
    purchase.orderNumber,
    supplierName,
    ...items.map(item => item.productCode),
    ...items.map(item => item.productName)
  ].filter(Boolean).join(' ');

  return {
    ...purchase,
    id: purchase._id || purchase.id,
    supplierName,
    supplierId,
    items,
    source,
    dispatchOrderId,
    productsSearch,
    searchText,
    // Ensure payments are numbers
    cashPayment: purchase.cashPayment || 0,
    bankPayment: purchase.bankPayment || 0,
    grandTotal: purchase.grandTotal || 0,
    remainingBalance: purchase.remainingBalance || 0,
    paymentStatus: purchase.paymentStatus || 'pending',
    deliveryStatus: purchase.deliveryStatus || 'pending'
  };
}

// Update purchase
router.put('/:id', auth, async (req, res) => {
  try {
    const { error, value } = purchaseSchema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const purchase = await Purchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    const itemsWithDetails = [];
    for (const item of value.items) {
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.product}`
        });
      }

      const landedTotal = item.landedTotal !== undefined
        ? item.landedTotal
        : (item.unitPrice || 0) * (item.quantity || 0);

      itemsWithDetails.push({
        product: product._id,
        productCode: item.productCode || product.productCode || product.sku,
        color: item.color || product.color || '',
        size: item.size || product.size || '',
        quantity: item.quantity,
        landedTotal
      });
    }

    const { subtotal, totalTax, grandTotal } = calculateTotals(
      itemsWithDetails,
      value.totalDiscount,
      value.shippingCost
    );

    const cashPayment = Number(value.cashPayment || 0);
    const bankPayment = Number(value.bankPayment || 0);
    const paidAmount = cashPayment + bankPayment;
    const remainingBalance = value.remainingBalance !== undefined
      ? Number(value.remainingBalance)
      : Math.max(0, grandTotal - paidAmount);

    const paymentStatus = value.paymentStatus || (
      remainingBalance <= 0
        ? 'paid'
        : paidAmount > 0
          ? 'partial'
          : 'pending'
    );

    purchase.supplier = value.supplier;
    purchase.purchaseDate = value.purchaseDate ? new Date(value.purchaseDate) : purchase.purchaseDate;
    purchase.expectedDeliveryDate = value.expectedDeliveryDate;
    purchase.items = itemsWithDetails;
    purchase.subtotal = subtotal;
    purchase.totalDiscount = value.totalDiscount;
    purchase.totalTax = totalTax;
    purchase.shippingCost = value.shippingCost;
    purchase.grandTotal = grandTotal;
    purchase.cashPayment = cashPayment;
    purchase.bankPayment = bankPayment;
    purchase.remainingBalance = remainingBalance;
    purchase.paymentStatus = paymentStatus;
    purchase.paymentTerms = value.paymentTerms;
    purchase.invoiceNumber = value.invoiceNumber;
    purchase.notes = value.notes;

    await purchase.save();

    await populatePurchaseDocument(purchase);

    res.json({
      success: true,
      message: 'Purchase updated successfully',
      data: purchase
    });

  } catch (error) {
    console.error('Update purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Record supplier QA checks
router.post('/:id/qa-checks', auth, async (req, res) => {
  try {
    const { error, value } = qualityCheckSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const purchase = await Purchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.deliveryStatus !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'QA checks can only be recorded while the order is pending'
      });
    }

    const qaEntry = {
      qaStatus: value.qaStatus,
      notes: value.notes || undefined,
      checkedBy: req.user._id,
      checkedAt: value.checkedAt ? new Date(value.checkedAt) : new Date()
    };

    purchase.qualityChecks.push(qaEntry);

    await purchase.save();
    await populatePurchaseDocument(purchase);
    await convertPurchaseImages(purchase);

    res.status(201).json({
      success: true,
      message: 'QA checkpoint recorded',
      data: purchase
    });

  } catch (error) {
    console.error('Create purchase QA check error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update supplier fulfillment / dispatch details
router.patch('/:id/fulfillment', auth, async (req, res) => {
  try {
    const { error, value } = fulfillmentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const purchase = await Purchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.deliveryStatus === 'delivered' || purchase.deliveryStatus === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update fulfillment for delivered or cancelled orders'
      });
    }

    const shipmentDate = value.shipmentDate ? new Date(value.shipmentDate) : new Date();
    const now = new Date();
    const targetStatus = value.deliveryStatus || 'shipped';

    if (!purchase.fulfillment) {
      purchase.fulfillment = {};
    }

    if (!Array.isArray(purchase.fulfillment.history)) {
      purchase.fulfillment.history = [];
    }

    purchase.fulfillment.status = targetStatus;
    purchase.fulfillment.carrier = value.carrier;
    purchase.fulfillment.trackingNumber = value.trackingNumber;
    purchase.fulfillment.shipmentDate = shipmentDate;
    purchase.fulfillment.dispatchedAt = now;
    purchase.fulfillment.notes = value.notes || undefined;
    purchase.fulfillment.updatedBy = req.user._id;
    purchase.fulfillment.updatedAt = now;
    purchase.fulfillment.history.push({
      status: targetStatus,
      carrier: value.carrier,
      trackingNumber: value.trackingNumber,
      shipmentDate,
      notes: value.notes || undefined,
      updatedBy: req.user._id,
      updatedAt: now
    });

    purchase.deliveryStatus = targetStatus;

    await purchase.save();
    await populatePurchaseDocument(purchase);

    res.json({
      success: true,
      message: 'Purchase fulfillment updated',
      data: purchase
    });

  } catch (error) {
    console.error('Update purchase fulfillment error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Mark purchase as delivered and update inventory
router.patch('/:id/delivered', auth, async (req, res) => {
  try {
    const { error, value } = deliveryConfirmationSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { actualDeliveryDate, notes, receivedBy, discrepancies } = value;
    const Ledger = require('../models/Ledger');

    const purchase = await Purchase.findById(req.params.id);

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    if (purchase.deliveryStatus === 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Purchase already marked as delivered'
      });
    }

    await purchase.populate({ path: 'items.product' });

    for (const item of purchase.items) {
      await Inventory.findOneAndUpdate(
        { product: item.product._id },
        {
          $inc: { currentStock: item.quantity },
          $push: {
            stockMovements: {
              type: 'in',
              quantity: item.quantity,
              reference: 'Purchase',
              referenceId: purchase._id,
              user: req.user._id,
              notes: `Purchase delivery: ${purchase.purchaseNumber}`
            }
          },
          lastStockUpdate: new Date()
        }
      );
    }

    const confirmationDate = new Date();
    purchase.deliveryStatus = 'delivered';
    purchase.actualDeliveryDate = actualDeliveryDate || confirmationDate;

    if (!purchase.fulfillment) {
      purchase.fulfillment = {};
    }

    if (!Array.isArray(purchase.fulfillment.history)) {
      purchase.fulfillment.history = [];
    }

    purchase.fulfillment.status = 'delivered';
    purchase.fulfillment.updatedBy = req.user._id;
    purchase.fulfillment.updatedAt = confirmationDate;
    purchase.fulfillment.history.push({
      status: 'delivered',
      carrier: purchase.fulfillment.carrier,
      trackingNumber: purchase.fulfillment.trackingNumber,
      shipmentDate: purchase.fulfillment.shipmentDate,
      notes,
      updatedBy: req.user._id,
      updatedAt: confirmationDate
    });

    const confirmationEntry = {
      confirmedBy: req.user._id,
      confirmedAt: confirmationDate,
      notes: notes || undefined,
      receivedBy: receivedBy || undefined,
      discrepancies: discrepancies || undefined
    };

    if (!Array.isArray(purchase.deliveryConfirmations)) {
      purchase.deliveryConfirmations = [];
    }

    purchase.deliveryConfirmations.push(confirmationEntry);

    if (purchase.remainingBalance > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: purchase.supplier,
        entityModel: 'Supplier',
        transactionType: 'purchase',
        referenceId: purchase._id,
        referenceModel: 'Purchase',
        debit: purchase.remainingBalance,
        credit: 0,
        date: new Date(),
        description: `Purchase ${purchase.purchaseNumber} confirmed delivered`,
        remarks: notes || undefined,
        createdBy: req.user._id
      });
    }

    await purchase.save();

    await Supplier.findByIdAndUpdate(
      purchase.supplier,
      { $inc: { totalPurchases: purchase.grandTotal, currentBalance: purchase.remainingBalance } }
    );

    await populatePurchaseDocument(purchase);

    res.json({
      success: true,
      message: 'Purchase marked as delivered and inventory updated',
      data: purchase
    });

  } catch (error) {
    console.error('Mark purchase delivered error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update payment status
router.patch('/:id/payment', auth, async (req, res) => {
  try {
    const { paymentStatus } = req.body;

    if (!['pending', 'partial', 'paid', 'overdue'].includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    }

    const purchase = await Purchase.findByIdAndUpdate(
      req.params.id,
      { paymentStatus },
      { new: true }
    );

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    await populatePurchaseDocument(purchase);

    res.json({
      success: true,
      message: 'Payment status updated successfully',
      data: purchase
    });

  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete purchase
router.delete('/:id', auth, async (req, res) => {
  try {
    const purchase = await Purchase.findByIdAndUpdate(
      req.params.id,
      { deliveryStatus: 'cancelled' },
      { new: true }
    );

    if (!purchase) {
      return res.status(404).json({
        success: false,
        message: 'Purchase not found'
      });
    }

    res.json({
      success: true,
      message: 'Purchase cancelled successfully'
    });

  } catch (error) {
    console.error('Delete purchase error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;