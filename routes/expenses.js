const express = require('express');
const Joi = require('joi');
const Expense = require('../models/Expense');
const CostType = require('../models/CostType');
const auth = require('../middleware/auth');

const router = express.Router();

const expenseSchema = Joi.object({
  description: Joi.string().min(5).max(200).required(),
  costType: Joi.string().required(),
  dispatchOrder: Joi.string().allow(null, '').optional(),
  amount: Joi.number().min(0).optional(),
  cashAmount: Joi.number().min(0).optional(),
  bankAmount: Joi.number().min(0).optional(),
  paymentMethod: Joi.string().valid('cash', 'card', 'bank_transfer', 'cheque', 'online', 'split').required(),
  expenseDate: Joi.date().default(Date.now),
  vendor: Joi.string().optional(),
  invoiceNumber: Joi.string().optional(),
  receiptNumber: Joi.string().optional(),
  taxAmount: Joi.number().min(0).default(0),
  isRecurring: Joi.boolean().default(false),
  recurringFrequency: Joi.string().valid('daily', 'weekly', 'monthly', 'quarterly', 'yearly').optional(),
  nextRecurringDate: Joi.date().optional(),
  attachments: Joi.array().items(Joi.string()).optional(),
  notes: Joi.string().optional()
});

// Generate expense number
const generateExpenseNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const prefix = `EXP${year}${month}`;
  const lastExpense = await Expense.findOne({
    expenseNumber: { $regex: `^${prefix}` }
  }).sort({ expenseNumber: -1 });

  let nextNumber = 1;
  if (lastExpense) {
    const lastNumber = parseInt(lastExpense.expenseNumber.slice(-4));
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, '0')}`;
};

// Create expense
router.post('/', auth, async (req, res) => {
  try {
    const { error } = expenseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Verify cost type exists
    const costType = await CostType.findById(req.body.costType);
    if (!costType) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cost type'
      });
    }

    const expenseNumber = await generateExpenseNumber();

    const amount = Number(req.body.amount || 0);
    const paymentMethod = req.body.paymentMethod;
    const cashAmount = paymentMethod === 'cash' ? amount : 0;
    const bankAmount = (paymentMethod !== 'cash' && paymentMethod !== 'split') ? amount : 0;

    let status = 'pending';
    let approvedBy = undefined;

    if (req.user.role === 'super_admin') {
      status = 'approved';
      approvedBy = req.user._id;
    }

    const expense = new Expense({
      ...req.body,
      amount,
      cashAmount,
      bankAmount,
      status,
      approvedBy,
      expenseNumber,
      createdBy: req.user._id
    });

    await expense.save();

    const populatedExpense = await Expense.findById(expense._id)
      .populate('costType', 'id name category')
      .populate({
        path: 'dispatchOrder',
        select: 'orderNumber supplier',
        populate: {
          path: 'supplier',
          select: 'name company'
        }
      })
      .populate('createdBy', 'name');

    res.status(201).json({
      success: true,
      message: 'Expense created successfully',
      data: populatedExpense
    });

  } catch (error) {
    console.error('Create expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all expenses
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      costType,
      paymentMethod,
      status,
      startDate,
      endDate
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { description: { $regex: search, $options: 'i' } },
        { expenseNumber: { $regex: search, $options: 'i' } },
        { vendor: { $regex: search, $options: 'i' } },
        { invoiceNumber: { $regex: search, $options: 'i' } }
      ];
    }

    if (costType) query.costType = costType;
    if (paymentMethod) query.paymentMethod = paymentMethod;
    if (status) query.status = status;

    if (startDate || endDate) {
      query.expenseDate = {};
      if (startDate) query.expenseDate.$gte = new Date(startDate);
      if (endDate) query.expenseDate.$lte = new Date(endDate);
    }

    const expenses = await Expense.find(query)
      .populate('costType', 'id name category')
      .populate({
        path: 'dispatchOrder',
        select: 'orderNumber supplier',
        populate: {
          path: 'supplier',
          select: 'name company'
        }
      })
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ expenseDate: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Expense.countDocuments(query);
    const totalAmount = await Expense.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: { $add: ['$amount', '$taxAmount'] } } } }
    ]);

    res.json({
      success: true,
      data: expenses,
      summary: {
        totalAmount: totalAmount[0]?.total || 0
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get expenses error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get expense by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const expense = await Expense.findById(req.params.id)
      .populate('costType', 'id name category description')
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email');

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    res.json({
      success: true,
      data: expense
    });

  } catch (error) {
    console.error('Get expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update expense
router.put('/:id', auth, async (req, res) => {
  try {
    const { error } = expenseSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Verify cost type exists if being updated
    if (req.body.costType) {
      const costType = await CostType.findById(req.body.costType);
      if (!costType) {
        return res.status(400).json({
          success: false,
          message: 'Invalid cost type'
        });
      }
    }

    const updateData = { ...req.body };

    if (req.body.amount !== undefined && req.body.paymentMethod !== undefined) {
      const amount = Number(req.body.amount);
      const paymentMethod = req.body.paymentMethod;
      updateData.cashAmount = paymentMethod === 'cash' ? amount : 0;
      updateData.bankAmount = (paymentMethod !== 'cash' && paymentMethod !== 'split') ? amount : 0;
      updateData.amount = amount;
    }

    const expense = await Expense.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('costType', 'id name category')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense updated successfully',
      data: expense
    });

  } catch (error) {
    console.error('Update expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Approve expense
router.patch('/:id/approve', auth, async (req, res) => {
  try {
    const expense = await Expense.findByIdAndUpdate(
      req.params.id,
      {
        status: 'approved',
        approvedBy: req.user._id
      },
      { new: true }
    )
      .populate('costType', 'id name category')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense approved successfully',
      data: expense
    });

  } catch (error) {
    console.error('Approve expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Reject expense
router.patch('/:id/reject', auth, async (req, res) => {
  try {
    const expense = await Expense.findByIdAndUpdate(
      req.params.id,
      {
        status: 'rejected',
        approvedBy: req.user._id
      },
      { new: true }
    )
      .populate('costType', 'id name category')
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense rejected successfully',
      data: expense
    });

  } catch (error) {
    console.error('Reject expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete expense
router.delete('/:id', auth, async (req, res) => {
  try {
    const expense = await Expense.findByIdAndDelete(req.params.id);

    if (!expense) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense deleted successfully'
    });

  } catch (error) {
    console.error('Delete expense error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get expense summary by cost type
router.get('/reports/summary', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const matchConditions = { status: 'approved' };

    if (startDate || endDate) {
      matchConditions.expenseDate = {};
      if (startDate) matchConditions.expenseDate.$gte = new Date(startDate);
      if (endDate) matchConditions.expenseDate.$lte = new Date(endDate);
    }

    const summary = await Expense.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: 'costtypes',
          localField: 'costType',
          foreignField: '_id',
          as: 'costTypeInfo'
        }
      },
      { $unwind: '$costTypeInfo' },
      {
        $group: {
          _id: {
            costTypeId: '$costTypeInfo.id',
            costTypeName: '$costTypeInfo.name',
            category: '$costTypeInfo.category'
          },
          totalAmount: { $sum: { $add: ['$amount', '$taxAmount'] } },
          count: { $sum: 1 },
          avgAmount: { $avg: { $add: ['$amount', '$taxAmount'] } }
        }
      },
      {
        $sort: { totalAmount: -1 }
      }
    ]);

    res.json({
      success: true,
      data: summary
    });

  } catch (error) {
    console.error('Get expense summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;