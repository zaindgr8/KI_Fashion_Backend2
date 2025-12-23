const express = require('express');
const Ledger = require('../models/Ledger');
const Expense = require('../models/Expense');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/cash-tracking/daily/:date
 * Get cash summary for a specific date
 * Date format: YYYY-MM-DD
 */
router.get('/daily/:date', auth, async (req, res) => {
  try {
    const { date } = req.params;
    const targetDate = new Date(date);
    targetDate.setHours(0, 0, 0, 0);
    const nextDate = new Date(targetDate);
    nextDate.setDate(nextDate.getDate() + 1);

    // Get previous day's closing balance (opening balance for today)
    // For the first day, opening balance is 0
    let openingBalance = 0;
    try {
      const previousDay = new Date(targetDate);
      previousDay.setDate(previousDay.getDate() - 1);
      const previousDayEnd = new Date(previousDay);
      previousDayEnd.setHours(23, 59, 59, 999);

      const previousDaySummary = await getDailyCashSummary(previousDay, previousDayEnd);
      // Calculate closing balance from previous day
      const prevOpening = 0; // Start from 0 for first day calculation
      openingBalance = prevOpening + previousDaySummary.cashIn - previousDaySummary.cashOut;
    } catch (error) {
      // If no previous day data, opening balance is 0
      openingBalance = 0;
    }

    // Get today's transactions
    const summary = await getDailyCashSummary(targetDate, nextDate);

    // Get detailed transactions
    const transactions = await getDailyCashTransactions(targetDate, nextDate);

    res.json({
      success: true,
      data: {
        date: date,
        openingBalance,
        cashIn: summary.cashIn,
        cashOut: summary.cashOut,
        closingBalance: openingBalance + summary.cashIn - summary.cashOut,
        transactions
      }
    });
  } catch (error) {
    console.error('Get daily cash summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * GET /api/cash-tracking/range
 * Get cash summary for date range
 * Query params: startDate, endDate (YYYY-MM-DD)
 */
router.get('/range', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: 'startDate and endDate are required (YYYY-MM-DD format)'
      });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // Get opening balance (closing balance of day before startDate)
    const dayBeforeStart = new Date(start);
    dayBeforeStart.setDate(dayBeforeStart.getDate() - 1);
    const dayBeforeEnd = new Date(dayBeforeStart);
    dayBeforeEnd.setHours(23, 59, 59, 999);

    const previousSummary = await getDailyCashSummary(dayBeforeStart, dayBeforeEnd);
    const openingBalance = previousSummary.closingBalance;

    // Get range summary
    const summary = await getDailyCashSummary(start, end);

    // Get daily breakdown
    const dailyBreakdown = await getDailyBreakdown(start, end);

    res.json({
      success: true,
      data: {
        startDate,
        endDate,
        openingBalance,
        cashIn: summary.cashIn,
        cashOut: summary.cashOut,
        closingBalance: openingBalance + summary.cashIn - summary.cashOut,
        dailyBreakdown
      }
    });
  } catch (error) {
    console.error('Get cash range summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

/**
 * Helper function to calculate daily cash summary
 */
async function getDailyCashSummary(startDate, endDate) {
  // Get cash transactions from Ledger
  const cashInEntries = await Ledger.find({
    paymentMethod: 'cash',
    transactionType: { $in: ['receipt', 'sale'] },
    date: { $gte: startDate, $lt: endDate }
  });

  const cashOutEntries = await Ledger.find({
    paymentMethod: 'cash',
    transactionType: { $in: ['payment', 'purchase'] },
    date: { $gte: startDate, $lt: endDate }
  });

  // Get cash expenses
  const cashExpenses = await Expense.find({
    paymentMethod: 'cash',
    expenseDate: { $gte: startDate, $lt: endDate },
    status: { $in: ['approved', 'paid'] }
  });

  const cashIn = cashInEntries.reduce((sum, entry) => sum + (entry.credit || 0), 0);
  const cashOut = cashOutEntries.reduce((sum, entry) => sum + (entry.debit || 0), 0) +
    cashExpenses.reduce((sum, expense) => sum + (expense.amount || 0) + (expense.taxAmount || 0), 0);

  // Calculate closing balance (will be added to opening balance by caller)
  const closingBalance = cashIn - cashOut;

  return {
    cashIn,
    cashOut,
    closingBalance
  };
}

/**
 * Helper function to get detailed transactions for a day
 */
async function getDailyCashTransactions(startDate, endDate) {
  const transactions = [];

  // Get ledger transactions
  const ledgerEntries = await Ledger.find({
    paymentMethod: 'cash',
    date: { $gte: startDate, $lt: endDate }
  })
    .populate('entityId', 'name company')
    .sort({ date: 1, createdAt: 1 });

  for (const entry of ledgerEntries) {
    const entityName = entry.entityId?.name || entry.entityId?.company || 'Unknown';
    
    if (entry.transactionType === 'receipt' || entry.transactionType === 'sale') {
      transactions.push({
        type: 'cash_in',
        category: entry.transactionType === 'receipt' ? 'Payment Received' : 'Sale',
        amount: entry.credit || 0,
        description: entry.description || `${entry.transactionType} from ${entityName}`,
        date: entry.date,
        reference: entry.referenceId,
        referenceModel: entry.referenceModel
      });
    } else if (entry.transactionType === 'payment' || entry.transactionType === 'purchase') {
      transactions.push({
        type: 'cash_out',
        category: entry.transactionType === 'payment' ? 'Payment Made' : 'Purchase',
        amount: entry.debit || 0,
        description: entry.description || `${entry.transactionType} to ${entityName}`,
        date: entry.date,
        reference: entry.referenceId,
        referenceModel: entry.referenceModel
      });
    }
  }

  // Get expense transactions
  const expenses = await Expense.find({
    paymentMethod: 'cash',
    expenseDate: { $gte: startDate, $lt: endDate },
    status: { $in: ['approved', 'paid'] }
  })
    .populate('costType', 'name category')
    .sort({ expenseDate: 1, createdAt: 1 });

  for (const expense of expenses) {
    transactions.push({
      type: 'cash_out',
      category: 'Expense',
      amount: (expense.amount || 0) + (expense.taxAmount || 0),
      description: expense.description || `Expense: ${expense.costType?.name || 'General'}`,
      date: expense.expenseDate,
      reference: expense._id,
      referenceModel: 'Expense',
      vendor: expense.vendor,
      expenseNumber: expense.expenseNumber
    });
  }

  // Sort all transactions by date
  transactions.sort((a, b) => new Date(a.date) - new Date(b.date));

  return transactions;
}

/**
 * Helper function to get daily breakdown for date range
 */
async function getDailyBreakdown(startDate, endDate) {
  const dailyData = [];
  const currentDate = new Date(startDate);

  while (currentDate < endDate) {
    const dayStart = new Date(currentDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(currentDate);
    dayEnd.setHours(23, 59, 59, 999);

    const summary = await getDailyCashSummary(dayStart, dayEnd);

    // Get previous day's closing for opening balance
    const prevDay = new Date(currentDate);
    prevDay.setDate(prevDay.getDate() - 1);
    const prevDayEnd = new Date(prevDay);
    prevDayEnd.setHours(23, 59, 59, 999);
    const prevSummary = await getDailyCashSummary(prevDay, prevDayEnd);
    const openingBalance = prevSummary.closingBalance;

    dailyData.push({
      date: currentDate.toISOString().split('T')[0],
      openingBalance,
      cashIn: summary.cashIn,
      cashOut: summary.cashOut,
      closingBalance: openingBalance + summary.cashIn - summary.cashOut
    });

    currentDate.setDate(currentDate.getDate() + 1);
  }

  return dailyData;
}

module.exports = router;

