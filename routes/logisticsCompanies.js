const express = require('express');
const Joi = require('joi');
const LogisticsCompany = require('../models/LogisticsCompany');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

const logisticsCompanySchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  contactInfo: Joi.object({
    phone: Joi.string().optional(),
    phoneAreaCode: Joi.string().max(5).optional(),
    email: Joi.string().email().optional(),
    address: Joi.object({
      street: Joi.string().optional(),
      city: Joi.string().optional(),
      state: Joi.string().optional(),
      zipCode: Joi.string().optional(),
      country: Joi.string().default('Pakistan')
    }).optional()
  }).optional(),
  serviceAreas: Joi.array().items(Joi.object({
    city: Joi.string().required(),
    state: Joi.string().optional(),
    deliveryDays: Joi.number().min(1).max(30).default(3)
  })).optional(),
  rates: Joi.object({
    perKg: Joi.number().min(0).default(0),
    baseRate: Joi.number().min(0).default(0),
    expressRate: Joi.number().min(0).default(0),
    boxRate: Joi.number().min(0).required(), // Required box rate field for payment calculations
    currency: Joi.string().default('PKR')
  }).optional(),
  rating: Joi.number().min(1).max(5).default(3),
  notes: Joi.string().optional()
});

// Create logistics company (Admin only)
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Only admins can create logistics companies', 403);
    }

    const { error } = logisticsCompanySchema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    const logisticsCompany = new LogisticsCompany({
      ...req.body,
      createdBy: req.user._id
    });

    await logisticsCompany.save();

    return sendResponse.success(res, logisticsCompany, 'Logistics company created successfully', 201);

  } catch (error) {
    console.error('Create logistics company error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get all active logistics companies
router.get('/', auth, async (req, res) => {
  try {
    const { page = 1, limit = 50, search, isActive } = req.query;

    const query = {};
    
    // Only filter by isActive if explicitly provided
    // This allows fetching all companies when isActive is not specified
    if (isActive === 'true') {
      query.isActive = true;
    } else if (isActive === 'false') {
      query.isActive = false;
    }
    // If isActive is undefined or 'all', don't add the filter (fetch all)

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { code: { $regex: search, $options: 'i' } }
      ];
    }

    const companies = await LogisticsCompany.find(query)
      .populate('createdBy', 'name')
      .sort({ rating: -1, name: 1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await LogisticsCompany.countDocuments(query);

    return sendResponse.paginated(res, companies, {
      currentPage: parseInt(page),
      totalPages: Math.ceil(total / limit),
      totalItems: total,
      itemsPerPage: parseInt(limit)
    });

  } catch (error) {
    console.error('Get logistics companies error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get logistics company by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const company = await LogisticsCompany.findById(req.params.id)
      .populate('createdBy', 'name');

    if (!company) {
      return sendResponse.error(res, 'Logistics company not found', 404);
    }

    return sendResponse.success(res, company);

  } catch (error) {
    console.error('Get logistics company error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Update logistics company (Admin only)
router.put('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Only admins can update logistics companies', 403);
    }

    const { error } = logisticsCompanySchema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    const company = await LogisticsCompany.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('createdBy', 'name');

    if (!company) {
      return sendResponse.error(res, 'Logistics company not found', 404);
    }

    return sendResponse.success(res, company, 'Logistics company updated successfully');

  } catch (error) {
    console.error('Update logistics company error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Toggle active status (Admin only)
router.patch('/:id/toggle-status', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Only admins can toggle logistics company status', 403);
    }

    const company = await LogisticsCompany.findById(req.params.id);
    if (!company) {
      return sendResponse.error(res, 'Logistics company not found', 404);
    }

    company.isActive = !company.isActive;
    await company.save();

    return sendResponse.success(res, company, `Logistics company ${company.isActive ? 'activated' : 'deactivated'} successfully`);

  } catch (error) {
    console.error('Toggle logistics company status error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

module.exports = router;
