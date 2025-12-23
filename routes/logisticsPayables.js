const express = require('express');
const Joi = require('joi');
const mongoose = require('mongoose');
const LogisticsCompany = require('../models/LogisticsCompany');
const DispatchOrder = require('../models/DispatchOrder');
const Ledger = require('../models/Ledger');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

// Validation schema for payment creation
const paymentSchema = Joi.object({
  logisticsCompanyId: Joi.string().required(),
  amount: Joi.number().min(0.01).required(),
  date: Joi.date().required(),
  method: Joi.string().valid('cash', 'bank').required(),
  description: Joi.string().optional().allow(''),
  boxRate: Joi.number().min(0).required(),
  numberOfBoxes: Joi.number().min(0).optional(),
  orderIds: Joi.array().items(Joi.string()).optional()
});

// Validation schema for box rate update
const boxRateSchema = Joi.object({
  boxRate: Joi.number().min(0).required()
});

// Helper function to calculate payments for a logistics company
async function calculateLogisticsPayments(logisticsCompanyId) {
  const paymentEntries = await Ledger.find({
    type: 'logistics',
    entityId: logisticsCompanyId,
    transactionType: 'payment'
  });
  
  const totalPaid = paymentEntries.reduce((sum, entry) => {
    return sum + (entry.credit || 0);
  }, 0);
  
  return { totalPaid, paymentCount: paymentEntries.length };
}

// Helper function to get last payment date
async function getLastPaymentDate(logisticsCompanyId) {
  const lastPayment = await Ledger.findOne({
    type: 'logistics',
    entityId: logisticsCompanyId,
    transactionType: 'payment'
  }).sort({ date: -1 });
  
  return lastPayment ? lastPayment.date : null;
}

// Helper function to determine payment status
function determinePaymentStatus(totalAmount, totalPaid) {
  if (totalPaid >= totalAmount) return 'paid';
  if (totalPaid > 0) return 'partial';
  return 'pending';
}

/**
 * GET /api/logistics-payables
 * Fetch all logistics payables with optional filters
 */
router.get('/', auth, async (req, res) => {
  try {
    const { companyId, paymentStatus, dateFrom, dateTo, limit = 1000 } = req.query;

    // Build query for dispatch orders
    const orderQuery = { status: 'confirmed' };
    
    // Filter by date range if provided
    if (dateFrom || dateTo) {
      orderQuery.dispatchDate = {};
      if (dateFrom) orderQuery.dispatchDate.$gte = new Date(dateFrom);
      if (dateTo) orderQuery.dispatchDate.$lte = new Date(dateTo);
    }

    // Fetch all confirmed dispatch orders with logistics companies
    const orders = await DispatchOrder.find(orderQuery)
      .populate('logisticsCompany', 'name code contactInfo rates')
      .populate('supplier', 'name company')
      .select('logisticsCompany totalBoxes dispatchDate createdAt');

    // Group by logistics company
    const companiesMap = new Map();

    for (const order of orders) {
      if (!order.logisticsCompany) continue;

      const companyId = order.logisticsCompany._id.toString();
      
      // Filter by specific company if requested
      if (req.query.companyId && companyId !== req.query.companyId) continue;

      if (!companiesMap.has(companyId)) {
        companiesMap.set(companyId, {
          id: companyId,
          companyName: order.logisticsCompany.name,
          boxRate: order.logisticsCompany.rates?.boxRate || 0,
          totalBoxes: 0,
          orderCount: 0,
          company: order.logisticsCompany
        });
      }

      const companyData = companiesMap.get(companyId);
      companyData.totalBoxes += order.totalBoxes || 0;
      companyData.orderCount += 1;
    }

    // Calculate payments and outstanding for each company
    const payables = [];
    for (const [companyId, data] of companiesMap) {
      const { totalPaid } = await calculateLogisticsPayments(companyId);
      const totalAmount = data.totalBoxes * data.boxRate;
      const outstandingBalance = Math.max(0, totalAmount - totalPaid);
      const status = determinePaymentStatus(totalAmount, totalPaid);

      // Filter by payment status if requested
      if (paymentStatus && paymentStatus !== 'all' && status !== paymentStatus) {
        continue;
      }

      const lastPaymentDate = await getLastPaymentDate(companyId);

      payables.push({
        id: companyId,
        companyName: data.companyName,
        name: data.companyName,
        totalBoxes: data.totalBoxes,
        boxRate: data.boxRate,
        totalAmount,
        totalPaid,
        outstandingBalance,
        paymentStatus: status,
        lastPaymentDate,
        orderCount: data.orderCount
      });
    }

    // Sort by outstanding balance (highest first)
    payables.sort((a, b) => b.outstandingBalance - a.outstandingBalance);

    res.json({
      success: true,
      data: payables.slice(0, parseInt(limit))
    });

  } catch (error) {
    console.error('Error fetching logistics payables:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch logistics payables'
    });
  }
});

/**
 * GET /api/logistics-payables/summary
 * Get summary statistics for all logistics payables
 */
router.get('/summary', auth, async (req, res) => {
  try {
    // Get all confirmed dispatch orders with logistics companies
    const orders = await DispatchOrder.find({ status: 'confirmed' })
      .populate('logisticsCompany', 'rates');

    // Group by logistics company to get unique companies
    const uniqueCompanies = new Set();
    let totalBoxes = 0;
    let totalAmount = 0;

    for (const order of orders) {
      if (!order.logisticsCompany) continue;

      const companyId = order.logisticsCompany._id.toString();
      uniqueCompanies.add(companyId);

      const boxes = order.totalBoxes || 0;
      const rate = order.logisticsCompany.rates?.boxRate || 0;
      
      totalBoxes += boxes;
      totalAmount += boxes * rate;
    }

    // Calculate total paid across all logistics companies
    const allPayments = await Ledger.find({
      type: 'logistics',
      transactionType: 'payment'
    });

    const totalPaid = allPayments.reduce((sum, entry) => sum + (entry.credit || 0), 0);
    const totalOutstanding = Math.max(0, totalAmount - totalPaid);

    res.json({
      success: true,
      data: {
        totalCompanies: uniqueCompanies.size,
        totalBoxes,
        totalAmount,
        totalPaid,
        totalOutstanding
      }
    });

  } catch (error) {
    console.error('Error fetching logistics payables summary:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch summary'
    });
  }
});

/**
 * GET /api/logistics-payables/company/:companyId
 * Get detailed payable info for a specific logistics company
 */
router.get('/company/:companyId', auth, async (req, res) => {
  try {
    const { companyId } = req.params;

    console.log('GET /company/:companyId - Fetching details for company:', companyId);

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company ID'
      });
    }

    // Fetch company details
    const company = await LogisticsCompany.findById(companyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Logistics company not found'
      });
    }

    console.log('Company found:', company.name, 'Box rate:', company.rates?.boxRate);

    // Get all orders for this company
    const orders = await DispatchOrder.find({
      logisticsCompany: companyId,
      status: 'confirmed'
    }).select('totalBoxes orderNumber');

    console.log('Found orders for this company:', orders.length);
    console.log('Orders:', orders.map(o => ({ orderNumber: o.orderNumber, totalBoxes: o.totalBoxes })));

    // Calculate totals
    const totalBoxes = orders.reduce((sum, order) => sum + (order.totalBoxes || 0), 0);
    const boxRate = company.rates?.boxRate || 0;
    const totalAmount = totalBoxes * boxRate;

    console.log('Calculation: totalBoxes =', totalBoxes, '× boxRate =', boxRate, '= totalAmount =', totalAmount);

    // Get payments
    const { totalPaid } = await calculateLogisticsPayments(companyId);
    console.log('Total paid:', totalPaid);
    
    const outstandingBalance = Math.max(0, totalAmount - totalPaid);
    console.log('Outstanding balance:', outstandingBalance);

    res.json({
      success: true,
      data: {
        id: company._id,
        name: company.name,
        code: company.code,
        contact: company.contactInfo?.phone 
          ? `${company.contactInfo.phoneAreaCode || ''}${company.contactInfo.phone}`
          : null,
        email: company.contactInfo?.email,
        boxRate,
        totalBoxes,
        totalAmount,
        totalPaid,
        outstandingBalance,
        orderCount: orders.length
      }
    });

  } catch (error) {
    console.error('Error fetching company details:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch company details'
    });
  }
});

/**
 * GET /api/logistics-payables/company/:companyId/orders
 * Get orders for a specific logistics company with box counts
 */
router.get('/company/:companyId/orders', auth, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { dateFrom, dateTo, paymentStatus, limit = 100 } = req.query;

    console.log('GET /company/:companyId/orders - Received companyId:', companyId);
    console.log('Query params:', { dateFrom, dateTo, paymentStatus, limit });

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      console.log('Invalid company ID format:', companyId);
      return res.status(400).json({
        success: false,
        message: 'Invalid company ID'
      });
    }

    // Get company to fetch box rate
    const company = await LogisticsCompany.findById(companyId);
    console.log('Found company:', company ? company.name : 'NOT FOUND');
    
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Logistics company not found'
      });
    }

    const boxRate = company.rates?.boxRate || 0;

    // Build query
    const query = {
      logisticsCompany: companyId,
      status: 'confirmed'
    };
    
    console.log('Querying DispatchOrders with:', query);

    // Filter by date range
    if (dateFrom || dateTo) {
      query.dispatchDate = {};
      if (dateFrom) query.dispatchDate.$gte = new Date(dateFrom);
      if (dateTo) query.dispatchDate.$lte = new Date(dateTo);
    }

    // Fetch orders
    const orders = await DispatchOrder.find(query)
      .populate('supplier', 'name company')
      .select('orderNumber dispatchDate totalBoxes supplier createdAt logisticsCompany')
      .sort({ dispatchDate: -1 })
      .limit(parseInt(limit));

    console.log('Found orders count:', orders.length);
    console.log('Order details:', orders.map(o => ({ 
      orderNumber: o.orderNumber, 
      logisticsCompany: o.logisticsCompany?.toString(), 
      totalBoxes: o.totalBoxes 
    })));

    // Format orders with payment information
    const ordersWithPayments = orders.map(order => {
      const totalBoxes = order.totalBoxes || 0;
      const amount = totalBoxes * boxRate;

      // For now, set paidAmount to 0 (would need order-specific payment tracking)
      const paidAmount = 0;
      const status = paidAmount >= amount ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');

      return {
        id: order._id,
        orderNumber: order.orderNumber,
        dispatchDate: order.dispatchDate || order.createdAt,
        supplierName: order.supplier?.name || order.supplier?.company || 'N/A',
        totalBoxes,
        boxRate,
        amount,
        paidAmount,
        paymentStatus: status
      };
    });

    // Filter by payment status if requested
    const filteredOrders = paymentStatus && paymentStatus !== 'all'
      ? ordersWithPayments.filter(o => o.paymentStatus === paymentStatus)
      : ordersWithPayments;

    res.json({
      success: true,
      data: {
        orders: filteredOrders
      }
    });

  } catch (error) {
    console.error('Error fetching company orders:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch orders'
    });
  }
});

/**
 * GET /api/logistics-payables/company/:companyId/payments
 * Get payment history for a logistics company
 */
router.get('/company/:companyId/payments', auth, async (req, res) => {
  try {
    const { companyId } = req.params;
    const { limit = 100 } = req.query;

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company ID'
      });
    }

    // Fetch payment entries
    const payments = await Ledger.find({
      type: 'logistics',
      entityId: companyId,
      transactionType: 'payment'
    })
    .sort({ date: -1 })
    .limit(parseInt(limit));

    // Format payments
    const formattedPayments = payments.map(payment => ({
      id: payment._id,
      date: payment.date,
      amount: payment.credit || 0,
      method: payment.paymentMethod,
      description: payment.description,
      numberOfBoxes: payment.remarks ? parseFloat(payment.remarks) : 0,
      balance: payment.balance
    }));

    res.json({
      success: true,
      data: {
        payments: formattedPayments
      }
    });

  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to fetch payment history'
    });
  }
});

/**
 * POST /api/logistics-payables/payment
 * Create a payment for a logistics company
 */
router.post('/payment', auth, async (req, res) => {
  try {
    // Validate request body
    const { error, value } = paymentSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const {
      logisticsCompanyId,
      amount,
      date,
      method,
      description,
      boxRate,
      numberOfBoxes
    } = value;

    // Validate company exists
    const company = await LogisticsCompany.findById(logisticsCompanyId);
    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Logistics company not found'
      });
    }

    // Calculate boxes if not provided
    const boxes = numberOfBoxes || (boxRate > 0 ? amount / boxRate : 0);

    // Create ledger entry
    const ledgerEntry = await Ledger.createEntry({
      type: 'logistics',
      entityId: logisticsCompanyId,
      entityModel: 'LogisticsCompany',
      transactionType: 'payment',
      debit: 0,
      credit: amount,
      date: new Date(date),
      description: description || `Payment for logistics services - ${company.name}`,
      paymentMethod: method,
      paymentDetails: {
        cashPayment: method === 'cash' ? amount : 0,
        bankPayment: method === 'bank' ? amount : 0,
        remainingBalance: 0
      },
      remarks: boxes.toString(), // Store number of boxes in remarks
      createdBy: req.user._id
    });

    res.json({
      success: true,
      data: {
        payment: {
          id: ledgerEntry._id,
          date: ledgerEntry.date,
          amount: ledgerEntry.credit,
          method: ledgerEntry.paymentMethod,
          description: ledgerEntry.description,
          numberOfBoxes: boxes,
          balance: ledgerEntry.balance
        }
      },
      message: 'Payment recorded successfully'
    });

  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to create payment'
    });
  }
});

/**
 * PUT /api/logistics-payables/company/:companyId/rate
 * Update box rate for a logistics company
 */
router.put('/company/:companyId/rate', auth, async (req, res) => {
  try {
    const { companyId } = req.params;

    // Validate company ID
    if (!mongoose.Types.ObjectId.isValid(companyId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid company ID'
      });
    }

    // Validate request body
    const { error, value } = boxRateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const { boxRate } = value;

    // Update company
    const company = await LogisticsCompany.findByIdAndUpdate(
      companyId,
      { 'rates.boxRate': boxRate },
      { new: true, runValidators: true }
    );

    if (!company) {
      return res.status(404).json({
        success: false,
        message: 'Logistics company not found'
      });
    }

    res.json({
      success: true,
      data: {
        id: company._id,
        name: company.name,
        boxRate: company.rates.boxRate
      },
      message: 'Box rate updated successfully'
    });

  } catch (error) {
    console.error('Error updating box rate:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to update box rate'
    });
  }
});

module.exports = router;

