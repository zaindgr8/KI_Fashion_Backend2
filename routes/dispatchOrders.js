const express = require('express');
const multer = require('multer');
const DispatchOrder = require('../models/DispatchOrder');
const LogisticsCompany = require('../models/LogisticsCompany');
const Supplier = require('../models/Supplier');
const Return = require('../models/Return');
const Ledger = require('../models/Ledger');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');
const { generateDispatchOrderQR } = require('../utils/qrCode');

const dispatchOrderController = require('../controllers/dispatchOrderController');
const dispatchOrderService = require('../services/DispatchOrderService');

const router = express.Router();

// Helper wrapper for legacy support (used by GET routes)
const convertDispatchOrderImages = dispatchOrderService.convertDispatchOrderImages.bind(dispatchOrderService);

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10) * 1024 * 1024 // Default 5MB
  }
});

// Helper moved to Service

// Schemas moved to validators/dispatchOrderValidators.js

// Create dispatch order (Suppliers only)
router.post('/', auth, dispatchOrderController.createDispatchOrder);

// Create manual entry (CRM Admin only - replaces Purchase)
router.post('/manual', auth, dispatchOrderController.createManualEntry);

// Get dispatch orders
router.get('/', auth, dispatchOrderController.getDispatchOrders);

// Get unpaid/partially paid dispatch orders for a supplier
router.get('/unpaid/:supplierId', auth, dispatchOrderController.getUnpaidOrders);

// Get dispatch order by ID
router.get('/:id', auth, dispatchOrderController.getDispatchOrderById);

// Update dispatch order status
router.patch('/:id/status', auth, dispatchOrderController.updateStatus);

// Submit dispatch order for approval (Admin only)
router.post('/:id/submit-approval', auth, dispatchOrderController.submitForApproval);

// Confirm dispatch order (Super-admin only)
router.post('/:id/confirm', auth, dispatchOrderController.confirmDispatchOrder);

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
      const { itemIndex, quantity, reason } = returnItem;

      if (itemIndex < 0 || itemIndex >= dispatchOrder.items.length) {
        return sendResponse.error(res, `Invalid item index: ${itemIndex}`, 400);
      }

      const item = dispatchOrder.items[itemIndex];
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

      // Calculate return value using actual cost price paid to supplier (supplier currency)
      // NOT landed price - we return what we paid the supplier
      // Use costPrice directly (NO exchange rate) because that's what we paid supplier during confirmation
      const supplierPaymentAmount = item.costPrice || 0;
      const returnValue = supplierPaymentAmount * quantity;
      totalReturnValue += returnValue;

      // Keep landedPrice for reference
      const landedPrice = item.landedPrice || (item.costPrice * (dispatchOrder.exchangeRate || 1) * (1 + ((dispatchOrder.percentage || 0) / 100)));

      returnItemsData.push({
        itemIndex,
        originalQuantity: originalQty,
        returnedQuantity: quantity,
        costPrice: item.costPrice,
        supplierPaymentAmount, // What we actually return to supplier
        landedPrice, // Keep for reference
        reason: reason || ''
      });

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
      notes: req.body.notes || ''
    });

    await returnDoc.save();

    // If dispatch order is already confirmed, create ledger credit entry
    if (dispatchOrder.status === 'confirmed') {
      const totalReturnedItems = returnItemsData.reduce((sum, item) => sum + item.returnedQuantity, 0);

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
        createdBy: req.user._id
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

      // Update payment details - reduce remaining balance by return value
      const currentRemaining = dispatchOrder.paymentDetails?.remainingBalance || 0;
      const newRemaining = Math.max(0, currentRemaining - totalReturnValue);

      dispatchOrder.paymentDetails = {
        ...dispatchOrder.paymentDetails,
        remainingBalance: newRemaining,
        // Update payment status if now fully paid
        paymentStatus: newRemaining <= 0 ? 'paid' :
          (dispatchOrder.paymentDetails?.cashPayment || 0) +
            (dispatchOrder.paymentDetails?.bankPayment || 0) +
            (dispatchOrder.paymentDetails?.creditApplied || 0) > 0
            ? 'partial' : 'pending'
      };

      console.log(`[Return] Updated remainingBalance: €${currentRemaining.toFixed(2)} -> €${newRemaining.toFixed(2)} (return value: €${totalReturnValue.toFixed(2)})`);


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

          let product = await Product.findOne({
            $or: [
              { sku: item.productCode.toUpperCase() },
              { productCode: item.productCode }
            ]
          });

          if (!product) {
            // Handle primaryColor: can be array or string
            const colorForProduct = Array.isArray(item.primaryColor) && item.primaryColor.length > 0
              ? item.primaryColor[0]  // Use first color as main color
              : (typeof item.primaryColor === 'string' ? item.primaryColor : undefined);

            product = new Product({
              name: item.productName,
              sku: item.productCode.toUpperCase(),
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
                product = await Product.findOne({ sku: item.productCode.toUpperCase() });
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
router.put('/:id', auth, dispatchOrderController.updateDispatchOrder);

// Delete dispatch order (only pending orders)
router.delete('/:id', auth, dispatchOrderController.deleteDispatchOrder);

// Request pre-signed URL for direct GCS upload
router.post('/:id/items/:itemIndex/upload-url', auth, dispatchOrderController.generateUploadUrl);

// Confirm upload and save image path to database
router.post('/:id/items/:itemIndex/confirm-upload', auth, dispatchOrderController.confirmUpload);

// Upload image for dispatch order item
// Supports both FormData (web) and base64 JSON (mobile)
router.post('/:id/items/:itemIndex/image', auth, upload.single('image'), dispatchOrderController.uploadDispatchOrderItemImage);

module.exports = router;
