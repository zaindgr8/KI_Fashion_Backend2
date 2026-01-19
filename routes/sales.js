const express = require('express');
const Joi = require('joi');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const Buyer = require('../models/Buyer');
const Product = require('../models/Product');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const PacketStock = require('../models/PacketStock');
const auth = require('../middleware/auth');
const { generateSaleQR } = require('../utils/qrCode');
const { generateInvoicePDF } = require('../utils/invoiceGenerator');
const { sendInvoiceEmails } = require('../utils/emailService');
const { generateSignedUrls } = require('../utils/imageUpload');
const BalanceService = require('../services/BalanceService');
const { normalizeBarcode, parseBarcodeType } = require('../utils/barcodeGenerator');

const router = express.Router();

/**
 * Convert sale product images to signed URLs
 * @param {Object|Array} sales - Sale document(s)
 * @returns {Promise<Object|Array>} Sale(s) with signed image URLs
 */
async function convertSaleProductImages(sales) {
  if (!sales) {
    return sales;
  }

  const isArray = Array.isArray(sales);
  const salesArray = isArray ? sales : [sales];

  await Promise.all(salesArray.map(async (sale) => {
    if (!sale || !sale.items || !Array.isArray(sale.items)) {
      return;
    }

    await Promise.all(sale.items.map(async (item) => {
      if (item.product && item.product.images && Array.isArray(item.product.images)) {
        if (item.product.images.length > 0) {
          item.product.images = await generateSignedUrls(item.product.images);
        }
      }
    }));
  }));

  return isArray ? salesArray : salesArray[0];
}

// Helper function to get or create buyer ID for distributor/buyer users
async function getBuyerIdForUser(user) {
  // If buyer is already linked, use it
  if (user.buyer) {
    return user.buyer;
  }

  // If user is distributor/buyer, try to find buyer by email
  if ((user.role === 'distributor' || user.role === 'buyer') && user.email) {
    let buyer = await Buyer.findOne({
      email: user.email.toLowerCase(),
      customerType: 'distributor'
    });

    // If not found, create buyer automatically
    if (!buyer) {
      buyer = new Buyer({
        name: user.name || user.email.split('@')[0],
        email: user.email.toLowerCase(),
        phone: user.phone || '',
        customerType: 'distributor',
        createdBy: user._id
      });
      await buyer.save();
    }

    return buyer._id;
  }

  return null;
}

const saleItemSchema = Joi.object({
  product: Joi.string().required(),
  quantity: Joi.number().min(1).required(),
  unitPrice: Joi.number().min(0).required(),
  discount: Joi.number().min(0).default(0),
  taxRate: Joi.number().min(0).default(0)
});

const saleSchema = Joi.object({
  buyer: Joi.string().optional(),
  manualCustomer: Joi.object({
    name: Joi.string().required(),
    phone: Joi.string().optional(),
    phoneAreaCode: Joi.string().max(5).optional(),
    email: Joi.string().email().optional(),
    address: Joi.object({
      street: Joi.string().optional(),
      city: Joi.string().optional(),
      state: Joi.string().optional(),
      zipCode: Joi.string().optional(),
      country: Joi.string().optional()
    }).optional()
  }).optional(),
  saleDate: Joi.date().default(Date.now),
  deliveryDate: Joi.date().optional(),
  deliveryAddress: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().optional()
  }).optional(),
  deliveryPersonnel: Joi.string().optional(),
  items: Joi.array().items(saleItemSchema).min(1).required(),
  totalDiscount: Joi.number().min(0).default(0),
  shippingCost: Joi.number().min(0).default(0),
  cashPayment: Joi.number().min(0).default(0),
  bankPayment: Joi.number().min(0).default(0),
  paymentMethod: Joi.string().valid('cash', 'card', 'bank_transfer', 'cheque', 'online', 'credit').optional(),
  saleType: Joi.string().valid('retail', 'wholesale', 'bulk').default('retail'),
  invoiceNumber: Joi.string().optional(),
  receiptNumber: Joi.string().optional(),
  notes: Joi.string().optional(),
  attachments: Joi.array().items(Joi.string()).optional()
}).or('buyer', 'manualCustomer');

// Generate sale number
const generateSaleNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const prefix = `SAL${year}${month}`;
  const lastSale = await Sale.findOne({
    saleNumber: { $regex: `^${prefix}` }
  }).sort({ saleNumber: -1 });

  let nextNumber = 1;
  if (lastSale) {
    const lastNumber = parseInt(lastSale.saleNumber.slice(-4));
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, '0')}`;
};

// Calculate sale totals
const calculateTotals = (items, totalDiscount = 0, shippingCost = 0) => {
  let subtotal = 0;
  let totalTax = 0;

  items.forEach(item => {
    const itemTotal = (item.quantity * item.unitPrice) - item.discount;
    const itemTax = itemTotal * (item.taxRate / 100);

    item.totalPrice = itemTotal + itemTax;
    subtotal += itemTotal;
    totalTax += itemTax;
  });

  const grandTotal = subtotal + totalTax - totalDiscount + shippingCost;

  return {
    subtotal,
    totalTax,
    grandTotal: Math.max(0, grandTotal)
  };
};

/**
 * Process sale delivery with atomic stock updates
 * Ensures Inventory and PacketStock remain in sync
 * @param {Object} sale - Sale document
 * @param {Object} products - Map of productId to product
 * @param {Object} inventories - Map of productId to inventory
 * @param {string} userId - User ID processing the delivery
 * @returns {Object} Result with updated counts
 */
const processDeliveryWithTransaction = async (sale, productMap, inventoryMap, userId) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  const results = {
    inventoryUpdated: 0,
    packetsUpdated: 0,
    errors: []
  };
  
  try {
    for (const item of sale.items) {
      const product = productMap.get(item.product.toString());
      const inventory = inventoryMap.get(item.product.toString());
      
      if (!inventory) {
        results.errors.push(`Inventory not found for product ${item.product}`);
        continue;
      }
      
      const quantityToDeliver = item.quantity;
      
      // Handle variant-specific stock deduction
      if (product && product.variantTracking && product.variantTracking.enabled && item.variant) {
        await inventory.reduceVariantStock(
          item.variant.size,
          item.variant.color,
          quantityToDeliver,
          'Sale',
          sale._id,
          userId,
          `Sale delivery: ${sale.saleNumber}`
        );
      } else {
        // Legacy stock deduction (non-variant products)
        const currentReservedStock = inventory.reservedStock || 0;
        
        inventory.currentStock = Math.max(0, inventory.currentStock - quantityToDeliver);
        if (currentReservedStock > 0) {
          inventory.reservedStock = Math.max(0, currentReservedStock - quantityToDeliver);
        }
        
        inventory.stockMovements.push({
          type: 'out',
          quantity: quantityToDeliver,
          reference: 'Sale',
          referenceId: sale._id,
          user: userId,
          notes: `Sale delivery: ${sale.saleNumber}`,
          date: new Date()
        });
        
        inventory.lastStockUpdate = new Date();
        await inventory.save({ session });
      }
      
      results.inventoryUpdated++;
      
      // Update PacketStock atomically if this is a packet sale
      if (item.isPacketSale && item.packetStock) {
        const packetStock = await PacketStock.findById(item.packetStock).session(session);
        if (packetStock) {
          packetStock.availablePackets = Math.max(0, packetStock.availablePackets - item.quantity);
          packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - item.quantity);
          packetStock.soldPackets += item.quantity;
          await packetStock.save({ session });
          results.packetsUpdated++;
        }
      }
    }
    
    await session.commitTransaction();
    session.endSession();
    
    console.log(`[Sale Delivery] Transaction completed for ${sale.saleNumber}: ${results.inventoryUpdated} inventory, ${results.packetsUpdated} packets updated`);
    return { success: true, ...results };
    
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    
    console.error(`[Sale Delivery] Transaction failed for ${sale.saleNumber}:`, error.message);
    return { success: false, error: error.message, ...results };
  }
};

/**
 * @route   POST /api/sales/lookup-barcode
 * @desc    Lookup packet by barcode for adding to sale cart
 * @access  Private
 */
router.post('/lookup-barcode', auth, async (req, res) => {
  try {
    const { barcode } = req.body;
    
    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: 'Barcode is required'
      });
    }
    
    const normalizedBarcode = normalizeBarcode(barcode);
    const barcodeInfo = parseBarcodeType(normalizedBarcode);
    
    if (!barcodeInfo.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid barcode format. Expected PKT-XXXXXXXX or LSE-XXXXXXXX'
      });
    }
    
    const packetStock = await PacketStock.findOne({ 
      barcode: normalizedBarcode, 
      isActive: true 
    })
      .populate('product', 'name sku productCode images pricing season')
      .populate('supplier', 'name company');
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet not found. Check barcode and try again.'
      });
    }
    
    const actualAvailable = packetStock.availablePackets - packetStock.reservedPackets;
    
    if (actualAvailable <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No stock available for this packet',
        data: {
          barcode: packetStock.barcode,
          productName: packetStock.product?.name,
          availablePackets: 0
        }
      });
    }
    
    // Convert product images to signed URLs if present
    let productImages = [];
    if (packetStock.product?.images && packetStock.product.images.length > 0) {
      try {
        productImages = await generateSignedUrls(packetStock.product.images);
      } catch (imgError) {
        console.warn('Failed to generate signed URLs for product images:', imgError.message);
        productImages = packetStock.product.images;
      }
    }
    
    return res.json({
      success: true,
      data: {
        packetStockId: packetStock._id,
        barcode: packetStock.barcode,
        isLoose: packetStock.isLoose,
        product: {
          _id: packetStock.product?._id,
          name: packetStock.product?.name,
          sku: packetStock.product?.sku,
          productCode: packetStock.product?.productCode,
          images: productImages,
          season: packetStock.product?.season
        },
        supplier: {
          _id: packetStock.supplier?._id,
          name: packetStock.supplier?.name || packetStock.supplier?.company
        },
        composition: packetStock.composition,
        totalItemsPerPacket: packetStock.totalItemsPerPacket,
        availablePackets: actualAvailable,
        // Pricing info
        suggestedSellingPrice: packetStock.suggestedSellingPrice,
        landedPricePerPacket: packetStock.landedPricePerPacket,
        costPricePerPacket: packetStock.costPricePerPacket,
        // For cart display
        compositionText: packetStock.composition.map(c => `${c.color}/${c.size}×${c.quantity}`).join(', ')
      }
    });
  } catch (error) {
    console.error('Barcode lookup error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Create sale
router.post('/', auth, async (req, res) => {
  try {
    // Auto-detect buyer ID for distributors BEFORE validation
    if (!req.body.buyer && !req.body.manualCustomer) {
      if (req.user.role === 'distributor' || req.user.role === 'buyer') {
        const buyerId = await getBuyerIdForUser(req.user);
        if (buyerId) {
          req.body.buyer = buyerId.toString();
        }
      }
    }

    const { error } = saleSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Verify buyer exists (only if buyer is provided, not for manual customers)
    let buyer = null;
    let isManualSale = false;

    if (req.body.buyer) {
      buyer = await Buyer.findById(req.body.buyer);
      if (!buyer) {
        return res.status(400).json({
          success: false,
          message: 'Buyer not found'
        });
      }
    } else if (req.body.manualCustomer) {
      // Validate manual customer has required fields
      if (!req.body.manualCustomer.name) {
        return res.status(400).json({
          success: false,
          message: 'Manual customer name is required'
        });
      }
      isManualSale = true;
    } else {
      return res.status(400).json({
        success: false,
        message: 'Either buyer or manualCustomer must be provided'
      });
    }

    // Batch fetch all products and inventory to avoid N+1 queries
    const productIds = req.body.items.map(item => item.product);
    const [products, inventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).lean(),
      Inventory.find({ product: { $in: productIds } })
    ]);

    // Create lookup maps for O(1) access
    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    const inventoryMap = new Map(inventories.map(inv => [inv.product.toString(), inv]));

    // Verify all products exist and check stock
    for (const item of req.body.items) {
      const product = productMap.get(item.product.toString ? item.product.toString() : item.product);
      if (!product) {
        return res.status(400).json({
          success: false,
          message: `Product not found: ${item.product}`
        });
      }

      // Validation check for variant selection removed as per user request
      /* 
      if (product.variantTracking && product.variantTracking.enabled) {
        if (!item.variant || !item.variant.size || !item.variant.color) {
          return res.status(400).json({
            success: false,
            message: `Product ${product.name} requires size and color selection`
          });
        }
      }
      */

      const inventory = inventoryMap.get(item.product.toString ? item.product.toString() : item.product);
      if (!inventory) {
        return res.status(400).json({
          success: false,
          message: `Inventory not found for product: ${product.name}`
        });
      }

      // Check stock availability
      if (product.variantTracking && product.variantTracking.enabled && item.variant) {
        // Check variant-specific stock
        const availableVariantStock = inventory.getVariantAvailableStock(item.variant.size, item.variant.color);
        if (availableVariantStock < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for product: ${product.name} (${item.variant.color}-${item.variant.size}). Available: ${availableVariantStock}`
          });
        }
      } else {
        // Check total stock
        if (inventory.availableStock < item.quantity) {
          return res.status(400).json({
            success: false,
            message: `Insufficient stock for product: ${product.name}`
          });
        }
      }
    }

    const saleNumber = await generateSaleNumber();
    const { subtotal, totalTax, grandTotal } = calculateTotals(
      req.body.items,
      req.body.totalDiscount,
      req.body.shippingCost
    );

    // Determine payment amounts based on payment method
    // Handle both 'cashPayment' and 'paidAmount' (from CRM form)
    let cashPayment = req.body.cashPayment || req.body.paidAmount || 0;
    let bankPayment = req.body.bankPayment || 0;
    const paymentMethod = req.body.paymentMethod;

    // For distributors/buyers: Always force full payment (they pay upfront, no pending balances)
    const isDistributor = req.user.role === 'distributor' || req.user.role === 'buyer';

    if (isDistributor) {
      // Distributors always pay in full immediately
      if (paymentMethod === 'cash') {
        cashPayment = grandTotal;
        bankPayment = 0;
      } else if (paymentMethod === 'card' || paymentMethod === 'online') {
        cashPayment = 0;
        bankPayment = grandTotal;
      } else {
        // Default to cash if no method specified
        cashPayment = grandTotal;
        bankPayment = 0;
      }
    } else {
      // For other users (admin/manual sales), use existing logic
      // If paymentMethod is specified but amounts aren't, set them based on method
      if (paymentMethod === 'cash' && cashPayment === 0 && bankPayment === 0) {
        cashPayment = grandTotal;
      } else if ((paymentMethod === 'card' || paymentMethod === 'online') && cashPayment === 0 && bankPayment === 0) {
        bankPayment = grandTotal;
      }
    }

    // Calculate remaining balance
    const totalPaid = cashPayment + bankPayment;
    let remainingBalance = grandTotal - totalPaid;

    // For distributors: Force remaining balance to 0 (always fully paid)
    if (isDistributor) {
      remainingBalance = 0;
    }

    // Determine payment status
    let paymentStatus = 'pending';
    if (remainingBalance <= 0) {
      paymentStatus = 'paid';
    } else if (totalPaid > 0) {
      paymentStatus = 'partial';
    }

    // For distributors: Always mark as paid
    if (isDistributor) {
      paymentStatus = 'paid';
    }

    const sale = new Sale({
      ...req.body,
      saleNumber,
      subtotal,
      totalTax,
      grandTotal,
      cashPayment,
      bankPayment,
      paymentStatus,
      isManualSale,
      // For distributor purchases, mark as delivered (purchase completed)
      deliveryStatus: (req.user.role === 'distributor' || req.user.role === 'buyer') ? 'delivered' : 'pending',
      createdBy: req.user._id
    });

    await sale.save();

    // Reserve stock for each item (skip for manual sales if needed, or make optional)
    if (!isManualSale) {
      for (const item of req.body.items) {
        try {
          const product = await Product.findById(item.product);
          const inventory = await Inventory.findOne({ product: item.product });
          if (!inventory) {
            console.warn(`Inventory not found for product ${item.product} when creating sale ${saleNumber}`);
            continue;
          }

          // Reserve variant-specific stock if applicable
          if (product && product.variantTracking && product.variantTracking.enabled && item.variant) {
            await inventory.reserveVariantStock(item.variant.size, item.variant.color, item.quantity);
            console.log(`Variant stock reserved for product ${item.product} (${item.variant.color}-${item.variant.size}): ${item.quantity}`);
          } else {
            // Reserve total stock (legacy behavior)
            const currentReservedStock = inventory.reservedStock || 0;
            inventory.reservedStock = currentReservedStock + item.quantity;

            // Validate we have enough available stock
            if (inventory.availableStock < item.quantity) {
              console.warn(`Insufficient available stock for product ${item.product}. Available: ${inventory.availableStock}, Required: ${item.quantity}`);
            }

            await inventory.save();
            console.log(`Stock reserved for product ${item.product}: reservedStock=${inventory.reservedStock}`);
          }

          // Handle PacketStock if this is a packet sale
          if (item.isPacketSale && item.packetStock) {
            try {
              const packetStock = await PacketStock.findById(item.packetStock);
              if (packetStock) {
                // For distributor sales (auto-delivered), directly sell packets
                // For regular sales (pending delivery), reserve packets
                if (isDistributor) {
                  await packetStock.sellPackets(item.quantity);
                  console.log(`PacketStock sold (distributor) for ${packetStock.barcode}: ${item.quantity} packets`);
                } else {
                  await packetStock.reservePackets(item.quantity);
                  console.log(`PacketStock reserved for ${packetStock.barcode}: ${item.quantity} packets`);
                }
              } else {
                console.warn(`PacketStock not found for ID ${item.packetStock} when creating sale ${saleNumber}`);
              }
            } catch (packetError) {
              console.error(`Error handling PacketStock for sale ${saleNumber}:`, packetError);
              // Continue - don't fail sale creation for packet issues
            }
          }
        } catch (inventoryError) {
          console.error(`Error reserving stock for product ${item.product}:`, inventoryError);
          // Continue with other items even if one fails
        }
      }
    }

    // Create ledger entries immediately
    try {
      if (isManualSale) {
        // For manual sales, create ledger entries with customer name in description
        // Note: We need a buyer entityId, so we'll create a special "Manual Customers" buyer
        // or use a placeholder. For now, we'll skip ledger creation for manual sales
        // and log it, or create entries with a note in description.
        // TODO: Consider creating a special "Manual Customers" buyer group for ledger tracking
        console.log(`Manual sale ${saleNumber} created for customer: ${req.body.manualCustomer.name}. Ledger entries skipped (no buyer entity).`);
      } else {
        // 1. Create sale entry (debit) for the full grand total
        await Ledger.createEntry({
          type: 'buyer',
          entityId: sale.buyer,
          entityModel: 'Buyer',
          transactionType: 'sale',
          referenceId: sale._id,
          referenceModel: 'Sale',
          debit: grandTotal,
          credit: 0,
          date: sale.saleDate || new Date(),
          description: `Sale ${saleNumber} - Total: ${grandTotal.toFixed(2)}`,
          paymentDetails: {
            cashPayment: cashPayment,
            bankPayment: bankPayment,
            remainingBalance: remainingBalance
          },
          createdBy: req.user._id
        });

        // 2. Create receipt entry (credit) for cash payment if any
        if (cashPayment > 0) {
          await Ledger.createEntry({
            type: 'buyer',
            entityId: sale.buyer,
            entityModel: 'Buyer',
            transactionType: 'receipt',
            referenceId: sale._id,
            referenceModel: 'Sale',
            debit: 0,
            credit: cashPayment,
            date: sale.saleDate || new Date(),
            description: `Cash payment for Sale ${saleNumber}`,
            paymentMethod: 'cash',
            paymentDetails: {
              cashPayment: cashPayment,
              bankPayment: 0,
              remainingBalance: 0
            },
            createdBy: req.user._id
          });
        }

        // 3. Create receipt entry (credit) for bank/card payment if any
        if (bankPayment > 0) {
          await Ledger.createEntry({
            type: 'buyer',
            entityId: sale.buyer,
            entityModel: 'Buyer',
            transactionType: 'receipt',
            referenceId: sale._id,
            referenceModel: 'Sale',
            debit: 0,
            credit: bankPayment,
            date: sale.saleDate || new Date(),
            description: `Bank/Card payment for Sale ${saleNumber}`,
            paymentMethod: 'bank',
            paymentDetails: {
              cashPayment: 0,
              bankPayment: bankPayment,
              remainingBalance: 0
            },
            createdBy: req.user._id
          });
        }

        // 4. Update buyer balance and total sales
        await Buyer.findByIdAndUpdate(
          sale.buyer,
          {
            $inc: {
              totalSales: grandTotal,
              currentBalance: remainingBalance // Increase balance by remaining amount (debit - credit)
            }
          }
        );

        // 5. Recalculate and sync buyer balance from ledger (source of truth)
        // This ensures the balance is always accurate even if there were previous discrepancies
        try {
          const ledgerBalance = await Ledger.getBalance('buyer', sale.buyer);
          await Buyer.findByIdAndUpdate(
            sale.buyer,
            { currentBalance: ledgerBalance }
          );
          console.log(`Buyer balance synced from ledger after sale creation: ${ledgerBalance} for buyer ${sale.buyer}`);
        } catch (balanceError) {
          console.error('Error syncing buyer balance from ledger after sale creation:', balanceError);
          // Don't fail the sale creation if balance sync fails
        }
      }
    } catch (ledgerError) {
      console.error('Error creating ledger entries for sale:', ledgerError);
      // Don't fail the sale creation if ledger update fails, but log it
    }

    // Populate sale for QR code and invoice generation
    let populatedSale = await Sale.findById(sale._id)
      .populate('buyer', 'name company email phone address')
      .populate('items.product', 'name sku unit pricing images')
      .populate('deliveryPersonnel', 'name phone')
      .populate('createdBy', 'name email');

    // For manual sales, add customer info to populated sale object for display
    if (isManualSale && populatedSale.manualCustomer) {
      // Create a virtual buyer object for manual sales
      populatedSale.buyer = {
        name: populatedSale.manualCustomer.name,
        company: populatedSale.manualCustomer.name,
        email: populatedSale.manualCustomer.email || null,
        phone: populatedSale.manualCustomer.phone || null,
        address: populatedSale.manualCustomer.address || {}
      };
    }

    // Convert product images to signed URLs
    await convertSaleProductImages(populatedSale);

    // Generate QR code for the sale
    try {
      await generateSaleQR(populatedSale, req.user._id);
      // Re-populate to get QR code
      await populatedSale.populate('qrCode.generatedBy', 'name');
    } catch (qrError) {
      console.error('Error generating QR code for sale:', qrError);
      // Don't fail the sale creation if QR generation fails
    }

    // Generate invoice PDF and send emails (async, don't block response)
    (async () => {
      try {
        // Create invoices directory if it doesn't exist
        const invoicesDir = path.join(__dirname, '../invoices');
        if (!fs.existsSync(invoicesDir)) {
          fs.mkdirSync(invoicesDir, { recursive: true });
        }

        const invoiceFileName = `Invoice-${populatedSale.invoiceNumber || populatedSale.saleNumber}-${Date.now()}.pdf`;
        const invoicePath = path.join(invoicesDir, invoiceFileName);

        // Generate invoice PDF
        await generateInvoicePDF(populatedSale, invoicePath);

        // Update sale with invoice PDF info
        populatedSale.invoicePdf = {
          url: `/invoices/${invoiceFileName}`,
          generatedAt: new Date(),
          generatedBy: req.user._id
        };
        await populatedSale.save();

        // Get distributor email (from buyer or user)
        let distributorEmail = null;
        if (populatedSale.buyer?.email) {
          distributorEmail = populatedSale.buyer.email;
        } else {
          // Try to get email from buyer's associated user
          const buyerUser = await User.findOne({ buyer: populatedSale.buyer._id });
          if (buyerUser?.email) {
            distributorEmail = buyerUser.email;
          }
        }

        // Get admin email (first admin user)
        const adminUser = await User.findOne({ role: 'super-admin' });
        const adminEmail = adminUser?.email || process.env.ADMIN_EMAIL;

        // Send emails if we have at least one recipient
        if (distributorEmail || adminEmail) {
          const emailResults = await sendInvoiceEmails(
            populatedSale,
            invoicePath,
            distributorEmail,
            adminEmail
          );
          console.log('Invoice emails sent:', emailResults);
        } else {
          console.warn('No email addresses found for invoice delivery');
        }

      } catch (invoiceError) {
        console.error('Error generating invoice or sending emails:', invoiceError);
        // Don't fail the sale creation if invoice/email fails
      }
    })();

    res.status(201).json({
      success: true,
      message: 'Sale created successfully. Invoice will be generated and emailed shortly.',
      data: populatedSale
    });

  } catch (error) {
    console.error('Create sale error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Create bulk sale
router.post('/bulk', auth, async (req, res) => {
  try {
    const { sales } = req.body;

    if (!sales || !Array.isArray(sales) || sales.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Sales array is required'
      });
    }

    const createdSales = [];
    const errors = [];

    for (let i = 0; i < sales.length; i++) {
      try {
        const saleData = { ...sales[i], saleType: 'bulk' };
        const { error } = saleSchema.validate(saleData);

        if (error) {
          errors.push(`Sale ${i + 1}: ${error.details[0].message}`);
          continue;
        }

        // Verify buyer exists
        const buyer = await Buyer.findById(saleData.buyer);
        if (!buyer) {
          errors.push(`Sale ${i + 1}: Buyer not found`);
          continue;
        }

        // Check stock for all items
        let stockCheck = true;
        for (const item of saleData.items) {
          const inventory = await Inventory.findOne({ product: item.product });
          if (!inventory || inventory.availableStock < item.quantity) {
            errors.push(`Sale ${i + 1}: Insufficient stock for product ${item.product}`);
            stockCheck = false;
            break;
          }
        }

        if (!stockCheck) continue;

        const saleNumber = await generateSaleNumber();
        const { subtotal, totalTax, grandTotal } = calculateTotals(
          saleData.items,
          saleData.totalDiscount,
          saleData.shippingCost
        );

        const sale = new Sale({
          ...saleData,
          saleNumber,
          subtotal,
          totalTax,
          grandTotal,
          createdBy: req.user._id
        });

        await sale.save();

        // Reserve stock
        for (const item of saleData.items) {
          await Inventory.findOneAndUpdate(
            { product: item.product },
            { $inc: { reservedStock: item.quantity } }
          );
        }

        createdSales.push(sale);

      } catch (err) {
        errors.push(`Sale ${i + 1}: ${err.message}`);
      }
    }

    res.status(201).json({
      success: true,
      message: `Bulk sale created: ${createdSales.length} successful, ${errors.length} failed`,
      data: {
        successful: createdSales.length,
        failed: errors.length,
        errors: errors,
        sales: createdSales
      }
    });

  } catch (error) {
    console.error('Create bulk sale error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all sales
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      buyer,
      paymentStatus,
      deliveryStatus,
      saleType,
      startDate,
      endDate
    } = req.query;

    const query = {};

    // Role-based filtering: Distributors can only see their own sales
    if (req.user.role === 'distributor' || req.user.role === 'buyer') {
      const buyerId = await getBuyerIdForUser(req.user);
      if (buyerId) {
        query.buyer = buyerId;
      } else {
        // If no buyer found, return empty results (don't show all sales)
        return res.json({
          success: true,
          data: [],
          pagination: {
            currentPage: page,
            totalPages: 0,
            totalItems: 0,
            itemsPerPage: limit
          }
        });
      }
    } else if (buyer) {
      // Admins/managers can filter by buyer if provided
      query.buyer = buyer;
    }

    if (search) {
      query.$or = [
        { saleNumber: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } },
        { receiptNumber: { $regex: search, $options: 'i' } }
      ];
    }
    if (paymentStatus) query.paymentStatus = paymentStatus;
    if (deliveryStatus) query.deliveryStatus = deliveryStatus;
    if (saleType) query.saleType = saleType;

    if (startDate || endDate) {
      query.saleDate = {};
      if (startDate) query.saleDate.$gte = new Date(startDate);
      if (endDate) query.saleDate.$lte = new Date(endDate);
    }

    const sales = await Sale.find(query)
      .populate('buyer', 'name company')
      .populate('items.product', 'name sku productCode images pricing')
      .populate('deliveryPersonnel', 'name phone')
      .populate('createdBy', 'name')
      .sort({ saleDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Sale.countDocuments(query);

    res.json({
      success: true,
      data: sales,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get sales error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get sale by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id)
      .populate('buyer', 'name company phone email address')
      .populate('items.product', 'name sku unit pricing images')
      .populate('deliveryPersonnel', 'name phone vehicleInfo')
      .populate('createdBy', 'name email')
      .lean();

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    // Convert product images to signed URLs
    await convertSaleProductImages(sale);

    res.json({
      success: true,
      data: sale
    });

  } catch (error) {
    console.error('Get sale error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update sale
router.put('/:id', auth, async (req, res) => {
  try {
    const { error } = saleSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { subtotal, totalTax, grandTotal } = calculateTotals(
      req.body.items,
      req.body.totalDiscount,
      req.body.shippingCost
    );

    const sale = await Sale.findByIdAndUpdate(
      req.params.id,
      {
        ...req.body,
        subtotal,
        totalTax,
        grandTotal
      },
      { new: true, runValidators: true }
    )
      .populate('buyer', 'name company')
      .populate('items.product', 'name sku')
      .populate('deliveryPersonnel', 'name phone')
      .populate('createdBy', 'name');

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    res.json({
      success: true,
      message: 'Sale updated successfully',
      data: sale
    });

  } catch (error) {
    console.error('Update sale error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Mark sale as delivered and update inventory
router.patch('/:id/delivered', auth, async (req, res) => {
  try {
    const Ledger = require('../models/Ledger');
    const sale = await Sale.findById(req.params.id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    if (sale.deliveryStatus === 'delivered') {
      return res.status(400).json({
        success: false,
        message: 'Sale already marked as delivered'
      });
    }

    // Batch fetch all products and inventory to avoid N+1 queries
    const productIds = sale.items.map(item => item.product);
    const [products, inventories] = await Promise.all([
      Product.find({ _id: { $in: productIds } }).lean(),
      Inventory.find({ product: { $in: productIds } })
    ]);

    // Create lookup maps for O(1) access
    const productMap = new Map(products.map(p => [p._id.toString(), p]));
    const inventoryMap = new Map(inventories.map(inv => [inv.product.toString(), inv]));

    // Process delivery with atomic transaction for stock updates
    const deliveryResult = await processDeliveryWithTransaction(sale, productMap, inventoryMap, req.user._id);
    
    if (!deliveryResult.success) {
      console.error(`[Sale Delivery] Transaction failed for ${sale.saleNumber}, falling back to non-transactional update`);
      // Fallback: Continue with non-transactional approach for backward compatibility
      // This ensures delivery still works even if transactions fail
      for (const item of sale.items) {
        const product = productMap.get(item.product.toString());
        const inventory = inventoryMap.get(item.product.toString());

        if (!inventory) {
          console.warn(`Inventory not found for product ${item.product} in sale ${sale.saleNumber}`);
          continue;
        }

        try {
          const quantityToDeliver = item.quantity;

          // Handle variant-specific stock deduction
          if (product && product.variantTracking && product.variantTracking.enabled && item.variant) {
            await inventory.reduceVariantStock(
              item.variant.size,
              item.variant.color,
              quantityToDeliver,
              'Sale',
              sale._id,
              req.user._id,
              `Sale delivery: ${sale.saleNumber}`
            );
          } else {
            const currentReservedStock = inventory.reservedStock || 0;
            inventory.currentStock = Math.max(0, inventory.currentStock - quantityToDeliver);
            if (currentReservedStock > 0) {
              inventory.reservedStock = Math.max(0, currentReservedStock - quantityToDeliver);
            }
            inventory.stockMovements.push({
              type: 'out',
              quantity: quantityToDeliver,
              reference: 'Sale',
              referenceId: sale._id,
              user: req.user._id,
              notes: `Sale delivery: ${sale.saleNumber}`,
              date: new Date()
            });
            inventory.lastStockUpdate = new Date();
            await inventory.save();
          }

          if (item.isPacketSale && item.packetStock) {
            const packetStock = await PacketStock.findById(item.packetStock);
            if (packetStock) {
              await packetStock.sellPackets(item.quantity);
            }
          }
        } catch (itemError) {
          console.error(`Error processing item ${item.product}:`, itemError);
        }
      }
    }

    sale.deliveryStatus = 'delivered';
    sale.deliveryDate = new Date();

    // Check if ledger entries already exist for this sale (created at sale creation)
    const existingLedgerEntries = await Ledger.find({
      referenceId: sale._id,
      referenceModel: 'Sale'
    });

    // Only create ledger entry if it doesn't already exist
    // (This handles legacy sales created before ledger integration)
    if (existingLedgerEntries.length === 0) {
      const remainingBalance = sale.grandTotal - (sale.cashPayment || 0) - (sale.bankPayment || 0);

      if (remainingBalance > 0 && sale.paymentStatus !== 'paid') {
        await Ledger.createEntry({
          type: 'buyer',
          entityId: sale.buyer,
          entityModel: 'Buyer',
          transactionType: 'sale',
          referenceId: sale._id,
          referenceModel: 'Sale',
          debit: remainingBalance,
          credit: 0,
          date: new Date(),
          description: `Sale ${sale.saleNumber} - Remaining balance`,
          createdBy: req.user._id
        });
      }

      // Update buyer balance only if ledger entries didn't exist
      await Buyer.findByIdAndUpdate(
        sale.buyer,
        { $inc: { totalSales: sale.grandTotal, currentBalance: remainingBalance } }
      );
    }

    // Recalculate and sync buyer balance from ledger (source of truth)
    try {
      const ledgerBalance = await Ledger.getBalance('buyer', sale.buyer);
      await Buyer.findByIdAndUpdate(
        sale.buyer,
        { currentBalance: ledgerBalance }
      );
      console.log(`Buyer balance synced from ledger: ${ledgerBalance} for buyer ${sale.buyer}`);
    } catch (balanceError) {
      console.error('Error syncing buyer balance from ledger:', balanceError);
      // Don't fail the delivery if balance sync fails
    }

    await sale.save();

    res.json({
      success: true,
      message: 'Sale marked as delivered and inventory updated',
      data: sale
    });

  } catch (error) {
    console.error('Mark sale delivered error:', error);
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

    if (!['pending', 'partial', 'paid', 'refunded'].includes(paymentStatus)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment status'
      });
    }

    const sale = await Sale.findByIdAndUpdate(
      req.params.id,
      { paymentStatus },
      { new: true }
    )
      .populate('buyer', 'name company')
      .populate('items.product', 'name sku');

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    res.json({
      success: true,
      message: 'Payment status updated successfully',
      data: sale
    });

  } catch (error) {
    console.error('Update payment status error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Cancel sale
router.delete('/:id', auth, async (req, res) => {
  try {
    const sale = await Sale.findById(req.params.id);

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Sale not found'
      });
    }

    // Release reserved stock
    for (const item of sale.items) {
      await Inventory.findOneAndUpdate(
        { product: item.product },
        { $inc: { reservedStock: -item.quantity } }
      );

      // Release PacketStock reservation if this is a packet sale
      if (item.isPacketSale && item.packetStock) {
        try {
          const packetStock = await PacketStock.findById(item.packetStock);
          if (packetStock) {
            await packetStock.releaseReservedPackets(item.quantity);
            console.log(`PacketStock released for ${packetStock.barcode}: ${item.quantity} packets`);
          }
        } catch (packetError) {
          console.error(`Error releasing PacketStock for sale ${sale.saleNumber}:`, packetError);
          // Continue - don't fail cancellation for packet release issues
        }
      }
    }

    sale.deliveryStatus = 'cancelled';
    await sale.save();

    res.json({
      success: true,
      message: 'Sale cancelled successfully'
    });

  } catch (error) {
    console.error('Cancel sale error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;