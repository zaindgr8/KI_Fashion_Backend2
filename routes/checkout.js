const express = require('express');
const Joi = require('joi');
const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const Buyer = require('../models/Buyer');
const Product = require('../models/Product');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const PacketStock = require('../models/PacketStock');
const Settings = require('../models/Settings');
const auth = require('../middleware/auth');
const { generateSaleQR } = require('../utils/qrCode');
const { generateInvoicePDF } = require('../utils/invoiceGenerator');
const { sendInvoiceEmails } = require('../utils/emailService');

const router = express.Router();

// Initialize Stripe (will be null if STRIPE_SECRET_KEY not set)
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

// Validation schema for checkout
const checkoutSchema = Joi.object({
  addressId: Joi.string().required(),
  items: Joi.array().items(Joi.object({
    id: Joi.string().required(),
    productId: Joi.string().required(),
    name: Joi.string().required(),
    price: Joi.number().min(0).required(),
    quantity: Joi.number().min(1).required(),
    image: Joi.string().allow('', null).optional(),
    sku: Joi.string().optional(),
    inventoryType: Joi.string().valid('packet', 'loose').required(),
    packetBarcode: Joi.string().optional(),
    packetStockId: Joi.string().optional(),
    packetInfo: Joi.object().optional(),
    variant: Joi.object({
      size: Joi.string().required(),
      color: Joi.string().required(),
      sku: Joi.string().optional()
    }).optional()
  })).min(1).required(),
  notes: Joi.string().optional().allow('')
});

// Helper function to get buyer ID for authenticated user
async function getBuyerIdForUser(user) {
  if (user.buyer) {
    // Handle both populated and unpopulated buyer reference
    return user.buyer._id || user.buyer;
  }

  if ((user.role === 'distributor' || user.role === 'buyer') && user.email) {
    let buyer = await Buyer.findOne({
      email: user.email.toLowerCase(),
      customerType: 'distributor'
    });

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

// Calculate sale totals with VAT
const calculateTotals = async (items, totalDiscount = 0, shippingCost = 0) => {
  let subtotal = 0;
  let totalTax = 0;
  let totalVAT = 0;

  // Fetch VAT settings
  const settings = await Settings.getSettings();
  const vatRate = settings.vat.enabled ? settings.vat.rate : 0;

  const processedItems = items.map(item => {
    const itemTotal = item.quantity * item.price;
    const discount = item.discount || 0;
    const taxRate = item.taxRate || 0;
    const itemTax = (itemTotal - discount) * (taxRate / 100);
    
    // Calculate VAT on the item (after discount, before other taxes)
    const itemVAT = (itemTotal - discount) * (vatRate / 100);
    
    const totalPrice = itemTotal - discount + itemTax + itemVAT;

    subtotal += itemTotal - discount;
    totalTax += itemTax;
    totalVAT += itemVAT;

    return {
      product: item.productId,
      quantity: item.quantity,
      unitPrice: item.price,
      discount: discount,
      taxRate: taxRate,
      vatRate: vatRate,
      totalPrice: totalPrice,
      variant: item.variant || null,
      isPacketSale: item.inventoryType === 'packet',
      packetStock: item.packetStockId || null,
      packetBarcode: item.packetBarcode || null,
      packetComposition: item.packetInfo?.composition || [],
      totalItemsPerPacket: item.packetInfo?.itemsPerPacket || 1
    };
  });

  const grandTotal = subtotal + totalTax + totalVAT - totalDiscount + shippingCost;

  return {
    items: processedItems,
    subtotal,
    totalTax,
    totalVAT,
    vatRate,
    grandTotal: Math.max(0, grandTotal)
  };
};

/**
 * Reserve stock for checkout
 * Creates temporary reservation without deducting
 */
async function reserveStock(items, saleId, userId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const item of items) {
      if (item.inventoryType === 'packet' && item.packetBarcode) {
        // Reserve packet stock
        const packetStock = await PacketStock.findOne({ 
          barcode: item.packetBarcode,
          isActive: true 
        }).session(session);

        if (!packetStock) {
          throw new Error(`Packet not found: ${item.packetBarcode}`);
        }

        const availableStock = packetStock.availablePackets - packetStock.reservedPackets;
        if (availableStock < item.quantity) {
          throw new Error(`Insufficient stock for ${item.name}. Available: ${availableStock}`);
        }

        packetStock.reservedPackets += item.quantity;
        await packetStock.save({ session });
      } else if (item.variant) {
        // Reserve variant stock
        const inventory = await Inventory.findOne({ 
          product: item.productId 
        }).session(session);

        if (!inventory) {
          throw new Error(`Inventory not found for product: ${item.productId}`);
        }

        const availableStock = inventory.getVariantAvailableStock(
          item.variant.size, 
          item.variant.color
        );

        if (availableStock < item.quantity) {
          throw new Error(`Insufficient stock for ${item.name} (${item.variant.color}/${item.variant.size}). Available: ${availableStock}`);
        }

        // Reserve in variant stock (only if variantStock exists)
        if (inventory.variantStock && inventory.variantStock.length > 0) {
          const variantIdx = inventory.variantStock.findIndex(
            v => v.size === item.variant.size && v.color === item.variant.color
          );
          if (variantIdx >= 0) {
            inventory.variantStock[variantIdx].reservedStock = (inventory.variantStock[variantIdx].reservedStock || 0) + item.quantity;
          }
        }
        inventory.reservedStock = (inventory.reservedStock || 0) + item.quantity;
        await inventory.save({ session });
      }
    }

    await session.commitTransaction();
    session.endSession();
    return { success: true };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    return { success: false, error: error.message };
  }
}

/**
 * Release reserved stock (on payment failure/cancellation)
 */
async function releaseReservedStock(sale) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const item of sale.items) {
      if (item.isPacketSale && item.packetBarcode) {
        const packetStock = await PacketStock.findOne({ 
          barcode: item.packetBarcode 
        }).session(session);

        if (packetStock) {
          packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - item.quantity);
          await packetStock.save({ session });
        }
      } else if (item.variant) {
        const inventory = await Inventory.findOne({ 
          product: item.product 
        }).session(session);

        if (inventory) {
          // Release variant stock reservation (only if variantStock exists)
          if (inventory.variantStock && inventory.variantStock.length > 0) {
            const variantIdx = inventory.variantStock.findIndex(
              v => v.size === item.variant.size && v.color === item.variant.color
            );
            if (variantIdx >= 0) {
              inventory.variantStock[variantIdx].reservedStock = Math.max(
                0, 
                (inventory.variantStock[variantIdx].reservedStock || 0) - item.quantity
              );
            }
          }
          inventory.reservedStock = Math.max(0, (inventory.reservedStock || 0) - item.quantity);
          await inventory.save({ session });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    return { success: true };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error releasing reserved stock:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Confirm stock deduction (convert reservation to actual deduction)
 */
async function confirmStockDeduction(sale, userId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    for (const item of sale.items) {
      if (item.isPacketSale && item.packetBarcode) {
        const packetStock = await PacketStock.findOne({ 
          barcode: item.packetBarcode 
        }).session(session);

        if (packetStock) {
          // Convert reservation to sold
          packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - item.quantity);
          packetStock.availablePackets = Math.max(0, packetStock.availablePackets - item.quantity);
          packetStock.soldPackets += item.quantity;
          await packetStock.save({ session });
        }
      } else if (item.variant) {
        const inventory = await Inventory.findOne({ 
          product: item.product 
        }).session(session);

        if (inventory) {
          // Convert reservation to actual deduction (only if variantStock exists)
          if (inventory.variantStock && inventory.variantStock.length > 0) {
            const variantIdx = inventory.variantStock.findIndex(
              v => v.size === item.variant.size && v.color === item.variant.color
            );
            
            if (variantIdx >= 0) {
              inventory.variantStock[variantIdx].reservedStock = Math.max(
                0, 
                (inventory.variantStock[variantIdx].reservedStock || 0) - item.quantity
              );
              inventory.variantStock[variantIdx].currentStock = Math.max(
                0,
                (inventory.variantStock[variantIdx].currentStock || 0) - item.quantity
              );
            }
          }
          
          inventory.reservedStock = Math.max(0, (inventory.reservedStock || 0) - item.quantity);
          inventory.currentStock = Math.max(0, (inventory.currentStock || 0) - item.quantity);
          
          inventory.stockMovements.push({
            type: 'out',
            quantity: item.quantity,
            reference: 'Sale',
            referenceId: sale._id,
            user: userId,
            notes: `Online order: ${sale.saleNumber}`,
            date: new Date()
          });
          
          inventory.lastStockUpdate = new Date();
          await inventory.save({ session });
        }
      }
    }

    await session.commitTransaction();
    session.endSession();
    return { success: true };
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    console.error('Error confirming stock deduction:', error);
    return { success: false, error: error.message };
  }
}

/**
 * @route   POST /api/checkout/create-session
 * @desc    Create Stripe Checkout session and reserve stock
 * @access  Private (authenticated users only)
 */
router.post('/create-session', auth, async (req, res) => {
  try {
    // Validate request body
    const { error } = checkoutSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { addressId, items, notes } = req.body;

    // Check if Stripe is configured
    if (!stripe) {
      return res.status(503).json({
        success: false,
        message: 'Payment gateway not configured. Please contact support.'
      });
    }

    // Get buyer ID for authenticated user
    const buyerId = await getBuyerIdForUser(req.user);
    if (!buyerId) {
      return res.status(400).json({
        success: false,
        message: 'Buyer profile not found. Please complete your profile first.'
      });
    }

    // Fetch buyer with address
    const buyer = await Buyer.findById(buyerId);
    if (!buyer) {
      return res.status(404).json({
        success: false,
        message: 'Buyer not found'
      });
    }

    // Get selected delivery address
    const deliveryAddress = buyer.deliveryAddresses?.id(addressId);
    if (!deliveryAddress) {
      return res.status(400).json({
        success: false,
        message: 'Invalid delivery address'
      });
    }

    // Calculate totals (now async because it fetches VAT settings)
    const { items: saleItems, subtotal, totalTax, totalVAT, vatRate, grandTotal } = await calculateTotals(items);

    // Generate sale number
    const saleNumber = await generateSaleNumber();

    // Create sale with pending payment status
    const sale = new Sale({
      saleNumber,
      buyer: buyerId,
      items: saleItems,
      saleDate: new Date(),
      deliveryAddress: {
        street: deliveryAddress.street,
        city: deliveryAddress.city,
        state: deliveryAddress.state,
        zipCode: deliveryAddress.zipCode,
        country: deliveryAddress.country
      },
      subtotal,
      totalTax,
      totalVAT,
      vatRate,
      totalDiscount: 0,
      shippingCost: 0,
      grandTotal,
      cashPayment: 0,
      bankPayment: 0,
      paymentStatus: 'awaiting_payment',
      paymentMethod: 'stripe',
      deliveryStatus: 'processing',
      saleType: 'retail',
      notes: notes || '',
      stockReserved: true,
      reservationExpiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      createdBy: req.user._id
    });

    // Reserve stock
    const reservationResult = await reserveStock(items, sale._id, req.user._id);
    if (!reservationResult.success) {
      return res.status(400).json({
        success: false,
        message: reservationResult.error || 'Failed to reserve stock'
      });
    }

    // Create Stripe Checkout session
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    
    const lineItems = items.map(item => ({
      price_data: {
        currency: 'gbp',
        product_data: {
          name: item.name,
          description: item.variant 
            ? `${item.variant.color} / ${item.variant.size}`
            : item.packetInfo?.composition?.map(c => `${c.color}/${c.size}×${c.quantity}`).join(', ') || '',
          images: item.image ? [item.image] : []
        },
        unit_amount: Math.round(item.price * 100) // Stripe expects amounts in pence
      },
      quantity: item.quantity
    }));

    const stripeSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      success_url: `${frontendUrl}/order-confirmation?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/checkout?cancelled=true`,
      customer_email: buyer.email || req.user.email,
      metadata: {
        saleId: sale._id.toString(),
        userId: req.user._id.toString(),
        buyerId: buyerId.toString()
      },
      expires_at: Math.floor(Date.now() / 1000) + (30 * 60) // 30 minutes
    });

    // Update sale with Stripe session ID
    sale.stripeSessionId = stripeSession.id;
    await sale.save();

    res.json({
      success: true,
      data: {
        sessionId: stripeSession.id,
        sessionUrl: stripeSession.url,
        saleId: sale._id,
        saleNumber: sale.saleNumber
      }
    });

  } catch (error) {
    console.error('Create checkout session error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   POST /api/checkout/webhook
 * @desc    Handle Stripe webhook events
 * @access  Public (verified by Stripe signature)
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Payment gateway not configured' });
  }

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      // For testing without webhook secret
      event = JSON.parse(req.body);
    }
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // Handle the event
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object;
      await handleSuccessfulPayment(session);
      break;
    }

    case 'checkout.session.expired': {
      const session = event.data.object;
      await handleExpiredSession(session);
      break;
    }

    case 'payment_intent.payment_failed': {
      const paymentIntent = event.data.object;
      await handleFailedPayment(paymentIntent);
      break;
    }

    case 'charge.refunded': {
      const charge = event.data.object;
      await handleRefund(charge);
      break;
    }

    default:
      console.log(`Unhandled event type: ${event.type}`);
  }

  res.json({ received: true });
});

/**
 * Handle successful payment
 */
async function handleSuccessfulPayment(session) {
  try {
    const saleId = session.metadata?.saleId;
    if (!saleId) {
      console.error('No saleId in session metadata');
      return;
    }

    const sale = await Sale.findById(saleId)
      .populate('buyer', 'name company email phone address')
      .populate('items.product', 'name sku unit pricing images')
      .populate('createdBy', 'name email');

    if (!sale) {
      console.error('Sale not found:', saleId);
      return;
    }

    // Update sale status
    sale.paymentStatus = 'paid';
    sale.deliveryStatus = 'pending';
    sale.stripePaymentIntentId = session.payment_intent;
    sale.bankPayment = sale.grandTotal;
    sale.stockReserved = false;
    sale.reservationExpiresAt = null;
    await sale.save();

    // Confirm stock deduction
    const userId = session.metadata?.userId;
    await confirmStockDeduction(sale, userId);

    // Create ledger entries
    try {
      // Sale entry (debit)
      await Ledger.createEntry({
        type: 'buyer',
        entityId: sale.buyer._id,
        entityModel: 'Buyer',
        transactionType: 'sale',
        referenceId: sale._id,
        referenceModel: 'Sale',
        debit: sale.grandTotal,
        credit: 0,
        date: new Date(),
        description: `Online Sale ${sale.saleNumber}`,
        paymentDetails: {
          cashPayment: 0,
          bankPayment: sale.grandTotal,
          remainingBalance: 0
        },
        createdBy: userId
      });

      // Receipt entry (credit) for payment
      await Ledger.createEntry({
        type: 'buyer',
        entityId: sale.buyer._id,
        entityModel: 'Buyer',
        transactionType: 'receipt',
        referenceId: sale._id,
        referenceModel: 'Sale',
        debit: 0,
        credit: sale.grandTotal,
        date: new Date(),
        description: `Stripe payment for Sale ${sale.saleNumber}`,
        paymentMethod: 'online',
        createdBy: userId
      });

      // Update buyer totals
      await Buyer.findByIdAndUpdate(sale.buyer._id, {
        $inc: { totalSales: sale.grandTotal }
      });
    } catch (ledgerError) {
      console.error('Error creating ledger entries:', ledgerError);
    }

    // Generate QR code
    try {
      await generateSaleQR(sale, userId);
    } catch (qrError) {
      console.error('Error generating QR code:', qrError);
    }

    // Generate invoice and send emails (async)
    generateInvoiceAndSendEmail(sale, userId);

    console.log(`Payment completed for sale ${sale.saleNumber}`);
  } catch (error) {
    console.error('Error handling successful payment:', error);
  }
}

/**
 * Handle expired session
 */
async function handleExpiredSession(session) {
  try {
    const saleId = session.metadata?.saleId;
    if (!saleId) return;

    const sale = await Sale.findById(saleId);
    if (!sale) return;

    if (sale.paymentStatus === 'awaiting_payment') {
      // Release reserved stock
      await releaseReservedStock(sale);

      // Update sale status
      sale.paymentStatus = 'failed';
      sale.deliveryStatus = 'cancelled';
      sale.stockReserved = false;
      await sale.save();

      console.log(`Session expired for sale ${sale.saleNumber}, stock released`);
    }
  } catch (error) {
    console.error('Error handling expired session:', error);
  }
}

/**
 * Handle failed payment
 */
async function handleFailedPayment(paymentIntent) {
  try {
    const sale = await Sale.findOne({ stripePaymentIntentId: paymentIntent.id });
    if (!sale) return;

    if (sale.paymentStatus === 'awaiting_payment') {
      await releaseReservedStock(sale);

      sale.paymentStatus = 'failed';
      sale.deliveryStatus = 'cancelled';
      sale.stockReserved = false;
      await sale.save();

      console.log(`Payment failed for sale ${sale.saleNumber}, stock released`);
    }
  } catch (error) {
    console.error('Error handling failed payment:', error);
  }
}

/**
 * Handle refund
 */
async function handleRefund(charge) {
  try {
    const sale = await Sale.findOne({ stripePaymentIntentId: charge.payment_intent });
    if (!sale) return;

    sale.paymentStatus = 'refunded';
    await sale.save();

    console.log(`Refund processed for sale ${sale.saleNumber}`);
  } catch (error) {
    console.error('Error handling refund:', error);
  }
}

/**
 * Generate invoice PDF and send email (async helper)
 */
async function generateInvoiceAndSendEmail(sale, userId) {
  const fs = require('fs');
  const path = require('path');

  try {
    const invoicesDir = path.join(__dirname, '../invoices');
    if (!fs.existsSync(invoicesDir)) {
      fs.mkdirSync(invoicesDir, { recursive: true });
    }

    const invoiceFileName = `Invoice-${sale.invoiceNumber || sale.saleNumber}-${Date.now()}.pdf`;
    const invoicePath = path.join(invoicesDir, invoiceFileName);

    await generateInvoicePDF(sale, invoicePath);

    sale.invoicePdf = {
      url: `/invoices/${invoiceFileName}`,
      generatedAt: new Date(),
      generatedBy: userId
    };
    await sale.save();

    // Get emails
    let distributorEmail = sale.buyer?.email;
    if (!distributorEmail) {
      const buyerUser = await User.findOne({ buyer: sale.buyer._id });
      distributorEmail = buyerUser?.email;
    }

    const adminUser = await User.findOne({ role: 'super-admin' });
    const adminEmail = adminUser?.email || process.env.ADMIN_EMAIL;

    if (distributorEmail || adminEmail) {
      await sendInvoiceEmails(sale, invoicePath, distributorEmail, adminEmail);
      console.log(`Invoice emails sent for sale ${sale.saleNumber}`);
    }
  } catch (error) {
    console.error('Error generating invoice/sending email:', error);
  }
}

/**
 * @route   GET /api/checkout/verify-session/:sessionId
 * @desc    Verify Stripe checkout session status
 * @access  Private
 */
router.get('/verify-session/:sessionId', auth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    if (!stripe) {
      return res.status(503).json({
        success: false,
        message: 'Payment gateway not configured'
      });
    }

    // Fetch session from Stripe
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    // Find corresponding sale
    const sale = await Sale.findOne({ stripeSessionId: sessionId })
      .populate('buyer', 'name email')
      .populate('items.product', 'name sku images')
      .select('saleNumber grandTotal paymentStatus deliveryStatus deliveryAddress items createdAt');

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Verify user owns this order
    const buyerId = await getBuyerIdForUser(req.user);
    if (sale.buyer._id.toString() !== buyerId?.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    res.json({
      success: true,
      data: {
        sessionStatus: session.payment_status,
        orderNumber: sale.saleNumber,
        amount: sale.grandTotal,
        paymentStatus: sale.paymentStatus,
        deliveryStatus: sale.deliveryStatus,
        deliveryAddress: sale.deliveryAddress,
        items: sale.items,
        createdAt: sale.createdAt
      }
    });

  } catch (error) {
    console.error('Verify session error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   GET /api/checkout/order/:saleId
 * @desc    Get order details by sale ID (for confirmation page)
 * @access  Private
 */
router.get('/order/:saleId', auth, async (req, res) => {
  try {
    const { saleId } = req.params;

    const sale = await Sale.findById(saleId)
      .populate('buyer', 'name email')
      .populate('items.product', 'name sku images pricing')
      .select('saleNumber grandTotal subtotal totalTax shippingCost paymentStatus deliveryStatus deliveryAddress items createdAt');

    if (!sale) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    // Verify user owns this order
    const buyerId = await getBuyerIdForUser(req.user);
    if (sale.buyer._id.toString() !== buyerId?.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Unauthorized'
      });
    }

    res.json({
      success: true,
      data: sale
    });

  } catch (error) {
    console.error('Get order error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
