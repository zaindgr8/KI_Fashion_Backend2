const express = require('express');
const multer = require('multer');
const Joi = require('joi');
const mongoose = require('mongoose');
const DispatchOrder = require('../models/DispatchOrder');
const LogisticsCompany = require('../models/LogisticsCompany');
const Supplier = require('../models/Supplier');
const Return = require('../models/Return');
const Ledger = require('../models/Ledger');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const PacketStock = require('../models/PacketStock');
const auth = require('../middleware/auth');
const checkPermission = require('../middleware/checkPermission');
const dateControl = require('../middleware/dateControl');
const EditRequestService = require('../services/EditRequestService');
const { sendResponse, getTransactionDate } = require('../utils/helpers');
const { logActivity } = require('../utils/auditLogger');

const { generateDispatchOrderQR, buildDispatchOrderQrPayload } = require('../utils/qrCode');
const { validateImageFile, uploadImage, generateSignedUrl, generateSignedUrls, generateSignedUploadUrl, verifyFileExists, deleteImage } = require('../utils/imageUpload');
const BalanceService = require('../services/BalanceService');
const { generatePacketBarcode, generateLooseItemBarcode } = require('../utils/barcodeGenerator');

const router = express.Router();

/**
 * Truncate a number to 2 decimal places (no rounding)
 * Example: 14.554472 -> 14.55, 19.125456 -> 19.12, 13.337555 -> 13.33
 * @param {number} value - The number to truncate
 * @returns {number} The truncated number with at most 2 decimal places
 */
const truncateToTwoDecimals = (value) => {
  if (typeof value !== 'number' || isNaN(value)) return 0;
  return Math.floor(value * 100) / 100;
};

const resolveMinSellingPrice = (value, fallback = 0) => {
  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) return truncateToTwoDecimals(parsed);
  const parsedFallback = Number(fallback);
  if (Number.isFinite(parsedFallback) && parsedFallback >= 0) return truncateToTwoDecimals(parsedFallback);
  return 0;
};

const buildRequestError = (message, status = 400, details = null, code = null) => {
  const err = new Error(message);
  err.status = status;
  if (details) err.details = details;
  if (code) err.code = code;
  return err;
};

const formatTransactionError = (error, actionLabel) => {
  let status = error.status || 500;
  let message = error.message || `Failed to ${actionLabel}.`;
  let errors = error.details || null;

  if (error.name === 'ValidationError') {
    status = 400;
    message = error.message || `Invalid data while attempting to ${actionLabel}.`;
    errors = error.errors || errors;
  }

  if (error.code === 11000) {
    status = 409;
    message = `Duplicate record detected while trying to ${actionLabel}. This can happen if the order was partially processed earlier or another request ran in parallel. Please refresh and try again.`;
    errors = { code: 'DUPLICATE_KEY', key: error.keyValue || null };
  }

  if (!message.toLowerCase().includes('no changes')) {
    message = `${message} No changes were saved.`;
  }

  return { status, message, errors };
};

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10) * 1024 * 1024 // Default 5MB
  }
});

/**
 * Convert dispatch order images to signed URLs
 * @param {Object|Array} orders - Dispatch order(s)
 * @param {Object} options - Options for image conversion
 * @param {boolean} options.primaryOnly - If true, only return the first image (for list views)
 * @returns {Promise<Object|Array>} Order(s) with signed image URLs
 */
async function convertDispatchOrderImages(orders, options = {}) {
  if (!orders) {
    return orders;
  }

  const { primaryOnly = false } = options;
  const isArray = Array.isArray(orders);
  const ordersArray = isArray ? orders : [orders];

  await Promise.all(ordersArray.map(async (order) => {
    if (!order || !order.items || !Array.isArray(order.items)) {
      return;
    }

    // Process each item in the order
    await Promise.all(order.items.map(async (item) => {
      try {
        // Convert productImage if it exists - handle both string (backward compat) and array
        if (item.productImage) {
          if (Array.isArray(item.productImage)) {
            // Store total image count before processing
            const totalImages = item.productImage.length;

            // For list views, only process the first image
            const urlsToProcess = primaryOnly ? [item.productImage[0]] : [...item.productImage];
            const finalUrls = [];
            let successCount = 0;
            let failCount = 0;

            // Process each URL individually to preserve order and handle failures gracefully
            for (const originalUrl of urlsToProcess) {
              try {
                const signedUrl = await generateSignedUrl(originalUrl);
                if (signedUrl) {
                  finalUrls.push(signedUrl);
                  successCount++;
                } else {
                  // Signed URL generation failed - preserve original URL
                  finalUrls.push(originalUrl);
                  failCount++;
                }
              } catch (error) {
                // Error generating signed URL - preserve original URL
                console.warn(`[convertDispatchOrderImages] Error generating signed URL for item ${item.productCode || 'unknown'}:`, {
                  originalUrl: originalUrl,
                  error: error.message
                });
                finalUrls.push(originalUrl);
                failCount++;
              }
            }

            // Log summary
            if (failCount > 0) {
              console.warn(`[convertDispatchOrderImages] ${failCount} of ${urlsToProcess.length} signed URL generations failed for item ${item.productCode || 'unknown'}. Using signed URLs where available, preserving originals for failed ones.`, {
                itemIndex: order.items.indexOf(item),
                productCode: item.productCode,
                totalUrls: urlsToProcess.length,
                successfulSignedUrls: successCount,
                failedCount: failCount,
                finalUrlCount: finalUrls.length
              });
            }

            item.productImage = finalUrls;
            // Store total count and primary image for UI
            if (primaryOnly) {
              item.totalImages = totalImages;
              item.primaryImage = finalUrls[0] || null;
            }
          } else if (typeof item.productImage === 'string') {
            // Single image string (backward compatibility) - convert to array with signed URL
            const originalUrl = item.productImage;
            const signedUrl = await generateSignedUrl(item.productImage);

            if (!signedUrl && originalUrl) {
              // Signed URL generation failed - preserve original URL as fallback
              console.warn(`[convertDispatchOrderImages] Signed URL generation failed for single image in item ${item.productCode || 'unknown'}. Preserving original URL as fallback.`, {
                itemIndex: order.items.indexOf(item),
                productCode: item.productCode,
                originalUrl: originalUrl
              });
              // Keep original URL in array format
              item.productImage = [originalUrl];
            } else if (signedUrl) {
              item.productImage = [signedUrl];
            } else {
              // Both original and signed URL are null/empty - set to empty array
              item.productImage = [];
            }
          }
        }

        // Convert product.images if product is populated
        if (item.product && item.product.images && Array.isArray(item.product.images)) {
          if (item.product.images.length > 0) {
            try {
              const originalProductUrls = [...item.product.images]; // Store original URLs
              const signedProductUrls = await generateSignedUrls(item.product.images);

              // Check if signed URL generation failed completely
              if (signedProductUrls.length === 0 && originalProductUrls.length > 0) {
                // All URLs failed - preserve original URLs as fallback
                console.warn(`[convertDispatchOrderImages] All signed URL generations failed for product images in item ${item.productCode || 'unknown'}. Preserving original URLs as fallback.`, {
                  itemIndex: order.items.indexOf(item),
                  productCode: item.productCode,
                  originalUrlCount: originalProductUrls.length
                });
                item.product.images = originalProductUrls;
              } else if (signedProductUrls.length < originalProductUrls.length) {
                // Some URLs failed - log warning but keep successful ones
                const failedCount = originalProductUrls.length - signedProductUrls.length;
                console.warn(`[convertDispatchOrderImages] ${failedCount} of ${originalProductUrls.length} product image signed URL generations failed for item ${item.productCode || 'unknown'}. Keeping ${signedProductUrls.length} successful URLs.`, {
                  itemIndex: order.items.indexOf(item),
                  productCode: item.productCode,
                  totalUrls: originalProductUrls.length,
                  successfulUrls: signedProductUrls.length
                });
                item.product.images = signedProductUrls;
              } else {
                // All URLs converted successfully
                item.product.images = signedProductUrls;
              }
            } catch (productImageError) {
              // Error generating signed URLs for product images - preserve original
              console.error(`[convertDispatchOrderImages] Error converting product images for item ${item.productCode || 'unknown'}:`, {
                error: productImageError.message,
                stack: productImageError.stack,
                itemIndex: order.items.indexOf(item),
                productCode: item.productCode
              });
              // Keep original product.images - don't modify
            }
          }
        }
      } catch (itemError) {
        // Error processing item - log but don't break the entire response
        console.error(`[convertDispatchOrderImages] Error processing item ${item.productCode || 'unknown'}:`, {
          error: itemError.message,
          stack: itemError.stack,
          itemIndex: order.items.indexOf(item),
          productCode: item.productCode,
          productImage: item.productImage
        });
        // Continue processing other items - don't modify this item's images
      }
    }));
  }));

  return isArray ? ordersArray : ordersArray[0];
}

/**
 * Normalize and apply admin-provided fields (items, pricing, boxes, logistics)
 * Mutates `dispatchOrder` in place and sets it to `pending-approval`.
 * Does NOT save the document.
 */
async function normalizeDispatchOrderForAdmin(dispatchOrder, input = {}, user, options = { setSubmitted: true }) {
  const {
    cashPayment = 0,
    bankPayment = 0,
    exchangeRate,
    percentage,
    discount = 0,
    items,
    totalBoxes,
    logisticsCompany,
    dispatchDate,
    isTotalBoxesConfirmed
  } = input || {};

  const finalExchangeRate = exchangeRate !== undefined && exchangeRate !== null
    ? parseFloat(exchangeRate)
    : dispatchOrder.exchangeRate || 1.0;
  const finalPercentage = percentage !== undefined && percentage !== null
    ? parseFloat(percentage)
    : dispatchOrder.percentage || 0;

  if (isNaN(finalExchangeRate) || finalExchangeRate <= 0) {
    throw new Error('Invalid exchange rate. Must be a positive number.');
  }
  if (isNaN(finalPercentage) || finalPercentage < 0) {
    throw new Error('Invalid percentage. Must be a non-negative number.');
  }

  dispatchOrder.exchangeRate = finalExchangeRate;
  dispatchOrder.percentage = finalPercentage;

  if (totalBoxes !== undefined && totalBoxes !== null) {
    dispatchOrder.totalBoxes = parseInt(totalBoxes) || 0;
  }
  if (logisticsCompany) {
    dispatchOrder.logisticsCompany = logisticsCompany;
    dispatchOrder.markModified('logisticsCompany');
  }
  if (dispatchDate) {
    // Preserve existing time if available
    dispatchOrder.dispatchDate = getTransactionDate(dispatchDate, dispatchOrder.dispatchDate);
    dispatchOrder.markModified('dispatchDate');
  }
  if (isTotalBoxesConfirmed !== undefined) {
    dispatchOrder.isTotalBoxesConfirmed = !!isTotalBoxesConfirmed;
    dispatchOrder.markModified('isTotalBoxesConfirmed');
  }

  // Update items if provided
  if (Array.isArray(items)) {
    if (Array.isArray(dispatchOrder.items) && items.length === dispatchOrder.items.length) {
      dispatchOrder.items.forEach((item, index) => {
        const reqItem = items[index];
        if (!reqItem) return;

        // Capture original variants for comparison
        const originalSizes = Array.isArray(item.size) ? item.size.map(String) : (item.size ? [String(item.size)] : []);
        const originalColors = Array.isArray(item.primaryColor) ? item.primaryColor.map(String) : (item.primaryColor ? [String(item.primaryColor)] : []);

        if (reqItem.quantity !== undefined) item.quantity = Number(reqItem.quantity);
        if (reqItem.productName) item.productName = reqItem.productName;
        if (reqItem.productCode) item.productCode = reqItem.productCode ? reqItem.productCode.trim() : item.productCode;
        if (reqItem.costPrice !== undefined) item.costPrice = Number(reqItem.costPrice);
        if (reqItem.minSellingPrice !== undefined) item.minSellingPrice = Number(reqItem.minSellingPrice);
        if (reqItem.primaryColor) item.primaryColor = Array.isArray(reqItem.primaryColor) ? reqItem.primaryColor : [reqItem.primaryColor];
        if (reqItem.size) item.size = Array.isArray(reqItem.size) ? reqItem.size : [reqItem.size];
        if (reqItem.season) item.season = Array.isArray(reqItem.season) ? reqItem.season : [reqItem.season];
        // Only update productImage if the incoming value is a non-empty array (guard against accidentally clearing images with [])
        if (reqItem.productImage && Array.isArray(reqItem.productImage) && reqItem.productImage.length > 0) {
          item.productImage = reqItem.productImage;
        } else if (reqItem.productImage && typeof reqItem.productImage === 'string') {
          item.productImage = [reqItem.productImage];
        }

        // If new packets provided, accept them and clear reconfiguration flag
        if (reqItem.packets) {
          item.packets = reqItem.packets;
          item.requiresReconfiguration = false;
        }

        if (reqItem.boxes) item.boxes = reqItem.boxes;
        if (reqItem.useVariantTracking !== undefined) item.useVariantTracking = !!reqItem.useVariantTracking;

        // Detect removal of sizes/colors compared to original; if removed, require reconfiguration
        const newSizes = Array.isArray(item.size) ? item.size.map(String) : (item.size ? [String(item.size)] : []);
        const newColors = Array.isArray(item.primaryColor) ? item.primaryColor.map(String) : (item.primaryColor ? [String(item.primaryColor)] : []);

        const sizeRemoved = originalSizes.some(s => !newSizes.includes(s));
        const colorRemoved = originalColors.some(c => !newColors.includes(c));

        if (sizeRemoved || colorRemoved) {
          // Mark this item as needing a new packet configuration
          item.requiresReconfiguration = true;
          // Optionally clear existing packets to force reconfiguration by UX
          if (!reqItem.packets) {
            item.packets = [];
          }
        }
      });
      dispatchOrder.markModified('items');
    } else {
      // Replace entire items array
      dispatchOrder.items = items;
      dispatchOrder.markModified('items');
    }
  }

  // Calculate confirmed quantities
  const confirmedQuantities = (dispatchOrder.items || []).map((item, index) => {
    const returnedItems = dispatchOrder.returnedItems || [];
    const totalReturned = returnedItems
      .filter(returned => returned.itemIndex === index)
      .reduce((sum, returned) => sum + returned.quantity, 0);

    const confirmedQty = Math.max(0, (item.quantity || 0) - totalReturned);
    return { itemIndex: index, quantity: confirmedQty };
  });

  // Calculate supplier payment and landed prices
  let supplierPaymentTotal = 0;
  let landedPriceTotal = 0;
  const itemsWithPrices = (dispatchOrder.items || []).map((item, index) => {
    const costPrice = item.costPrice || 0;
    const confirmedQty = confirmedQuantities[index]?.quantity || 0;

    const supplierPaymentAmount = costPrice;
    supplierPaymentTotal += supplierPaymentAmount * confirmedQty;

    const landedPrice = truncateToTwoDecimals((costPrice / finalExchangeRate) * (1 + (finalPercentage / 100)));
    const landedPriceItemTotal = truncateToTwoDecimals(landedPrice * confirmedQty);
    landedPriceTotal += landedPriceItemTotal;

    return { supplierPaymentAmount, landedPrice, confirmedQuantity: confirmedQty };
  });

  const totalDiscount = parseFloat(discount) !== undefined && discount !== null
    ? parseFloat(discount)
    : (dispatchOrder.totalDiscount || 0);

  const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);
  const subtotal = truncateToTwoDecimals(landedPriceTotal);
  const grandTotal = truncateToTwoDecimals(Math.max(0, subtotal - totalDiscount));

  dispatchOrder.status = 'pending-approval';
  if (options && options.setSubmitted) {
    dispatchOrder.submittedForApprovalAt = new Date();
    dispatchOrder.submittedForApprovalBy = user._id;
  }
  dispatchOrder.exchangeRate = finalExchangeRate;
  dispatchOrder.percentage = finalPercentage;
  dispatchOrder.totalDiscount = totalDiscount;
  dispatchOrder.subtotal = subtotal;
  dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal;
  dispatchOrder.grandTotal = grandTotal;
  dispatchOrder.paymentDetails = {
    cashPayment: (parseFloat(cashPayment) || 0),
    bankPayment: (parseFloat(bankPayment) || 0),
    remainingBalance: discountedSupplierPaymentTotal - (parseFloat(cashPayment) || 0) - (parseFloat(bankPayment) || 0),
    paymentStatus: discountedSupplierPaymentTotal === (parseFloat(cashPayment) || 0) + (parseFloat(bankPayment) || 0)
      ? 'paid'
      : (parseFloat(cashPayment) || 0) + (parseFloat(bankPayment) || 0) > 0
        ? 'partial'
        : 'pending'
  };

  dispatchOrder.confirmedQuantities = confirmedQuantities;

  // Update prices on items
  dispatchOrder.items.forEach((item, index) => {
    item.supplierPaymentAmount = itemsWithPrices[index]?.supplierPaymentAmount || 0;
    item.landedPrice = itemsWithPrices[index]?.landedPrice || 0;
  });

  dispatchOrder.markModified('items');
  return dispatchOrder;
}

const boxSchema = Joi.object({
  boxNumber: Joi.number().required(),
  itemsPerBox: Joi.number().min(0).optional().allow(null),
  weight: Joi.number().min(0).default(0),
  dimensions: Joi.object({
    length: Joi.number().min(0).optional(),
    width: Joi.number().min(0).optional(),
    height: Joi.number().min(0).optional()
  }).optional()
});

const packetCompositionSchema = Joi.object({
  size: Joi.string().required().trim(),
  color: Joi.string().required().trim(),
  quantity: Joi.number().min(1).required()
});

const packetSchema = Joi.object({
  packetNumber: Joi.number().required(),
  totalItems: Joi.number().required(),
  templateId: Joi.string().optional(),
  composition: Joi.array().items(packetCompositionSchema).min(1).required(),
  isLoose: Joi.boolean().optional()
});

const dispatchItemSchema = Joi.object({
  productName: Joi.string().min(1).required(),
  productCode: Joi.string().min(1).required(),
  season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season', 'accessories')).min(1).required(),
  costPrice: Joi.number().min(0).required(),
  minSellingPrice: Joi.number().min(0).optional(),
  primaryColor: Joi.array().items(Joi.string()).optional(),
  size: Joi.array().items(Joi.string()).optional(),
  material: Joi.string().allow(null, '').optional(),
  description: Joi.string().allow(null, '').optional(),
  productImage: Joi.alternatives().try(
    Joi.string().uri(),
    Joi.array().items(Joi.string().uri())
  ).optional(), // Accept both string (backward compat) and array
  quantity: Joi.number().min(1).required(),
  boxes: Joi.array().items(boxSchema).optional(),
  unitWeight: Joi.number().min(0).default(0),
  notes: Joi.string().allow(null, '').optional(),
  // Packet management fields
  useVariantTracking: Joi.boolean().optional(),
  packets: Joi.array().items(packetSchema).optional()
});

const dispatchOrderSchema = Joi.object({
  date: Joi.string().optional(),
  logisticsCompany: Joi.string().required(),
  items: Joi.array().items(dispatchItemSchema).min(1).required(),
  dispatchDate: Joi.date().optional(),
  expectedDeliveryDate: Joi.date().optional(),
  pickupAddress: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan'),
    contactPerson: Joi.string().optional(),
    contactPhone: Joi.string().optional(),
    contactPhoneAreaCode: Joi.string().max(5).optional()
  }).optional(),
  deliveryAddress: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan'),
    contactPerson: Joi.string().optional(),
    contactPhone: Joi.string().optional(),
    contactPhoneAreaCode: Joi.string().max(5).optional()
  }).optional(),
  specialInstructions: Joi.string().optional(),
  notes: Joi.string().optional(),
  totalDiscount: Joi.number().min(0).default(0).optional(),
  totalBoxes: Joi.number().min(0).optional()
});

// Schema for manual entry (Purchase-like)
const manualEntryItemSchema = Joi.object({
  product: Joi.string().optional(), // Product reference
  productName: Joi.string().optional(), // For new products
  productCode: Joi.string().optional(), // For new products
  season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season', 'accessories')).min(1).optional(), // For new products
  costPrice: Joi.number().min(0).optional(), // For new products
  minSellingPrice: Joi.number().min(0).required(),
  primaryColor: Joi.alternatives().try(
    Joi.string().allow(null, ''),
    Joi.array().items(Joi.string())
  ).optional(),
  size: Joi.alternatives().try(
    Joi.string().allow(null, ''),
    Joi.array().items(Joi.string().allow('')).min(0),
    Joi.any().allow(null)
  ).optional(),
  material: Joi.string().allow(null, '').optional(),
  description: Joi.string().allow(null, '').optional(),
  productImage: Joi.alternatives().try(
    Joi.string().allow(null, ''),
    Joi.array().items(Joi.string())
  ).optional(),
  quantity: Joi.number().min(1).required(),
  landedTotal: Joi.number().min(0).required(),
  // Packet management fields
  useVariantTracking: Joi.boolean().optional(),
  packets: Joi.array().items(packetSchema).min(1).required()
});

const manualEntrySchema = Joi.object({
  supplier: Joi.string().required(),
  purchaseDate: Joi.date().optional(),
  expectedDeliveryDate: Joi.date().optional(),
  exchangeRate: Joi.number().min(0.01).required(), // Exchange rate for currency conversion
  percentage: Joi.number().min(0).required(), // Profit margin percentage
  items: Joi.array().items(manualEntryItemSchema).min(1).required(),
  subtotal: Joi.number().min(0).optional(),
  totalDiscount: Joi.number().min(0).default(0),
  totalTax: Joi.number().min(0).default(0),
  shippingCost: Joi.number().min(0).default(0),
  grandTotal: Joi.number().min(0).optional(), // Can be calculated or provided (landed total)
  cashPayment: Joi.number().min(0).default(0),
  bankPayment: Joi.number().min(0).default(0),
  remainingBalance: Joi.number().min(0).optional(),
  paymentStatus: Joi.string().valid('pending', 'partial', 'paid', 'overdue').optional(),
  paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').default('net30'),
  invoiceNumber: Joi.string().allow('', null).optional(),
  notes: Joi.string().allow('', null).optional(),
  attachments: Joi.array().items(Joi.string()).optional(),
  logisticsCompany: Joi.string().allow(null, '').optional() // Optional logistics company for tracking charges
});

// Create dispatch order (Suppliers only)
router.post('/', auth, checkPermission('dispatch_orders'), dateControl({ entityType: 'dispatch-order', dateField: 'date', requestType: 'create' }), async (req, res) => {

  try {
    if (req.user.role !== 'supplier') {
      return sendResponse.error(res, 'Only suppliers can create dispatch orders', 403);
    }

    const { error } = dispatchOrderSchema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    // Verify logistics company exists and is active
    const logisticsCompany = await LogisticsCompany.findById(req.body.logisticsCompany);
    if (!logisticsCompany || !logisticsCompany.isActive) {
      return sendResponse.error(res, 'Invalid or inactive logistics company', 400);
    }

    // Get supplier info
    const supplier = await Supplier.findOne({ userId: req.user._id });
    if (!supplier) {
      return sendResponse.error(res, 'Supplier profile not found', 400);
    }

    // Auto-populate addresses from supplier profile if not provided
    let pickupAddress = req.body.pickupAddress;
    if (!pickupAddress && supplier.address) {
      pickupAddress = {
        street: supplier.address.street || '',
        city: supplier.address.city || '',
        state: supplier.address.state || '',
        zipCode: supplier.address.zipCode || '',
        country: supplier.address.country || 'Pakistan',
        contactPerson: supplier.name || req.user.name || '',
        contactPhone: supplier.phone || req.user.phone || ''
      };
    }

    // Default delivery address (can be configured later)
    let deliveryAddress = req.body.deliveryAddress;
    if (!deliveryAddress) {
      deliveryAddress = {
        street: '',
        city: '',
        state: '',
        zipCode: '',
        country: 'Pakistan',
        contactPerson: '',
        contactPhone: ''
      };
    }

    // Process items and calculate boxes
    const processedItems = req.body.items.map(item => {
      const boxes = item.boxes || [];
      const totalBoxes = boxes.length;

      // Note: We no longer validate box quantities since we only track box count, not items per box

      const totalWeight = (item.unitWeight || 0) * item.quantity;

      // Clean up empty strings - convert to undefined so they're not stored
      // Handle primaryColor as array or string (for backward compatibility)
      let cleanedPrimaryColor = undefined;
      if (item.primaryColor) {
        if (Array.isArray(item.primaryColor)) {
          // Filter out empty strings and keep only non-empty values
          cleanedPrimaryColor = item.primaryColor.filter(c => c && typeof c === 'string' && c.trim() !== '');
          // Convert to undefined if array is empty
          cleanedPrimaryColor = cleanedPrimaryColor.length > 0 ? cleanedPrimaryColor : undefined;
        } else if (typeof item.primaryColor === 'string' && item.primaryColor.trim() !== '') {
          cleanedPrimaryColor = item.primaryColor.trim();
        }
      }

      // Handle size as array or string (for backward compatibility)
      let cleanedSize = undefined;
      if (item.size) {
        if (Array.isArray(item.size)) {
          // Filter out empty strings and keep only non-empty values
          cleanedSize = item.size.filter(s => s && typeof s === 'string' && s.trim() !== '');
          // Convert to undefined if array is empty
          cleanedSize = cleanedSize.length > 0 ? cleanedSize : undefined;
        } else if (typeof item.size === 'string' && item.size.trim() !== '') {
          cleanedSize = item.size.trim();
        }
      }

      // Validate packet composition if provided
      if (item.packets && item.packets.length > 0) {
        const totalPacketItems = item.packets.reduce((sum, packet) => {
          const packetTotal = packet.composition.reduce((pSum, comp) => pSum + comp.quantity, 0);
          return sum + packetTotal;
        }, 0);

        if (totalPacketItems !== item.quantity) {
          throw new Error(`Packet composition total (${totalPacketItems}) must equal item quantity (${item.quantity}) for item ${item.productCode}`);
        }
      }

      const cleanedItem = {
        ...item,
        primaryColor: cleanedPrimaryColor,
        size: cleanedSize,
        material: item.material && item.material.trim() !== '' ? item.material : undefined,
        description: item.description && item.description.trim() !== '' ? item.description : undefined,
        notes: item.notes && item.notes.trim() !== '' ? item.notes : undefined,
        boxes: boxes,
        totalBoxes: totalBoxes || 0,
        totalWeight,
        useVariantTracking: item.useVariantTracking || false,
        packets: item.packets || []
      };

      return cleanedItem;
    });

    // Ensure every item has packet configuration before allowing order creation
    const unconfiguredItems = processedItems.filter(item => !item.packets || item.packets.length === 0);
    if (unconfiguredItems.length > 0) {
      const names = unconfiguredItems.map(item => `"${item.productName || item.productCode}"`).join(', ');
      return sendResponse.error(res, `All items must have packet configuration before creating an order. Unconfigured items: ${names}`, 400);
    }

    // Set dispatch date from date field or use current date
    const dispatchDate = getTransactionDate(req.body.date);

    // Calculate totals before saving (pre-save hook will recalculate, but this ensures validation passes)
    const totalQuantity = processedItems.reduce((sum, item) => sum + item.quantity, 0);
    // Use req.body.totalBoxes if provided (from Supplier Portal form), otherwise calculate from items
    const calculatedBoxes = processedItems.reduce((sum, item) => sum + (item.totalBoxes || 0), 0);
    const totalBoxes = req.body.totalBoxes && req.body.totalBoxes > 0 ? req.body.totalBoxes : calculatedBoxes;

    const dispatchOrder = new DispatchOrder({
      ...req.body,
      supplier: supplier._id,
      supplierUser: req.user._id,
      items: processedItems,
      dispatchDate: dispatchDate,
      pickupAddress: pickupAddress,
      deliveryAddress: deliveryAddress,
      totalQuantity: totalQuantity,
      totalBoxes: totalBoxes,
      totalDiscount: req.body.totalDiscount || 0,
      // Set default values for exchange rate and percentage (suppliers cannot set these)
      exchangeRate: 1.0,
      percentage: 0,
      createdBy: req.user._id
    });

    await dispatchOrder.save();

    // Generate QR code for the dispatch order
    try {
      await generateDispatchOrderQR(dispatchOrder, req.user._id);
    } catch (qrError) {
      console.error('Generate dispatch order QR error (create):', qrError);
      // Don't fail the entire creation if QR generation fails
    }

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'qrCode.generatedBy', select: 'name' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    // Log the activity
    await logActivity(req, {
      action: 'CREATE',
      resource: 'DispatchOrder',
      resourceId: dispatchOrder._id,
      description: `Created dispatch order: ${dispatchOrder.orderNumber} (Supplier: ${supplier.company})`,
      changes: { old: null, new: dispatchOrder.toObject() }
    });

    return sendResponse.success(res, orderObj, 'Dispatch order created successfully', 201);

  } catch (error) {
    console.error('Create dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Create manual entry (CRM Admin only - replaces Purchase)
router.post('/manual', auth, dateControl({ entityType: 'dispatch-order', dateField: 'purchaseDate', requestType: 'create', allowAdminBypassWithBaseline: true }), async (req, res) => {
  // Helper to normalize size/color arrays - handles strings, comma-separated strings, and arrays
  const normalizeToArray = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
      // Flatten in case of nested comma-separated values, filter empty strings
      return value
        .flatMap(v => typeof v === 'string' ? v.split(',').map(s => s.trim()) : [v])
        .filter(v => v && typeof v === 'string' && v.trim() !== '');
    }
    if (typeof value === 'string') {
      return value.split(',').map(s => s.trim()).filter(s => s !== '');
    }
    return [];
  };

  // Only admin/manager can create manual entries
  if (!['super-admin', 'admin', 'employee'].includes(req.user.role)) {
    return sendResponse.error(res, 'Only admins and managers can create manual entries', 403);
  }

  const { error, value } = manualEntrySchema.validate(req.body, {
    abortEarly: false,
    allowUnknown: true,
    stripUnknown: false
  });
  if (error) {
    console.error('Validation error:', JSON.stringify(error.details, null, 2));
    return sendResponse.error(res, error.details[0].message, 400);
  }

  const session = await mongoose.startSession();
  const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
  let manualOrderId = null;

  try {
    await session.withTransaction(async () => {
      const supplier = await Supplier.findById(value.supplier).session(session);
      if (!supplier) throw buildRequestError('Supplier not found', 400);

      const normalizeSku = (value) => String(value || '').trim().toUpperCase();
      const itemsWithDetails = [];

      const productIds = value.items.map(i => i.product).filter(Boolean);
      const productCodes = value.items.map(i => i.productCode).filter(Boolean).map(c => normalizeSku(c));

      const [existingProductsById, existingProductsBySku] = await Promise.all([
        Product.find({ _id: { $in: productIds } }).session(session),
        Product.find({ sku: { $in: productCodes }, supplier: value.supplier }).session(session)
      ]);

      const productMap = new Map();
      existingProductsById.forEach(p => productMap.set(p._id.toString(), p));
      existingProductsBySku.forEach(p => productMap.set(p.sku, p));

      for (const item of value.items) {
        let product = null;
        let season = null;

        if (item.product) {
          product = productMap.get(String(item.product));
          if (!product) throw buildRequestError(`Product not found: ${item.product}`, 400);
          const productSupplierId = product.supplier?._id || product.supplier;
          if (productSupplierId && String(productSupplierId) !== String(value.supplier)) {
            throw buildRequestError(`Product supplier mismatch for item: ${item.productCode || product.sku}`, 400);
          }
          season = product.season;
        } else if (item.productCode) {
          const productCodeUpper = normalizeSku(item.productCode);
          product = productMap.get(productCodeUpper);
          if (product) {
            season = product.season;
          } else if (item.season?.length > 0) {
            if (!item.productName?.trim()) throw buildRequestError(`Product name required for new product: ${item.productCode}`, 400);
            season = item.season;
          } else {
            throw buildRequestError(`Season required for new product: ${item.productCode}`, 400);
          }
        }

        const costPrice = item.costPrice || (product ? product.pricing?.costPrice : 0);
        const exchangeRate = value.exchangeRate || 1.0;
        const percentage = value.percentage || 0;
        const landedPrice = truncateToTwoDecimals((costPrice / exchangeRate) * (1 + (percentage / 100)));
        const landedTotal = item.landedTotal ? truncateToTwoDecimals(item.landedTotal) : truncateToTwoDecimals(landedPrice * item.quantity);

        itemsWithDetails.push({
          product: product ? product._id : undefined,
          productName: item.productName || product?.name,
          productCode: item.productCode || product?.productCode || product?.sku,
          season, costPrice, minSellingPrice: item.minSellingPrice, landedPrice, landedTotal,
          quantity: item.quantity,
          productImage: item.productImage,
          useVariantTracking: true,
          packets: item.packets,
          size: item.size,
          primaryColor: item.primaryColor,
          material: item.material
        });
      }

      const supplierPaymentTotal = itemsWithDetails.reduce((sum, item) => sum + ((item.costPrice || 0) * item.quantity), 0);
      const subtotal = itemsWithDetails.reduce((sum, item) => sum + (item.landedTotal || 0), 0);
      const totalDiscount = value.totalDiscount || 0;
      const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);
      const grandTotal = Math.max(0, subtotal - totalDiscount + (value.totalTax || 0) + (value.shippingCost || 0));

      const initialPaidAmount = Number(value.cashPayment || 0) + Number(value.bankPayment || 0);
      const currentSupplierBalance = await Ledger.getBalance('supplier', supplier._id, session);
      let creditApplied = 0;
      let finalRemainingBalance = Math.max(0, discountedSupplierPaymentTotal - initialPaidAmount);

      if (currentSupplierBalance < 0) {
        creditApplied = Math.min(Math.abs(currentSupplierBalance), finalRemainingBalance);
        finalRemainingBalance = Math.max(0, finalRemainingBalance - creditApplied);
      }

      const dispatchOrder = new DispatchOrder({
        supplier: value.supplier,
        supplierUser: supplier.userId || null,
        logisticsCompany: value.logisticsCompany || null,
        dispatchDate: getTransactionDate(value.purchaseDate),
        items: itemsWithDetails,
        status: 'confirmed',
        confirmedAt: new Date(),
        confirmedBy: req.user._id,
        subtotal,
        totalDiscount,
        totalTax: value.totalTax || 0,
        shippingCost: value.shippingCost || 0,
        supplierPaymentTotal: discountedSupplierPaymentTotal,
        grandTotal,
        cashPayment: value.cashPayment || 0,
        bankPayment: value.bankPayment || 0,
        remainingBalance: finalRemainingBalance,
        paymentStatus: finalRemainingBalance <= 0 ? 'paid' : (initialPaidAmount + creditApplied > 0 ? 'partial' : 'pending'),
        paymentDetails: {
          cashPayment: value.cashPayment || 0,
          bankPayment: value.bankPayment || 0,
          creditApplied,
          remainingBalance: finalRemainingBalance,
          paymentStatus: finalRemainingBalance <= 0 ? 'paid' : (initialPaidAmount + creditApplied > 0 ? 'partial' : 'pending')
        },
        invoiceNumber: value.invoiceNumber,
        notes: value.notes,
        createdBy: req.user._id
      });

      await dispatchOrder.save({ session });

      const ledgerTasks = [];
      ledgerTasks.push(Ledger.createEntry({
        type: 'supplier',
        entityId: supplier._id,
        entityModel: 'Supplier',
        transactionType: 'purchase',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: discountedSupplierPaymentTotal,
        credit: 0,
        date: dispatchOrder.dispatchDate,
        description: `Manual Purchase ${dispatchOrder.orderNumber}`,
        createdBy: req.user._id
      }, session));
      if (value.cashPayment > 0) ledgerTasks.push(Ledger.createEntry({
        type: 'supplier',
        entityId: supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: value.cashPayment,
        date: dispatchOrder.dispatchDate,
        description: `Cash payment: ${dispatchOrder.orderNumber}`,
        paymentMethod: 'cash',
        createdBy: req.user._id
      }, session));
      if (value.bankPayment > 0) ledgerTasks.push(Ledger.createEntry({
        type: 'supplier',
        entityId: supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: value.bankPayment,
        date: dispatchOrder.dispatchDate,
        description: `Bank payment: ${dispatchOrder.orderNumber}`,
        paymentMethod: 'bank',
        createdBy: req.user._id
      }, session));
      if (creditApplied > 0) ledgerTasks.push(Ledger.createEntry({
        type: 'supplier',
        entityId: supplier._id,
        entityModel: 'Supplier',
        transactionType: 'credit_application',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: creditApplied,
        date: dispatchOrder.dispatchDate,
        description: `Credit applied: ${dispatchOrder.orderNumber}`,
        createdBy: req.user._id
      }, session));
      ledgerTasks.push(Supplier.findByIdAndUpdate(
        supplier._id,
        { $inc: { totalPurchases: discountedSupplierPaymentTotal, currentBalance: discountedSupplierPaymentTotal - initialPaidAmount - creditApplied } },
        { session }
      ));

      if (dispatchOrder.logisticsCompany && value.totalBoxes > 0) {
        const lc = await LogisticsCompany.findById(dispatchOrder.logisticsCompany).session(session);
        if (lc?.rates?.boxRate > 0) {
          ledgerTasks.push(Ledger.createEntry({
            type: 'logistics',
            entityId: lc._id,
            entityModel: 'LogisticsCompany',
            transactionType: 'charge',
            referenceId: dispatchOrder._id,
            referenceModel: 'DispatchOrder',
            debit: value.totalBoxes * lc.rates.boxRate,
            credit: 0,
            date: dispatchOrder.dispatchDate,
            description: `Logistics charge: ${dispatchOrder.orderNumber}`,
            createdBy: req.user._id
          }, session));
        }
      }

      await Promise.all(ledgerTasks);

      const bwipjs = require('bwip-js');
      const transactionDate = dispatchOrder.dispatchDate || new Date();

      const productUpdateTasks = dispatchOrder.items.map(async (item) => {
        let productObj = item.product;

        // In this flow item.product can be a populated document, plain object, or ObjectId.
        // Ensure we always work with a real Product document before using document methods.
        if (productObj && typeof productObj.save !== 'function') {
          const maybeProductId = productObj._id || productObj;
          if (mongoose.Types.ObjectId.isValid(maybeProductId)) {
            productObj = await Product.findById(maybeProductId).session(session);
          } else {
            productObj = null;
          }
        }

        if (!productObj) {
          productObj = new Product({
            name: item.productName,
            sku: normalizeSku(item.productCode),
            supplier: value.supplier,
            productCode: item.productCode,
            season: item.season,
            category: 'General',
            unit: 'piece',
            pricing: { 
              costPrice: item.landedPrice, 
              sellingPrice: resolveMinSellingPrice(item.minSellingPrice, item.landedPrice * 1.2),
              minSellingPrice: resolveMinSellingPrice(item.minSellingPrice, item.landedPrice * 1.2)
            },
            color: normalizeToArray(item.primaryColor).filter(Boolean),
            size: normalizeToArray(item.size).filter(Boolean),
            specifications: { color: normalizeToArray(item.primaryColor)[0], material: item.material },
            isActive: true,
            createdBy: req.user._id,
            images: Array.isArray(item.productImage) ? item.productImage : (item.productImage ? [item.productImage] : [])
          });
          await productObj.save({ session });
          item.product = productObj._id;
        } else {
          let hasUpdates = false;
          if (!productObj.isActive) { productObj.isActive = true; hasUpdates = true; }
          
          // Sync pricing - costPrice should be base currency (landedPrice)
          if (productObj.pricing.costPrice !== item.landedPrice) {
            productObj.pricing.costPrice = item.landedPrice;
            hasUpdates = true;
          }
          
          const resMin = resolveMinSellingPrice(item.minSellingPrice, item.landedPrice * 1.2);
          if (productObj.pricing.sellingPrice !== resMin) {
            productObj.pricing.sellingPrice = resMin;
            productObj.pricing.minSellingPrice = resMin;
            hasUpdates = true;
          }

          if (!Array.isArray(productObj.images)) {
            productObj.images = [];
            hasUpdates = true;
          }
          if (item.productImage) {
            const imgs = Array.isArray(item.productImage) ? item.productImage : [item.productImage];
            imgs.forEach(url => { if (url && !productObj.images.includes(url)) { productObj.images.unshift(url); hasUpdates = true; } });
          }
          const newSizes = normalizeToArray(item.size);
          const mergedSizes = [...new Set([...normalizeToArray(productObj.size), ...newSizes])];
          if (mergedSizes.length !== normalizeToArray(productObj.size).length) { productObj.size = mergedSizes; hasUpdates = true; }
          
          if (hasUpdates) await productObj.save({ session });
          item.product = productObj._id;
        }
        return productObj;
      });
      await Promise.all(productUpdateTasks);

      dispatchOrder.markModified('items');
      await dispatchOrder.save({ session });

      for (const item of dispatchOrder.items) {
        const prodId = item.product?._id || item.product;

        const inventory = await Inventory.findOneAndUpdate(
          { product: prodId },
          {
            $setOnInsert: {
              product: prodId,
              currentStock: 0,
              averageCostPrice: item.landedPrice,
              purchaseBatches: [],
              minStockLevel: 0,
              maxStockLevel: 1000,
              reorderLevel: 10
            }
          },
          { new: true, upsert: true, session, setDefaultsOnInsert: true }
        );

        const packetGroups = (() => {
          const groups = new Map();
          const isLoose = item.packets.some(p => p.isLoose);
          if (isLoose) {
            item.packets.filter(p => p.isLoose).forEach(p => p.composition.forEach(c => {
              const k = `${c.color}|${c.size}`;
              if (groups.has(k)) groups.get(k).quantity += c.quantity;
              else groups.set(k, { color: c.color, size: c.size, quantity: c.quantity, isLoose: true });
            }));
          } else {
            item.packets.forEach(p => {
              const b = generatePacketBarcode(supplier._id.toString(), prodId.toString(), p.composition, false);
              if (groups.has(b)) groups.get(b).count++;
              else groups.set(b, { barcode: b, comp: p.composition, items: p.totalItems || p.composition.reduce((s, c) => s + c.quantity, 0), count: 1, isLoose: false });
            });
          }
          return Array.from(groups.values());
        })();

        const batchInfo = {
          dispatchOrderId: dispatchOrder._id,
          supplierId: supplier._id,
          purchaseDate: transactionDate,
          costPrice: item.costPrice,
          landedPrice: item.landedPrice,
          exchangeRate: value.exchangeRate || 1.0
        };

        if (item.packets?.length > 0) {
          const variantComposition = [];
          item.packets.forEach(packet => packet.composition.forEach(comp => {
            const existing = variantComposition.find(v => v.size === comp.size && v.color === comp.color);
            if (existing) existing.quantity += comp.quantity;
            else variantComposition.push({ size: comp.size, color: comp.color, quantity: comp.quantity });
          }));
          await inventory.addStockWithVariants(
            item.quantity,
            variantComposition,
            'DispatchOrder',
            dispatchOrder._id,
            req.user._id,
            `Manual Purchase ${dispatchOrder.orderNumber}`,
            transactionDate,
            session
          );
          inventory.purchaseBatches.push({ ...batchInfo, quantity: item.quantity, remainingQuantity: item.quantity });
        } else {
          await inventory.addStockWithBatch(
            item.quantity,
            batchInfo,
            'DispatchOrder',
            dispatchOrder._id,
            req.user._id,
            `Manual Purchase ${dispatchOrder.orderNumber}`,
            transactionDate,
            session
          );
        }
        inventory.recalculateAverageCost();
        await inventory.save({ session });

        const packetTasks = packetGroups.map(async (group) => {
          let barcode = group.barcode;
          let comp = group.comp;
          let itemsPerPacket = group.items;
          let qty = group.count;
          if (group.isLoose) {
            comp = [{ size: group.size, color: group.color, quantity: 1 }];
            barcode = generatePacketBarcode(supplier._id.toString(), prodId.toString(), comp, true);
            qty = group.quantity;
            itemsPerPacket = 1;
          }
          let ps = await PacketStock.findOne({ barcode }).session(session);
          if (ps) {
            await ps.addStock(qty, dispatchOrder._id, item.costPrice * itemsPerPacket, item.landedPrice * itemsPerPacket, transactionDate, session);
            ps.suggestedSellingPrice = resolveMinSellingPrice(item.minSellingPrice, item.landedPrice * 1.2) * itemsPerPacket;
          } else {
            const buffer = await bwipjs.toBuffer({ bcid: 'code128', text: barcode, scale: 3, height: 10, includetext: true, textxalign: 'center', textsize: 8 }).catch(() => null);
            const image = buffer ? `data:image/png;base64,${buffer.toString('base64')}` : null;
            ps = new PacketStock({
              barcode,
              product: prodId,
              supplier: supplier._id,
              composition: comp,
              totalItemsPerPacket: itemsPerPacket,
              availablePackets: qty,
              costPricePerPacket: item.costPrice * itemsPerPacket,
              landedPricePerPacket: item.landedPrice * itemsPerPacket,
              suggestedSellingPrice: resolveMinSellingPrice(item.minSellingPrice, item.landedPrice * 1.2) * itemsPerPacket,
              isLoose: !!group.isLoose,
              barcodeImage: image ? { dataUrl: image, format: 'code128', generatedAt: transactionDate } : undefined,
              dispatchOrderHistory: [{ dispatchOrderId: dispatchOrder._id, quantity: qty, costPricePerPacket: item.costPrice * itemsPerPacket, landedPricePerPacket: item.landedPrice * itemsPerPacket, addedAt: transactionDate }]
            });
          }
          return ps.save({ session });
        });
        await Promise.all(packetTasks);
      }

      manualOrderId = dispatchOrder._id;
    }, txOptions);

    const dispatchOrder = await DispatchOrder.findById(manualOrderId)
      .populate([
        { path: 'supplier', select: 'name company phone email address' },
        { path: 'items.product', select: 'name sku unit images color size productCode pricing' },
        { path: 'createdBy', select: 'name email' },
        { path: 'confirmedBy', select: 'name' }
      ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    await logActivity(req, {
      action: 'CREATE',
      resource: 'Purchase',
      resourceId: dispatchOrder._id,
      description: `Created manual purchase/dispatch order: ${dispatchOrder.orderNumber} (Supplier: ${dispatchOrder.supplier?.company || 'Unknown'})`,
      changes: { old: null, new: dispatchOrder.toObject() }
    });

    // Auto-generate edit request for backdated entries (Admin only)
    if (req.pendingBackdate) {
      try {
        await EditRequestService.submitRequest({
          entityType: 'dispatch-order',
          entityId: dispatchOrder._id,
          requestType: 'edit',
          requestedChanges: { dispatchDate: req.pendingBackdate },
          rawPayload: { dispatchDate: req.pendingBackdate },
          reason: `Auto-generated request to update Dispatch Date from ${new Date().toLocaleDateString('en-GB')} to ${new Date(req.pendingBackdate).toLocaleDateString('en-GB')} (Backdated creation by admin)`,
          requestedBy: req.user._id,
          entityRef: dispatchOrder.orderNumber
        });
      } catch (editReqError) {
        console.error('Failed to auto-create backdate edit request:', editReqError.message);
        // We don't block the response since the main record is already saved
      }
    }

    return sendResponse.success(res, orderObj, 'Manual entry created successfully', 201);

  } catch (error) {
    console.error('Create manual entry error:', error);
    const { status, message, errors } = formatTransactionError(error, 'create manual purchase');
    return sendResponse.error(res, message, status, errors);
  } finally {
    session.endSession();
  }
});

// Get dispatch orders
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20, status, supplier: supplierId, supplierUser, search } = req.query;

    let query = {};

    // If user is supplier, only show their orders
    if (req.user.role === 'supplier') {
      query.supplierUser = req.user._id;
    } else if (supplierId) {
      query.supplier = supplierId;
    }
    // Admin and other roles can view all dispatch orders

    if (search) {
      const searchRegex = new RegExp(search, 'i');

      // Find suppliers matching the search query to search by supplier name
      const matchingSuppliers = await Supplier.find({
        $or: [
          { name: searchRegex },
          { company: searchRegex }
        ]
      }).select('_id');
      const supplierIds = matchingSuppliers.map(s => s._id);

      query.$or = [
        { orderNumber: searchRegex },
        { invoiceNumber: searchRegex },
        { supplier: { $in: supplierIds } }
      ];
    }

    // Filter by supplierUser (null for manual entries, or specific ID for supplier portal entries)
    if (supplierUser !== undefined) {
      if (supplierUser === 'null' || supplierUser === null) {
        query.supplierUser = null; // Manual entries
      } else {
        query.supplierUser = supplierUser; // Specific supplier portal entries
      }
    }

    if (status) {
      // Support comma-separated statuses for multiple status filtering
      const statusArray = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statusArray.length === 1) {
        query.status = statusArray[0];
      } else if (statusArray.length > 1) {
        query.status = { $in: statusArray };
      }
    }

    const orders = await DispatchOrder.find(query)
      .populate('supplier', 'name company')
      .populate('logisticsCompany', 'name code')
      .populate('createdBy', 'name')
      .populate('confirmedBy', 'name')
      .populate('items.product', 'name sku unit images color size productCode pricing')
      .populate('returnedItems.returnedBy', 'name')
      .populate('qrCode.generatedBy', 'name')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await DispatchOrder.countDocuments(query);

    // Convert images to signed URLs (only primary image for list views - reduces payload)
    await convertDispatchOrderImages(orders, { primaryOnly: true });

    return sendResponse.paginated(res, orders, {
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: parseInt(limit)
    });

  } catch (error) {
    console.error('Get dispatch orders error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get unpaid/partially paid dispatch orders for a supplier
router.get('/unpaid/:supplierId', auth, async (req, res) => {
  try {
    const { supplierId } = req.params;

    // Find confirmed dispatch orders for this supplier with remaining balance > 0
    const dispatchOrders = await DispatchOrder.find({
      supplier: supplierId,
      status: 'confirmed',
      'paymentDetails.remainingBalance': { $gt: 0 }
    })
      .select('orderNumber paymentDetails totalQuantity dispatchDate createdAt supplierPaymentTotal totalDiscount')
      .sort({ createdAt: -1 });

    // Calculate total amount and paid amount for each order
    const ordersWithDetails = await Promise.all(dispatchOrders.map(async (order) => {
      // Use supplierPaymentTotal (what we owe supplier in their currency - NO exchange rate, NO percentage)
      // This is already calculated and stored during order confirmation
      const totalAmount = order.supplierPaymentTotal || 0;

      // Calculate cumulative payments from ledger entries
      const paymentEntries = await Ledger.find({
        type: 'supplier',
        entityId: supplierId,
        referenceModel: 'DispatchOrder',
        referenceId: order._id,
        transactionType: 'payment'
      });

      const totalPaid = paymentEntries.reduce((sum, entry) => {
        return sum + (entry.paymentDetails?.cashPayment || 0) + (entry.paymentDetails?.bankPayment || 0);
      }, 0);

      const remainingBalance = totalAmount - totalPaid;

      return {
        _id: order._id,
        orderNumber: order.orderNumber,
        totalAmount: totalAmount,
        paidAmount: totalPaid,
        remainingBalance: remainingBalance,
        paymentStatus: order.paymentDetails?.paymentStatus || 'pending',
        dispatchDate: order.dispatchDate || order.createdAt
      };
    }));

    // Filter out orders that are fully paid (shouldn't happen, but just in case)
    const unpaidOrders = ordersWithDetails.filter(order => order.remainingBalance > 0);

    return sendResponse.success(res, unpaidOrders);

  } catch (error) {
    console.error('Get unpaid dispatch orders error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get dispatch order by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await DispatchOrder.findById(req.params.id)
      .populate('supplier', 'name company contactInfo')
      .populate('logisticsCompany', 'name code contactInfo rates')
      .populate('createdBy', 'name')
      .populate('confirmedBy', 'name')
      .populate('items.product', 'name sku unit images color size productCode pricing')
      .populate('returnedItems.returnedBy', 'name')
      .populate('qrCode.generatedBy', 'name')
      .lean();

    if (!order) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check permissions
    if (req.user.role === 'supplier' && order.supplierUser.toString() !== req.user._id.toString()) {
      return sendResponse.error(res, 'Access denied', 403);
    }

    // Fetch returns for this dispatch order
    const returns = await Return.find({ dispatchOrder: order._id })
      .populate('returnedBy', 'name')
      .sort({ returnedAt: -1 })
      .lean();

    // order is already a plain object from .lean()
    const enrichedOrder = await BalanceService.enrichOrderWithPaymentStatus({ ...order, returns });
    const orderObj = enrichedOrder;

    // Convert images to signed URLs
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj);

  } catch (error) {
    console.error('Get dispatch order error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

/**
 * @route   GET /api/dispatch-orders/:id/packet-stocks
 * @desc    Get packet stocks associated with a dispatch order
 * @access  Private
 */
router.get('/:id/packet-stocks', auth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const Return = require('../models/Return');

    // Fetch packets that have this order in their history
    const packetStocks = await PacketStock.find({
      'dispatchOrderHistory.dispatchOrderId': new mongoose.Types.ObjectId(req.params.id),
      isActive: true,
      availablePackets: { $gt: 0 }
    }).populate('product', 'name sku productCode images');

    // Fetch returns for this order to subtract already returned quantities
    const returns = await Return.find({ dispatchOrder: req.params.id });

    // Calculate order-specific available quantity for each packet stock
    const refinedPacketStocks = packetStocks.map(stock => {
      const stockObj = stock.toObject();

      // 1. Get initial qty from this order in history
      const historyEntry = stock.dispatchOrderHistory.find(
        h => h.dispatchOrderId.toString() === req.params.id
      );
      const initialOrderQty = historyEntry ? historyEntry.quantity : 0;

      // 2. Subtract quantities already returned for this specific packet stock in this order
      let returnedQty = 0;
      returns.forEach(ret => {
        const adjustment = ret.packetAdjustments?.find(
          adj => adj.packetStockId.toString() === stock._id.toString()
        );
        if (adjustment) {
          // If it's a full packet return, count packets * total
          if (adjustment.adjustmentType === 'full-packet-return') {
            returnedQty += (adjustment.packetsReturned || 0);
          } else {
            // Partial or loose returns are tracked in itemsReturned
            returnedQty += (adjustment.itemsReturned || 0);
          }
        }
      });

      // For non-loose packets, initialOrderQty is in PACKETS
      // For loose items, initialOrderQty is in ITEMS (since totalItemsPerPacket is 1)
      const remainingQty = Math.max(0, initialOrderQty - returnedQty);

      // Add totalQuantity field for the frontend
      stockObj.totalQuantity = remainingQty;

      return stockObj;
    }).filter(stock => stock.totalQuantity > 0);

    return sendResponse.success(res, refinedPacketStocks);
  } catch (error) {
    console.error('Get dispatch order packet stocks error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

// Update dispatch order status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status, notes, trackingNumber, actualDeliveryDate } = req.body;

    const order = await DispatchOrder.findById(req.params.id);
    if (!order) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check permissions
    if (req.user.role === 'supplier' && order.supplierUser.toString() !== req.user._id.toString()) {
      return sendResponse.error(res, 'Access denied', 403);
    }

    order.status = status;
    if (notes) order.notes = notes;
    if (trackingNumber) {
      order.trackingInfo.trackingNumber = trackingNumber;
      order.trackingInfo.carrier = order.logisticsCompany.name;
    }
    if (actualDeliveryDate) order.actualDeliveryDate = actualDeliveryDate;

    await order.save();

    await logActivity(req, {
      action: 'STATUS_CHANGE',
      resource: 'DispatchOrder',
      resourceId: order._id,
      description: `Updated status of dispatch order ${order.orderNumber} to ${status}`,
      changes: { old: order.status, new: status, notes }
    });

    return sendResponse.success(res, order, 'Order status updated successfully');

  } catch (error) {
    console.error('Update dispatch order status error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Submit dispatch order for approval (Admin only)
router.post('/:id/submit-approval', auth, async (req, res) => {
  try {
    // Only admin can submit for approval
    if (req.user.role !== 'admin') {
      return sendResponse.error(res, 'Only admin users can submit orders for approval', 403);
    }

    const {
      cashPayment = 0,
      bankPayment = 0,
      exchangeRate,
      percentage,
      discount = 0,
      items,
      totalBoxes,
      logisticsCompany,
      dispatchDate,
      isTotalBoxesConfirmed
    } = req.body;

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier')
      .populate('logisticsCompany', 'name rates');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    if (dispatchOrder.status !== 'pending' && dispatchOrder.status !== 'pending-approval') {
      return sendResponse.error(res, 'Only pending or pending-approval dispatch orders can be submitted for approval', 400);
    }

    try {
      await normalizeDispatchOrderForAdmin(dispatchOrder, req.body, req.user, { setSubmitted: true });
      await dispatchOrder.save();
    } catch (normErr) {
      console.error('Submit approval normalization error:', normErr);
      return sendResponse.error(res, normErr.message || 'Invalid admin input', 400);
    }

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'submittedForApprovalBy', select: 'name' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj, 'Dispatch order submitted for approval successfully');

  } catch (error) {
    console.error('Submit approval error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Confirm dispatch order (Super-admin/Admin)
router.post(
  '/:id/confirm',
  auth,
  dateControl({
    entityType: 'dispatch-order',
    dateField: 'dispatchDate',
    requestType: 'update',
    compareToExisting: true,
    existingDateField: 'dispatchDate',
    entityModel: DispatchOrder,
    allowAdminBypassWithBaseline: true
  }),
  async (req, res) => {
    // Only super-admin or admin can confirm dispatch orders
    if (req.user.role !== 'super-admin' && req.user.role !== 'admin') {
      return sendResponse.error(res, 'Only super-admin or admin can confirm dispatch orders', 403);
    }

    const {
      cashPayment = 0,
      bankPayment = 0,
      exchangeRate,
      percentage,
      discount = 0,
      items,
      totalBoxes,
      logisticsCompany,
      dispatchDate,
      isTotalBoxesConfirmed
    } = req.body;

    const session = await mongoose.startSession();
    const txOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
    let confirmedOrderId = null;

    try {
      await session.withTransaction(async () => {
        const dispatchOrder = await DispatchOrder.findById(req.params.id).session(session);

        if (!dispatchOrder) {
          throw buildRequestError('Dispatch order not found', 404);
        }

        if (!['pending', 'pending-approval'].includes(dispatchOrder.status)) {
          throw buildRequestError('Only pending or pending-approval dispatch orders can be confirmed', 400);
        }

        const unconfiguredItems = (dispatchOrder.items || []).filter(item => !item.packets || item.packets.length === 0);
        if (unconfiguredItems.length > 0) {
          const names = unconfiguredItems.map(item => `"${item.productName || item.productCode}"`).join(', ');
          throw buildRequestError(
            `Cannot confirm order: the following items are missing packet configuration: ${names}`,
            400,
            { code: 'MISSING_PACKETS', items: unconfiguredItems.map(item => item.productName || item.productCode || 'unknown') }
          );
        }

        const finalExchangeRate = exchangeRate !== undefined && exchangeRate !== null
          ? parseFloat(exchangeRate)
          : dispatchOrder.exchangeRate || 1.0;
        const finalPercentage = percentage !== undefined && percentage !== null
          ? parseFloat(percentage)
          : dispatchOrder.percentage || 0;

        if (isNaN(finalExchangeRate) || finalExchangeRate <= 0) {
          throw buildRequestError('Invalid exchange rate. Must be a positive number.', 400);
        }

        if (isNaN(finalPercentage) || finalPercentage < 0) {
          throw buildRequestError('Invalid percentage. Must be a non-negative number.', 400);
        }

        dispatchOrder.exchangeRate = finalExchangeRate;
        dispatchOrder.percentage = finalPercentage;

        if (logisticsCompany) {
          dispatchOrder.logisticsCompany = logisticsCompany;
          dispatchOrder.markModified('logisticsCompany');
        }
        if (dispatchDate !== undefined) {
          const parsedDispatchDate = new Date(dispatchDate);
          if (Number.isNaN(parsedDispatchDate.getTime())) {
            throw buildRequestError('Invalid dispatch date.', 400);
          }
          dispatchOrder.dispatchDate = parsedDispatchDate;
          dispatchOrder.markModified('dispatchDate');
        }
        if (isTotalBoxesConfirmed !== undefined) {
          dispatchOrder.isTotalBoxesConfirmed = !!isTotalBoxesConfirmed;
          dispatchOrder.markModified('isTotalBoxesConfirmed');
        }
        if (totalBoxes !== undefined) {
          dispatchOrder.totalBoxes = parseInt(totalBoxes) || 0;
          dispatchOrder.markModified('totalBoxes');
        }

        const transactionDate = dispatchOrder.dispatchDate ? new Date(dispatchOrder.dispatchDate) : null;
        if (!transactionDate || Number.isNaN(transactionDate.getTime())) {
          throw buildRequestError('Dispatch date is required before confirming this order.', 400);
        }

        if (Array.isArray(items)) {
          if (items.length === dispatchOrder.items.length) {
            dispatchOrder.items.forEach((item, index) => {
              const reqItem = items[index];
              if (reqItem) {
                if (reqItem.quantity !== undefined) item.quantity = Number(reqItem.quantity);
                if (reqItem.productName) item.productName = reqItem.productName;
                if (reqItem.productCode) item.productCode = reqItem.productCode ? reqItem.productCode.trim() : item.productCode;
                if (reqItem.costPrice !== undefined) item.costPrice = Number(reqItem.costPrice);
                if (reqItem.minSellingPrice !== undefined) item.minSellingPrice = Number(reqItem.minSellingPrice);
                if (reqItem.primaryColor) item.primaryColor = Array.isArray(reqItem.primaryColor) ? reqItem.primaryColor : [reqItem.primaryColor];
                if (reqItem.size) item.size = Array.isArray(reqItem.size) ? reqItem.size : [reqItem.size];
                if (reqItem.season) item.season = Array.isArray(reqItem.season) ? reqItem.season : [reqItem.season];
                if (reqItem.productImage) item.productImage = Array.isArray(reqItem.productImage) ? reqItem.productImage : [reqItem.productImage];
                if (reqItem.packets) item.packets = reqItem.packets;
                if (reqItem.boxes) item.boxes = reqItem.boxes;
              }
            });
            dispatchOrder.markModified('items');
          } else {
            dispatchOrder.items = items;
            dispatchOrder.markModified('items');
          }
          await dispatchOrder.save({ session });
        }

        const confirmedQuantities = dispatchOrder.items.map((item, index) => {
          const returnedQty = (dispatchOrder.returnedItems || [])
            .filter(r => r.itemIndex === index)
            .reduce((sum, r) => sum + r.quantity, 0);
          return { itemIndex: index, quantity: Math.max(0, (item.quantity || 0) - returnedQty) };
        });

        let supplierPaymentTotal = 0;
        let landedPriceTotal = 0;
        const itemsWithPrices = dispatchOrder.items.map((item, index) => {
          const qty = confirmedQuantities[index].quantity;
          const landedPrice = truncateToTwoDecimals((item.costPrice / finalExchangeRate) * (1 + (finalPercentage / 100)));
          supplierPaymentTotal += item.costPrice * qty;
          landedPriceTotal += landedPrice * qty;
          return { ...item.toObject(), supplierPaymentAmount: item.costPrice, landedPrice, confirmedQuantity: qty };
        });

        const totalDiscount = (discount !== undefined && discount !== null) ? parseFloat(discount) : (dispatchOrder.totalDiscount || 0);
        const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);
        const subtotal = truncateToTwoDecimals(landedPriceTotal);
        const grandTotal = truncateToTwoDecimals(Math.max(0, subtotal - totalDiscount));

        const supplierId = dispatchOrder.supplier?._id || dispatchOrder.supplier;
        const skus = [...new Set(dispatchOrder.items.map(i => i.productCode?.trim().toUpperCase()).filter(Boolean))];

        const [existingProducts, existingInventories] = await Promise.all([
          Product.find({ sku: { $in: skus }, supplier: supplierId }).session(session),
          Inventory.find({ product: { $in: dispatchOrder.items.map(i => i.product).filter(Boolean) } }).session(session)
        ]);

        const productMap = new Map(existingProducts.map(p => [p.sku, p]));
        const inventoryMap = new Map(existingInventories.map(inv => [inv.product.toString(), inv]));

        const bwipjs = require('bwip-js');

        const itemTasks = dispatchOrder.items.map(async (item, index) => {
          try {
            const confirmedQty = confirmedQuantities[index].quantity;
            if (confirmedQty <= 0) return { index, success: true, skipped: true };

            const productCodeUpper = item.productCode?.trim().toUpperCase();
            let product = productMap.get(productCodeUpper);
            const landedPrice = itemsWithPrices[index].landedPrice;

            if (!product && productCodeUpper) {
              product = await Product.findOne({ sku: productCodeUpper, supplier: supplierId }).session(session);
              if (product) productMap.set(productCodeUpper, product);
            }

            if (!product) {
              const colors = Array.isArray(item.primaryColor) ? item.primaryColor : [item.primaryColor];
              const sizes = Array.isArray(item.size) ? item.size : [item.size];
              product = new Product({
                name: item.productName,
                sku: productCodeUpper,
                supplier: supplierId,
                productCode: item.productCode,
                season: item.season,
                category: 'General',
                unit: 'piece',
                pricing: { 
                  costPrice: landedPrice, 
                  sellingPrice: resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2),
                  minSellingPrice: resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2) 
                },
                color: colors.filter(Boolean),
                size: sizes.filter(Boolean),
                specifications: { color: colors[0], material: item.material },
                isActive: true,
                createdBy: req.user._id
              });
              await product.save({ session });
              if (productCodeUpper) productMap.set(productCodeUpper, product);
            } else {
              let needsSave = false;
              if (!product.isActive) { product.isActive = true; needsSave = true; }
              if (product.pricing.costPrice !== landedPrice) { product.pricing.costPrice = landedPrice; needsSave = true; }
              const resMin = resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2);
              if (product.pricing.sellingPrice !== resMin) {
                product.pricing.sellingPrice = resMin;
                product.pricing.minSellingPrice = resMin;
                needsSave = true;
              }
              if (!Array.isArray(product.images)) {
                product.images = [];
                needsSave = true;
              }
              if (item.productImage) {
                const imgs = Array.isArray(item.productImage) ? item.productImage : [item.productImage];
                imgs.forEach(url => { if (url && !product.images.includes(url)) { product.images.unshift(url); needsSave = true; } });
              }
              if (needsSave) await product.save({ session });
            }

            item.product = product._id;

            let inventory = inventoryMap.get(product._id.toString());
            if (!inventory) {
              inventory = await Inventory.findOneAndUpdate(
                { product: product._id },
                {
                  $setOnInsert: {
                    product: product._id,
                    currentStock: 0,
                    averageCostPrice: landedPrice,
                    purchaseBatches: [],
                    minStockLevel: 0,
                    maxStockLevel: 1000,
                    reorderLevel: 10
                  }
                },
                { new: true, upsert: true, session, setDefaultsOnInsert: true }
              );
              inventoryMap.set(product._id.toString(), inventory);
            }

            const batchInfo = {
              dispatchOrderId: dispatchOrder._id,
              supplierId,
              purchaseDate: transactionDate,
              costPrice: item.costPrice,
              landedPrice,
              exchangeRate: finalExchangeRate
            };

            if (item.useVariantTracking && item.packets?.length > 0) {
              const variantComp = [];
              item.packets.forEach(p => {
                if (!p.composition || !Array.isArray(p.composition)) return;
                p.composition.forEach(c => {
                  const qty = Number(c.quantity);
                  if (c.size && c.color && !isNaN(qty) && qty > 0) {
                    const e = variantComp.find(v => v.size === c.size && v.color === c.color);
                    if (e) e.quantity += qty;
                    else variantComp.push({ size: c.size, color: c.color, quantity: qty });
                  }
                });
              });
              await inventory.addStockWithVariants(
                confirmedQty,
                variantComp,
                'DispatchOrder',
                dispatchOrder._id,
                req.user._id,
                `Confirm Order ${dispatchOrder.orderNumber}`,
                transactionDate,
                session
              );
              inventory.purchaseBatches.push({ ...batchInfo, quantity: confirmedQty, remainingQuantity: confirmedQty });
            } else {
              await inventory.addStockWithBatch(
                confirmedQty,
                batchInfo,
                'DispatchOrder',
                dispatchOrder._id,
                req.user._id,
                `Confirm Order ${dispatchOrder.orderNumber}`,
                transactionDate,
                session
              );
            }
            inventory.recalculateAverageCost();
            await inventory.save({ session });

            const packetGroups = new Map();
            const isLoose = item.packets.some(p => p.isLoose);

            if (isLoose) {
              item.packets.filter(p => p.isLoose).forEach(p => {
                if (!p.composition || !Array.isArray(p.composition)) return;
                p.composition.forEach(c => {
                  const qty = Number(c.quantity);
                  if (c.size && c.color && !isNaN(qty) && qty > 0) {
                    const k = `${c.color}|${c.size}`;
                    if (packetGroups.has(k)) packetGroups.get(k).quantity += qty;
                    else packetGroups.set(k, { color: c.color, size: c.size, quantity: qty, isLoose: true });
                  }
                });
              });
            } else {
              item.packets.forEach(p => {
                const b = generatePacketBarcode(supplierId.toString(), product._id.toString(), p.composition, false);
                if (packetGroups.has(b)) packetGroups.get(b).count++;
                else packetGroups.set(b, { barcode: b, comp: p.composition, items: p.totalItems || p.composition.reduce((s, c) => s + c.quantity, 0), count: 1, isLoose: false });
              });
            }

            const psTasks = Array.from(packetGroups.values()).map(async (group) => {
              let barcode = group.barcode;
              let comp = group.comp;
              let itemsPerPkt = group.items;
              let qty = group.count;

              if (group.isLoose) {
                comp = [{ size: group.size, color: group.color, quantity: 1 }];
                barcode = generatePacketBarcode(supplierId.toString(), product._id.toString(), comp, true);
                qty = group.quantity;
                itemsPerPkt = 1;
              }

              let ps = await PacketStock.findOne({ barcode }).session(session);
              if (ps) {
                await ps.addStock(
                  qty,
                  dispatchOrder._id,
                  item.costPrice * itemsPerPkt,
                  landedPrice * itemsPerPkt,
                  transactionDate,
                  session
                );
                ps.suggestedSellingPrice = resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2) * itemsPerPkt;
              } else {
                const buffer = await bwipjs.toBuffer({ bcid: 'code128', text: barcode, scale: 3, height: 10, includetext: true, textxalign: 'center', textsize: 8 }).catch(() => null);
                ps = new PacketStock({
                  barcode,
                  product: product._id,
                  supplier: supplierId,
                  composition: comp,
                  totalItemsPerPacket: itemsPerPkt,
                  availablePackets: qty,
                  costPricePerPacket: item.costPrice * itemsPerPkt,
                  landedPricePerPacket: landedPrice * itemsPerPkt,
                  suggestedSellingPrice: resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2) * itemsPerPkt,
                  isLoose: !!group.isLoose,
                  barcodeImage: buffer ? { dataUrl: `data:image/png;base64,${buffer.toString('base64')}`, format: 'code128', generatedAt: transactionDate } : undefined,
                  dispatchOrderHistory: [{ dispatchOrderId: dispatchOrder._id, quantity: qty, costPricePerPacket: item.costPrice * itemsPerPkt, landedPricePerPacket: landedPrice * itemsPerPkt, addedAt: transactionDate }]
                });
              }
              return ps.save({ session });
            });
            await Promise.all(psTasks);

            return { index, success: true, productCode: item.productCode };
          } catch (err) {
            console.error(`Item ${index} error:`, err);
            return { index, success: false, error: err.message, productCode: item.productCode };
          }
        });

        const results = await Promise.all(itemTasks);
        if (results.some(r => !r.success)) {
          const failedItems = results.filter(r => !r.success);
          const errorDetails = failedItems.map(r => `Item ${r.index} (${r.productCode || 'unknown'}): ${r.error}`).join('; ');
          throw buildRequestError(
            `Confirmation failed. Errors: ${errorDetails}`,
            400,
            { code: 'ITEM_PROCESSING_FAILED', items: failedItems }
          );
        }

        dispatchOrder.status = 'confirmed';
        dispatchOrder.confirmedAt = transactionDate;
        dispatchOrder.confirmedBy = req.user._id;
        dispatchOrder.exchangeRate = finalExchangeRate;
        dispatchOrder.percentage = finalPercentage;
        dispatchOrder.totalDiscount = totalDiscount;
        dispatchOrder.subtotal = subtotal;
        dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal;
        dispatchOrder.grandTotal = grandTotal;
        dispatchOrder.paymentDetails = {
          cashPayment: Number(cashPayment || 0),
          bankPayment: Number(bankPayment || 0),
          remainingBalance: discountedSupplierPaymentTotal - Number(cashPayment || 0) - Number(bankPayment || 0),
          paymentStatus: (discountedSupplierPaymentTotal <= Number(cashPayment || 0) + Number(bankPayment || 0))
            ? 'paid'
            : (Number(cashPayment || 0) + Number(bankPayment || 0) > 0 ? 'partial' : 'pending')
        };

        await dispatchOrder.save({ session });

        const ledgerTasks = [];
        ledgerTasks.push(Ledger.createEntry({
          type: 'supplier',
          entityId: supplierId,
          entityModel: 'Supplier',
          transactionType: 'purchase',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: discountedSupplierPaymentTotal,
          credit: 0,
          date: transactionDate,
          description: `Confirmed Order ${dispatchOrder.orderNumber}`,
          createdBy: req.user._id
        }, session));
        if (Number(cashPayment) > 0) ledgerTasks.push(Ledger.createEntry({
          type: 'supplier',
          entityId: supplierId,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: Number(cashPayment),
          date: transactionDate,
          description: `Cash payment: ${dispatchOrder.orderNumber}`,
          createdBy: req.user._id
        }, session));
        if (Number(bankPayment) > 0) ledgerTasks.push(Ledger.createEntry({
          type: 'supplier',
          entityId: supplierId,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: Number(bankPayment),
          date: transactionDate,
          description: `Bank payment: ${dispatchOrder.orderNumber}`,
          createdBy: req.user._id
        }, session));
        ledgerTasks.push(Supplier.findByIdAndUpdate(
          supplierId,
          { $inc: { currentBalance: discountedSupplierPaymentTotal - Number(cashPayment || 0) - Number(bankPayment || 0) } },
          { session }
        ));

        if (dispatchOrder.logisticsCompany && dispatchOrder.totalBoxes > 0) {
          const lc = await LogisticsCompany.findById(dispatchOrder.logisticsCompany).session(session);
          if (lc?.rates?.boxRate > 0) {
            ledgerTasks.push(Ledger.createEntry({
              type: 'logistics',
              entityId: lc._id,
              entityModel: 'LogisticsCompany',
              transactionType: 'charge',
              referenceId: dispatchOrder._id,
              referenceModel: 'DispatchOrder',
              debit: dispatchOrder.totalBoxes * lc.rates.boxRate,
              credit: 0,
              date: transactionDate,
              description: `Logistics charge: ${dispatchOrder.orderNumber}`,
              createdBy: req.user._id
            }, session));
          }
        }

        await Promise.all(ledgerTasks);
        confirmedOrderId = dispatchOrder._id;
      }, txOptions);

      const confirmedOrder = await DispatchOrder.findById(confirmedOrderId)
        .populate('supplier', 'name company')
        .populate('createdBy', 'name');

      const orderObj = confirmedOrder.toObject();
      await convertDispatchOrderImages(orderObj);

      sendResponse.success(res, orderObj, 'Dispatch order confirmed successfully');

      (async () => {
        try {
          // Create auto-approval request for backdate if it was bypassed by admin
          if (req.pendingBackdate) {
            await EditRequestService.submitRequest({
              entityType: 'dispatch-order',
              entityId: confirmedOrderId,
              requestType: 'edit',
              requestedChanges: { dispatchDate: req.pendingBackdate },
              rawPayload: { dispatchDate: req.pendingBackdate },
              reason: `Admin request to update Dispatch Date from ${new Date(confirmedOrder.dispatchDate).toLocaleDateString('en-GB')} to ${new Date(req.pendingBackdate).toLocaleDateString('en-GB')} `,
              requestedBy: req.user._id,
              entityRef: confirmedOrder.orderNumber || ''
            });
          }

          await logActivity(req, {
            action: 'STATUS_CHANGE',
            resource: 'DispatchOrder',
            resourceId: confirmedOrderId,
            description: `Confirmed dispatch order: ${confirmedOrder.orderNumber}`,
            changes: { old: 'pending', new: 'confirmed' }
          });
        } catch (err) {
          console.error('Post-confirmation background error:', err);
        }
      })();
    } catch (error) {
      console.error('Confirm dispatch order error:', error);
      const { status, message, errors } = formatTransactionError(error, 'confirm dispatch order');
      return sendResponse.error(res, message, status, errors);
    } finally {
      session.endSession();
    }
  });

// ==========================================
// GET /:id/edit-impact — Impact analysis before editing a confirmed order
// Returns per-item sold quantities and the minimum editable quantity floor.
// Super-admin only.
// ==========================================
router.get('/:id/edit-impact', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin' && req.user.role !== 'admin' && req.user.role !== 'accountant') {
      return sendResponse.error(res, 'Access denied', 403);
    }

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier', 'name company');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    const editableStatuses = ['confirmed', 'picked_up', 'in_transit', 'delivered'];
    if (!editableStatuses.includes(dispatchOrder.status)) {
      return sendResponse.error(res, `Orders with status '${dispatchOrder.status}' cannot be edited`, 400);
    }

    const itemImpacts = [];
    let hasSoldItems = false;
    let hasFullySoldItems = false;

    for (let index = 0; index < dispatchOrder.items.length; index++) {
      const item = dispatchOrder.items[index];
      const productId = item.product;

      let soldQuantity = 0;
      let orderedQuantity = item.quantity || 0;
      let remainingQuantity = orderedQuantity;

      if (productId) {
        const inventory = await Inventory.findOne({ product: productId });
        if (inventory) {
          const batch = inventory.purchaseBatches.find(
            b => b.dispatchOrderId && b.dispatchOrderId.toString() === dispatchOrder._id.toString()
          );
          if (batch) {
            orderedQuantity = batch.quantity || orderedQuantity;
            remainingQuantity = batch.remainingQuantity || 0;
            soldQuantity = orderedQuantity - remainingQuantity;
          }
        }
      }

      if (soldQuantity > 0) hasSoldItems = true;
      if (soldQuantity >= orderedQuantity && orderedQuantity > 0) hasFullySoldItems = true;

      itemImpacts.push({
        itemIndex: index,
        productId: productId ? productId.toString() : null,
        productName: item.productName,
        productCode: item.productCode,
        primaryColor: Array.isArray(item.primaryColor) ? item.primaryColor : [],
        size: Array.isArray(item.size) ? item.size : [],
        season: Array.isArray(item.season) ? item.season : [],
        material: item.material || '',
        description: item.description || '',
        packets: Array.isArray(item.packets) ? item.packets : [],
        useVariantTracking: item.useVariantTracking || false,
        orderedQuantity,
        soldQuantity,
        remainingQuantity,
        minEditableQuantity: soldQuantity,
        canEditConfiguration: soldQuantity === 0,
        currentCostPrice: item.costPrice,
        currentMinSellingPrice: item.minSellingPrice,
        currentLandedPrice: item.landedPrice,
        currentSupplierPaymentAmount: item.supplierPaymentAmount
      });
    }

    return sendResponse.success(res, {
      orderId: dispatchOrder._id,
      orderNumber: dispatchOrder.orderNumber,
      status: dispatchOrder.status,
      currentExchangeRate: dispatchOrder.exchangeRate,
      currentPercentage: dispatchOrder.percentage,
      currentDiscount: dispatchOrder.totalDiscount || 0,
      currentSupplierPaymentTotal: dispatchOrder.supplierPaymentTotal,
      currentGrandTotal: dispatchOrder.grandTotal,
      hasSoldItems,
      hasFullySoldItems,
      items: itemImpacts
    }, 'Order edit impact analysis');

  } catch (error) {
    console.error('Edit impact error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// ==========================================
// PATCH /:id/edit-confirmed — Edit financial fields on a confirmed order.
// Allowed fields: exchangeRate, percentage, discount, items[].costPrice, items[].quantity
// Creates a Ledger adjustment entry if the supplier payment total changes.
// Super-admin only.
// ==========================================
router.patch('/:id/edit-confirmed', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Direct edits are not permitted. Please submit an edit request for approval.', 403);
    }

    const {
      exchangeRate,
      percentage,
      discount,
      dispatchDate,
      items: updatedItems
    } = req.body;

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    const editableStatuses = ['confirmed', 'picked_up', 'in_transit', 'delivered'];
    if (!editableStatuses.includes(dispatchOrder.status)) {
      return sendResponse.error(res, `Orders with status '${dispatchOrder.status}' cannot be edited`, 400);
    }

    // Resolve final values (keep existing if not provided)
    const newExchangeRate = exchangeRate !== undefined && exchangeRate !== null
      ? parseFloat(exchangeRate) : dispatchOrder.exchangeRate;
    const newPercentage = percentage !== undefined && percentage !== null
      ? parseFloat(percentage) : dispatchOrder.percentage;
    const newDiscount = discount !== undefined && discount !== null
      ? parseFloat(discount) : (dispatchOrder.totalDiscount || 0);

    if (isNaN(newExchangeRate) || newExchangeRate <= 0) {
      return sendResponse.error(res, 'Invalid exchange rate. Must be a positive number.', 400);
    }
    if (isNaN(newPercentage) || newPercentage < 0) {
      return sendResponse.error(res, 'Invalid percentage. Must be a non-negative number.', 400);
    }

    // Capture old values for sync
    const oldSupplierPaymentTotal = dispatchOrder.supplierPaymentTotal || 0;
    const oldDispatchDate = dispatchOrder.dispatchDate ? new Date(dispatchOrder.dispatchDate) : null;
    let dateChanged = false;

    if (dispatchDate !== undefined && dispatchDate !== null) {
      const newD = new Date(dispatchDate);
      if (!isNaN(newD.getTime())) {
        // Time Preservation: Keep original HH:mm:ss if possible
        if (oldDispatchDate) {
          newD.setHours(oldDispatchDate.getHours(), oldDispatchDate.getMinutes(), oldDispatchDate.getSeconds(), oldDispatchDate.getMilliseconds());
        }

        if (!oldDispatchDate || oldDispatchDate.getTime() !== newD.getTime()) {
          dispatchOrder.dispatchDate = newD;
          dateChanged = true;
        }
      }
    }

    // Validate item updates — quantity floors and safe configuration edits
    if (Array.isArray(updatedItems)) {
      for (let i = 0; i < updatedItems.length; i++) {
        const reqItem = updatedItems[i];
        if (!reqItem) continue;

        const item = dispatchOrder.items[i];
        if (!item) continue;

        if (reqItem.quantity !== undefined) {
          const newQty = parseInt(reqItem.quantity);
          if (isNaN(newQty) || newQty < 0) {
            return sendResponse.error(res, `Invalid quantity for item ${i}`, 400);
          }

          if (item.product) {
            const inventory = await Inventory.findOne({ product: item.product });
            if (inventory) {
              const batch = inventory.purchaseBatches.find(
                b => b.dispatchOrderId && b.dispatchOrderId.toString() === dispatchOrder._id.toString()
              );
              if (batch) {
                const soldQty = (batch.quantity || 0) - (batch.remainingQuantity || 0);
                if (newQty < soldQty) {
                  return sendResponse.error(res,
                    `Cannot reduce quantity for item "${item.productName || item.productCode}" below sold quantity (${soldQty} units already sold)`,
                    400
                  );
                }
              }
            }
          }
        }

        const hasConfigMutation =
          reqItem.productName !== undefined ||
          reqItem.productCode !== undefined ||
          reqItem.minSellingPrice !== undefined ||
          reqItem.primaryColor !== undefined ||
          reqItem.size !== undefined ||
          reqItem.season !== undefined ||
          reqItem.material !== undefined ||
          reqItem.description !== undefined ||
          reqItem.productId !== undefined ||
          reqItem.packets !== undefined ||
          reqItem.useVariantTracking !== undefined;

        if (hasConfigMutation && item.product) {
          const inventory = await Inventory.findOne({ product: item.product });
          if (inventory) {
            const batch = inventory.purchaseBatches.find(
              b => b.dispatchOrderId && b.dispatchOrderId.toString() === dispatchOrder._id.toString()
            );
            if (batch) {
              const soldQty = (batch.quantity || 0) - (batch.remainingQuantity || 0);
              if (soldQty > 0) {
                return sendResponse.error(
                  res,
                  `Configuration changes are only allowed when sold quantity is 0. Item "${item.productName || item.productCode}" has ${soldQty} sold units.`,
                  400
                );
              }
            }
          }
        }
      }
    }

    // Apply item-level cost/quantity updates
    if (Array.isArray(updatedItems)) {
      updatedItems.forEach((reqItem, index) => {
        if (!reqItem) return;
        const item = dispatchOrder.items[index];
        if (!item) return;
        if (reqItem.costPrice !== undefined) item.costPrice = parseFloat(reqItem.costPrice) || item.costPrice;
        if (reqItem.quantity !== undefined) item.quantity = parseInt(reqItem.quantity) || item.quantity;
        if (reqItem.productName !== undefined) item.productName = String(reqItem.productName || '').trim() || item.productName;
        if (reqItem.productCode !== undefined) item.productCode = String(reqItem.productCode || '').trim().toUpperCase() || item.productCode;
        if (reqItem.minSellingPrice !== undefined) item.minSellingPrice = parseFloat(reqItem.minSellingPrice);
        if (reqItem.primaryColor !== undefined) item.primaryColor = Array.isArray(reqItem.primaryColor) ? reqItem.primaryColor.filter(Boolean) : [];
        if (reqItem.size !== undefined) item.size = Array.isArray(reqItem.size) ? reqItem.size.filter(Boolean) : [];
        if (reqItem.season !== undefined) item.season = Array.isArray(reqItem.season) ? reqItem.season.filter(Boolean) : [];
        if (reqItem.material !== undefined) item.material = reqItem.material ?? '';
        if (reqItem.description !== undefined) item.description = reqItem.description ?? '';
        if (reqItem.packets !== undefined) item.packets = Array.isArray(reqItem.packets) ? reqItem.packets : [];
        if (reqItem.useVariantTracking !== undefined) item.useVariantTracking = Boolean(reqItem.useVariantTracking);
        if (reqItem.productId !== undefined && mongoose.Types.ObjectId.isValid(reqItem.productId)) {
          item.product = new mongoose.Types.ObjectId(reqItem.productId);
        }
      });
      dispatchOrder.markModified('items');
    }

    // Recalculate totals with new rates
    let newSupplierPaymentTotal = 0;
    let newLandedPriceTotal = 0;

    const recalcedItems = dispatchOrder.items.map((item) => {
      const costPrice = item.costPrice || 0;
      const qty = item.quantity || 0;
      const supplierPaymentAmount = costPrice; // per unit, no exchange rate
      newSupplierPaymentTotal += supplierPaymentAmount * qty;

      const landedPrice = truncateToTwoDecimals((costPrice / newExchangeRate) * (1 + (newPercentage / 100)));
      newLandedPriceTotal += truncateToTwoDecimals(landedPrice * qty);

      const minSellingPrice = resolveMinSellingPrice(item.minSellingPrice, landedPrice * 1.2);

      return { item, landedPrice, supplierPaymentAmount, minSellingPrice };
    });

    const discountedSupplierPaymentTotal = Math.max(0, newSupplierPaymentTotal - newDiscount);
    const newSubtotal = truncateToTwoDecimals(newLandedPriceTotal);
    const newGrandTotal = truncateToTwoDecimals(Math.max(0, newSubtotal - newDiscount));

    // Write recalculated per-item prices back onto order
    recalcedItems.forEach(({ item, landedPrice, supplierPaymentAmount, minSellingPrice }) => {
      item.supplierPaymentAmount = supplierPaymentAmount;
      item.landedPrice = landedPrice;
      item.minSellingPrice = minSellingPrice;
    });

    // Update order-level financial fields
    dispatchOrder.exchangeRate = newExchangeRate;
    dispatchOrder.percentage = newPercentage;
    dispatchOrder.totalDiscount = newDiscount;
    dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal;
    dispatchOrder.subtotal = newSubtotal;
    dispatchOrder.grandTotal = newGrandTotal;

    await dispatchOrder.save();

    // Update original Ledger purchase entry instead of creating an adjustment
    const ledgerDelta = parseFloat((discountedSupplierPaymentTotal - oldSupplierPaymentTotal).toFixed(4));

    if (Math.abs(ledgerDelta) > 0.001) {
      const originalPurchaseEntry = await Ledger.findOne({
        referenceId: dispatchOrder._id,
        transactionType: 'purchase'
      });

      if (originalPurchaseEntry) {
        // Update the original entry directly
        originalPurchaseEntry.debit = discountedSupplierPaymentTotal;
        originalPurchaseEntry.date = dispatchOrder.dispatchDate; // Update date
        originalPurchaseEntry.description = `Confirmed Order ${dispatchOrder.orderNumber} confirmed (Edited) - Supplier Payment: €${discountedSupplierPaymentTotal.toFixed(2)}, Discount: €${newDiscount.toFixed(2)}, Final Amount: €${discountedSupplierPaymentTotal.toFixed(2)}`;

        // Save the updated entry (this triggers internal balance calculation for THIS entry)
        await originalPurchaseEntry.save();

        // Recalculate all subsequent balances for this supplier to ensure the ledger remains consistent
        // Use the earlier of the old and new date as the starting point for recalculation
        const recalcStartDate = (oldDispatchDate && oldDispatchDate < dispatchOrder.dispatchDate) ? oldDispatchDate : dispatchOrder.dispatchDate;
        await Ledger.recalculateBalances('supplier', dispatchOrder.supplier._id, recalcStartDate);

        console.log(`[Edit Order] Updated original ledger entry for order ${dispatchOrder.orderNumber} and recalculated balances from ${recalcStartDate.toISOString()}.`);
      } else {
        // Fallback: If for some reason the original purchase entry is missing, create an adjustment as before
        const isIncrease = ledgerDelta > 0;
        await Ledger.createEntry({
          type: 'supplier',
          entityId: dispatchOrder.supplier._id,
          entityModel: 'Supplier',
          transactionType: 'adjustment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: isIncrease ? truncateToTwoDecimals(Math.abs(ledgerDelta)) : 0,
          credit: !isIncrease ? truncateToTwoDecimals(Math.abs(ledgerDelta)) : 0,
          date: new Date(),
          description: `Order ${dispatchOrder.orderNumber} edited by super-admin — original purchase entry not found, applied adjustment (delta: ${isIncrease ? '+' : ''}€${ledgerDelta.toFixed(2)})`,
          createdBy: req.user._id
        });
        console.log(`[Edit Order] Original ledger entry not found for order ${dispatchOrder.orderNumber}, created adjustment fallback.`);
      }

      // Keep Supplier.currentBalance in sync
      await Supplier.findByIdAndUpdate(
        dispatchOrder.supplier._id,
        { $inc: { currentBalance: ledgerDelta } }
      );
    }

    // Update inventory batch prices & dates (non-fatal per item)
    for (const { item, landedPrice, minSellingPrice } of recalcedItems) {
      if (!item.product) continue;
      try {
        const inventory = await Inventory.findOne({ product: item.product });
        if (!inventory) continue;

        // Update price
        await inventory.updateBatchPrices(dispatchOrder._id, {
          costPrice: item.costPrice,
          landedPrice,
          exchangeRate: newExchangeRate,
          quantity: item.quantity
        });

        // Update date if changed
        if (dateChanged) {
          await inventory.updateBatchDate(dispatchOrder._id, dispatchOrder.dispatchDate);
        }
      } catch (invErr) {
        console.error(`[Edit Confirmed] Failed to update inventory batch for product ${item.product}:`, invErr.message);
      }
    }

    // Keep product pricing aligned with edited minimum selling prices
    for (const { item, minSellingPrice } of recalcedItems) {
      if (!item.product) continue;
      try {
        await Product.findByIdAndUpdate(item.product, {
          $set: {
            'pricing.minSellingPrice': minSellingPrice,
            'pricing.sellingPrice': minSellingPrice,
          }
        });
      } catch (productErr) {
        console.error(`[Edit Confirmed] Failed to update Product pricing for ${item.product}:`, productErr.message);
      }
    }

    // Update PacketStock dispatchOrderHistory for this order (non-fatal per packet)
    for (const { item, landedPrice, minSellingPrice } of recalcedItems) {
      if (!item.product) continue;
      try {
        const packetStocks = await PacketStock.find({
          product: item.product,
          'dispatchOrderHistory.dispatchOrderId': dispatchOrder._id
        });
        for (const ps of packetStocks) {
          const histEntry = ps.dispatchOrderHistory.find(
            h => h.dispatchOrderId && h.dispatchOrderId.toString() === dispatchOrder._id.toString()
          );
          if (!histEntry) continue;

          const itemsPerPacket = ps.totalItemsPerPacket || 1;
          histEntry.landedPricePerPacket = truncateToTwoDecimals(landedPrice * itemsPerPacket);
          histEntry.costPricePerPacket = truncateToTwoDecimals(item.costPrice * itemsPerPacket);
          ps.markModified('dispatchOrderHistory');

          // If this is the only contributing order, also update the headline per-packet prices
          if (ps.dispatchOrderHistory.length === 1) {
            ps.landedPricePerPacket = histEntry.landedPricePerPacket;
            ps.costPricePerPacket = histEntry.costPricePerPacket;
          }

          // Dispatch-order min sell price is authoritative for customer-facing packet price.
          ps.suggestedSellingPrice = truncateToTwoDecimals(minSellingPrice * (ps.totalItemsPerPacket || 1));
          await ps.save();
        }
      } catch (psErr) {
        console.error(`[Edit Confirmed] Failed to update PacketStock for product ${item.product}:`, psErr.message);
      }
    }

    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'confirmedBy', select: 'name' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, {
      order: orderObj,
      ledgerDelta,
      message: Math.abs(ledgerDelta) > 0.001
        ? `Order updated. Ledger entry updated (delta: ${ledgerDelta > 0 ? '+' : ''}€${ledgerDelta.toFixed(2)}).`
        : 'Order updated. No ledger change needed.'
    }, 'Confirmed order updated successfully');

  } catch (error) {
    console.error('Edit confirmed order error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Return items from dispatch order
router.post('/:id/return', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    // Only admin/manager can return items
    if (!['super-admin', 'admin', 'employee'].includes(req.user.role)) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Only admins and managers can return items', 403);
    }

    const { returnedItems, notes } = req.body;

    if (!Array.isArray(returnedItems) || returnedItems.length === 0) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Returned items array is required', 400);
    }

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier')
      .session(session);

    if (!dispatchOrder) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Validate return quantities and process stock
    const returnItemsData = [];
    const packetAdjustments = [];
    let totalReturnValueUnits = 0; // Total value in units * costPrice

    for (const returnItem of returnedItems) {
      const { quantity, reason, returnType, packetStockId, breakItems, productId } = returnItem;

      // Find item in dispatch order
      let itemIndex = returnItem.itemIndex;
      let item;

      if (itemIndex !== undefined && itemIndex !== null) {
        item = dispatchOrder.items[itemIndex];
      } else if (productId) {
        itemIndex = dispatchOrder.items.findIndex(i =>
          i.product && i.product.toString() === productId
        );
        if (itemIndex !== -1) item = dispatchOrder.items[itemIndex];
      }

      if (!item) {
        throw new Error(`Item not found in dispatch order`);
      }

      const unitCostPrice = item.costPrice || 0;
      let unitsReturnedInThisItem = 0;

      // Handle Packet-Aware Returns
      if (packetStockId) {
        const packetStock = await PacketStock.findById(packetStockId).session(session);
        if (!packetStock) throw new Error(`PacketStock ${packetStockId} not found`);

        if (returnType === 'packet') {
          // Return full packets
          await packetStock.returnToSupplier(quantity, null, session);
          unitsReturnedInThisItem = quantity * packetStock.totalItemsPerPacket;

          packetAdjustments.push({
            packetStockId: packetStock._id,
            barcode: packetStock.barcode,
            adjustmentType: 'full-packet-return',
            packetsReturned: quantity,
            itemsReturned: unitsReturnedInThisItem
          });
        } else if (returnType === 'break') {
          // Break one packet and return specific items
          const breakResult = await packetStock.breakForSupplierReturn(breakItems, req.user._id, null, session);
          unitsReturnedInThisItem = breakResult.totalItemsReturned;

          packetAdjustments.push({
            packetStockId: packetStock._id,
            barcode: packetStock.barcode,
            adjustmentType: 'partial-break',
            packetsReturned: 1,
            itemsReturned: unitsReturnedInThisItem,
            looseStocksCreated: breakResult.looseStocksCreated
          });
        } else if (returnType === 'loose') {
          // Return loose items from a loose packet stock
          await packetStock.returnLooseToSupplier(quantity, null, session);
          unitsReturnedInThisItem = quantity;

          packetAdjustments.push({
            packetStockId: packetStock._id,
            barcode: packetStock.barcode,
            adjustmentType: 'loose-return',
            itemsReturned: quantity
          });
        }
      } else {
        // Fallback for legacy items or items without packet tracking
        unitsReturnedInThisItem = quantity;
      }

      // Update Inventory Stock (FIFO or standard)
      const inventory = await Inventory.findOne({ product: item.product }).session(session);
      if (inventory) {
        // We use reduceStock here because items are LEAVING our warehouse and going back to supplier
        // This mirrors how the items were originally added to the system
        try {
          await inventory.reduceStock(
            unitsReturnedInThisItem,
            `Return - ${dispatchOrder.orderNumber}`,
            null, // Will update with returnDoc._id reference if possible later, or use null for now
            req.user._id,
            `Supplier Return from DO: ${dispatchOrder.orderNumber}. Reason: ${reason || 'None'}`
          );
        } catch (invErr) {
          console.warn(`[Return] Inventory reduction warning for ${item.productCode}: ${invErr.message}`);
          // If inventory reduction fails due to "insufficient stock", we still allow the return 
          // to maintain correct financials, but we log the discrepancy.
        }
      }

      // Validate against order remaining quantity
      const alreadyReturned = dispatchOrder.returnedItems
        .filter(returned => returned.itemIndex === itemIndex)
        .reduce((sum, returned) => sum + returned.quantity, 0);
      const remainingQty = item.quantity - alreadyReturned;

      if (unitsReturnedInThisItem > remainingQty) {
        throw new Error(`Total units returned (${unitsReturnedInThisItem}) exceeds remaining quantity (${remainingQty}) for ${item.productName}`);
      }

      // Calculate value based on order's cost price (accurate to this specific DO)
      const returnValue = unitCostPrice * unitsReturnedInThisItem;
      totalReturnValueUnits += returnValue;

      // Add to returnItemsData for Return document
      returnItemsData.push({
        itemIndex,
        product: item.product,
        productName: item.productName,
        productCode: item.productCode,
        originalQuantity: item.quantity,
        returnedQuantity: unitsReturnedInThisItem,
        costPrice: unitCostPrice,
        landedPrice: item.landedPrice || unitCostPrice,
        reason: reason || '',
        returnComposition: breakItems || []
      });

      // Add to dispatch order's returnedItems array
      dispatchOrder.returnedItems.push({
        itemIndex,
        quantity: unitsReturnedInThisItem,
        reason: reason || '',
        returnedAt: new Date(),
        returnedBy: req.user._id
      });
    }

    // Create Return document
    const returnDoc = new Return({
      dispatchOrder: dispatchOrder._id,
      supplier: dispatchOrder.supplier._id,
      returnType: 'order-level',
      returnMode: packetAdjustments.length > 0 ? 'mixed' : 'legacy',
      packetAdjustments,
      items: returnItemsData,
      totalReturnValue: totalReturnValueUnits,
      returnedAt: new Date(),
      returnedBy: req.user._id,
      notes: notes || ''
    });

    await returnDoc.save({ session });

    // Update Financials if order is confirmed
    if (dispatchOrder.status === 'confirmed') {
      const totalUnits = returnItemsData.reduce((sum, i) => sum + i.returnedQuantity, 0);

      // Create Ledger Credit entry
      // Use BalanceService to get accurate balance
      const currentSupplierBalance = await BalanceService.getSupplierBalance(dispatchOrder.supplier._id);
      const newSupplierBalance = currentSupplierBalance - totalReturnValueUnits;

      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'return',
        referenceId: returnDoc._id,
        referenceModel: 'Return',
        debit: 0,
        credit: totalReturnValueUnits,
        date: new Date(),
        description: `Return from DO ${dispatchOrder.orderNumber} - ${totalUnits} units worth ${totalReturnValueUnits.toFixed(2)}`,
        remarks: `Return ID: ${returnDoc._id}`,
        createdBy: req.user._id,
        paymentDetails: {
          cashPayment: 0,
          bankPayment: 0,
          remainingBalance: newSupplierBalance
        }
      }, session);

      // Update supplier balance
      await Supplier.findByIdAndUpdate(
        dispatchOrder.supplier._id,
        { $inc: { currentBalance: -totalReturnValueUnits } },
        { session }
      );

      // Recalculate confirmed quantities for DO
      dispatchOrder.confirmedQuantities = dispatchOrder.items.map((item, index) => {
        const totalReturned = dispatchOrder.returnedItems
          .filter(returned => returned.itemIndex === index)
          .reduce((sum, returned) => sum + returned.quantity, 0);
        return {
          itemIndex: index,
          quantity: item.quantity - totalReturned
        };
      });

      // Update DO remaining balance
      const currentOrderRemaining = dispatchOrder.paymentDetails?.remainingBalance || 0;
      const newOrderRemaining = Math.max(0, currentOrderRemaining - totalReturnValueUnits);

      dispatchOrder.paymentDetails = {
        ...dispatchOrder.paymentDetails,
        remainingBalance: newOrderRemaining,
        paymentStatus: newOrderRemaining <= 0 ? 'paid' :
          (dispatchOrder.paymentDetails?.cashPayment || 0) +
            (dispatchOrder.paymentDetails?.bankPayment || 0) +
            (dispatchOrder.paymentDetails?.creditApplied || 0) > 0
            ? 'partial' : 'pending'
      };
    }

    await dispatchOrder.save({ session });
    await session.commitTransaction();
    session.endSession();

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' },
      { path: 'returnedItems.returnedBy', select: 'name' }
    ]);

    const returns = await Return.find({ dispatchOrder: dispatchOrder._id })
      .populate('returnedBy', 'name')
      .sort({ returnedAt: -1 });

    const orderObj = dispatchOrder.toObject();
    orderObj.returns = returns;
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj, 'Items returned successfully');

  } catch (error) {
    try {
      await session.abortTransaction();
    } catch (abortErr) {
      // Transaction may already be aborted
    }
    session.endSession();
    console.error('Return items error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Generate/regenerate QR code for dispatch order
router.post('/:id/generate-qr', auth, async (req, res) => {
  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check permissions - supplier can only generate QR for their own orders
    if (req.user.role === 'supplier' && dispatchOrder.supplierUser.toString() !== req.user._id.toString()) {
      return sendResponse.error(res, 'Access denied', 403);
    }

    await generateDispatchOrderQR(dispatchOrder, req.user._id);

    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code' },
      { path: 'qrCode.generatedBy', select: 'name' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj, 'QR code generated successfully');
  } catch (error) {
    console.error('Generate QR code error:', error);
    return sendResponse.error(res, error.message || 'Unable to generate QR code', 500);
  }
});

// Get dispatch order details from QR code data (for mobile app scanning)
router.get('/qr/:qrData', async (req, res) => {
  try {
    const { qrData } = req.params;

    // Decode QR data - try multiple formats
    let payload;
    try {
      // Try direct JSON parse first (most common)
      payload = JSON.parse(decodeURIComponent(qrData));
    } catch (parseError1) {
      try {
        // Try base64 decode then JSON parse
        payload = JSON.parse(Buffer.from(qrData, 'base64').toString('utf-8'));
      } catch (parseError2) {
        try {
          // Try direct JSON parse without decoding
          payload = JSON.parse(qrData);
        } catch (e) {
          return sendResponse.error(res, 'Invalid QR code data format', 400);
        }
      }
    }

    // Validate payload structure
    if (!payload.type || payload.type !== 'dispatch_order' || !payload.dispatchOrderId) {
      return sendResponse.error(res, 'Invalid QR code payload', 400);
    }

    const dispatchOrder = await DispatchOrder.findById(payload.dispatchOrderId)
      .populate('supplier', 'name company')
      .populate('logisticsCompany', 'name code')
      .populate('items.product', 'name sku code pricing season category brand');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj, 'Dispatch order found');
  } catch (error) {
    console.error('Get dispatch order from QR error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Confirm dispatch order via QR scan (mobile app endpoint)
router.post('/qr/:qrData/confirm', auth, async (req, res) => {
  try {
    // Only admin/manager can confirm via QR scan
    if (!['super-admin', 'admin', 'employee'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins and managers can confirm dispatch orders', 403);
    }

    const { qrData } = req.params;
    const { cashPayment = 0, bankPayment = 0, qrPayload, exchangeRate, percentage } = req.body;

    // Decode QR data - can come from URL param or request body
    let payload;
    if (qrPayload) {
      // If payload is in request body, use it directly
      payload = qrPayload;
    } else {
      // Otherwise, decode from URL parameter
      try {
        payload = JSON.parse(decodeURIComponent(qrData));
      } catch (parseError1) {
        try {
          payload = JSON.parse(Buffer.from(qrData, 'base64').toString('utf-8'));
        } catch (parseError2) {
          try {
            payload = JSON.parse(qrData);
          } catch (e) {
            return sendResponse.error(res, 'Invalid QR code data format', 400);
          }
        }
      }
    }

    // Validate payload
    if (!payload.type || payload.type !== 'dispatch_order' || !payload.dispatchOrderId) {
      return sendResponse.error(res, 'Invalid QR code payload', 400);
    }

    const dispatchOrder = await DispatchOrder.findById(payload.dispatchOrderId)
      .populate('supplier');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    if (!['pending', 'pending-approval'].includes(dispatchOrder.status)) {
      return sendResponse.error(res, 'Only pending or pending-approval dispatch orders can be confirmed', 400);
    }

    // Validate and set exchange rate and percentage from admin input
    const finalExchangeRate = exchangeRate !== undefined && exchangeRate !== null
      ? parseFloat(exchangeRate)
      : dispatchOrder.exchangeRate || 1.0;
    const finalPercentage = percentage !== undefined && percentage !== null
      ? parseFloat(percentage)
      : dispatchOrder.percentage || 0;

    if (isNaN(finalExchangeRate) || finalExchangeRate <= 0) {
      return sendResponse.error(res, 'Invalid exchange rate. Must be a positive number.', 400);
    }

    if (isNaN(finalPercentage) || finalPercentage < 0) {
      return sendResponse.error(res, 'Invalid percentage. Must be a non-negative number.', 400);
    }

    // Update dispatch order with admin-provided exchange rate and percentage
    dispatchOrder.exchangeRate = finalExchangeRate;
    dispatchOrder.percentage = finalPercentage;

    // Calculate confirmed quantities (original - returned)
    const confirmedQuantities = dispatchOrder.items.map((item, index) => {
      const returnedItems = dispatchOrder.returnedItems || [];
      const totalReturned = returnedItems
        .filter(returned => returned.itemIndex === index)
        .reduce((sum, returned) => sum + returned.quantity, 0);

      const confirmedQty = Math.max(0, (item.quantity || 0) - totalReturned);

      return {
        itemIndex: index,
        quantity: confirmedQty
      };
    });

    // Calculate supplier payment amount and landed price for each item
    // Supplier Payment = costPrice × quantity (NO exchange rate, NO profit margin) - what admin pays supplier
    // Landed Price = (costPrice / exchangeRate) × (1 + profit%) × quantity - for inventory valuation
    let supplierPaymentTotal = 0;
    let landedPriceTotal = 0;
    const itemsWithPrices = dispatchOrder.items.map((item, index) => {
      const costPrice = item.costPrice || 0;
      const confirmedQty = confirmedQuantities[index].quantity;

      // Supplier payment amount (what admin pays supplier - NO exchange rate, NO profit margin)
      // Formula: cost price × quantity
      const supplierPaymentAmount = costPrice;
      const supplierPaymentItemTotal = supplierPaymentAmount * confirmedQty;
      supplierPaymentTotal += supplierPaymentItemTotal;

      // Landed price (for inventory valuation - WITH profit margin)
      // Formula: (cost price / exchange rate) × (1 + percentage/100)
      const landedPrice = (costPrice / finalExchangeRate) * (1 + (finalPercentage / 100));
      const landedPriceItemTotal = landedPrice * confirmedQty;
      landedPriceTotal += landedPriceItemTotal;

      return {
        ...item.toObject(),
        supplierPaymentAmount,
        landedPrice,
        confirmedQuantity: confirmedQty
      };
    });

    // Get discount from order (set by supplier)
    const totalDiscount = dispatchOrder.totalDiscount || 0;

    // Apply discount to supplierPaymentTotal (what admin pays supplier)
    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);

    const subtotal = landedPriceTotal;
    const grandTotal = Math.max(0, subtotal - totalDiscount);

    // Update dispatch order
    dispatchOrder.status = 'confirmed';
    dispatchOrder.confirmedAt = new Date();
    dispatchOrder.confirmedBy = req.user._id;
    dispatchOrder.exchangeRate = finalExchangeRate;
    dispatchOrder.percentage = finalPercentage;
    dispatchOrder.totalDiscount = totalDiscount;
    dispatchOrder.subtotal = subtotal;
    dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal; // Use discounted amount
    dispatchOrder.grandTotal = grandTotal; // Landed total after discount (for inventory valuation)
    dispatchOrder.paymentDetails = {
      cashPayment: parseFloat(cashPayment) || 0,
      bankPayment: parseFloat(bankPayment) || 0,
      remainingBalance: discountedSupplierPaymentTotal - (parseFloat(cashPayment) || 0) - (parseFloat(bankPayment) || 0),
      paymentStatus: discountedSupplierPaymentTotal === (parseFloat(cashPayment) || 0) + (parseFloat(bankPayment) || 0)
        ? 'paid'
        : (parseFloat(cashPayment) || 0) + (parseFloat(bankPayment) || 0) > 0
          ? 'partial'
          : 'pending'
    };
    dispatchOrder.confirmedQuantities = confirmedQuantities;

    // Update prices on items
    dispatchOrder.items.forEach((item, index) => {
      item.supplierPaymentAmount = itemsWithPrices[index].supplierPaymentAmount;
      item.landedPrice = itemsWithPrices[index].landedPrice;
    });

    await dispatchOrder.save();

    // Log the activity
    await logActivity(req, {
      action: 'STATUS_CHANGE',
      resource: 'DispatchOrder',
      resourceId: dispatchOrder._id,
      description: `Confirmed dispatch order ${dispatchOrder.orderNumber} via QR scan`,
      changes: { old: 'pending/pending-approval', new: 'confirmed' }
    });

    // Create ledger entry for purchase (debit) - use supplierPaymentTotal (what admin owes supplier)
    await Ledger.createEntry({
      type: 'supplier',
      entityId: dispatchOrder.supplier._id,
      entityModel: 'Supplier',
      transactionType: 'purchase',
      referenceId: dispatchOrder._id,
      referenceModel: 'DispatchOrder',
      debit: supplierPaymentTotal,
      credit: 0,
      date: transactionDate,
      description: `Dispatch Order ${dispatchOrder.orderNumber} confirmed via QR scan - Supplier Payment: €${supplierPaymentTotal.toFixed(2)} (Cost ÷ Exchange Rate × Qty), Ledger shows: €${landedPriceTotal.toFixed(2)} ((Cost ÷ Exchange Rate + ${finalPercentage}%) × Qty), Cash: €${parseFloat(cashPayment).toFixed(2)}, Bank: €${parseFloat(bankPayment).toFixed(2)}, Remaining: €${dispatchOrder.paymentDetails.remainingBalance.toFixed(2)}`,
      paymentDetails: {
        cashPayment: parseFloat(cashPayment) || 0,
        bankPayment: parseFloat(bankPayment) || 0,
        remainingBalance: dispatchOrder.paymentDetails.remainingBalance
      },
      createdBy: req.user._id
    });

    // Create payment ledger entries
    const cashPaymentAmount = parseFloat(cashPayment) || 0;
    const bankPaymentAmount = parseFloat(bankPayment) || 0;

    if (cashPaymentAmount > 0) {
      try {
        await Ledger.createEntry({
          type: 'supplier',
          entityId: dispatchOrder.supplier._id,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: cashPaymentAmount,
          date: transactionDate,
          description: `Cash payment for Dispatch Order ${dispatchOrder.orderNumber} (QR scan)`,
          paymentMethod: 'cash',
          paymentDetails: {
            cashPayment: cashPaymentAmount,
            bankPayment: 0,
            remainingBalance: 0
          },
          createdBy: req.user._id
        });
      } catch (paymentError) {
        console.error('Error creating cash payment ledger entry:', paymentError);
      }
    }

    if (bankPaymentAmount > 0) {
      try {
        await Ledger.createEntry({
          type: 'supplier',
          entityId: dispatchOrder.supplier._id,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: bankPaymentAmount,
          date: transactionDate,
          description: `Bank payment for Dispatch Order ${dispatchOrder.orderNumber} (QR scan)`,
          paymentMethod: 'bank',
          paymentDetails: {
            cashPayment: 0,
            bankPayment: bankPaymentAmount,
            remainingBalance: 0
          },
          createdBy: req.user._id
        });
      } catch (paymentError) {
        console.error('Error creating bank payment ledger entry:', paymentError);
      }
    }

    // Update supplier balance - use discountedSupplierPaymentTotal (what admin owes supplier after discount)
    await Supplier.findByIdAndUpdate(
      dispatchOrder.supplier._id,
      { $inc: { currentBalance: discountedSupplierPaymentTotal - cashPaymentAmount - bankPaymentAmount } }
    );

    // Update inventory (similar to regular confirmation)
    try {
      // Track results for each item
      const inventoryResults = [];

      // Season is now an array field, no need to populate

      for (let index = 0; index < dispatchOrder.items.length; index++) {
        try {
          const item = dispatchOrder.items[index];
          const confirmedQtyEntry = confirmedQuantities.find(cq => cq.itemIndex === index);
          const confirmedQuantity = confirmedQtyEntry ? confirmedQtyEntry.quantity : 0;

          if (confirmedQuantity <= 0) {
            const totalReturned = (item.quantity || 0) - confirmedQuantity;
            console.warn(`[Inventory Update - QR] Skipping item ${index} for dispatch order ${dispatchOrder.orderNumber}: confirmedQuantity=${confirmedQuantity}, item.quantity=${item.quantity || 0}, totalReturned=${totalReturned}, productCode=${item.productCode || 'unknown'}`);
            inventoryResults.push({
              index,
              success: false,
              skipped: true,
              reason: 'Zero or negative confirmed quantity',
              productCode: item.productCode
            });
            continue;
          }

          // Validate required fields
          if (!item.productCode) {
            console.error(`[Inventory Update - QR] Item ${index} missing productCode, skipping`);
            inventoryResults.push({
              index,
              success: false,
              error: 'Missing productCode',
              productName: item.productName
            });
            continue;
          }

          // Extract season (handle both array and single value for backward compatibility)
          const season = Array.isArray(item.season) ? item.season : (item.season ? [item.season] : []);

          if (!season || season.length === 0) {
            console.error(`[Inventory Update - QR] Item ${index} missing season, skipping`);
            inventoryResults.push({
              index,
              success: false,
              error: 'Missing season',
              productCode: item.productCode
            });
            continue;
          }

          const landedPrice = item.landedPrice || itemsWithPrices[index].landedPrice;
          const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;

          // SUPPLIER-SCOPED: Look for product with this SKU from this supplier
          let product = await Product.findOne({
            sku: item.productCode.toUpperCase(),
            supplier: supplierId
          });

          if (!product) {
            // Handle primaryColor: can be array or string
            const colorForProduct = Array.isArray(item.primaryColor) && item.primaryColor.length > 0
              ? item.primaryColor[0]  // Use first color as main color
              : (typeof item.primaryColor === 'string' ? item.primaryColor : undefined);

            product = new Product({
              name: item.productName,
              sku: item.productCode.toUpperCase(),
              supplier: supplierId, // Associate product with supplier
              productCode: item.productCode,
              season: season,
              category: 'General', // Default category since we no longer use ProductType
              unit: 'piece',
              pricing: {
                costPrice: landedPrice,
                sellingPrice: landedPrice * 1.2
              },
              color: colorForProduct,
              specifications: {
                color: colorForProduct,  // Single color string (Product model expects string, not array)
                material: item.material || undefined
              },
              createdBy: req.user._id
            });

            try {
              await product.save();
            } catch (productError) {
              if (productError.code === 11000) {
                product = await Product.findOne({
                  sku: item.productCode.toUpperCase(),
                  supplier: supplierId
                });
              } else {
                console.error(`Error creating product for item ${index}:`, productError);
                continue;
              }
            }
          } else {
            if (product.pricing.costPrice !== landedPrice) {
              product.pricing.costPrice = landedPrice;
              await product.save();
            }
          }

          // Add productImage from dispatch order item to Product's images array
          if (item.productImage) {
            // Initialize images array if it doesn't exist
            if (!product.images || !Array.isArray(product.images)) {
              product.images = [];
            }

            // Handle both string (backward compat) and array of images
            const imagesToAdd = Array.isArray(item.productImage)
              ? item.productImage
              : [item.productImage];

            // Add images to beginning of array (most recent first)
            // Check if image already exists to avoid duplicates
            let addedCount = 0;
            for (const imageUrl of imagesToAdd) {
              if (imageUrl && !product.images.includes(imageUrl)) {
                product.images.unshift(imageUrl);
                addedCount++;
              }
            }

            if (addedCount > 0) {
              try {
                await product.save();
                console.log(`[Dispatch Order QR Confirm] Added ${addedCount} image(s) to product ${product.name || product._id}`);
              } catch (productImageError) {
                console.error(`[Dispatch Order QR Confirm] Failed to save image to product ${product.name || product._id}:`, {
                  message: productImageError.message,
                  stack: productImageError.stack
                });
                // Don't fail the entire confirmation if product image save fails
              }
            } else {

            }
          }

          // Validate product exists before creating inventory
          if (!product || !product._id) {
            console.warn(`[QR Confirm] Skipping inventory creation for item ${index} (${item.productCode || item.productName || 'unknown'}) - invalid product reference`);
            continue;
          }

          // Verify product actually exists in database
          const productExists = await Product.findById(product._id);
          if (!productExists) {
            console.warn(`[QR Confirm] Skipping inventory creation for item ${index} (${item.productCode || item.productName || 'unknown'}) - product ${product._id} not found in database`);
            continue;
          }

          let inventory = await Inventory.findOne({ product: product._id });

          if (!inventory) {
            inventory = new Inventory({
              product: product._id,
              currentStock: 0,
              averageCostPrice: landedPrice,
              minStockLevel: 0,
              maxStockLevel: 1000,
              reorderLevel: 10
            });
            await inventory.save();
          } else {
            const currentValue = inventory.currentStock * inventory.averageCostPrice;
            const newValue = confirmedQuantity * landedPrice;
            const totalQuantity = inventory.currentStock + confirmedQuantity;
            inventory.averageCostPrice = totalQuantity > 0
              ? (currentValue + newValue) / totalQuantity
              : landedPrice;
          }

          // Add stock to inventory with variant composition if available
          if (item.useVariantTracking && item.packets && item.packets.length > 0) {
            // Build variant composition from packets
            const variantComposition = [];
            item.packets.forEach(packet => {
              packet.composition.forEach(comp => {
                const existing = variantComposition.find(v => v.size === comp.size && v.color === comp.color);
                if (existing) {
                  existing.quantity += comp.quantity;
                } else {
                  variantComposition.push({
                    size: comp.size,
                    color: comp.color,
                    quantity: comp.quantity
                  });
                }
              });
            });

            // Add stock with variant composition
            await inventory.addStockWithVariants(
              confirmedQuantity,
              variantComposition,
              'DispatchOrder',
              dispatchOrder._id,
              req.user._id,
              `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed via QR scan with variants`,
              transactionDate
            );
          } else {
            // Add stock without variant tracking (legacy behavior)
            await inventory.addStock(
              confirmedQuantity,
              'DispatchOrder',
              dispatchOrder._id,
              req.user._id,
              `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed via QR scan`,
              transactionDate
            );
          }

          // Track successful processing
          inventoryResults.push({
            index,
            success: true,
            productCode: item.productCode,
            productName: item.productName,
            quantity: confirmedQuantity
          });

        } catch (itemError) {
          console.error(`[Inventory Update - QR] Failed to process item ${index}:`, {
            error: itemError.message,
            stack: itemError.stack,
            item: {
              productCode: item.productCode,
              productName: item.productName,
              season: item.season,
              quantity: item.quantity
            }
          });

          inventoryResults.push({
            index,
            success: false,
            error: itemError.message,
            productCode: item.productCode,
            productName: item.productName
          });
        }
      }

      // After processing all items, check results
      const successCount = inventoryResults.filter(r => r.success).length;
      const failCount = inventoryResults.filter(r => !r.success && !r.skipped).length;
      const skippedCount = inventoryResults.filter(r => r.skipped).length;



      // If all items failed (and at least one was attempted), throw error
      if (successCount === 0 && (failCount > 0 || (dispatchOrder.items.length > 0 && skippedCount < dispatchOrder.items.length))) {
        const failedItems = inventoryResults.filter(r => !r.success && !r.skipped);
        const errorDetails = failedItems.map(r => `Item ${r.index} (${r.productCode || r.productName || 'unknown'}): ${r.error}`).join('; ');
        throw new Error(`Failed to update inventory for all items. Details: ${errorDetails}`);
      }

    } catch (inventoryError) {
      console.error('Error updating inventory (QR):', inventoryError);
      console.error('Error stack:', inventoryError.stack);

      // Rollback the confirmation
      dispatchOrder.status = 'pending';
      dispatchOrder.confirmedAt = null;
      dispatchOrder.confirmedBy = null;
      dispatchOrder.confirmedQuantities = [];
      dispatchOrder.paymentDetails = {
        cashPayment: 0,
        bankPayment: 0,
        remainingBalance: 0,
        paymentStatus: 'pending'
      };
      await dispatchOrder.save();



      return sendResponse.error(res,
        `Confirmation failed: ${inventoryError.message}. The order remains pending. Please check the error logs and fix any issues before confirming again.`,
        500
      );
    }

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'confirmedBy', select: 'name' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    // Log the activity
    await logActivity(req, {
      action: 'STATUS_CHANGE',
      resource: 'DispatchOrder',
      resourceId: dispatchOrder._id,
      description: `Confirmed dispatch order: ${dispatchOrder.orderNumber} via QR scan`,
      changes: { old: 'pending', new: 'confirmed' }
    });

    return sendResponse.success(res, orderObj, 'Dispatch order confirmed successfully via QR scan');
  } catch (error) {
    console.error('Confirm dispatch order via QR error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Update dispatch order (only pending orders)
router.put('/:id', auth, async (req, res) => {
  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Only pending orders can be updated — allow admin/super-admin to edit pending-approval
    const canEditPendingApproval = ['admin', 'super-admin'].includes(req.user.role) && dispatchOrder.status === 'pending-approval';
    if (dispatchOrder.status !== 'pending' && !canEditPendingApproval) {
      return sendResponse.error(res, 'Only pending dispatch orders can be updated', 400);
    }

    // Check permissions
    if (req.user.role === 'supplier') {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        return sendResponse.error(res, 'You do not have permission to update this dispatch order', 403);
      }
    } else if (req.user.role !== 'super-admin' && req.user.role !== 'admin') {
      return sendResponse.error(res, 'You do not have permission to update dispatch orders', 403);
    }

    // Validate and update fields
    const allowedFields = [
      'date', 'exchangeRate', 'percentage', 'logisticsCompany', 'items',
      'dispatchDate', 'pickupAddress', 'deliveryAddress'
    ];

    const updateData = {};
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    // Validate items if provided
    if (updateData.items && Array.isArray(updateData.items)) {
      // Validate each item
      for (const item of updateData.items) {
        const { error } = dispatchItemSchema.validate(item);
        if (error) {
          return sendResponse.error(res, `Invalid item data: ${error.details[0].message}`, 400);
        }
      }

      // Process items similar to create endpoint
      const processedItems = updateData.items.map((item, index) => {
        const processedItem = {
          productName: item.productName,
          productCode: item.productCode,
          season: item.season || [],
          costPrice: item.costPrice || 0,
          quantity: item.quantity,
          boxes: item.boxes || [],
          totalBoxes: item.boxes?.length || 0,
          unitWeight: item.unitWeight || 0,
          useVariantTracking: item.useVariantTracking || false,
          packets: item.packets || []
        };

        if (item.primaryColor) processedItem.primaryColor = item.primaryColor;
        if (item.size) processedItem.size = item.size;
        if (item.material) processedItem.material = item.material;
        if (item.description) processedItem.description = item.description;
        if (item.productImage) processedItem.productImage = item.productImage;

        return processedItem;
      });

      // Preserve existing subdocument _id values when replacing with same-length array
      if (Array.isArray(dispatchOrder.items) && processedItems.length === dispatchOrder.items.length) {
        for (let i = 0; i < processedItems.length; i++) {
          if (dispatchOrder.items[i] && dispatchOrder.items[i]._id) {
            processedItems[i]._id = dispatchOrder.items[i]._id;
          }
        }
      }

      updateData.items = processedItems;
      updateData.totalQuantity = processedItems.reduce((sum, item) => sum + (item.quantity || 0), 0);
      // Use req.body.totalBoxes if provided (from Supplier Portal form), otherwise calculate from items
      const calculatedBoxes = processedItems.reduce((sum, item) => sum + (item.totalBoxes || item.boxes?.length || 0), 0);
      updateData.totalBoxes = req.body.totalBoxes && req.body.totalBoxes > 0 ? req.body.totalBoxes : calculatedBoxes;
    }

    // Handle date field
    if (updateData.date) {
      updateData.dispatchDate = new Date(updateData.date);
    }

    // Capture old state for audit logging
    const oldState = dispatchOrder.toObject();

    // Update dispatch order (apply updates then normalize using admin logic)
    Object.assign(dispatchOrder, updateData);
    try {
      await normalizeDispatchOrderForAdmin(dispatchOrder, { ...updateData, cashPayment: 0, bankPayment: 0, discount: dispatchOrder.totalDiscount }, req.user, { setSubmitted: true });
    } catch (normErr) {
      return sendResponse.error(res, normErr.message || 'Invalid admin input', 400);
    }
    // If any item requires reconfiguration (variants removed) and packets are not provided, block save
    const needsReconfig = (dispatchOrder.items || []).some(it => it.requiresReconfiguration && (!Array.isArray(it.packets) || it.packets.length === 0));
    if (needsReconfig) {
      return sendResponse.error(res, 'One or more items have had variants removed and require packet reconfiguration. Please open the Configure Packets modal and save a new configuration before submitting.', 400);
    }
    await dispatchOrder.save();

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' }
    ]);

    const orderObj = dispatchOrder.toObject();
    await convertDispatchOrderImages(orderObj);

    // Log the activity
    await logActivity(req, {
      action: 'UPDATE',
      resource: 'DispatchOrder',
      resourceId: dispatchOrder._id,
      description: `Updated dispatch order: ${dispatchOrder.orderNumber}`,
      changes: { old: oldState, new: dispatchOrder.toObject() }
    });

    return sendResponse.success(res, orderObj, 'Dispatch order updated successfully');

  } catch (error) {
    console.error('Update dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Failed to update dispatch order', 500);
  }
});

// Delete dispatch order (super-admin can delete any status; admin/supplier only pending)
router.delete('/:id', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id).session(session);

    if (!dispatchOrder) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    const isSuperAdmin = req.user.role === 'super-admin';
    const isAdmin = req.user.role === 'admin';
    const isSupplier = req.user.role === 'supplier';

    // Check permissions
    if (isSupplier) {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        await session.abortTransaction();
        session.endSession();
        return sendResponse.error(res, 'You do not have permission to delete this dispatch order', 403);
      }
    } else if (!isSuperAdmin && !isAdmin) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'You do not have permission to delete dispatch orders', 403);
    }

    // CASE 1: Pending Order (Original Logic)
    if (dispatchOrder.status === 'pending' || dispatchOrder.status === 'pending-approval') {
      // Delete associated images from Google Cloud Storage
      if (dispatchOrder.items && Array.isArray(dispatchOrder.items)) {
        const imageDeletionPromises = dispatchOrder.items
          .filter(item => item.productImage)
          .flatMap((item) => {
            const imagesToDelete = Array.isArray(item.productImage) ? item.productImage : [item.productImage];
            return imagesToDelete.map(async (imageUrl) => {
              try {
                await deleteImage(imageUrl);
              } catch (imageError) {
                console.error('Error deleting image from GCS:', imageError.message);
              }
            });
          });
        await Promise.allSettled(imageDeletionPromises);
      }

      await DispatchOrder.findByIdAndDelete(req.params.id).session(session);
      await session.commitTransaction();
      session.endSession();
      // Log the activity
      await logActivity(req, {
        action: 'DELETE',
        resource: 'DispatchOrder',
        resourceId: req.params.id,
        description: `Deleted pending dispatch order: ${dispatchOrder.orderNumber}`,
        changes: { old: dispatchOrder.toObject(), new: null }
      });

      return sendResponse.success(res, null, 'Pending dispatch order deleted successfully');
    }

    // CASE 2: Confirmed/Delivered Order (Selective Clean Delete)
    // Strict Guard: Only super-admin can initiate clean delete for confirmed orders
    if (!isSuperAdmin) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Only super-admins can delete confirmed dispatch orders', 403);
    }

    // Guard 1: Check for associated Returns
    const existingReturn = await Return.findOne({ dispatchOrder: req.params.id }).session(session);
    if (existingReturn) {
      await session.abortTransaction();
      session.endSession();
      return sendResponse.error(res, 'Cannot delete: Associated returns exist. Please delete the returns first.', 400);
    }

    // Guard 2: Check for Sales (FIFO Batch Usage)
    for (const item of dispatchOrder.items) {
      if (item.product) {
        const inventory = await Inventory.findOne({ product: item.product }).session(session);
        if (inventory) {
          const batch = inventory.purchaseBatches.find(b => b.dispatchOrderId?.toString() === req.params.id);
          if (batch && batch.remainingQuantity < batch.quantity) {
            await session.abortTransaction();
            session.endSession();
            return sendResponse.error(res, `Cannot delete: Some items from product "${item.productName}" have already been sold.`, 400);
          }
        }
      }
    }

    console.log(`[Clean Delete] Passing guards for order ${dispatchOrder.orderNumber}. Starting reversal...`);

    // REVERSAL STAGE
    // 1. Delete all Ledger entries (purchase, logistics charges, payments)
    await Ledger.deleteMany({ referenceId: req.params.id }).session(session);

    // 2. Adjust Supplier Balance and Total Purchases
    // We reverse the exact amount added during confirmation
    const discountedSupplierPaymentTotal = dispatchOrder.supplierPaymentTotal || 0;
    // We need to account for any at-confirmation payments that were recorded
    // Find payment entries in Ledger before they were deleted or use cached values if reliable
    // Actually, calculate from dispatchOrder fields
    const cashPaymentAmount = dispatchOrder.paymentDetails?.cashPayment || 0;
    const bankPaymentAmount = dispatchOrder.paymentDetails?.bankPayment || 0;

    await Supplier.findByIdAndUpdate(
      dispatchOrder.supplier,
      {
        $inc: {
          currentBalance: -(discountedSupplierPaymentTotal - cashPaymentAmount - bankPaymentAmount)
        }
      },
      { session }
    );

    // 3. Restore Inventory
    for (const item of dispatchOrder.items) {
      if (item.product) {
        const inventory = await Inventory.findOne({ product: item.product }).session(session);
        if (inventory) {
          const batchIndex = inventory.purchaseBatches.findIndex(b => b.dispatchOrderId?.toString() === req.params.id);
          if (batchIndex !== -1) {
            const batch = inventory.purchaseBatches[batchIndex];

            // Decrease Stock
            inventory.currentStock = Math.max(0, inventory.currentStock - batch.quantity);

            // Handle Variant Composition
            if (item.useVariantTracking && item.packets) {
              item.packets.forEach(packet => {
                packet.composition.forEach(comp => {
                  const variant = inventory.variantComposition.find(v => v.size === comp.size && v.color === comp.color);
                  if (variant) {
                    variant.quantity = Math.max(0, variant.quantity - comp.quantity);
                  }
                });
              });
            }

            // Remove Batch
            inventory.purchaseBatches.splice(batchIndex, 1);

            // Recalculate Average Cost
            inventory.recalculateAverageCost();
          }

          // Clean up stock movements
          inventory.stockMovements = inventory.stockMovements.filter(m => m.referenceId?.toString() !== req.params.id);

          await inventory.save({ session });
        }
      }
    }

    // 4. Clean up PacketStock
    // Find all packets that have this order in their history
    const packetsToUpdate = await PacketStock.find({ 'dispatchOrderHistory.dispatchOrderId': req.params.id }).session(session);
    for (const packet of packetsToUpdate) {
      const historyEntry = packet.dispatchOrderHistory.find(h => h.dispatchOrderId?.toString() === req.params.id);
      if (historyEntry) {
        packet.availablePackets = Math.max(0, packet.availablePackets - historyEntry.quantity);
        packet.dispatchOrderHistory = packet.dispatchOrderHistory.filter(h => h.dispatchOrderId?.toString() !== req.params.id);

        // If no packets left and no other history, we could deactivate, but let's just save for now
        if (packet.availablePackets === 0 && packet.dispatchOrderHistory.length === 0) {
          packet.isActive = false;
        }
        await packet.save({ session });
      }
    }

    // 5. Image Cleanup
    if (dispatchOrder.items && Array.isArray(dispatchOrder.items)) {
      const imageDeletionPromises = dispatchOrder.items
        .filter(item => item.productImage)
        .flatMap((item) => {
          const imagesToDelete = Array.isArray(item.productImage) ? item.productImage : [item.productImage];
          return imagesToDelete.map(async (imageUrl) => {
            try { await deleteImage(imageUrl); } catch (e) { }
          });
        });
      await Promise.allSettled(imageDeletionPromises);
    }

    // 6. Final Order Deletion
    await DispatchOrder.findByIdAndDelete(req.params.id).session(session);

    await session.commitTransaction();
    session.endSession();
    console.log(`[Clean Delete] Success: Order ${dispatchOrder.orderNumber} deleted.`);

    // Log the activity
    await logActivity(req, {
      action: 'DELETE',
      resource: 'DispatchOrder',
      resourceId: req.params.id,
      description: `Clean deleted confirmed dispatch order: ${dispatchOrder.orderNumber} and all associated records`,
      changes: { old: dispatchOrder.toObject(), new: null }
    });

    return sendResponse.success(res, null, 'Confirmed dispatch order and all associated records deleted successfully');

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
    }
    session.endSession();
    console.error('Delete dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Failed to delete dispatch order', 500);
  }
});

// Request pre-signed URL for direct GCS upload
router.post('/:id/items/:itemIndex/upload-url', auth, async (req, res) => {
  try {
    const { fileName, mimeType } = req.body;

    console.log('Request for upload URL:', {
      dispatchOrderId: req.params.id,
      itemIndex: req.params.itemIndex,
      fileName,
      mimeType
    });

    // Validate required fields
    if (!fileName) {
      return sendResponse.error(res, 'fileName is required', 400);
    }

    if (!mimeType) {
      return sendResponse.error(res, 'mimeType is required', 400);
    }

    // Find dispatch order
    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check permissions (supplier can only upload to their own orders)
    if (req.user.role === 'supplier') {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        return sendResponse.error(res, 'You do not have permission to upload images for this dispatch order', 403);
      }
    }

    // Validate item index
    const itemIndex = parseInt(req.params.itemIndex);
    if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= dispatchOrder.items.length) {
      return sendResponse.error(res, 'Invalid item index', 400);
    }

    // Generate unique file path
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = `products/dispatch-${dispatchOrder._id.toString()}-item-${itemIndex}/${timestamp}-${sanitizedFileName}`;

    // Generate signed upload URL (expires in 15 minutes)
    const uploadUrl = await generateSignedUploadUrl(filePath, mimeType, 15);

    console.log('Upload URL generated successfully:', {
      filePath,
      expiresIn: '15 minutes'
    });

    return sendResponse.success(res, {
      uploadUrl,
      filePath,
      expiresIn: 900 // 15 minutes in seconds
    }, 'Upload URL generated successfully');

  } catch (error) {
    console.error('Error generating upload URL:', {
      message: error.message,
      stack: error.stack
    });
    return sendResponse.error(res, error.message || 'Failed to generate upload URL', 500);
  }
});

// Confirm upload and save image path to database
router.post('/:id/items/:itemIndex/confirm-upload', auth, async (req, res) => {
  try {
    const { filePath, fileName, mimeType } = req.body;

    console.log('Confirm upload request:', {
      dispatchOrderId: req.params.id,
      itemIndex: req.params.itemIndex,
      filePath,
      fileName,
      mimeType
    });

    // Validate required fields
    if (!filePath) {
      return sendResponse.error(res, 'filePath is required', 400);
    }

    // Find dispatch order
    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check permissions
    if (req.user.role === 'supplier') {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        return sendResponse.error(res, 'You do not have permission to confirm upload for this dispatch order', 403);
      }
    }

    // Validate item index
    const itemIndex = parseInt(req.params.itemIndex);
    if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= dispatchOrder.items.length) {
      return sendResponse.error(res, 'Invalid item index', 400);
    }

    // Verify file exists in GCS
    const fileExists = await verifyFileExists(filePath);
    if (!fileExists) {
      console.error('File not found in GCS after upload:', filePath);
      return sendResponse.error(res, 'File not found in cloud storage. Upload may have failed.', 400);
    }



    // Get the full GCS URL (match format returned by uploadImage function)
    const { getBucketName } = require('../config/gcs');
    const bucketName = getBucketName();
    const url = `https://storage.googleapis.com/${bucketName}/${filePath}`;

    // Save image URL to dispatch order item - append to array instead of overwriting
    // Initialize as array if it doesn't exist or is a string (backward compatibility)
    if (!dispatchOrder.items[itemIndex].productImage) {
      dispatchOrder.items[itemIndex].productImage = [];
    } else if (typeof dispatchOrder.items[itemIndex].productImage === 'string') {
      // Convert old string format to array for backward compatibility
      dispatchOrder.items[itemIndex].productImage = [dispatchOrder.items[itemIndex].productImage];
    }

    // Check if URL already exists to avoid duplicates
    if (!dispatchOrder.items[itemIndex].productImage.includes(url)) {
      dispatchOrder.items[itemIndex].productImage.push(url);
      await dispatchOrder.save();
      console.log('Image URL saved to dispatch order item (appended to array)');
    } else {

      await dispatchOrder.save();
    }

    // Find or create product with this product code and update its image
    const item = dispatchOrder.items[itemIndex];
    if (item.productCode) {
      try {
        const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;
        let product = await Product.findOne({
          sku: item.productCode.toUpperCase(),
          supplier: supplierId
        });

        if (product) {
          // Update existing product - add image if not already present
          if (!product.images.includes(url)) {
            product.images.push(url);
            await product.save();

          }
        }
      } catch (productError) {
        console.error('Error updating product with image:', productError);
        // Don't fail the request if product update fails
      }
    }

    // Generate signed read URL for immediate display
    const signedImageUrl = await generateSignedUrl(url);



    return sendResponse.success(res, {
      imageUrl: signedImageUrl,
      itemIndex: itemIndex,
      dispatchOrderId: dispatchOrder._id
    }, 'Image uploaded successfully');

  } catch (error) {
    console.error('Error confirming upload:', {
      message: error.message,
      stack: error.stack
    });
    return sendResponse.error(res, error.message || 'Failed to confirm upload', 500);
  }
});

// Upload image for dispatch order item
// Supports both FormData (web) and base64 JSON (mobile)
router.post('/:id/items/:itemIndex/image', auth, upload.single('image'), async (req, res) => {
  try {
    const contentType = req.headers['content-type'] || '';
    const isBase64Upload = contentType.includes('application/json') || req.body.image;

    console.log('Upload dispatch order image request:', {
      dispatchOrderId: req.params.id,
      itemIndex: req.params.itemIndex,
      contentType: contentType,
      isBase64Upload: isBase64Upload,
      hasFile: !!req.file,
      hasBase64Image: !!req.body.image,
      fileInfo: req.file ? {
        fieldname: req.file.fieldname,
        originalname: req.file.originalname,
        encoding: req.file.encoding,
        mimetype: req.file.mimetype,
        size: req.file.size
      } : null,
      contentLength: req.headers['content-length']
    });

    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      console.error('Dispatch order not found:', req.params.id);
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Check if user has permission (supplier can only upload to their own orders)
    if (req.user.role === 'supplier') {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        console.error('Permission denied for user:', req.user._id, 'on dispatch order:', req.params.id);
        return sendResponse.error(res, 'You do not have permission to upload images for this dispatch order', 403);
      }
    }

    const itemIndex = parseInt(req.params.itemIndex);
    if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= dispatchOrder.items.length) {
      console.error('Invalid item index:', req.params.itemIndex, 'for dispatch order with', dispatchOrder.items.length, 'items');
      return sendResponse.error(res, 'Invalid item index', 400);
    }

    let fileBuffer;
    let fileName;
    let mimeType;

    // Handle base64 JSON upload (mobile app)
    if (isBase64Upload && req.body.image) {


      const base64String = req.body.image;
      const providedFileName = req.body.fileName || `dispatch-order-${req.params.id}-item-${itemIndex}.jpg`;
      const providedMimeType = req.body.mimeType || 'image/jpeg';

      // Validate base64 string
      if (!base64String || typeof base64String !== 'string') {
        return sendResponse.error(res, 'Invalid base64 image data', 400);
      }

      // Remove data URI prefix if present (data:image/jpeg;base64,)
      const base64Data = base64String.includes(',')
        ? base64String.split(',')[1]
        : base64String;

      try {
        // Convert base64 to buffer
        fileBuffer = Buffer.from(base64Data, 'base64');
        fileName = providedFileName;
        mimeType = providedMimeType;

        console.log('Base64 decoded successfully:', {
          bufferLength: fileBuffer.length,
          fileName: fileName,
          mimeType: mimeType,
          estimatedSizeKB: Math.round(fileBuffer.length / 1024)
        });
      } catch (decodeError) {
        console.error('Failed to decode base64:', {
          error: decodeError.message,
          base64Length: base64String.length
        });
        return sendResponse.error(res, 'Invalid base64 image data. Failed to decode.', 400);
      }
    }
    // Handle FormData upload (web app)
    else if (req.file) {

      fileBuffer = req.file.buffer;
      fileName = req.file.originalname;
      mimeType = req.file.mimetype;
    }
    // No file provided
    else {
      console.error('No file received in request. Request details:', {
        headers: req.headers,
        body: req.body,
        files: req.files,
        isBase64Upload: isBase64Upload
      });
      return sendResponse.error(res, 'No image file provided. Please select an image file to upload.', 400);
    }

    // Create a file object for validation and upload (compatible with validateImageFile and uploadImage)
    const fileForProcessing = {
      buffer: fileBuffer,
      originalname: fileName,
      mimetype: mimeType,
      size: fileBuffer.length
    };

    console.log('File ready for validation:', {
      fileName: fileName,
      mimetype: mimeType,
      size: fileBuffer.length,
      bufferLength: fileBuffer.length
    });

    // Validate file
    const validation = validateImageFile(fileForProcessing);
    if (!validation.valid) {
      console.error('File validation failed:', {
        error: validation.error,
        fileInfo: {
          originalname: fileName,
          mimetype: mimeType,
          size: fileBuffer.length
        }
      });
      return sendResponse.error(res, validation.error, 400);
    }



    // Upload to GCS - use dispatch order ID and item index for path
    let url;
    try {
      const uploadResult = await uploadImage(fileForProcessing, `dispatch-${dispatchOrder._id.toString()}-item-${itemIndex}`);
      url = uploadResult.url;

    } catch (uploadError) {
      console.error('GCS upload error:', {
        message: uploadError.message,
        stack: uploadError.stack,
        fileInfo: {
          originalname: req.file.originalname,
          mimetype: req.file.mimetype,
          size: req.file.size
        }
      });
      return sendResponse.error(res, `Failed to upload image to storage: ${uploadError.message}`, 500);
    }

    // Update dispatch order item with image URL - append to array instead of overwriting
    // Initialize as array if it doesn't exist or is a string (backward compatibility)
    if (!dispatchOrder.items[itemIndex].productImage) {
      dispatchOrder.items[itemIndex].productImage = [];
    } else if (typeof dispatchOrder.items[itemIndex].productImage === 'string') {
      // Convert old string format to array for backward compatibility
      dispatchOrder.items[itemIndex].productImage = [dispatchOrder.items[itemIndex].productImage];
    }

    // Check if URL already exists to avoid duplicates
    if (!dispatchOrder.items[itemIndex].productImage.includes(url)) {
      dispatchOrder.items[itemIndex].productImage.push(url);
      try {
        await dispatchOrder.save();
        console.log('Dispatch order updated with image URL (appended to array)');
      } catch (saveError) {
        console.error('Failed to save dispatch order:', {
          message: saveError.message,
          stack: saveError.stack
        });
        return sendResponse.error(res, `Failed to save image URL: ${saveError.message}`, 500);
      }
    } else {

      // Still save to ensure any schema changes are applied
      try {
        await dispatchOrder.save();
      } catch (saveError) {
        console.error('Failed to save dispatch order:', {
          message: saveError.message,
          stack: saveError.stack
        });
      }
    }

    // Also add image to Product's images array
    const item = dispatchOrder.items[itemIndex];
    let product = null;

    // Find product by reference or productCode (supplier-scoped)
    const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;
    if (item.product) {
      product = await Product.findById(item.product);
    } else if (item.productCode) {
      product = await Product.findOne({
        sku: item.productCode.toUpperCase(),
        supplier: supplierId
      });
    }

    if (product) {
      // Initialize images array if it doesn't exist
      if (!product.images || !Array.isArray(product.images)) {
        product.images = [];
      }

      // Add image to beginning of array (most recent first)
      // Check if image already exists to avoid duplicates
      if (!product.images.includes(url)) {
        product.images.unshift(url);
        try {
          await product.save();

        } catch (productSaveError) {
          console.error(`[Dispatch Order] Failed to save image to product ${product.name || product._id}:`, {
            message: productSaveError.message,
            stack: productSaveError.stack
          });
          // Don't fail the request if product save fails - dispatch order is already saved
        }
      } else {

      }
    } else {
      console.warn(`[Dispatch Order] Could not find product for item ${itemIndex}. ProductCode: ${item.productCode}, Product ID: ${item.product}`);
    }

    // Generate signed URL for the newly uploaded image
    let signedImageUrl;
    try {
      signedImageUrl = await generateSignedUrl(url);

    } catch (signedUrlError) {
      console.error('Failed to generate signed URL:', {
        message: signedUrlError.message,
        stack: signedUrlError.stack,
        imageUrl: url
      });
      // Don't fail the request if signed URL generation fails, use original URL
      signedImageUrl = null;
    }

    // Also try to upload to product if it exists or gets created later
    // This will be handled when the dispatch order is confirmed

    return sendResponse.success(res, {
      imageUrl: signedImageUrl || url,
      itemIndex: itemIndex
    }, 'Image uploaded successfully');

  } catch (error) {
    console.error('Upload dispatch order item image error:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      dispatchOrderId: req.params.id,
      itemIndex: req.params.itemIndex
    });
    return sendResponse.error(res, error.message || 'Failed to upload image', 500);
  }
});

// Get barcode data as JSON for a confirmed dispatch order
// Auto-regenerates if barcodes are missing or invalid
router.get('/:id/barcode-data', auth, async (req, res) => {
  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier', 'name company')
      .populate('items.product', 'name sku productCode pricing');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Only allow viewing barcodes for confirmed orders
    if (dispatchOrder.status !== 'confirmed') {
      return sendResponse.error(res, 'Barcodes are only available for confirmed orders', 400);
    }

    // Helper: build a price map from PacketStock for all barcodes (uses product minSellingPrice)
    const buildPriceMap = async (barcodes) => {
      const barcodeStrings = barcodes.map(b => b.data).filter(Boolean);
      if (barcodeStrings.length === 0) return {};
      const packetStocks = await PacketStock.find({ barcode: { $in: barcodeStrings } })
        .select('barcode suggestedSellingPrice product')
        .populate('product', 'pricing')
        .lean();
      const priceMap = {};
      packetStocks.forEach(ps => {
        const minPrice = ps.product?.pricing?.minSellingPrice;
        priceMap[ps.barcode] = minPrice || ps.suggestedSellingPrice || 0;
      });
      return priceMap;
    };

    // Check if barcodes are already generated and stored in database
    if (dispatchOrder.barcodeData && dispatchOrder.barcodeData.length > 0) {
      // Validate that barcodes have proper structure (dataUrl and data fields)
      const validBarcodes = dispatchOrder.barcodeData.filter(b => b.dataUrl && b.data);

      if (validBarcodes.length > 0) {
        const priceMap = await buildPriceMap(validBarcodes);
        return sendResponse.success(res, {
          orderNumber: dispatchOrder.orderNumber,
          supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
          barcodes: validBarcodes,
          priceMap,
          source: 'database',
          generatedAt: dispatchOrder.barcodeGeneratedAt
        });
      }
      // If validBarcodes.length === 0, fall through to regeneration

    }

    // No valid barcodes found - AUTO-REGENERATE instead of returning empty


    const bwipjs = require('bwip-js');
    const barcodeResults = [];

    for (const item of dispatchOrder.items) {
      const supplierId = dispatchOrder.supplier._id.toString();

      // Get product ID - look it up if not populated
      let productId = 'manual';
      if (item.product) {
        productId = item.product._id ? item.product._id.toString() : item.product.toString();
      } else if (item.productCode) {
        // Look up product by productCode + supplier
        const product = await Product.findOne({
          sku: item.productCode.toUpperCase(),
          supplier: dispatchOrder.supplier._id
        });
        if (product) {
          productId = product._id.toString();
        }
      }

      if (item.useVariantTracking && item.packets && item.packets.length > 0) {
        // Generate barcodes for packets
        for (const packet of item.packets) {

          // If packet is marked as loose, generate SEPARATE barcode for EACH composition entry
          if (packet.isLoose) {
            for (const comp of packet.composition) {
              const looseBarcode = generateLooseItemBarcode(
                supplierId,
                productId,
                comp.size,
                comp.color
              );

              const barcodeBuffer = await bwipjs.toBuffer({
                bcid: 'code128',
                text: looseBarcode,
                scale: 3,
                height: 10,
                includetext: true,
                textxalign: 'center',
                textsize: 8
              });

              const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

              barcodeResults.push({
                type: 'loose',
                productName: item.productName,
                productCode: item.productCode,
                packetNumber: packet.packetNumber,
                size: comp.size,
                color: comp.color,
                quantity: comp.quantity,
                data: looseBarcode,
                dataUrl: dataUrl,
                isLoose: true,
                generatedAt: new Date()
              });
            }
          } else {
            // Regular packet - generate one barcode for entire packet
            const packetBarcode = generatePacketBarcode(
              supplierId,
              productId,
              packet.composition,
              false
            );

            const barcodeBuffer = await bwipjs.toBuffer({
              bcid: 'code128',
              text: packetBarcode,
              scale: 3,
              height: 10,
              includetext: true,
              textxalign: 'center',
              textsize: 8
            });

            const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

            barcodeResults.push({
              type: 'packet',
              productName: item.productName,
              productCode: item.productCode,
              packetNumber: packet.packetNumber,
              composition: packet.composition,
              data: packetBarcode,
              dataUrl: dataUrl,
              isLoose: false,
              generatedAt: new Date()
            });
          }
        }
      } else {
        // Generate barcode for loose item (no packet structure)
        const firstColor = Array.isArray(item.primaryColor) && item.primaryColor.length > 0
          ? item.primaryColor[0]
          : (typeof item.primaryColor === 'string' ? item.primaryColor : 'default');
        const firstSize = Array.isArray(item.size) && item.size.length > 0
          ? item.size[0]
          : (typeof item.size === 'string' ? item.size : 'default');

        const looseBarcode = generateLooseItemBarcode(
          supplierId,
          productId,
          firstSize,
          firstColor
        );

        const barcodeBuffer = await bwipjs.toBuffer({
          bcid: 'code128',
          text: looseBarcode,
          scale: 3,
          height: 10,
          includetext: true,
          textxalign: 'center',
          textsize: 8
        });

        const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

        barcodeResults.push({
          type: 'loose',
          productName: item.productName,
          productCode: item.productCode,
          size: firstSize,
          color: firstColor,
          quantity: item.quantity,
          data: looseBarcode,
          dataUrl: dataUrl,
          isLoose: true,
          generatedAt: new Date()
        });
      }
    }

    // Save newly generated barcodes to database
    if (barcodeResults.length > 0) {
      dispatchOrder.barcodeData = barcodeResults;
      dispatchOrder.barcodeGeneratedAt = new Date();
      await dispatchOrder.save();

    }

    const priceMap = await buildPriceMap(barcodeResults);
    return sendResponse.success(res, {
      orderNumber: dispatchOrder.orderNumber,
      supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
      barcodes: barcodeResults,
      priceMap,
      source: 'generated',
      generatedAt: dispatchOrder.barcodeGeneratedAt
    });

  } catch (error) {
    console.error('Get barcode data error:', error);
    return sendResponse.error(res, error.message || 'Failed to get barcode data', 500);
  }
});

// Generate barcodes and save to database for a confirmed dispatch order
// Note: No auth required - this allows suppliers to generate barcodes via direct link
// Use ?force=true to regenerate existing barcodes
router.get('/:id/barcodes', async (req, res) => {
  try {
    const { force } = req.query;
    const forceRegenerate = force === 'true' || force === '1';

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier', 'name company')
      .populate('items.product', 'name sku productCode');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Only allow generating barcodes for confirmed orders
    if (dispatchOrder.status !== 'confirmed') {
      return sendResponse.error(res, 'Barcodes can only be generated for confirmed orders', 400);
    }

    // Check if barcodes already exist (unless force regenerate is requested)
    if (!forceRegenerate && dispatchOrder.barcodeData && dispatchOrder.barcodeData.length > 0) {
      return sendResponse.success(res, {
        orderNumber: dispatchOrder.orderNumber,
        supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
        barcodes: dispatchOrder.barcodeData,
        generatedAt: dispatchOrder.barcodeGeneratedAt,
        message: `Retrieved ${dispatchOrder.barcodeData.length} existing barcodes`
      }, 'Barcodes already exist');
    }



    // Generate new barcodes using simplified logic like QR codes
    const bwipjs = require('bwip-js');
    const barcodeResults = [];

    for (const item of dispatchOrder.items) {
      const supplierId = dispatchOrder.supplier._id.toString();

      // Get product ID - look it up if not populated
      let productId = 'manual';
      if (item.product) {
        // Handle both populated product (object with _id) and direct ObjectId reference
        productId = item.product._id ? item.product._id.toString() : item.product.toString();
      } else if (item.productCode) {
        // Look up product by productCode + supplier for existing orders
        const product = await Product.findOne({
          sku: item.productCode.toUpperCase(),
          supplier: dispatchOrder.supplier._id
        });
        if (product) {
          productId = product._id.toString();

        } else {

        }
      }

      if (item.useVariantTracking && item.packets && item.packets.length > 0) {
        // Generate barcodes for packets
        for (const packet of item.packets) {

          // If packet is marked as loose, generate SEPARATE barcode for EACH composition entry
          if (packet.isLoose) {
            for (const comp of packet.composition) {
              // Generate unique barcode for each size/color combo
              const looseBarcode = generateLooseItemBarcode(
                supplierId,
                productId,
                comp.size,
                comp.color
              );

              // Generate barcode image as dataURL (like QR codes)
              const barcodeBuffer = await bwipjs.toBuffer({
                bcid: 'code128',
                text: looseBarcode,
                scale: 3,
                height: 10,
                includetext: true,
                textxalign: 'center',
                textsize: 8
              });

              const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

              barcodeResults.push({
                type: 'loose',
                productName: item.productName,
                productCode: item.productCode,
                packetNumber: packet.packetNumber,
                size: comp.size,
                color: comp.color,
                quantity: comp.quantity,
                data: looseBarcode,
                dataUrl: dataUrl,
                isLoose: true,
                generatedAt: new Date()
              });
            }
          } else {
            // Regular packet - generate one barcode for entire packet
            const packetBarcode = generatePacketBarcode(
              supplierId,
              productId,
              packet.composition,
              false
            );

            // Generate barcode image as dataURL (like QR codes)
            const barcodeBuffer = await bwipjs.toBuffer({
              bcid: 'code128',
              text: packetBarcode,
              scale: 3,
              height: 10,
              includetext: true,
              textxalign: 'center',
              textsize: 8
            });

            const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

            barcodeResults.push({
              type: 'packet',
              productName: item.productName,
              productCode: item.productCode,
              packetNumber: packet.packetNumber,
              composition: packet.composition,
              data: packetBarcode,
              dataUrl: dataUrl,
              isLoose: false,
              generatedAt: new Date()
            });
          }
        }
      } else {
        // Generate barcode for loose item
        const firstColor = Array.isArray(item.primaryColor) && item.primaryColor.length > 0
          ? item.primaryColor[0]
          : (typeof item.primaryColor === 'string' ? item.primaryColor : 'default');
        const firstSize = Array.isArray(item.size) && item.size.length > 0
          ? item.size[0]
          : (typeof item.size === 'string' ? item.size : 'default');

        const looseBarcode = generateLooseItemBarcode(
          supplierId,
          productId,
          firstSize,
          firstColor
        );

        // Generate barcode image as dataURL (like QR codes)
        const barcodeBuffer = await bwipjs.toBuffer({
          bcid: 'code128',
          text: looseBarcode,
          scale: 3,
          height: 10,
          includetext: true,
          textxalign: 'center',
          textsize: 8
        });

        const dataUrl = `data:image/png;base64,${barcodeBuffer.toString('base64')}`;

        barcodeResults.push({
          type: 'loose',
          productName: item.productName,
          productCode: item.productCode,
          size: firstSize,
          color: firstColor,
          quantity: item.quantity,
          data: looseBarcode,
          dataUrl: dataUrl,
          isLoose: true,
          generatedAt: new Date()
        });
      }
    }

    // Save barcodes to database with dataURL format
    dispatchOrder.barcodeData = barcodeResults;
    dispatchOrder.barcodeGeneratedAt = new Date();
    await dispatchOrder.save();



    // Return JSON response
    return sendResponse.success(res, {
      orderNumber: dispatchOrder.orderNumber,
      supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
      barcodes: barcodeResults,
      generatedAt: dispatchOrder.barcodeGeneratedAt,
      message: `Successfully generated ${barcodeResults.length} barcodes`
    }, 'Barcodes generated and saved successfully');

  } catch (error) {
    console.error('Generate barcodes error:', error);
    return sendResponse.error(res, error.message || 'Failed to generate barcodes', 500);
  }
});

module.exports = router;