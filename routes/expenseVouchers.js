const express = require('express');
const Joi = require('joi');
const ExpenseVoucher = require('../models/ExpenseVoucher');
const auth = require('../middleware/auth');

const router = express.Router();

const expenseVoucherSchema = Joi.object({
  date: Joi.date().default(Date.now),
  name: Joi.string().min(2).max(200).required(),
  amount: Joi.number().min(0).required(),
  paymentMethod: Joi.string().valid('cash', 'card', 'bank_transfer', 'cheque', 'online').required(),
  remarks: Joi.string().optional(),
  category: Joi.string().optional(),
  attachments: Joi.array().items(Joi.string()).optional()
});

const generateVoucherNumber = async () => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');

  const prefix = `EV${year}${month}`;
  const lastVoucher = await ExpenseVoucher.findOne({
    voucherNumber: { $regex: `^${prefix}` }
  }).sort({ voucherNumber: -1 });

  let nextNumber = 1;
  if (lastVoucher) {
    const lastNumber = parseInt(lastVoucher.voucherNumber.slice(-4));
    nextNumber = lastNumber + 1;
  }

  return `${prefix}${String(nextNumber).padStart(4, '0')}`;
};

router.post('/', auth, async (req, res) => {
  try {
    const { error } = expenseVoucherSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const voucherNumber = await generateVoucherNumber();

    const voucher = new ExpenseVoucher({
      ...req.body,
      voucherNumber,
      createdBy: req.user._id
    });

    await voucher.save();

    const populatedVoucher = await ExpenseVoucher.findById(voucher._id)
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    res.status(201).json({
      success: true,
      message: 'Expense voucher created successfully',
      data: populatedVoucher
    });
  } catch (error) {
    console.error('Create expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      paymentMethod,
      status,
      startDate,
      endDate
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { voucherNumber: { $regex: search, $options: 'i' } },
        { remarks: { $regex: search, $options: 'i' } }
      ];
    }

    if (paymentMethod) query.paymentMethod = paymentMethod;
    if (status) query.status = status;

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const vouchers = await ExpenseVoucher.find(query)
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name')
      .sort({ date: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await ExpenseVoucher.countDocuments(query);
    const totalAmount = await ExpenseVoucher.aggregate([
      { $match: query },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      success: true,
      data: vouchers,
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
    console.error('Get expense vouchers error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const voucher = await ExpenseVoucher.findById(req.params.id)
      .populate('createdBy', 'name email')
      .populate('approvedBy', 'name email');

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Expense voucher not found'
      });
    }

    res.json({
      success: true,
      data: voucher
    });
  } catch (error) {
    console.error('Get expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const { error } = expenseVoucherSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    const voucher = await ExpenseVoucher.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Expense voucher not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense voucher updated successfully',
      data: voucher
    });
  } catch (error) {
    console.error('Update expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.patch('/:id/approve', auth, async (req, res) => {
  try {
    const voucher = await ExpenseVoucher.findByIdAndUpdate(
      req.params.id,
      {
        status: 'approved',
        approvedBy: req.user._id
      },
      { new: true }
    )
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Expense voucher not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense voucher approved successfully',
      data: voucher
    });
  } catch (error) {
    console.error('Approve expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.patch('/:id/reject', auth, async (req, res) => {
  try {
    const voucher = await ExpenseVoucher.findByIdAndUpdate(
      req.params.id,
      {
        status: 'rejected',
        approvedBy: req.user._id
      },
      { new: true }
    )
      .populate('createdBy', 'name')
      .populate('approvedBy', 'name');

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Expense voucher not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense voucher rejected successfully',
      data: voucher
    });
  } catch (error) {
    console.error('Reject expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const voucher = await ExpenseVoucher.findByIdAndDelete(req.params.id);

    if (!voucher) {
      return res.status(404).json({
        success: false,
        message: 'Expense voucher not found'
      });
    }

    res.json({
      success: true,
      message: 'Expense voucher deleted successfully'
    });
  } catch (error) {
    console.error('Delete expense voucher error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;