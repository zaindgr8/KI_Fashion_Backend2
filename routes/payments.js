const express = require('express');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Ledger = require('../models/Ledger');
const Buyer = require('../models/Buyer');
const Sale = require('../models/Sale');
const auth = require('../middleware/auth');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

// =====================================================
// CREATE CUSTOMER PAYMENT
// =====================================================

/**
 * POST /payments/customer
 * Create a new customer payment with FIFO distribution
 * 
 * Body: {
 *   customerId: ObjectId,
 *   amount: number,
 *   paymentMethod: 'cash' | 'bank',
 *   date: Date (optional),
 *   description: string (optional)
 * }
 */
router.post('/customer', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  });

  try {
    const { customerId, amount, paymentMethod, date, description, paymentDirection = 'credit', debitReason } = req.body;

    // Validation
    if (!customerId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Customer ID is required'
      });
    }

    if (!amount || amount <= 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Amount must be greater than 0'
      });
    }

    if (!paymentMethod || !['cash', 'bank'].includes(paymentMethod)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Payment method must be 'cash' or 'bank'"
      });
    }

    // Validate paymentDirection
    if (!['credit', 'debit'].includes(paymentDirection)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: "Payment direction must be 'credit' or 'debit'"
      });
    }

    // Validate debitReason if direction is debit
    const validDebitReasons = ['refund', 'credit_note', 'price_adjustment', 'goodwill', 'other'];
    if (paymentDirection === 'debit' && (!debitReason || !validDebitReasons.includes(debitReason))) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Debit reason is required for debit transactions. Valid reasons: ' + validDebitReasons.join(', ')
      });
    }

    // Verify customer exists
    const customer = await Buyer.findById(customerId).session(session);
    if (!customer) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Customer not found'
      });
    }

    // Get balance before payment
    const balanceBefore = await BalanceService.getBuyerBalance(customerId);

    // Generate payment number
    const paymentNumber = await Payment.getNextPaymentNumber(session);
    const paymentDate = date ? new Date(date) : new Date();

    // Get pending sales for FIFO distribution
    const pendingSales = await BalanceService.getPendingSalesForBuyer(customerId, session);

    console.log("\n========== CUSTOMER PAYMENT CREATION ==========");
    console.log(`Payment Number: ${paymentNumber}`);
    console.log(`Customer: ${customer.name} (${customerId})`);
    console.log(`Amount: £${parseFloat(amount).toFixed(2)}`);
    console.log(`Method: ${paymentMethod}`);
    console.log(`Direction: ${paymentDirection}`);
    if (paymentDirection === 'debit') {
      console.log(`Debit Reason: ${debitReason}`);
    }
    console.log(`Balance Before: £${balanceBefore.toFixed(2)}`);
    console.log(`Pending Sales: ${pendingSales.length}`);
    console.log("================================================\n");

    const distributions = [];
    let remainingAmount = parseFloat(amount);
    let advanceAmount = 0;

    // Handle DEBIT transactions (we owe customer - refund/credit)
    if (paymentDirection === 'debit') {
      // For debit transactions, create a single ledger entry that increases customer credit
      const debitReasonLabels = {
        'refund': 'Refund',
        'credit_note': 'Credit Note',
        'price_adjustment': 'Price Adjustment',
        'goodwill': 'Goodwill Credit',
        'other': 'Adjustment'
      };
      
      const debitLedgerEntry = await Ledger.createEntry({
        type: 'buyer',
        entityId: customerId,
        entityModel: 'Buyer',
        transactionType: 'adjustment',
        debit: remainingAmount, // Debit increases what we owe them (their credit)
        credit: 0,
        paymentMethod,
        date: paymentDate,
        description: description || `${debitReasonLabels[debitReason]} - ${paymentNumber}`,
        createdBy: req.user._id,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? remainingAmount : 0,
          bankPayment: paymentMethod === 'bank' ? remainingAmount : 0,
          remainingBalance: 0
        }
      }, session);

      distributions.push({
        saleId: null,
        saleNumber: debitReasonLabels[debitReason].toUpperCase(),
        amountApplied: remainingAmount,
        previousBalance: 0,
        newBalance: remainingAmount,
        ledgerEntryId: debitLedgerEntry._id,
        isAdvance: false
      });

      console.log(`Debit transaction: £${remainingAmount.toFixed(2)} credited to customer (${debitReasonLabels[debitReason]})`);
      
      // Balance after for debit = balance increases (we owe more)
      const balanceAfterDebit = balanceBefore + parseFloat(amount);

      // Create the Payment record for debit
      const payment = new Payment({
        paymentNumber,
        paymentType: 'customer',
        paymentDirection: 'debit',
        debitReason,
        customerId,
        totalAmount: parseFloat(amount),
        cashAmount: paymentMethod === 'cash' ? parseFloat(amount) : 0,
        bankAmount: paymentMethod === 'bank' ? parseFloat(amount) : 0,
        paymentMethod,
        paymentDate,
        description,
        distributions,
        advanceAmount: 0,
        balanceBefore,
        balanceAfter: balanceAfterDebit,
        status: 'active',
        createdBy: req.user._id
      });

      await payment.save({ session });
      await session.commitTransaction();

      console.log("\n========== DEBIT PAYMENT CREATED ==========");
      console.log(`Payment Number: ${paymentNumber}`);
      console.log(`Debit Reason: ${debitReasonLabels[debitReason]}`);
      console.log(`Amount: £${parseFloat(amount).toFixed(2)}`);
      console.log(`Balance After: £${balanceAfterDebit.toFixed(2)}`);
      console.log("============================================\n");

      const populatedPayment = await Payment.findById(payment._id)
        .populate('customerId', 'name company email phone')
        .populate('createdBy', 'name')
        .lean();

      return res.status(201).json({
        success: true,
        message: `${debitReasonLabels[debitReason]} ${paymentNumber} created successfully`,
        data: {
          payment: populatedPayment,
          summary: {
            paymentNumber,
            customerName: customer.name,
            totalAmount: parseFloat(amount),
            paymentMethod,
            paymentDirection: 'debit',
            debitReason,
            salesAffected: 0,
            advanceAmount: 0,
            balanceBefore,
            balanceAfter: balanceAfterDebit
          }
        }
      });
    }

    // Handle CREDIT transactions (customer pays us - original behavior)
    // Distribute payment across sales (FIFO)
    if (pendingSales.length === 0) {
      // No pending sales - entire payment is advance
      advanceAmount = remainingAmount;

      // Create advance ledger entry
      const advanceLedgerEntry = await Ledger.createEntry({
        type: 'buyer',
        entityId: customerId,
        entityModel: 'Buyer',
        transactionType: 'receipt',
        debit: 0,
        credit: advanceAmount,
        paymentMethod,
        date: paymentDate,
        description: description || `Advance payment - ${paymentNumber}`,
        createdBy: req.user._id,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? advanceAmount : 0,
          bankPayment: paymentMethod === 'bank' ? advanceAmount : 0,
          remainingBalance: 0
        }
      }, session);

      distributions.push({
        saleId: null,
        saleNumber: 'ADVANCE',
        amountApplied: advanceAmount,
        previousBalance: 0,
        newBalance: -advanceAmount,
        ledgerEntryId: advanceLedgerEntry._id,
        isAdvance: true
      });

      console.log(`No pending sales - Full amount £${advanceAmount.toFixed(2)} applied as advance`);
    } else {
      // Distribute across pending sales
      for (const sale of pendingSales) {
        if (remainingAmount <= 0) break;

        const saleRemaining = sale.remainingBalance;
        const paymentForSale = Math.min(remainingAmount, saleRemaining);

        if (paymentForSale > 0) {
          const newSaleRemaining = saleRemaining - paymentForSale;

          console.log(`Applying £${paymentForSale.toFixed(2)} to ${sale.saleNumber}`);

          // Create ledger entry for this sale
          const ledgerEntry = await Ledger.createEntry({
            type: 'buyer',
            entityId: customerId,
            entityModel: 'Buyer',
            transactionType: 'receipt',
            referenceId: sale._id,
            referenceModel: 'Sale',
            debit: 0,
            credit: paymentForSale,
            paymentMethod,
            date: paymentDate,
            description: description || `Payment ${paymentNumber} - ${sale.saleNumber}`,
            createdBy: req.user._id,
            paymentDetails: {
              cashPayment: paymentMethod === 'cash' ? paymentForSale : 0,
              bankPayment: paymentMethod === 'bank' ? paymentForSale : 0,
              remainingBalance: Math.max(0, newSaleRemaining)
            }
          }, session);

          // Update Sale model payment tracking
          const saleDoc = await Sale.findById(sale._id).session(session);
          if (saleDoc) {
            if (paymentMethod === 'cash') {
              saleDoc.cashPayment = (saleDoc.cashPayment || 0) + paymentForSale;
            } else {
              saleDoc.bankPayment = (saleDoc.bankPayment || 0) + paymentForSale;
            }
            
            const newTotalPaid = (saleDoc.cashPayment || 0) + (saleDoc.bankPayment || 0);
            if (newTotalPaid >= saleDoc.grandTotal) {
              saleDoc.paymentStatus = 'paid';
            } else if (newTotalPaid > 0) {
              saleDoc.paymentStatus = 'partial';
            }
            
            await saleDoc.save({ session });
          }

          distributions.push({
            saleId: sale._id,
            saleNumber: sale.saleNumber,
            amountApplied: paymentForSale,
            previousBalance: saleRemaining,
            newBalance: newSaleRemaining,
            ledgerEntryId: ledgerEntry._id,
            isAdvance: false
          });

          remainingAmount -= paymentForSale;
        }
      }

      // Handle excess payment as advance
      if (remainingAmount > 0) {
        advanceAmount = remainingAmount;

        const advanceLedgerEntry = await Ledger.createEntry({
          type: 'buyer',
          entityId: customerId,
          entityModel: 'Buyer',
          transactionType: 'receipt',
          debit: 0,
          credit: advanceAmount,
          paymentMethod,
          date: paymentDate,
          description: description || `Advance (excess from ${paymentNumber})`,
          createdBy: req.user._id,
          paymentDetails: {
            cashPayment: paymentMethod === 'cash' ? advanceAmount : 0,
            bankPayment: paymentMethod === 'bank' ? advanceAmount : 0,
            remainingBalance: 0
          }
        }, session);

        distributions.push({
          saleId: null,
          saleNumber: 'ADVANCE',
          amountApplied: advanceAmount,
          previousBalance: 0,
          newBalance: -advanceAmount,
          ledgerEntryId: advanceLedgerEntry._id,
          isAdvance: true
        });

        console.log(`Excess £${advanceAmount.toFixed(2)} applied as advance`);
      }
    }

    // Get balance after payment
    const balanceAfter = balanceBefore - parseFloat(amount);

    // Create the Payment record
    const payment = new Payment({
      paymentNumber,
      paymentType: 'customer',
      paymentDirection: 'credit',
      customerId,
      totalAmount: parseFloat(amount),
      cashAmount: paymentMethod === 'cash' ? parseFloat(amount) : 0,
      bankAmount: paymentMethod === 'bank' ? parseFloat(amount) : 0,
      paymentMethod,
      paymentDate,
      description,
      distributions,
      advanceAmount,
      balanceBefore,
      balanceAfter,
      status: 'active',
      createdBy: req.user._id
    });

    await payment.save({ session });

    // Commit transaction
    await session.commitTransaction();

    console.log("\n========== PAYMENT CREATED SUCCESSFULLY ==========");
    console.log(`Payment Number: ${paymentNumber}`);
    console.log(`Total Amount: £${parseFloat(amount).toFixed(2)}`);
    console.log(`Sales Affected: ${distributions.filter(d => !d.isAdvance).length}`);
    console.log(`Advance Amount: £${advanceAmount.toFixed(2)}`);
    console.log(`Balance After: £${balanceAfter.toFixed(2)}`);
    console.log("==================================================\n");

    // Populate response data
    const populatedPayment = await Payment.findById(payment._id)
      .populate('customerId', 'name company email phone')
      .populate('createdBy', 'name')
      .lean();

    res.status(201).json({
      success: true,
      message: `Payment ${paymentNumber} created successfully`,
      data: {
        payment: populatedPayment,
        summary: {
          paymentNumber,
          customerName: customer.name,
          totalAmount: parseFloat(amount),
          paymentMethod,
          salesAffected: distributions.filter(d => !d.isAdvance).length,
          advanceAmount,
          balanceBefore,
          balanceAfter
        }
      }
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Create customer payment error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create payment',
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    });
  } finally {
    session.endSession();
  }
});

// =====================================================
// GET CUSTOMER PAYMENTS
// =====================================================

/**
 * GET /payments/customer/:customerId
 * Get all payments for a specific customer
 */
router.get('/customer/:customerId', auth, async (req, res) => {
  try {
    const { customerId } = req.params;
    const { limit = 50, offset = 0, status = 'all' } = req.query;

    const payments = await Payment.getCustomerPayments(customerId, {
      limit: parseInt(limit),
      offset: parseInt(offset),
      status
    });

    const total = await Payment.countDocuments({
      customerId,
      ...(status !== 'all' && { status })
    });

    res.json({
      success: true,
      data: {
        payments,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset)
        }
      }
    });

  } catch (error) {
    console.error('Get customer payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
});

/**
 * GET /payments/all
 * Get all payments (with optional filters)
 */
router.get('/all', auth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 50, 
      status = 'all',
      customerId,
      startDate,
      endDate
    } = req.query;

    // Query for customer payments - include payments where paymentType is 'customer' OR not set (legacy)
    const query = { 
      $or: [
        { paymentType: 'customer' },
        { paymentType: { $exists: false } }
      ]
    };

    if (status !== 'all') {
      query.status = status;
    }

    if (customerId) {
      query.customerId = customerId;
    }

    if (startDate || endDate) {
      query.paymentDate = {};
      if (startDate) query.paymentDate.$gte = new Date(startDate);
      if (endDate) query.paymentDate.$lte = new Date(endDate);
    }

    const payments = await Payment.find(query)
      .sort({ paymentDate: -1, createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .populate('customerId', 'name company email phone')
      .populate('createdBy', 'name')
      .lean();

    const total = await Payment.countDocuments(query);

    res.json({
      success: true,
      data: {
        payments,
        pagination: {
          currentPage: parseInt(page),
          totalPages: Math.ceil(total / parseInt(limit)),
          totalItems: total,
          itemsPerPage: parseInt(limit)
        }
      }
    });

  } catch (error) {
    console.error('Get all payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments'
    });
  }
});

/**
 * GET /payments/:paymentNumber
 * Get a specific payment by payment number
 */
router.get('/:paymentNumber', auth, async (req, res) => {
  try {
    const payment = await Payment.getByPaymentNumber(req.params.paymentNumber);

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    res.json({
      success: true,
      data: payment
    });

  } catch (error) {
    console.error('Get payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment'
    });
  }
});

// =====================================================
// REVERSE PAYMENT
// =====================================================

/**
 * POST /payments/:paymentNumber/reverse
 * Reverse (void) a payment
 * 
 * Body: {
 *   reason: string (required)
 * }
 */
router.post('/:paymentNumber/reverse', auth, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' }
  });

  try {
    const { paymentNumber } = req.params;
    const { reason } = req.body;

    if (!reason || reason.trim() === '') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Reversal reason is required'
      });
    }

    // Find the payment
    const payment = await Payment.findOne({ paymentNumber }).session(session);

    if (!payment) {
      await session.abortTransaction();
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    if (payment.status === 'reversed') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment has already been reversed'
      });
    }

    console.log("\n========== PAYMENT REVERSAL ==========");
    console.log(`Payment Number: ${paymentNumber}`);
    console.log(`Original Amount: £${payment.totalAmount.toFixed(2)}`);
    console.log(`Reason: ${reason}`);
    console.log("=======================================\n");

    const reversalLedgerEntries = [];

    // Reverse each distribution
    for (const dist of payment.distributions) {
      // Create reversal ledger entry (debit to reverse the credit)
      const reversalEntry = await Ledger.createEntry({
        type: 'buyer',
        entityId: payment.customerId,
        entityModel: 'Buyer',
        transactionType: 'adjustment',
        referenceId: dist.saleId,
        referenceModel: dist.saleId ? 'Sale' : undefined,
        debit: dist.amountApplied, // Debit to reverse the credit
        credit: 0,
        date: new Date(),
        description: `REVERSAL: ${paymentNumber} - ${reason}`,
        createdBy: req.user._id,
        paymentDetails: {
          cashPayment: 0,
          bankPayment: 0,
          remainingBalance: 0
        }
      }, session);

      reversalLedgerEntries.push(reversalEntry._id);

      // If this was applied to a sale, update the sale's payment tracking
      if (dist.saleId) {
        const sale = await Sale.findById(dist.saleId).session(session);
        if (sale) {
          // Reverse the payment amounts
          if (payment.paymentMethod === 'cash') {
            sale.cashPayment = Math.max(0, (sale.cashPayment || 0) - dist.amountApplied);
          } else {
            sale.bankPayment = Math.max(0, (sale.bankPayment || 0) - dist.amountApplied);
          }

          // Recalculate payment status
          const newTotalPaid = (sale.cashPayment || 0) + (sale.bankPayment || 0);
          if (newTotalPaid <= 0) {
            sale.paymentStatus = 'pending';
          } else if (newTotalPaid >= sale.grandTotal) {
            sale.paymentStatus = 'paid';
          } else {
            sale.paymentStatus = 'partial';
          }

          await sale.save({ session });
          console.log(`Reversed £${dist.amountApplied.toFixed(2)} from ${dist.saleNumber}`);
        }
      } else {
        console.log(`Reversed advance credit of £${dist.amountApplied.toFixed(2)}`);
      }
    }

    // Update payment status
    payment.status = 'reversed';
    payment.reversalInfo = {
      reversedAt: new Date(),
      reversedBy: req.user._id,
      reason,
      reversalLedgerEntries
    };

    await payment.save({ session });

    // Commit transaction
    await session.commitTransaction();

    console.log("\n========== REVERSAL COMPLETE ==========");
    console.log(`Payment ${paymentNumber} has been reversed`);
    console.log(`${reversalLedgerEntries.length} ledger entries created for reversal`);
    console.log("========================================\n");

    // Get updated payment
    const updatedPayment = await Payment.findById(payment._id)
      .populate('customerId', 'name company email phone')
      .populate('createdBy', 'name')
      .populate('reversalInfo.reversedBy', 'name')
      .lean();

    res.json({
      success: true,
      message: `Payment ${paymentNumber} has been reversed`,
      data: updatedPayment
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Reverse payment error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to reverse payment',
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    });
  } finally {
    session.endSession();
  }
});

// =====================================================
// RECEIPT GENERATION
// =====================================================

/**
 * GET /payments/:paymentNumber/receipt
 * Get payment receipt data (for PDF generation)
 */
router.get('/:paymentNumber/receipt', auth, async (req, res) => {
  try {
    const payment = await Payment.findOne({ paymentNumber: req.params.paymentNumber })
      .populate('customerId', 'name company email phone address')
      .populate('createdBy', 'name')
      .lean();

    if (!payment) {
      return res.status(404).json({
        success: false,
        message: 'Payment not found'
      });
    }

    // Format receipt data
    const receiptData = {
      receiptNumber: payment.paymentNumber,
      date: payment.createdAt || payment.paymentDate,
      customer: {
        name: payment.customerId?.name || 'Unknown',
        company: payment.customerId?.company || '',
        email: payment.customerId?.email || '',
        phone: payment.customerId?.phone || '',
        address: payment.customerId?.address || ''
      },
      payment: {
        totalAmount: payment.totalAmount,
        paymentMethod: payment.paymentMethod,
        cashAmount: payment.cashAmount,
        bankAmount: payment.bankAmount,
        paymentDirection: payment.paymentDirection || 'credit',
        debitReason: payment.debitReason || null
      },
      distributions: payment.distributions.map(d => ({
        reference: d.saleNumber,
        amount: d.amountApplied,
        isAdvance: d.isAdvance
      })),
      balances: {
        before: payment.balanceBefore,
        after: payment.balanceAfter
      },
      status: payment.status,
      createdBy: payment.createdBy?.name || 'System',
      notes: payment.description || ''
    };

    // If reversed, include reversal info
    if (payment.status === 'reversed' && payment.reversalInfo) {
      receiptData.reversal = {
        reversedAt: payment.reversalInfo.reversedAt,
        reason: payment.reversalInfo.reason
      };
    }

    res.json({
      success: true,
      data: receiptData
    });

  } catch (error) {
    console.error('Get receipt error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate receipt data'
    });
  }
});

module.exports = router;
