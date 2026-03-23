const express = require('express');
const Joi = require('joi');
const mongoose = require('mongoose');
const Campaign = require('../models/Campaign');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

const toSlug = (value = '') =>
  String(value)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const canManageCampaigns = (user) => ['admin', 'super-admin'].includes(user?.role);

const hasCampaignScope = (payload = {}) => {
  const explicitProductIds = Array.isArray(payload.productIds)
    ? payload.productIds.filter(Boolean)
    : [];
  if (explicitProductIds.length > 0) return true;

  const filters = payload.filters || {};
  return Boolean(
    (Array.isArray(filters.categories) && filters.categories.length > 0) ||
    (Array.isArray(filters.brands) && filters.brands.length > 0) ||
    (Array.isArray(filters.seasons) && filters.seasons.length > 0) ||
    (Array.isArray(filters.supplierIds) && filters.supplierIds.length > 0) ||
    (Array.isArray(filters.skus) && filters.skus.length > 0) ||
    (filters.stockState && filters.stockState !== 'any')
  );
};

const campaignSchema = Joi.object({
  name: Joi.string().min(2).max(120).required(),
  campaignType: Joi.string().valid('discount', 'clearance').default('discount'),
  discountType: Joi.string().valid('percentage', 'fixed').required(),
  discountValue: Joi.number().min(0).required(),
  startAt: Joi.date().required(),
  endAt: Joi.date().required(),
  timezone: Joi.string().optional(),
  status: Joi.string().valid('draft', 'active', 'paused', 'expired', 'archived').optional(),
  isActive: Joi.boolean().optional(),
  productIds: Joi.array().items(Joi.string()).optional(),
  filters: Joi.object({
    categories: Joi.array().items(Joi.string()).optional(),
    brands: Joi.array().items(Joi.string()).optional(),
    seasons: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season', 'accessories')).optional(),
    supplierIds: Joi.array().items(Joi.string()).optional(),
    skus: Joi.array().items(Joi.string()).optional(),
    stockState: Joi.string().valid('any', 'in-stock', 'low-stock', 'out-of-stock').optional(),
  }).optional(),
  badgeText: Joi.string().allow('').optional(),
  badgeVariant: Joi.string().allow('').optional(),
  priority: Joi.number().min(0).optional(),
  notes: Joi.string().allow('').optional(),
});

const ensureValidReferences = async (payload) => {
  if (Array.isArray(payload.productIds) && payload.productIds.length > 0) {
    const validIds = payload.productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validIds.length !== payload.productIds.length) {
      throw new Error('One or more product IDs are invalid');
    }
    const count = await Product.countDocuments({ _id: { $in: validIds } });
    if (count !== validIds.length) {
      throw new Error('One or more selected products do not exist');
    }
  }

  const supplierIds = payload.filters?.supplierIds || [];
  if (Array.isArray(supplierIds) && supplierIds.length > 0) {
    const validSupplierIds = supplierIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
    if (validSupplierIds.length !== supplierIds.length) {
      throw new Error('One or more supplier IDs are invalid');
    }
    const count = await Supplier.countDocuments({ _id: { $in: validSupplierIds } });
    if (count !== validSupplierIds.length) {
      throw new Error('One or more selected suppliers do not exist');
    }
  }
};

router.get('/', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to view campaigns', 403);
    }

    const {
      page = 1,
      limit = 20,
      status,
      campaignType,
      search,
      activeOnly,
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (campaignType) query.campaignType = campaignType;

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { slug: { $regex: search, $options: 'i' } },
      ];
    }

    if (activeOnly === 'true') {
      const now = new Date();
      query.isActive = true;
      query.status = 'active';
      query.startAt = { $lte: now };
      query.endAt = { $gte: now };
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    const [items, totalItems] = await Promise.all([
      Campaign.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .populate('createdBy', 'name')
        .populate('updatedBy', 'name')
        .lean(),
      Campaign.countDocuments(query),
    ]);

    return sendResponse.success(res, {
      items,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(totalItems / limitNum),
        totalItems,
        itemsPerPage: limitNum,
      },
    });
  } catch (error) {
    console.error('List campaigns error:', error);
    return sendResponse.error(res, 'Server error');
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to view campaigns', 403);
    }

    const campaign = await Campaign.findById(req.params.id)
      .populate('createdBy', 'name')
      .populate('updatedBy', 'name')
      .lean();

    if (!campaign) {
      return sendResponse.error(res, 'Campaign not found', 404);
    }

    return sendResponse.success(res, campaign);
  } catch (error) {
    console.error('Get campaign error:', error);
    return sendResponse.error(res, 'Server error');
  }
});

router.post('/', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to create campaigns', 403);
    }

    const { error, value } = campaignSchema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    if (new Date(value.startAt) >= new Date(value.endAt)) {
      return sendResponse.error(res, 'startAt must be before endAt', 400);
    }

    if (value.discountType === 'percentage' && value.discountValue > 100) {
      return sendResponse.error(res, 'Percentage discount cannot exceed 100', 400);
    }

    if (value.campaignType === 'clearance' && !hasCampaignScope(value)) {
      return sendResponse.error(
        res,
        'Clearance campaigns must target at least one product or filter',
        400
      );
    }

    await ensureValidReferences(value);

    let slug = toSlug(value.name);
    if (!slug) {
      slug = `campaign-${Date.now()}`;
    }

    const existingSlug = await Campaign.findOne({ slug }).lean();
    if (existingSlug) {
      slug = `${slug}-${Date.now()}`;
    }

    const campaign = await Campaign.create({
      ...value,
      slug,
      filters: {
        categories: value.filters?.categories || [],
        brands: value.filters?.brands || [],
        seasons: value.filters?.seasons || [],
        supplierIds: value.filters?.supplierIds || [],
        skus: (value.filters?.skus || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean),
        stockState: value.filters?.stockState || 'any',
      },
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    return sendResponse.success(res, campaign, 'Campaign created successfully', 201);
  } catch (error) {
    console.error('Create campaign error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to update campaigns', 403);
    }

    const { error, value } = campaignSchema.min(1).validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    const existingCampaign = await Campaign.findById(req.params.id).lean();
    if (!existingCampaign) {
      return sendResponse.error(res, 'Campaign not found', 404);
    }

    if (value.startAt && value.endAt && new Date(value.startAt) >= new Date(value.endAt)) {
      return sendResponse.error(res, 'startAt must be before endAt', 400);
    }

    if (value.discountType === 'percentage' && value.discountValue > 100) {
      return sendResponse.error(res, 'Percentage discount cannot exceed 100', 400);
    }

    const mergedCampaignType = value.campaignType || existingCampaign.campaignType;
    const mergedCampaignScope = {
      productIds: value.productIds !== undefined ? value.productIds : existingCampaign.productIds,
      filters: value.filters !== undefined ? value.filters : existingCampaign.filters,
    };

    if (mergedCampaignType === 'clearance' && !hasCampaignScope(mergedCampaignScope)) {
      return sendResponse.error(
        res,
        'Clearance campaigns must target at least one product or filter',
        400
      );
    }

    await ensureValidReferences(value);

    const patch = {
      ...value,
      updatedBy: req.user._id,
    };

    if (value.name) {
      const desiredSlug = toSlug(value.name);
      if (desiredSlug) {
        const exists = await Campaign.findOne({ slug: desiredSlug, _id: { $ne: req.params.id } }).lean();
        patch.slug = exists ? `${desiredSlug}-${Date.now()}` : desiredSlug;
      }
    }

    if (value.filters) {
      patch.filters = {
        categories: value.filters.categories || [],
        brands: value.filters.brands || [],
        seasons: value.filters.seasons || [],
        supplierIds: value.filters.supplierIds || [],
        skus: (value.filters.skus || []).map((s) => String(s).toUpperCase().trim()).filter(Boolean),
        stockState: value.filters.stockState || 'any',
      };
    }

    const campaign = await Campaign.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    });

    if (!campaign) {
      return sendResponse.error(res, 'Campaign not found', 404);
    }

    return sendResponse.success(res, campaign, 'Campaign updated successfully');
  } catch (error) {
    console.error('Update campaign error:', error);
    return sendResponse.error(res, error.message || 'Server error', 500);
  }
});

router.patch('/:id/status', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to update campaigns', 403);
    }

    const schema = Joi.object({
      status: Joi.string().valid('draft', 'active', 'paused', 'expired', 'archived').required(),
      isActive: Joi.boolean().optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return sendResponse.error(res, error.details[0].message, 400);
    }

    const patch = {
      status: value.status,
      isActive: value.isActive !== undefined ? value.isActive : value.status === 'active',
      updatedBy: req.user._id,
    };

    if (patch.status === 'active' || patch.isActive === true) {
      const existingCampaign = await Campaign.findById(req.params.id).lean();
      if (!existingCampaign) {
        return sendResponse.error(res, 'Campaign not found', 404);
      }

      if (existingCampaign.campaignType === 'clearance' && !hasCampaignScope(existingCampaign)) {
        return sendResponse.error(
          res,
          'Cannot activate a clearance campaign without product or filter scope',
          400
        );
      }
    }

    const campaign = await Campaign.findByIdAndUpdate(req.params.id, patch, {
      new: true,
      runValidators: true,
    });

    if (!campaign) {
      return sendResponse.error(res, 'Campaign not found', 404);
    }

    return sendResponse.success(res, campaign, 'Campaign status updated successfully');
  } catch (error) {
    console.error('Update campaign status error:', error);
    return sendResponse.error(res, 'Server error');
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    if (!canManageCampaigns(req.user)) {
      return sendResponse.error(res, 'Not authorized to archive campaigns', 403);
    }

    const campaign = await Campaign.findByIdAndUpdate(
      req.params.id,
      {
        status: 'archived',
        isActive: false,
        updatedBy: req.user._id,
      },
      { new: true }
    );

    if (!campaign) {
      return sendResponse.error(res, 'Campaign not found', 404);
    }

    return sendResponse.success(res, campaign, 'Campaign archived successfully');
  } catch (error) {
    console.error('Archive campaign error:', error);
    return sendResponse.error(res, 'Server error');
  }
});

module.exports = router;
