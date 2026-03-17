const Campaign = require('../models/Campaign');

const toMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(2));
};

const nowUtc = () => new Date();

const normalizeCampaignSummary = (campaign, discountedPrice, originalPrice) => ({
  _id: campaign._id,
  name: campaign.name,
  campaignType: campaign.campaignType,
  discountType: campaign.discountType,
  discountValue: campaign.discountValue,
  badgeText: campaign.badgeText || campaign.name,
  badgeVariant: campaign.badgeVariant || 'sale',
  startAt: campaign.startAt,
  endAt: campaign.endAt,
  priority: campaign.priority ?? 100,
  originalPrice: toMoney(originalPrice),
  discountedPrice: toMoney(discountedPrice),
  discountAmount: toMoney(Math.max(0, originalPrice - discountedPrice)),
});

const calculateDiscountedPrice = (basePrice, campaign) => {
  const original = toMoney(basePrice);
  if (original <= 0) return 0;

  let discounted = original;
  if (campaign.discountType === 'percentage') {
    const pct = Math.max(0, Math.min(100, Number(campaign.discountValue) || 0));
    discounted = original - (original * pct / 100);
  } else if (campaign.discountType === 'fixed') {
    discounted = original - (Number(campaign.discountValue) || 0);
  }

  return toMoney(Math.max(0, discounted));
};

const isWindowActive = (campaign, at = nowUtc()) => {
  if (!campaign || !campaign.isActive || campaign.status !== 'active') return false;
  const startAt = campaign.startAt ? new Date(campaign.startAt) : null;
  const endAt = campaign.endAt ? new Date(campaign.endAt) : null;
  if (!startAt || !endAt) return false;
  return startAt <= at && at <= endAt;
};

const intersects = (left, right) => {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const set = new Set(left.map(String));
  return right.some((item) => set.has(String(item)));
};

const productMatchesStockState = (stockState, inventory) => {
  if (!stockState || stockState === 'any') return true;
  const currentStock = Number(inventory?.currentStock ?? 0);
  const reorderLevel = Number(inventory?.reorderLevel ?? 10);

  if (stockState === 'in-stock') return currentStock > 0;
  if (stockState === 'out-of-stock') return currentStock <= 0;
  if (stockState === 'low-stock') return currentStock > 0 && currentStock <= reorderLevel;
  return true;
};

const hasAnyFilter = (campaign) => {
  const filters = campaign?.filters || {};
  return Boolean(
    (Array.isArray(filters.categories) && filters.categories.length) ||
    (Array.isArray(filters.brands) && filters.brands.length) ||
    (Array.isArray(filters.seasons) && filters.seasons.length) ||
    (Array.isArray(filters.supplierIds) && filters.supplierIds.length) ||
    (Array.isArray(filters.skus) && filters.skus.length) ||
    (filters.stockState && filters.stockState !== 'any')
  );
};

const isProductEligible = (product, campaign, context = {}) => {
  if (!product || !campaign) return false;

  const candidateProductIds = Array.isArray(context.candidateProductIds) && context.candidateProductIds.length
    ? context.candidateProductIds.map((id) => String(id))
    : [String(product._id)];

  const explicitIds = Array.isArray(campaign.productIds)
    ? campaign.productIds.map((id) => String(id))
    : [];

  const explicitMatch = explicitIds.length > 0 && candidateProductIds.some((id) => explicitIds.includes(id));

  const filters = campaign.filters || {};
  const anyFilter = hasAnyFilter(campaign);

  let filterMatch = true;
  if (Array.isArray(filters.categories) && filters.categories.length > 0) {
    filterMatch = filterMatch && filters.categories.includes(product.category);
  }
  if (Array.isArray(filters.brands) && filters.brands.length > 0) {
    filterMatch = filterMatch && filters.brands.includes(product.brand);
  }
  if (Array.isArray(filters.seasons) && filters.seasons.length > 0) {
    const productSeasons = Array.isArray(product.season) ? product.season : [];
    filterMatch = filterMatch && intersects(filters.seasons, productSeasons);
  }
  if (Array.isArray(filters.supplierIds) && filters.supplierIds.length > 0) {
    const supplierId = product.supplier ? String(product.supplier._id || product.supplier) : null;
    filterMatch = filterMatch && Boolean(supplierId && filters.supplierIds.map((id) => String(id)).includes(supplierId));
  }
  if (Array.isArray(filters.skus) && filters.skus.length > 0) {
    const sku = String(product.sku || '').toUpperCase();
    filterMatch = filterMatch && filters.skus.map((s) => String(s).toUpperCase()).includes(sku);
  }
  filterMatch = filterMatch && productMatchesStockState(filters.stockState, context.inventory);

  if (!anyFilter && explicitIds.length === 0) {
    return true;
  }

  return explicitMatch || filterMatch;
};

const selectTopCampaigns = (campaignMatches) => {
  const sorted = [...campaignMatches].sort((a, b) => {
    if (a.discountedPrice !== b.discountedPrice) {
      return a.discountedPrice - b.discountedPrice;
    }
    const aPriority = a.campaign.priority ?? 100;
    const bPriority = b.campaign.priority ?? 100;
    if (aPriority !== bPriority) {
      return aPriority - bPriority;
    }
    return new Date(a.campaign.createdAt || 0).getTime() - new Date(b.campaign.createdAt || 0).getTime();
  });
  return sorted;
};

const getProductCampaignPricing = ({ product, basePrice, campaigns = [], context = {} }) => {
  const originalPrice = toMoney(basePrice);
  if (originalPrice <= 0 || !product) {
    return {
      effectivePrice: originalPrice,
      originalPrice,
      bestCampaign: null,
      activeCampaigns: [],
    };
  }

  const applicable = campaigns
    .filter((campaign) => isWindowActive(campaign))
    .filter((campaign) => isProductEligible(product, campaign, context))
    .map((campaign) => {
      const discountedPrice = calculateDiscountedPrice(originalPrice, campaign);
      return {
        campaign,
        discountedPrice,
      };
    });

  if (applicable.length === 0) {
    return {
      effectivePrice: originalPrice,
      originalPrice,
      bestCampaign: null,
      activeCampaigns: [],
    };
  }

  const sorted = selectTopCampaigns(applicable);
  const best = sorted[0];
  const topTwo = sorted.slice(0, 2).map((entry) =>
    normalizeCampaignSummary(entry.campaign, entry.discountedPrice, originalPrice)
  );

  return {
    effectivePrice: toMoney(best.discountedPrice),
    originalPrice,
    bestCampaign: normalizeCampaignSummary(best.campaign, best.discountedPrice, originalPrice),
    activeCampaigns: topTwo,
  };
};

const loadActiveCampaigns = async (at = nowUtc()) => {
  return Campaign.find({
    isActive: true,
    status: 'active',
    startAt: { $lte: at },
    endAt: { $gte: at },
  }).lean();
};

module.exports = {
  toMoney,
  calculateDiscountedPrice,
  isWindowActive,
  isProductEligible,
  getProductCampaignPricing,
  loadActiveCampaigns,
};
