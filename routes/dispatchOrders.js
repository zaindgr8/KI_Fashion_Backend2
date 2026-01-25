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
const { sendResponse } = require('../utils/helpers');
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
  season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season')).min(1).required(),
  costPrice: Joi.number().min(0).required(),
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
  season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season')).min(1).optional(), // For new products
  costPrice: Joi.number().min(0).optional(), // For new products
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
  packets: Joi.array().items(packetSchema).optional()
});

const manualEntrySchema = Joi.object({
  supplier: Joi.string().required(),
  purchaseDate: Joi.date().optional(),
  expectedDeliveryDate: Joi.date().optional(),
  exchangeRate: Joi.number().min(0.01).default(1.0), // Exchange rate for currency conversion
  percentage: Joi.number().min(0).default(0), // Profit margin percentage
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
router.post('/', auth, async (req, res) => {
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

    // Set dispatch date from date field or use current date
    const dispatchDate = req.body.date ? new Date(req.body.date) : new Date();

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

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order created successfully', 201);

  } catch (error) {
    console.error('Create dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Create manual entry (CRM Admin only - replaces Purchase)
router.post('/manual', auth, async (req, res) => {
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

  try {
    // Only admin/manager can create manual entries
    if (!['super-admin', 'admin'].includes(req.user.role)) {
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

    // Verify supplier exists
    const supplier = await Supplier.findById(value.supplier);
    if (!supplier) {
      return sendResponse.error(res, 'Supplier not found', 400);
    }

    // Process items - support both product reference and productName/productCode
    const itemsWithDetails = [];
    for (const item of value.items) {
      let product = null;
      let season = null;
      let color = null;
      let size = null;

      // If product reference provided, use it
      if (item.product) {
        product = await Product.findById(item.product);
        if (!product) {
          return sendResponse.error(res, `Product not found: ${item.product}`, 400);
        }
        season = product.season;
      } else if (item.productCode) {
        // Try to find existing product by code
        // Try to find existing product by code AND supplier
        product = await Product.findOne({
          sku: item.productCode.toUpperCase(),
          supplier: value.supplier // Use the supplier from the dispatch order
        });

        if (product) {
          season = product.season;
        } else if (item.season && Array.isArray(item.season) && item.season.length > 0) {
          // New product - use provided season
          season = item.season;
        } else {
          return sendResponse.error(res, `Season required for new product: ${item.productCode}`, 400);
        }
      } else {
        return sendResponse.error(res, 'Either product reference or productCode is required', 400);
      }

      const costPrice = item.costPrice || (product ? product.pricing?.costPrice : 0);
      const exchangeRate = value.exchangeRate || 1.0;
      const percentage = value.percentage || 0;

      // Calculate supplier payment amount (what admin pays supplier - NO exchange rate, NO profit margin)
      // Formula: cost price × quantity
      const supplierPaymentAmount = costPrice;
      const supplierPaymentItemTotal = supplierPaymentAmount * item.quantity;

      // Calculate landed price (for inventory valuation - WITH profit margin)
      // Formula: (cost price / exchange rate) × (1 + percentage/100)
      // Truncate to 2 decimal places (no rounding) for database storage
      const landedPrice = truncateToTwoDecimals((costPrice / exchangeRate) * (1 + (percentage / 100)));
      const landedTotal = truncateToTwoDecimals(landedPrice * item.quantity);

      itemsWithDetails.push({
        product: product ? product._id : undefined,
        productName: item.productName || (product ? product.name : undefined),
        productCode: item.productCode || (product ? (product.productCode || product.sku) : undefined),
        season: season,
        costPrice: costPrice,
        primaryColor: item.primaryColor || (product ? product.primaryColor : undefined),
        size: item.size || (product ? product.size : undefined), // Add size field
        material: item.material || (product ? product.specifications?.material : undefined),
        description: item.description,
        quantity: item.quantity,
        supplierPaymentAmount: supplierPaymentAmount,
        landedPrice: landedPrice,
        landedTotal: item.landedTotal ? truncateToTwoDecimals(item.landedTotal) : landedTotal, // Use provided (truncated) or calculated
        productImage: item.productImage || undefined
      });
    }

    // Calculate totals
    // 1. Supplier payment total (what admin owes supplier - NO profit margin)
    // Formula: cost price × quantity (Raw Currency)
    const supplierPaymentTotal = itemsWithDetails.reduce((sum, item) => {
      const costPrice = item.costPrice || 0;
      return sum + (costPrice * item.quantity);
    }, 0);

    // 2. Landed Subtotal (for inventory valuation - WITH profit margin)
    const subtotal = itemsWithDetails.reduce((sum, item) => sum + (item.landedTotal || 0), 0);

    const totalDiscount = value.totalDiscount || 0;
    const totalTax = value.totalTax || 0;
    const shippingCost = value.shippingCost || 0;
    const totalBoxes = value.totalBoxes || 0;

    // Apply discount to both totals (matching confirmation logic)
    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);
    const grandTotal = Math.max(0, subtotal - totalDiscount + totalTax + shippingCost);

    const cashPayment = Number(value.cashPayment || 0);
    const bankPayment = Number(value.bankPayment || 0);
    const initialPaidAmount = cashPayment + bankPayment;

    // ==========================================
    // CREDIT APPLICATION: Check if supplier owes admin and auto-apply credit
    // ==========================================
    const currentSupplierBalance = await Ledger.getBalance('supplier', supplier._id);
    let creditApplied = 0;
    let finalRemainingBalance = Math.max(0, discountedSupplierPaymentTotal - initialPaidAmount);

    // If balance is negative, supplier owes admin - apply credit
    if (currentSupplierBalance < 0) {
      const availableCredit = Math.abs(currentSupplierBalance);
      creditApplied = Math.min(availableCredit, finalRemainingBalance);
      finalRemainingBalance = Math.max(0, finalRemainingBalance - creditApplied);
    }

    const paymentStatus = value.paymentStatus || (
      finalRemainingBalance <= 0
        ? 'paid'
        : (initialPaidAmount + creditApplied) > 0
          ? 'partial'
          : 'pending'
    );

    // Create dispatch order as manual entry
    // If the supplier has a portal account (userId), set supplierUser so the entry appears in their portal
    const supplierUserId = supplier.userId || null;

    const dispatchOrder = new DispatchOrder({
      supplier: value.supplier,
      supplierUser: supplierUserId, // Set to supplier's userId if they have a portal account
      logisticsCompany: value.logisticsCompany || null, // Optional - for tracking logistics charges
      dispatchDate: value.purchaseDate ? new Date(value.purchaseDate) : new Date(),
      expectedDeliveryDate: value.expectedDeliveryDate,
      exchangeRate: value.exchangeRate || 1.0,
      percentage: value.percentage || 0,
      items: itemsWithDetails,
      status: 'confirmed', // Manual entries are pre-confirmed
      confirmedAt: new Date(),
      confirmedBy: req.user._id,
      // Financial fields
      subtotal,
      totalDiscount,
      totalBoxes,
      totalTax,
      shippingCost,
      supplierPaymentTotal: discountedSupplierPaymentTotal, // What admin owes supplier (after discount)
      grandTotal: grandTotal, // Landed total (for inventory valuation)
      cashPayment,
      bankPayment,
      remainingBalance: finalRemainingBalance,
      paymentStatus,
      // Payment details (nested)
      paymentDetails: {
        cashPayment,
        bankPayment,
        creditApplied, // Track credit applied
        remainingBalance: finalRemainingBalance,
        paymentStatus
      },
      // Purchase-specific fields
      invoiceNumber: value.invoiceNumber,
      paymentTerms: value.paymentTerms,
      notes: value.notes,
      attachments: value.attachments || [],
      createdBy: req.user._id
    });

    await dispatchOrder.save();

    // Create ledger entry for purchase (debit) - use supplierPaymentTotal (what admin owes supplier)
    try {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplier._id,
        entityModel: 'Supplier',
        transactionType: 'purchase',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: discountedSupplierPaymentTotal,
        credit: 0,
        date: dispatchOrder.dispatchDate,
        description: `Manual Purchase ${dispatchOrder.orderNumber} - Supplier Debt: €${discountedSupplierPaymentTotal.toFixed(2)} (Subtotal: €${supplierPaymentTotal.toFixed(2)}, Discount: €${totalDiscount.toFixed(2)}), Valuation: €${grandTotal.toFixed(2)}, Cash: €${cashPayment.toFixed(2)}, Bank: €${bankPayment.toFixed(2)}, Credit: €${creditApplied.toFixed(2)}, Remaining: €${finalRemainingBalance.toFixed(2)}`,
        paymentDetails: {
          cashPayment: cashPayment,
          bankPayment: bankPayment,
          remainingBalance: finalRemainingBalance
        },
        createdBy: req.user._id
      });
    } catch (ledgerError) {
      console.error(`Error creating purchase ledger entry:`, ledgerError);
    }

    // Create separate ledger entries for payments (credit entries)
    if (cashPayment > 0) {
      try {
        await Ledger.createEntry({
          type: 'supplier',
          entityId: supplier._id,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: cashPayment,
          date: dispatchOrder.dispatchDate,
          description: `Cash payment for Manual Purchase ${dispatchOrder.orderNumber}`,
          paymentMethod: 'cash',
          paymentDetails: {
            cashPayment: cashPayment,
            bankPayment: 0,
            remainingBalance: 0
          },
          createdBy: req.user._id
        });
      } catch (paymentError) {
        console.error(`Error creating cash payment ledger entry:`, paymentError);
      }
    }

    if (bankPayment > 0) {
      try {
        await Ledger.createEntry({
          type: 'supplier',
          entityId: supplier._id,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: bankPayment,
          date: dispatchOrder.dispatchDate,
          description: `Bank payment for Manual Purchase ${dispatchOrder.orderNumber}`,
          paymentMethod: 'bank',
          paymentDetails: {
            cashPayment: 0,
            bankPayment: bankPayment,
            remainingBalance: 0
          },
          createdBy: req.user._id
        });
      } catch (paymentError) {
        console.error(`Error creating bank payment ledger entry:`, paymentError);
      }
    }

    // Create credit application entry if credit was applied
    if (creditApplied > 0) {
      try {
        await Ledger.createEntry({
          type: 'supplier',
          entityId: supplier._id,
          entityModel: 'Supplier',
          transactionType: 'credit_application',
          referenceId: dispatchOrder._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: creditApplied,
          date: dispatchOrder.dispatchDate,
          description: `Credit application for Manual Purchase ${dispatchOrder.orderNumber} from existing supplier overpayment`,
          createdBy: req.user._id
        });
        console.log(`[Manual Entry] Created credit application ledger entry: €${creditApplied}`);
      } catch (creditError) {
        console.error(`Error creating credit application ledger entry:`, creditError);
      }
    }

    // Create logistics charge entry (debit) if logistics company and boxes exist
    try {
      if (dispatchOrder.logisticsCompany && dispatchOrder.totalBoxes > 0) {
        // Fetch logistics company to get rates
        const logisticsCompany = await LogisticsCompany.findById(dispatchOrder.logisticsCompany);
        if (logisticsCompany) {
          const boxRate = logisticsCompany.rates?.boxRate || 0;
          const totalBoxes = dispatchOrder.totalBoxes || 0;
          const logisticsCharge = totalBoxes * boxRate;

          if (logisticsCharge > 0) {
            await Ledger.createEntry({
              type: 'logistics',
              entityId: logisticsCompany._id,
              entityModel: 'LogisticsCompany',
              transactionType: 'charge',
              referenceId: dispatchOrder._id,
              referenceModel: 'DispatchOrder',
              debit: logisticsCharge,
              credit: 0,
              date: dispatchOrder.dispatchDate,
              description: `Logistics charge for Manual Purchase ${dispatchOrder.orderNumber} - ${totalBoxes} boxes × £${boxRate.toFixed(2)}/box = £${logisticsCharge.toFixed(2)}`,
              createdBy: req.user._id
            });
            console.log(`[Manual Entry] Created logistics charge ledger entry: £${logisticsCharge} (${totalBoxes} boxes × £${boxRate}/box)`);
          }
        }
      }
    } catch (ledgerError) {
      console.error(`[Manual Entry] Error creating logistics charge ledger entry:`, ledgerError);
      // Don't fail the entire manual entry creation if logistics charge entry fails
    }

    // Update supplier balance - use supplierPaymentTotal (what admin owes supplier)
    try {
      await Supplier.findByIdAndUpdate(
        supplier._id,
        { $inc: { totalPurchases: discountedSupplierPaymentTotal, currentBalance: discountedSupplierPaymentTotal - cashPayment - bankPayment } }
      );
    } catch (supplierError) {
      console.error(`Error updating supplier balance:`, supplierError);
    }

    // Update inventory immediately (manual entries = already delivered)
    try {
      await dispatchOrder.populate({ path: 'items.product' });

      for (const item of dispatchOrder.items) {
        if (!item.product) {
          // Create product if it doesn't exist
          if (!item.season || !Array.isArray(item.season) || item.season.length === 0) {
            console.warn(`Season required for item: ${item.productCode}`);
            continue;
          }

          // Normalize sizes and colors using helper function
          const productSizes = normalizeToArray(item.size);
          const productColors = normalizeToArray(item.primaryColor);
          const colorForSpec = productColors.length > 0 ? productColors[0] : undefined;

          const newProduct = new Product({
            name: item.productName || 'Unknown Product',
            sku: item.productCode?.toUpperCase() || 'UNKNOWN',
            supplier: supplier._id, // Associate product with supplier
            productCode: item.productCode,
            season: item.season,
            category: 'General',
            unit: 'piece',
            pricing: {
              costPrice: item.costPrice || (item.landedTotal / item.quantity),
              sellingPrice: (item.costPrice || (item.landedTotal / item.quantity)) * 1.2
            },
            size: productSizes,
            color: productColors,
            specifications: {
              color: colorForSpec,
              material: item.material || undefined
            },
            createdBy: req.user._id
          });

          try {
            await newProduct.save();
            item.product = newProduct._id;
          } catch (productError) {
            if (productError.code === 11000) {
              // Duplicate SKU+supplier - find existing for this supplier
              const existingProduct = await Product.findOne({
                sku: item.productCode?.toUpperCase(),
                supplier: supplier._id
              });
              if (existingProduct) {
                item.product = existingProduct._id;
              } else {
                console.error(`Error creating product:`, productError);
                continue;
              }
            } else {
              console.error(`Error creating product:`, productError);
              continue;
            }
          }
        }

        // Add productImage from dispatch order item to Product's images array
        const productObj = typeof item.product === 'object' && item.product._id
          ? await Product.findById(item.product._id)
          : await Product.findById(item.product);

        if (productObj && item.productImage) {
          // Initialize images array if it doesn't exist
          if (!productObj.images || !Array.isArray(productObj.images)) {
            productObj.images = [];
          }

          // Handle both string (backward compat) and array of images
          const imagesToAdd = Array.isArray(item.productImage)
            ? item.productImage
            : [item.productImage];

          // Add images to beginning of array (most recent first)
          // Check if image already exists to avoid duplicates
          let addedCount = 0;
          for (const imageUrl of imagesToAdd) {
            if (imageUrl && !productObj.images.includes(imageUrl)) {
              productObj.images.unshift(imageUrl);
              addedCount++;
            }
          }

          if (addedCount > 0) {
            try {
              await productObj.save();
              console.log(`[Manual Entry] Added ${addedCount} image(s) to product ${productObj.name || productObj._id}`);
            } catch (productImageError) {
              console.error(`[Manual Entry] Failed to save image to product ${productObj.name || productObj._id}:`, {
                message: productImageError.message,
                stack: productImageError.stack
              });
              // Don't fail the entire creation if product image save fails
            }
          } else {
            console.log(`[Manual Entry] All images already exist in product ${productObj.name || productObj._id}`);
          }
        }

        // Update existing product's size and color arrays (merge new values)
        if (productObj) {
          let hasUpdates = false;

          // Merge new sizes into existing product sizes (normalize both to handle old merged values)
          if (item.size) {
            const newSizes = normalizeToArray(item.size);
            const existingSizes = normalizeToArray(productObj.size); // Normalize existing too!
            const mergedSizes = [...new Set([...existingSizes, ...newSizes])];
            if (JSON.stringify(mergedSizes.sort()) !== JSON.stringify((productObj.size || []).sort())) {
              productObj.size = mergedSizes;
              hasUpdates = true;
            }
          }

          // Merge new colors into existing product colors (normalize both to handle old merged values)
          if (item.primaryColor) {
            const newColors = normalizeToArray(item.primaryColor);
            const existingColors = normalizeToArray(productObj.color); // Normalize existing too!
            const mergedColors = [...new Set([...existingColors, ...newColors])];
            if (JSON.stringify(mergedColors.sort()) !== JSON.stringify((productObj.color || []).sort())) {
              productObj.color = mergedColors;
              hasUpdates = true;
            }
          }

          // Save if we have updates
          if (hasUpdates) {
            try {
              await productObj.save();
              console.log(`[Manual Entry] Updated product ${productObj.name} with sizes: [${productObj.size?.join(', ')}], colors: [${productObj.color?.join(', ')}]`);
            } catch (updateError) {
              console.error(`[Manual Entry] Failed to update product sizes/colors:`, updateError.message);
            }
          }
        }

        // Validate product exists before creating inventory
        const productId = item.product?._id || item.product;
        if (!productId) {
          console.warn(`[Manual Entry] Skipping inventory creation for item ${item.productCode || item.productName || 'unknown'} - invalid product reference`);
          continue;
        }

        // Verify product actually exists in database
        const productExists = await Product.findById(productId);
        if (!productExists) {
          console.warn(`[Manual Entry] Skipping inventory creation for item ${item.productCode || item.productName || 'unknown'} - product ${productId} not found in database`);
          continue;
        }

        const quantity = item.quantity;
        const unitPrice = item.landedTotal / quantity;
        const costPrice = item.costPrice || unitPrice; // Actual cost price paid to supplier

        // Find or create Inventory
        let inventory = await Inventory.findOne({ product: productId });

        if (!inventory) {
          inventory = new Inventory({
            product: productId,
            currentStock: 0,
            averageCostPrice: unitPrice,
            minStockLevel: 0,
            maxStockLevel: 1000,
            reorderLevel: 10,
            purchaseBatches: [] // Initialize empty batches array
          });
          await inventory.save();
        }

        // Prepare batch info for FIFO cost tracking
        const batchInfo = {
          dispatchOrderId: dispatchOrder._id,
          supplierId: supplier._id,
          purchaseDate: dispatchOrder.dispatchDate || new Date(),
          costPrice: costPrice, // Actual cost price paid to supplier
          landedPrice: unitPrice, // Landed price for inventory valuation
          exchangeRate: value.exchangeRate || 1.0
        };

        // Add stock to inventory with batch tracking
        await inventory.addStockWithBatch(
          quantity,
          batchInfo,
          'DispatchOrder',
          dispatchOrder._id,
          req.user._id,
          `Manual Purchase ${dispatchOrder.orderNumber}`
        );
      }
    } catch (inventoryError) {
      console.error(`Error updating inventory:`, inventoryError);
    }

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company phone email address' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' },
      { path: 'createdBy', select: 'name email' },
      { path: 'confirmedBy', select: 'name' }
    ]);

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Manual entry created successfully', 201);

  } catch (error) {
    console.error('Create manual entry error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
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

    // Update total boxes if provided
    if (totalBoxes !== undefined && totalBoxes !== null) {
      dispatchOrder.totalBoxes = parseInt(totalBoxes) || 0;
    }

    // Update logistics and date if provided
    if (logisticsCompany) {
      dispatchOrder.logisticsCompany = logisticsCompany;
      dispatchOrder.markModified('logisticsCompany');
      // Re-populate to ensure we have the full object for response/calculations
      await dispatchOrder.populate('logisticsCompany', 'name code contactInfo rates');
    }
    if (dispatchDate) {
      dispatchOrder.dispatchDate = new Date(dispatchDate);
      dispatchOrder.markModified('dispatchDate');
    }
    if (isTotalBoxesConfirmed !== undefined) {
      dispatchOrder.isTotalBoxesConfirmed = !!isTotalBoxesConfirmed;
      dispatchOrder.markModified('isTotalBoxesConfirmed');
    }

    // Update items - handle structural changes (add/remove)
    if (Array.isArray(items)) {
      if (items.length === dispatchOrder.items.length) {
        // Standard mapping if length matches (preserves item IDs)
        dispatchOrder.items.forEach((item, index) => {
          const reqItem = items[index];
          if (reqItem) {
            if (reqItem.quantity !== undefined) item.quantity = Number(reqItem.quantity);
            if (reqItem.productName) item.productName = reqItem.productName;
            if (reqItem.productCode) item.productCode = reqItem.productCode ? reqItem.productCode.trim() : item.productCode;
            if (reqItem.costPrice !== undefined) item.costPrice = Number(reqItem.costPrice);
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
        // If items were added or removed, replace the array
        dispatchOrder.items = items;
        dispatchOrder.markModified('items');
      }
    }

    // Calculate confirmed quantities (same as confirm endpoint)
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
    let supplierPaymentTotal = 0;
    let landedPriceTotal = 0;
    const itemsWithPrices = dispatchOrder.items.map((item, index) => {
      const costPrice = item.costPrice || 0;
      const confirmedQty = confirmedQuantities[index].quantity;

      const supplierPaymentAmount = costPrice;
      const supplierPaymentItemTotal = supplierPaymentAmount * confirmedQty;
      supplierPaymentTotal += supplierPaymentItemTotal;

      // Truncate to 2 decimal places (no rounding) for database storage
      const landedPrice = truncateToTwoDecimals((costPrice / finalExchangeRate) * (1 + (finalPercentage / 100)));
      const landedPriceItemTotal = truncateToTwoDecimals(landedPrice * confirmedQty);
      landedPriceTotal += landedPriceItemTotal;

      return {
        ...item.toObject(),
        supplierPaymentAmount,
        landedPrice,
        confirmedQuantity: confirmedQty
      };
    });

    // Get discount from order or from request
    const totalDiscount = parseFloat(discount) !== undefined && discount !== null
      ? parseFloat(discount)
      : (dispatchOrder.totalDiscount || 0);

    // Apply discount to supplierPaymentTotal
    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);

    // Truncate subtotal and grandTotal to 2 decimal places
    const subtotal = truncateToTwoDecimals(landedPriceTotal);
    const grandTotal = truncateToTwoDecimals(Math.max(0, subtotal - totalDiscount));

    // Update dispatch order status to pending-approval (DO NOT process inventory or ledger)
    dispatchOrder.status = 'pending-approval';
    dispatchOrder.submittedForApprovalAt = new Date();
    dispatchOrder.submittedForApprovalBy = req.user._id;
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
      item.supplierPaymentAmount = itemsWithPrices[index].supplierPaymentAmount;
      item.landedPrice = itemsWithPrices[index].landedPrice;
    });

    await dispatchOrder.save();

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'submittedForApprovalBy', select: 'name' }
    ]);

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order submitted for approval successfully');

  } catch (error) {
    console.error('Submit approval error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Confirm dispatch order (Super-admin only)
router.post('/:id/confirm', auth, async (req, res) => {
  try {
    // Only super-admin can confirm dispatch orders
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Only super-admin can confirm dispatch orders', 403);
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

    // Update logistics and date if provided (Super-admin can refine these during confirmation)
    if (logisticsCompany) {
      dispatchOrder.logisticsCompany = logisticsCompany;
      dispatchOrder.markModified('logisticsCompany');
      // Re-populate to ensure we have rates for ledger calculation later
      await dispatchOrder.populate('logisticsCompany', 'name code contactInfo rates');
    }
    if (dispatchDate) {
      dispatchOrder.dispatchDate = new Date(dispatchDate);
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

    // Update items - handle structural changes (add/remove)
    if (Array.isArray(items)) {
      if (items.length === dispatchOrder.items.length) {
        // Standard mapping if length matches (preserves item IDs)
        dispatchOrder.items.forEach((item, index) => {
          const reqItem = items[index];
          if (reqItem) {
            if (reqItem.quantity !== undefined) item.quantity = Number(reqItem.quantity);
            if (reqItem.productName) item.productName = reqItem.productName;
            if (reqItem.productCode) item.productCode = reqItem.productCode ? reqItem.productCode.trim() : item.productCode;
            if (reqItem.costPrice !== undefined) item.costPrice = Number(reqItem.costPrice);
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
        // If items were added or removed, replace the array
        dispatchOrder.items = items;
        dispatchOrder.markModified('items');
      }
      // Save these updates so the order reflects what was confirmed
      await dispatchOrder.save();
    }

    // Calculate confirmed quantities
    // Now that dispatchOrder.items is updated, we can rely on it and the return logic
    const confirmedQuantities = dispatchOrder.items.map((item, index) => {
      const returnedItems = dispatchOrder.returnedItems || [];
      const totalReturned = returnedItems
        .filter(returned => returned.itemIndex === index)
        .reduce((sum, returned) => sum + returned.quantity, 0);

      // Confirmed Qty is simply the current item quantity minus any returns
      // (If user edited quantity in requestItems, item.quantity is now that edited value)
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
      // Truncate to 2 decimal places (no rounding) for database storage
      const landedPrice = truncateToTwoDecimals((costPrice / finalExchangeRate) * (1 + (finalPercentage / 100)));
      const landedPriceItemTotal = truncateToTwoDecimals(landedPrice * confirmedQty);
      landedPriceTotal += landedPriceItemTotal;

      return {
        ...item.toObject(),
        supplierPaymentAmount,
        landedPrice,
        confirmedQuantity: confirmedQty
      };
    });

    // Get discount from order (set by supplier) or from request (admin override)
    const totalDiscount = parseFloat(discount) !== undefined && discount !== null
      ? parseFloat(discount)
      : (dispatchOrder.totalDiscount || 0);

    // Apply discount to supplierPaymentTotal (what admin pays supplier)
    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - totalDiscount);

    // Truncate subtotal and grandTotal to 2 decimal places
    const subtotal = truncateToTwoDecimals(landedPriceTotal);
    const grandTotal = truncateToTwoDecimals(Math.max(0, subtotal - totalDiscount));

    // ==========================================
    // STEP 1: Process products and inventory FIRST (before changing order status)
    // This ensures atomicity - if products/inventory fail, nothing else happens
    // ==========================================

    console.log(`[Confirm Order] Starting product/inventory processing for dispatch order ${dispatchOrder.orderNumber}`);

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
          console.warn(`[Confirm Order] Skipping item ${index} for dispatch order ${dispatchOrder.orderNumber}: confirmedQuantity=${confirmedQuantity}, item.quantity=${item.quantity || 0}, totalReturned=${totalReturned}, productCode=${item.productCode || 'unknown'}`);
          inventoryResults.push({
            index,
            success: false,
            skipped: true,
            reason: 'Zero or negative confirmed quantity',
            productCode: item.productCode,
            productName: item.productName
          });
          continue; // Skip items with no confirmed quantity
        }

        // Validate required fields
        if (!item.productCode) {
          const error = 'Missing productCode';
          console.error(`[Confirm Order] Item ${index} ${error}`);
          inventoryResults.push({
            index,
            success: false,
            error,
            productName: item.productName
          });
          continue;
        }

        // Extract season (handle both array and single value for backward compatibility)
        const season = Array.isArray(item.season) ? item.season : (item.season ? [item.season] : []);

        if (!season || season.length === 0) {
          const error = 'Missing season';
          console.error(`[Confirm Order] Item ${index} ${error}`);
          inventoryResults.push({
            index,
            success: false,
            error,
            productCode: item.productCode,
            productName: item.productName
          });
          continue;
        }

        const landedPrice = item.landedPrice || itemsWithPrices[index].landedPrice;

        // Find or create Product
        // SUPPLIER-SCOPED: Look for product with this SKU FROM THIS SUPPLIER
        const productCodeTrimmed = item.productCode ? item.productCode.trim() : '';
        const productCodeUpper = productCodeTrimmed.toUpperCase();
        const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;

        console.log(`[Confirm Order] Looking for product with code: "${productCodeTrimmed}" from supplier: ${supplierId}`);

        // First, try to find a product with matching SKU AND supplier
        let product = await Product.findOne({
          sku: productCodeUpper,
          supplier: supplierId
        });

        if (product) {
          console.log(`[Confirm Order] Found existing product for supplier: ${product.name} (SKU: ${product.sku}, Supplier: ${product.supplier}, isActive: ${product.isActive})`);
        } else {
          console.log(`[Confirm Order] Product not found for supplier ${supplierId}, will create new product with code: "${productCodeTrimmed}"`);
        }

        if (!product) {
          // Create new Product
          // Extract all colors (handle both array and string)
          const colors = Array.isArray(item.primaryColor)
            ? item.primaryColor.filter(c => c && c.trim())
            : (item.primaryColor ? [item.primaryColor] : []);

          // Extract all sizes (handle both array and string)
          const sizes = Array.isArray(item.size)
            ? item.size.filter(s => s && s.trim())
            : (item.size ? [item.size] : []);

          // Primary color for specifications (backward compatibility with single string)
          const primaryColor = colors.length > 0 ? colors[0] : undefined;

          product = new Product({
            name: item.productName,
            sku: item.productCode.toUpperCase(),
            supplier: supplierId, // Associate product with supplier
            productCode: item.productCode,
            season: season,
            category: 'General',
            unit: 'piece',
            pricing: {
              costPrice: landedPrice,
              sellingPrice: landedPrice * 1.2
            },
            // Only set color and size if arrays have values
            ...(colors.length > 0 && { color: colors }),
            ...(sizes.length > 0 && { size: sizes }),
            specifications: {
              color: primaryColor,
              material: item.material || undefined
            },
            isActive: true, // Ensure product is active when created
            variantTracking: {
              enabled: colors.length > 1 || sizes.length > 1,
              ...(colors.length > 0 && { availableColors: colors }),
              ...(sizes.length > 0 && { availableSizes: sizes })
            },
            createdBy: req.user._id
          });

          try {
            await product.save();
            console.log(`[Confirm Order] Created new product: ${product.name} (${product.sku}) for supplier ${supplierId}`);
          } catch (productError) {
            // If product creation fails (e.g., duplicate SKU+supplier), try to find again
            if (productError.code === 11000) {
              product = await Product.findOne({
                sku: item.productCode.toUpperCase(),
                supplier: supplierId
              });
              if (!product) {
                const error = `Failed to create product and refetch failed: ${productError.message}`;
                console.error(`[Confirm Order] Item ${index} ${error}`);
                inventoryResults.push({
                  index,
                  success: false,
                  error,
                  productCode: item.productCode,
                  productName: item.productName
                });
                continue;
              }
            } else {
              const error = `Failed to create product: ${productError.message}`;
              console.error(`[Confirm Order] Item ${index} ${error}`);
              inventoryResults.push({
                index,
                success: false,
                error,
                productCode: item.productCode,
                productName: item.productName
              });
              continue;
            }
          }
        } else {
          // Ensure product is active (reactivate if it was deactivated)
          let productNeedsSave = false;
          if (!product.isActive) {
            product.isActive = true;
            productNeedsSave = true;
            console.log(`[Confirm Order] Reactivating product: ${product.name} (${product.sku})`);
          }

          // Update product cost price if landed price is different (use latest landed price)
          if (product.pricing.costPrice !== landedPrice) {
            product.pricing.costPrice = landedPrice;
            productNeedsSave = true;
            console.log(`[Confirm Order] Updated product cost price: ${product.name} -> ${landedPrice}`);
          }

          // Always ensure product is active before proceeding
          if (!product.isActive) {
            product.isActive = true;
            productNeedsSave = true;
          }

          if (productNeedsSave) {
            await product.save();
            console.log(`[Confirm Order] Saved product: ${product.name} (${product.sku}), isActive: ${product.isActive}`);
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
              console.log(`[Confirm Order] Added ${addedCount} image(s) to product ${product.name}`);
            } catch (productImageError) {
              console.error(`[Confirm Order] Failed to save image to product ${product.name}:`, productImageError.message);
              // Don't fail the entire confirmation if product image save fails
            }
          }
        }

        // Validate product exists before creating inventory
        if (!product || !product._id) {
          const error = 'Invalid product reference after save';
          console.error(`[Confirm Order] Item ${index} ${error}`);
          inventoryResults.push({
            index,
            success: false,
            error,
            productCode: item.productCode,
            productName: item.productName
          });
          continue;
        }

        // CRITICAL: Update item.product so barcode generation can use the correct product ID
        // This ensures barcodes match what's stored in PacketStock
        item.product = product._id;
        console.log(`[Confirm Order] Updated item.product to ${product._id} for barcode consistency`);

        // Find or create Inventory
        let inventory = await Inventory.findOne({ product: product._id });

        if (!inventory) {
          inventory = new Inventory({
            product: product._id,
            currentStock: 0,
            averageCostPrice: landedPrice,
            minStockLevel: 0,
            maxStockLevel: 1000,
            reorderLevel: 10,
            isActive: true, // Ensure inventory is active
            purchaseBatches: [] // Initialize empty batches array
          });
          await inventory.save();
          console.log(`[Confirm Order] Created new inventory for product ${product.name} (${product.sku})`);
        } else {
          // Ensure inventory is active (reactivate if it was deactivated)
          if (!inventory.isActive) {
            inventory.isActive = true;
            await inventory.save();
            console.log(`[Confirm Order] Reactivated inventory for product ${product.name} (${product.sku})`);
          }
        }

        // Double-check: Ensure both product and inventory are active before adding stock
        if (!product.isActive) {
          product.isActive = true;
          await product.save();
          console.log(`[Confirm Order] Force-activated product: ${product.name} (${product.sku})`);
        }
        if (!inventory.isActive) {
          inventory.isActive = true;
          await inventory.save();
          console.log(`[Confirm Order] Force-activated inventory for product: ${product.name} (${product.sku})`);
        }

        // Prepare batch info for FIFO cost tracking
        const batchInfo = {
          dispatchOrderId: dispatchOrder._id,
          supplierId: dispatchOrder.supplier._id || dispatchOrder.supplier,
          purchaseDate: dispatchOrder.dispatchDate || new Date(),
          costPrice: item.costPrice || 0, // Actual cost price paid to supplier
          landedPrice: landedPrice, // Landed price for inventory valuation
          exchangeRate: finalExchangeRate
        };

        // Add stock to inventory with batch tracking
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

          // Add stock with variant composition and batch tracking
          await inventory.addStockWithVariants(
            confirmedQuantity,
            variantComposition,
            'DispatchOrder',
            dispatchOrder._id,
            req.user._id,
            `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed quantity with variants`
          );

          // Also add purchase batch for FIFO tracking
          inventory.purchaseBatches.push({
            dispatchOrderId: batchInfo.dispatchOrderId,
            supplierId: batchInfo.supplierId,
            purchaseDate: batchInfo.purchaseDate,
            quantity: confirmedQuantity,
            remainingQuantity: confirmedQuantity,
            costPrice: batchInfo.costPrice,
            landedPrice: batchInfo.landedPrice,
            exchangeRate: batchInfo.exchangeRate,
            notes: `Dispatch Order ${dispatchOrder.orderNumber} - With variants`
          });
          
          // Recalculate weighted average cost from all batches
          inventory.recalculateAverageCost();
          await inventory.save();

          console.log(`[Confirm Order] Added ${confirmedQuantity} units with variants and batch tracking to inventory for ${product.name}`);

          // ==========================================
          // CREATE PACKET STOCK ENTRIES FOR BARCODE-BASED SELLING
          // ==========================================
          const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;
          const productId = product._id;
          
          // Check if this is a loose item configuration (packets with isLoose: true)
          const hasLooseItems = item.packets.some(p => p.isLoose === true);
          
          if (hasLooseItems) {
            // ==========================================
            // LOOSE ITEMS: Create separate barcode for each color/size combination
            // ==========================================
            console.log(`[Confirm Order] Processing loose items for ${product.name}`);
            
            // Merge all compositions from loose packets and group by color/size
            const looseItemGroups = new Map();
            
            for (const packet of item.packets) {
              if (!packet.isLoose) continue;
              
              for (const comp of packet.composition) {
                const key = `${comp.color}|${comp.size}`;
                if (looseItemGroups.has(key)) {
                  looseItemGroups.get(key).quantity += comp.quantity;
                } else {
                  looseItemGroups.set(key, {
                    color: comp.color,
                    size: comp.size,
                    quantity: comp.quantity
                  });
                }
              }
            }
            
            // Create PacketStock for each color/size combination
            for (const [key, looseItem] of looseItemGroups) {
              try {
                // Single-item composition for this color/size
                const singleComposition = [{
                  size: looseItem.size,
                  color: looseItem.color,
                  quantity: 1
                }];
                
                // Generate unique barcode for this color/size combination
                const looseBarcode = generatePacketBarcode(
                  supplierId.toString(),
                  productId.toString(),
                  singleComposition,
                  true // isLoose = true
                );
                
                // Find existing packet stock or create new
                let packetStock = await PacketStock.findOne({ barcode: looseBarcode });
                
                if (packetStock) {
                  // Add to existing stock
                  await packetStock.addStock(
                    looseItem.quantity,
                    dispatchOrder._id,
                    batchInfo.costPrice,
                    batchInfo.landedPrice
                  );
                  console.log(`[Confirm Order] Added ${looseItem.quantity} loose items (${looseItem.color}/${looseItem.size}) to existing PacketStock ${looseBarcode}`);
                } else {
                  // Create new packet stock for this loose item variant
                  packetStock = new PacketStock({
                    barcode: looseBarcode,
                    product: productId,
                    supplier: supplierId,
                    composition: singleComposition,
                    totalItemsPerPacket: 1,
                    availablePackets: looseItem.quantity,
                    costPricePerPacket: batchInfo.costPrice,
                    landedPricePerPacket: batchInfo.landedPrice,
                    suggestedSellingPrice: batchInfo.landedPrice * 1.20,
                    isLoose: true,
                    dispatchOrderHistory: [{
                      dispatchOrderId: dispatchOrder._id,
                      quantity: looseItem.quantity,
                      costPricePerPacket: batchInfo.costPrice,
                      landedPricePerPacket: batchInfo.landedPrice,
                      addedAt: new Date()
                    }]
                  });
                  await packetStock.save();
                  console.log(`[Confirm Order] Created new loose item PacketStock ${looseBarcode} (${looseItem.color}/${looseItem.size}) with ${looseItem.quantity} items`);
                }
              } catch (looseStockError) {
                console.error(`[Confirm Order] Failed to create/update loose PacketStock for ${looseItem.color}/${looseItem.size}:`, looseStockError.message);
                // Don't fail the entire confirmation if packet stock creation fails
              }
            }
          } else {
            // ==========================================
            // REGULAR PACKETS: One barcode per packet composition
            // ==========================================
            // Group packets by their composition to count duplicates
            const packetGroups = new Map();
            
            for (const packet of item.packets) {
              // Generate deterministic barcode for this packet composition
              const barcode = generatePacketBarcode(
                supplierId.toString(),
                productId.toString(),
                packet.composition,
                false // isLoose = false for packets
              );
              
              if (packetGroups.has(barcode)) {
                packetGroups.get(barcode).count += 1;
              } else {
                packetGroups.set(barcode, {
                  barcode,
                  composition: packet.composition,
                  totalItemsPerPacket: packet.totalItems || packet.composition.reduce((sum, c) => sum + c.quantity, 0),
                  count: 1
                });
              }
            }
            
            // Create or update PacketStock for each unique packet configuration
            for (const [barcode, packetGroup] of packetGroups) {
              try {
                // Calculate cost per packet (landed price × items per packet)
                const costPerPacket = batchInfo.costPrice * packetGroup.totalItemsPerPacket;
                const landedPerPacket = batchInfo.landedPrice * packetGroup.totalItemsPerPacket;
                
                // Find existing packet stock or create new
                let packetStock = await PacketStock.findOne({ barcode });
                
                if (packetStock) {
                  // Add to existing stock
                  await packetStock.addStock(
                    packetGroup.count,
                    dispatchOrder._id,
                    costPerPacket,
                    landedPerPacket
                  );
                  console.log(`[Confirm Order] Added ${packetGroup.count} packets to existing PacketStock ${barcode}`);
                } else {
                  // Create new packet stock
                  packetStock = new PacketStock({
                    barcode,
                    product: productId,
                    supplier: supplierId,
                    composition: packetGroup.composition,
                    totalItemsPerPacket: packetGroup.totalItemsPerPacket,
                    availablePackets: packetGroup.count,
                    costPricePerPacket: costPerPacket,
                    landedPricePerPacket: landedPerPacket,
                    suggestedSellingPrice: landedPerPacket * 1.20,
                    isLoose: false,
                    dispatchOrderHistory: [{
                      dispatchOrderId: dispatchOrder._id,
                      quantity: packetGroup.count,
                      costPricePerPacket: costPerPacket,
                      landedPricePerPacket: landedPerPacket,
                      addedAt: new Date()
                    }]
                  });
                  await packetStock.save();
                  console.log(`[Confirm Order] Created new PacketStock ${barcode} with ${packetGroup.count} packets`);
                }
              } catch (packetStockError) {
                console.error(`[Confirm Order] Failed to create/update PacketStock for barcode ${barcode}:`, packetStockError.message);
                // Don't fail the entire confirmation if packet stock creation fails
              }
            }
          }
        } else {
          // Add stock with batch tracking (for FIFO cost calculation)
          await inventory.addStockWithBatch(
            confirmedQuantity,
            batchInfo,
            'DispatchOrder',
            dispatchOrder._id,
            req.user._id,
            `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed quantity`
          );
          console.log(`[Confirm Order] Added ${confirmedQuantity} units with batch tracking to inventory for ${product.name}`);

          // ==========================================
          // CREATE LOOSE ITEM PACKET STOCK ENTRIES
          // Each loose item gets its own barcode for tracking
          // ==========================================
          const supplierId = dispatchOrder.supplier._id || dispatchOrder.supplier;
          const productId = product._id;
          
          // For loose items, create a single-item composition
          // Use item's color/size if available, otherwise use defaults
          const itemColor = item.color || product.specifications?.color || 'Default';
          const itemSize = item.size || product.size || 'Default';
          
          const looseComposition = [{
            size: itemSize,
            color: itemColor,
            quantity: 1
          }];
          
          // Generate barcode for loose item
          const looseBarcode = generatePacketBarcode(
            supplierId.toString(),
            productId.toString(),
            looseComposition,
            true // isLoose = true
          );
          
          try {
            // Find existing packet stock or create new
            let packetStock = await PacketStock.findOne({ barcode: looseBarcode });
            
            if (packetStock) {
              // Add to existing stock
              await packetStock.addStock(
                confirmedQuantity,
                dispatchOrder._id,
                batchInfo.costPrice,
                batchInfo.landedPrice
              );
              console.log(`[Confirm Order] Added ${confirmedQuantity} loose items to existing PacketStock ${looseBarcode}`);
            } else {
              // Create new packet stock for loose items
              packetStock = new PacketStock({
                barcode: looseBarcode,
                product: productId,
                supplier: supplierId,
                composition: looseComposition,
                totalItemsPerPacket: 1,
                availablePackets: confirmedQuantity,
                costPricePerPacket: batchInfo.costPrice,
                landedPricePerPacket: batchInfo.landedPrice,
                suggestedSellingPrice: batchInfo.landedPrice * 1.20,
                isLoose: true,
                dispatchOrderHistory: [{
                  dispatchOrderId: dispatchOrder._id,
                  quantity: confirmedQuantity,
                  costPricePerPacket: batchInfo.costPrice,
                  landedPricePerPacket: batchInfo.landedPrice,
                  addedAt: new Date()
                }]
              });
              await packetStock.save();
              console.log(`[Confirm Order] Created new loose item PacketStock ${looseBarcode} with ${confirmedQuantity} items`);
            }
          } catch (looseStockError) {
            console.error(`[Confirm Order] Failed to create/update loose PacketStock ${looseBarcode}:`, looseStockError.message);
            // Don't fail the entire confirmation if packet stock creation fails
          }
        }

        // Verify inventory was saved correctly and ensure both product and inventory are active
        const savedInventory = await Inventory.findById(inventory._id).populate('product');
        const savedProduct = await Product.findById(product._id);

        // Final verification: ensure both are active
        if (savedProduct && !savedProduct.isActive) {
          savedProduct.isActive = true;
          await savedProduct.save();
          console.log(`[Confirm Order] Final fix: Activated product ${savedProduct.name} (${savedProduct.sku})`);
        }
        if (savedInventory && !savedInventory.isActive) {
          savedInventory.isActive = true;
          await savedInventory.save();
          console.log(`[Confirm Order] Final fix: Activated inventory for product ${product.name}`);
        }

        console.log(`[Confirm Order] Inventory verification for ${product.name}:`, {
          productId: savedProduct?._id?.toString(),
          productSku: savedProduct?.sku,
          productIsActive: savedProduct?.isActive,
          productCode: savedProduct?.productCode,
          inventoryId: savedInventory?._id?.toString(),
          inventoryCurrentStock: savedInventory?.currentStock,
          inventoryIsActive: savedInventory?.isActive,
          hasPurchaseBatches: savedInventory?.purchaseBatches?.length > 0,
          inventoryProductId: savedInventory?.product?.toString()
        });

        // Track successful processing
        inventoryResults.push({
          index,
          success: true,
          productCode: item.productCode,
          productName: item.productName,
          quantity: confirmedQuantity
        });

      } catch (itemError) {
        console.error(`[Confirm Order] Failed to process item ${index}:`, {
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

    // Check results - enforce all-or-nothing approach
    const successCount = inventoryResults.filter(r => r.success).length;
    const failCount = inventoryResults.filter(r => !r.success && !r.skipped).length;
    const skippedCount = inventoryResults.filter(r => r.skipped).length;

    console.log(`[Confirm Order] Processed ${dispatchOrder.items.length} items: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`);

    // If ANY items failed (excluding skipped), abort the entire confirmation
    if (failCount > 0) {
      const failedItems = inventoryResults.filter(r => !r.success && !r.skipped);
      const errorDetails = failedItems.map(r =>
        `Item ${r.index} (${r.productCode || r.productName || 'unknown'}): ${r.error}`
      ).join('; ');

      console.error(`[Confirm Order] ABORTING: ${failCount} item(s) failed processing. Details: ${errorDetails}`);

      return sendResponse.error(res,
        `Cannot confirm order - ${failCount} item(s) failed processing. Please fix the following issues and try again:\n${errorDetails}`,
        400
      );
    }

    // ==========================================
    // STEP 2: All products/inventory succeeded - now update order status
    // ==========================================

    console.log(`[Confirm Order] All items processed successfully. Updating order status...`);

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

    // ==========================================
    // CREDIT APPLICATION: DISABLED - Manual payment application only
    // ==========================================

    // Automatic credit application disabled - credits must be manually applied through payment modal
    let creditApplied = 0;

    // Update prices on items
    dispatchOrder.items.forEach((item, index) => {
      item.supplierPaymentAmount = itemsWithPrices[index].supplierPaymentAmount;
      item.landedPrice = itemsWithPrices[index].landedPrice;
    });

    await dispatchOrder.save();
    console.log(`[Confirm Order] Order saved with final remainingBalance: €${dispatchOrder.paymentDetails.remainingBalance.toFixed(2)}`);


    // ==========================================
    // STEP 3: Create ledger entries
    // ==========================================

    console.log(`[Confirm Order] Creating ledger entries...`);

    // Create ledger entry for purchase (debit) - use supplierPaymentTotal (what admin owes supplier)
    await Ledger.createEntry({
      type: 'supplier',
      entityId: dispatchOrder.supplier._id,
      entityModel: 'Supplier',
      transactionType: 'purchase',
      referenceId: dispatchOrder._id,
      referenceModel: 'DispatchOrder',
      debit: discountedSupplierPaymentTotal, // What admin owes supplier (cost / exchange rate, NO profit, after discount)
      credit: 0,
      date: new Date(),
      description: `Dispatch Order ${dispatchOrder.orderNumber} confirmed - Supplier Payment: €${supplierPaymentTotal.toFixed(2)} (Cost ÷ Exchange Rate × Qty), Discount: €${totalDiscount.toFixed(2)}, Final Amount: €${discountedSupplierPaymentTotal.toFixed(2)}, Ledger shows: €${landedPriceTotal.toFixed(2)} ((Cost ÷ Exchange Rate + ${finalPercentage}%) × Qty), Cash: €${parseFloat(cashPayment).toFixed(2)}, Bank: €${parseFloat(bankPayment).toFixed(2)}, Remaining: €${dispatchOrder.paymentDetails.remainingBalance.toFixed(2)}`,
      paymentDetails: {
        cashPayment: parseFloat(cashPayment) || 0,
        bankPayment: parseFloat(bankPayment) || 0,
        remainingBalance: dispatchOrder.paymentDetails.remainingBalance
      },
      createdBy: req.user._id
    });

    // Create separate ledger entries for payments (credit entries)
    const cashPaymentAmount = parseFloat(cashPayment) || 0;
    const bankPaymentAmount = parseFloat(bankPayment) || 0;

    // Create payment entries
    if (cashPaymentAmount > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: cashPaymentAmount,
        date: new Date(),
        description: `Cash payment for Dispatch Order ${dispatchOrder.orderNumber}`,
        paymentMethod: 'cash',
        paymentDetails: {
          cashPayment: cashPaymentAmount,
          bankPayment: 0,
          remainingBalance: 0
        },
        createdBy: req.user._id
      });
      console.log(`[Confirm Order] Created cash payment ledger entry: £${cashPaymentAmount}`);
    }

    if (bankPaymentAmount > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: bankPaymentAmount,
        date: new Date(),
        description: `Bank payment for Dispatch Order ${dispatchOrder.orderNumber}`,
        paymentMethod: 'bank',
        paymentDetails: {
          cashPayment: 0,
          bankPayment: bankPaymentAmount,
          remainingBalance: 0
        },
        createdBy: req.user._id
      });
      console.log(`[Confirm Order] Created bank payment ledger entry: £${bankPaymentAmount}`);
    }

    // Credit application entry - DISABLED (automatic credit application disabled)
    // Credits must be manually applied through payment modal

    try {
      if (dispatchOrder.logisticsCompany && dispatchOrder.totalBoxes > 0) {
        // logisticsCompany should be populated from the initial query
        const logisticsCompany = dispatchOrder.logisticsCompany;
        const boxRate = logisticsCompany?.rates?.boxRate || 0;
        const totalBoxes = dispatchOrder.totalBoxes || 0;
        const logisticsCharge = totalBoxes * boxRate;

        if (logisticsCharge > 0 && logisticsCompany?._id) {
          await Ledger.createEntry({
            type: 'logistics',
            entityId: logisticsCompany._id,
            entityModel: 'LogisticsCompany',
            transactionType: 'charge',
            referenceId: dispatchOrder._id,
            referenceModel: 'DispatchOrder',
            debit: logisticsCharge,
            credit: 0,
            date: new Date(),
            description: `Logistics charge for Dispatch Order ${dispatchOrder.orderNumber} - ${totalBoxes} boxes × £${boxRate.toFixed(2)}/box = £${logisticsCharge.toFixed(2)}`,
            createdBy: req.user._id
          });
          console.log(`[Confirm Order] Created logistics charge ledger entry: £${logisticsCharge} (${totalBoxes} boxes × £${boxRate}/box)`);
        }
      }
    } catch (ledgerError) {
      console.error(`[Confirm Order] Error creating logistics charge ledger entry:`, ledgerError);
      // Don't fail the entire confirmation if logistics charge entry fails
    }

    // ==========================================
    // STEP 4: Update supplier balance
    // ==========================================

    await Supplier.findByIdAndUpdate(
      dispatchOrder.supplier._id,
      { $inc: { currentBalance: discountedSupplierPaymentTotal - cashPaymentAmount - bankPaymentAmount } }
    );
    console.log(`[Confirm Order] Updated supplier balance`)

    // ==========================================
    // STEP 5: Generate and save barcodes (AFTER inventory processing)
    // ==========================================
    console.log(`[Confirm Order] Generating barcodes for order ${dispatchOrder.orderNumber}...`);
    
    try {
      const bwipjs = require('bwip-js');
      
      // Generate barcodes with dataURL format like QR codes
      const barcodeResults = [];
      
      for (const item of dispatchOrder.items) {
        const supplierId = dispatchOrder.supplier._id.toString();
        // Handle both populated product (object with _id) and direct ObjectId reference
        const productId = item.product 
          ? (item.product._id ? item.product._id.toString() : item.product.toString())
          : 'manual';
        
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
            generatedAt: new Date()
          });
        }
      }
      
      // Save barcode data to dispatch order (with dataURL like QR codes)
      dispatchOrder.barcodeData = barcodeResults;
      dispatchOrder.barcodeGeneratedAt = new Date();
      
      console.log(`[Confirm Order] Generated ${barcodeResults.length} barcodes with dataURLs for order ${dispatchOrder.orderNumber}`);
      
    } catch (barcodeError) {
      console.error('Barcode generation error:', barcodeError);
      // Don't fail confirmation if barcode generation fails
    }

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'confirmedBy', select: 'name' }
    ]);

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order confirmed successfully');

  } catch (error) {
    console.error('Confirm dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

// Return items from dispatch order
router.post('/:id/return', auth, async (req, res) => {
  try {
    // Only admin/manager can return items
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Only admins and managers can return items', 403);
    }

    const { returnedItems } = req.body;

    if (!Array.isArray(returnedItems) || returnedItems.length === 0) {
      return sendResponse.error(res, 'Returned items array is required', 400);
    }

    const dispatchOrder = await DispatchOrder.findById(req.params.id)
      .populate('supplier');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Validate return quantities
    const returnItemsData = [];
    let totalReturnValue = 0;

    for (const returnItem of returnedItems) {
      // Support both itemIndex (legacy) and productId (modal)
      let itemIndex = returnItem.itemIndex;
      let item;

      if (itemIndex !== undefined && itemIndex !== null) {
        if (itemIndex < 0 || itemIndex >= dispatchOrder.items.length) {
          return sendResponse.error(res, `Invalid item index: ${itemIndex}`, 400);
        }
        item = dispatchOrder.items[itemIndex];
      } else if (returnItem.productId) {
        // Find item by product ID
        itemIndex = dispatchOrder.items.findIndex(i =>
          i.product && i.product.toString() === returnItem.productId
        );

        if (itemIndex === -1) {
          return sendResponse.error(res, `Product not found in dispatch order: ${returnItem.productId}`, 404);
        }
        item = dispatchOrder.items[itemIndex];
      } else {
        return sendResponse.error(res, 'Item identifier (itemIndex or productId) is required', 400);
      }

      const { quantity, reason, batchId } = returnItem;
      const originalQty = item.quantity;

      // Calculate already returned quantity for this item
      const alreadyReturned = dispatchOrder.returnedItems
        .filter(returned => returned.itemIndex === itemIndex)
        .reduce((sum, returned) => sum + returned.quantity, 0);

      const remainingQty = originalQty - alreadyReturned;

      if (quantity <= 0) {
        return sendResponse.error(res, `Return quantity must be greater than 0 for item ${itemIndex}`, 400);
      }

      if (quantity > remainingQty) {
        return sendResponse.error(res, `Return quantity (${quantity}) exceeds remaining quantity (${remainingQty}) for item ${itemIndex}`, 400);
      }

      // Handle Batch Deduction (if batchId provided)
      let batchDeductionInfo = null;
      if (batchId && item.product) {
        const inventory = await Inventory.findOne({ product: item.product });
        if (inventory) {
          const batch = inventory.purchaseBatches.find(b => b._id.toString() === batchId);
          if (batch) {
            // Only deduct if batch has enough quantity (safeguard)
            if (batch.remainingQuantity < quantity) {
              // If the batch doesn't have enough, we allow the return but only deduct what's available
              // This prevents blocking returns if data is slightly out of sync
              console.warn(`[Return] Insufficient batch quantity for ${item.productCode || 'product'}. Available: ${batch.remainingQuantity}, Requested: ${quantity}`);
            }

            // Reduce batch quantity, but don't go below 0
            const deductAmount = Math.min(batch.remainingQuantity, quantity);
            batch.remainingQuantity -= deductAmount;
            await inventory.save();

            batchDeductionInfo = {
              batchId: batch._id,
              dispatchOrderId: dispatchOrder._id,
              quantity: quantity,
              costPrice: batch.costPrice
            };
          } else {
            console.warn(`[Return] Batch ${batchId} not found in inventory for product ${item.product}`);
          }
        }
      }

      // Calculate return value using actual cost price paid to supplier (supplier currency)
      // NOT landed price - we return what we paid the supplier
      // Use costPrice directly (NO exchange rate) because that's what we paid supplier during confirmation
      const supplierPaymentAmount = item.costPrice || 0;
      const returnValue = supplierPaymentAmount * quantity;
      totalReturnValue += returnValue;

      // Keep landedPrice for reference
      const landedPrice = item.landedPrice || (item.costPrice * (dispatchOrder.exchangeRate || 1) * (1 + ((dispatchOrder.percentage || 0) / 100)));

      const returnItemData = {
        itemIndex,
        originalQuantity: originalQty,
        returnedQuantity: quantity,
        costPrice: item.costPrice,
        supplierPaymentAmount, // What we actually return to supplier
        landedPrice, // Keep for reference
        reason: reason || ''
      };

      if (batchDeductionInfo) {
        returnItemData.batchDeductions = [batchDeductionInfo];
      }

      returnItemsData.push(returnItemData);

      // Add to dispatch order's returnedItems array
      dispatchOrder.returnedItems.push({
        itemIndex,
        quantity,
        reason: reason || '',
        returnedAt: new Date(),
        returnedBy: req.user._id
      });
    }

    // Create Return document
    const returnDoc = new Return({
      dispatchOrder: dispatchOrder._id,
      supplier: dispatchOrder.supplier._id,
      items: returnItemsData,
      totalReturnValue,
      returnedAt: new Date(),
      returnedBy: req.user._id,
      notes: req.body.notes || '',
      returnType: 'order-level'
    });

    await returnDoc.save();

    // If dispatch order is already confirmed, create ledger credit entry
    if (dispatchOrder.status === 'confirmed') {
      const totalReturnedItems = returnItemsData.reduce((sum, item) => sum + item.returnedQuantity, 0);

      // Get current supplier balance using BalanceService (accurate aggregation-based calculation)
      const currentSupplierBalance = await BalanceService.getSupplierBalance(dispatchOrder.supplier._id);
      const newSupplierBalance = currentSupplierBalance - totalReturnValue;

      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'return',
        referenceId: returnDoc._id,
        referenceModel: 'Return',
        debit: 0,
        credit: totalReturnValue,
        date: new Date(),
        description: `Return from Dispatch Order ${dispatchOrder.orderNumber} - ${totalReturnedItems} items worth €${totalReturnValue.toFixed(2)} (adjusted from balance)`,
        remarks: `Return ID: ${returnDoc._id}`,
        createdBy: req.user._id,
        paymentDetails: {
          cashPayment: 0,
          bankPayment: 0,
          remainingBalance: newSupplierBalance
        }
      });

      // Update supplier balance (reduce by return amount)
      await Supplier.findByIdAndUpdate(
        dispatchOrder.supplier._id,
        { $inc: { currentBalance: -totalReturnValue } }
      );

      // Recalculate confirmed quantities
      dispatchOrder.confirmedQuantities = dispatchOrder.items.map((item, index) => {
        const totalReturned = dispatchOrder.returnedItems
          .filter(returned => returned.itemIndex === index)
          .reduce((sum, returned) => sum + returned.quantity, 0);

        return {
          itemIndex: index,
          quantity: item.quantity - totalReturned
        };
      });

      // Update payment details - reduce per-order remaining balance by return value
      const currentOrderRemaining = dispatchOrder.paymentDetails?.remainingBalance || 0;
      const newOrderRemaining = Math.max(0, currentOrderRemaining - totalReturnValue);

      dispatchOrder.paymentDetails = {
        ...dispatchOrder.paymentDetails,
        remainingBalance: newOrderRemaining,
        // Update payment status if now fully paid
        paymentStatus: newOrderRemaining <= 0 ? 'paid' :
          (dispatchOrder.paymentDetails?.cashPayment || 0) +
            (dispatchOrder.paymentDetails?.bankPayment || 0) +
            (dispatchOrder.paymentDetails?.creditApplied || 0) > 0
            ? 'partial' : 'pending'
      };

      console.log(`[Return] Updated order remainingBalance: €${currentOrderRemaining.toFixed(2)} -> €${newOrderRemaining.toFixed(2)} (return value: €${totalReturnValue.toFixed(2)})`);
      console.log(`[Return] Supplier balance updated: ${currentSupplierBalance} -> ${newSupplierBalance}`);


      // Reduce inventory for returned items
      try {
        for (const returnItem of returnItemsData) {
          const item = dispatchOrder.items[returnItem.itemIndex];

          // Only reduce inventory if product exists
          if (item.product) {
            const inventory = await Inventory.findOne({ product: item.product });

            if (inventory) {
              // Use reduceStock method (items going back to supplier)
              await inventory.reduceStock(
                returnItem.returnedQuantity,
                `Return - ${dispatchOrder.orderNumber}`,
                returnDoc._id,
                req.user._id,
                `Return of ${returnItem.returnedQuantity} units - Reason: ${returnItem.reason || 'Not specified'}`
              );

              console.log(`[Return] Reduced inventory for ${item.productCode}: -${returnItem.returnedQuantity} units`);
            } else {
              console.warn(`[Return] No inventory record found for product ${item.product}`);
            }
          }
        }
      } catch (inventoryError) {
        console.error('[Return] Error reducing inventory:', inventoryError);
        // Don't fail the return if inventory update fails
      }
    }

    await dispatchOrder.save();

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'confirmedBy', select: 'name' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' },
      { path: 'returnedItems.returnedBy', select: 'name' }
    ]);

    const returns = await Return.find({ dispatchOrder: dispatchOrder._id })
      .populate('returnedBy', 'name')
      .sort({ returnedAt: -1 });

    const orderObj = dispatchOrder.toObject();
    orderObj.returns = returns;

    // Convert images to signed URLs
    await convertDispatchOrderImages(orderObj);

    return sendResponse.success(res, orderObj, 'Items returned successfully');

  } catch (error) {
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

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'QR code generated successfully');
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

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order found');
  } catch (error) {
    console.error('Get dispatch order from QR error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Confirm dispatch order via QR scan (mobile app endpoint)
router.post('/qr/:qrData/confirm', auth, async (req, res) => {
  try {
    // Only admin/manager can confirm via QR scan
    if (!['super-admin', 'admin'].includes(req.user.role)) {
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
      date: new Date(),
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
          date: new Date(),
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
          date: new Date(),
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
              console.log(`[Dispatch Order QR Confirm] All images already exist in product ${product.name || product._id}`);
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
              `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed via QR scan with variants`
            );
          } else {
            // Add stock without variant tracking (legacy behavior)
            await inventory.addStock(
              confirmedQuantity,
              'DispatchOrder',
              dispatchOrder._id,
              req.user._id,
              `Dispatch Order ${dispatchOrder.orderNumber} - Confirmed via QR scan`
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

      console.log(`[Inventory Update - QR] Processed ${dispatchOrder.items.length} items: ${successCount} succeeded, ${failCount} failed, ${skippedCount} skipped`);

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

      console.log(`[Inventory Update - QR] Rolled back confirmation for dispatch order ${dispatchOrder.orderNumber}`);

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

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order confirmed successfully via QR scan');
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

    // Only pending orders can be updated
    if (dispatchOrder.status !== 'pending') {
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
        };

        if (item.primaryColor) processedItem.primaryColor = item.primaryColor;
        if (item.size) processedItem.size = item.size;
        if (item.material) processedItem.material = item.material;
        if (item.description) processedItem.description = item.description;
        if (item.productImage) processedItem.productImage = item.productImage;

        return processedItem;
      });

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

    // Update dispatch order
    Object.assign(dispatchOrder, updateData);
    await dispatchOrder.save();

    // Populate for response
    await dispatchOrder.populate([
      { path: 'supplier', select: 'name company' },
      { path: 'logisticsCompany', select: 'name code contactInfo rates' },
      { path: 'createdBy', select: 'name' },
      { path: 'items.product', select: 'name sku unit images color size productCode pricing' }
    ]);

    // Convert images to signed URLs
    await convertDispatchOrderImages(dispatchOrder);

    return sendResponse.success(res, dispatchOrder, 'Dispatch order updated successfully');

  } catch (error) {
    console.error('Update dispatch order error:', error);
    return sendResponse.error(res, error.message || 'Failed to update dispatch order', 500);
  }
});

// Delete dispatch order (only pending orders)
router.delete('/:id', auth, async (req, res) => {
  try {
    const dispatchOrder = await DispatchOrder.findById(req.params.id);

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Only pending orders can be deleted
    if (dispatchOrder.status !== 'pending') {
      return sendResponse.error(res, 'Only pending dispatch orders can be deleted', 400);
    }

    // Check permissions
    if (req.user.role === 'supplier') {
      const isOrderSupplier = dispatchOrder.supplier?.toString() === req.user.supplier?.toString();
      const isCreator = dispatchOrder.supplierUser?.toString() === req.user._id.toString();

      if (!isOrderSupplier && !isCreator) {
        return sendResponse.error(res, 'You do not have permission to delete this dispatch order', 403);
      }
    } else if (req.user.role !== 'super-admin' && req.user.role !== 'admin') {
      return sendResponse.error(res, 'You do not have permission to delete dispatch orders', 403);
    }

    // Delete associated images from Google Cloud Storage
    if (dispatchOrder.items && Array.isArray(dispatchOrder.items)) {
      const imageDeletionPromises = dispatchOrder.items
        .filter(item => item.productImage) // Only items with images
        .flatMap((item) => {
          // Handle both string (backward compat) and array of images
          const imagesToDelete = Array.isArray(item.productImage)
            ? item.productImage
            : [item.productImage];

          return imagesToDelete.map(async (imageUrl) => {
            try {
              console.log('Deleting image from GCS:', imageUrl);
              const deleted = await deleteImage(imageUrl);
              if (deleted) {
                console.log('Successfully deleted image:', imageUrl);
              } else {
                console.warn('Image not found or already deleted:', imageUrl);
              }
            } catch (imageError) {
              // Log error but don't block order deletion
              console.error('Error deleting image from GCS:', {
                imageUrl: imageUrl,
                error: imageError.message,
                stack: imageError.stack,
              });
            }
          });
        });

      // Wait for all image deletions to complete (or fail)
      await Promise.allSettled(imageDeletionPromises);
      console.log('Completed image deletion process for dispatch order:', req.params.id);
    }

    // Delete the dispatch order from database
    await DispatchOrder.findByIdAndDelete(req.params.id);

    return sendResponse.success(res, null, 'Dispatch order deleted successfully');

  } catch (error) {
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

    console.log('File verified in GCS:', filePath);

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
      console.log('Image URL already exists in array, skipping duplicate');
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
            console.log('Image added to existing product:', product._id);
          }
        }
      } catch (productError) {
        console.error('Error updating product with image:', productError);
        // Don't fail the request if product update fails
      }
    }

    // Generate signed read URL for immediate display
    const signedImageUrl = await generateSignedUrl(url);

    console.log('Upload confirmed successfully');

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
      console.log('Processing base64 image upload');

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
      console.log('Processing FormData file upload');
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

    console.log('File validation passed, uploading to GCS...');

    // Upload to GCS - use dispatch order ID and item index for path
    let url;
    try {
      const uploadResult = await uploadImage(fileForProcessing, `dispatch-${dispatchOrder._id.toString()}-item-${itemIndex}`);
      url = uploadResult.url;
      console.log('Image uploaded to GCS successfully:', url);
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
      console.log('Image URL already exists in array, skipping duplicate');
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
          console.log(`[Dispatch Order] Added image to product ${product.name || product._id}`);
        } catch (productSaveError) {
          console.error(`[Dispatch Order] Failed to save image to product ${product.name || product._id}:`, {
            message: productSaveError.message,
            stack: productSaveError.stack
          });
          // Don't fail the request if product save fails - dispatch order is already saved
        }
      } else {
        console.log(`[Dispatch Order] Image already exists in product ${product.name || product._id}`);
      }
    } else {
      console.warn(`[Dispatch Order] Could not find product for item ${itemIndex}. ProductCode: ${item.productCode}, Product ID: ${item.product}`);
    }

    // Generate signed URL for the newly uploaded image
    let signedImageUrl;
    try {
      signedImageUrl = await generateSignedUrl(url);
      console.log('Signed URL generated successfully');
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
      .populate('items.product', 'name sku productCode');

    if (!dispatchOrder) {
      return sendResponse.error(res, 'Dispatch order not found', 404);
    }

    // Only allow viewing barcodes for confirmed orders
    if (dispatchOrder.status !== 'confirmed') {
      return sendResponse.error(res, 'Barcodes are only available for confirmed orders', 400);
    }

    // Check if barcodes are already generated and stored in database
    if (dispatchOrder.barcodeData && dispatchOrder.barcodeData.length > 0) {
      // Validate that barcodes have proper structure (dataUrl and data fields)
      const validBarcodes = dispatchOrder.barcodeData.filter(b => b.dataUrl && b.data);
      
      if (validBarcodes.length > 0) {
        return sendResponse.success(res, {
          orderNumber: dispatchOrder.orderNumber,
          supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
          barcodes: validBarcodes,
          source: 'database',
          generatedAt: dispatchOrder.barcodeGeneratedAt
        });
      }
      // If validBarcodes.length === 0, fall through to regeneration
      console.log(`[Barcode-Data] Existing barcodes are invalid for order ${dispatchOrder.orderNumber}, regenerating...`);
    }

    // No valid barcodes found - AUTO-REGENERATE instead of returning empty
    console.log(`[Barcode-Data] Auto-generating barcodes for order ${dispatchOrder.orderNumber}`);
    
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
          generatedAt: new Date()
        });
      }
    }

    // Save newly generated barcodes to database
    if (barcodeResults.length > 0) {
      dispatchOrder.barcodeData = barcodeResults;
      dispatchOrder.barcodeGeneratedAt = new Date();
      await dispatchOrder.save();
      console.log(`[Barcode-Data] Generated and saved ${barcodeResults.length} barcodes for order ${dispatchOrder.orderNumber}`);
    }

    return sendResponse.success(res, {
      orderNumber: dispatchOrder.orderNumber,
      supplierName: dispatchOrder.supplier?.name || dispatchOrder.supplier?.company || 'N/A',
      barcodes: barcodeResults,
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
    
    console.log(`[Barcodes] ${forceRegenerate ? 'Force regenerating' : 'Generating'} barcodes for order ${dispatchOrder.orderNumber}`);

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
          console.log(`[Barcodes] Found product ${product._id} for code ${item.productCode}`);
        } else {
          console.log(`[Barcodes] No product found for code ${item.productCode}, using 'manual'`);
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
          generatedAt: new Date()
        });
      }
    }

    // Save barcodes to database with dataURL format
    dispatchOrder.barcodeData = barcodeResults;
    dispatchOrder.barcodeGeneratedAt = new Date();
    await dispatchOrder.save();

    console.log(`[Barcodes] Generated and saved ${barcodeResults.length} barcodes for order ${dispatchOrder.orderNumber}`);

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