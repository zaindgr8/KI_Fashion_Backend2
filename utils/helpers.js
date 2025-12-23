const jwt = require('jsonwebtoken');
const { MESSAGES, PAGINATION } = require('./constants');

// Response helper functions
const sendResponse = {
  success: (res, data = null, message = MESSAGES.SUCCESS.RETRIEVED, statusCode = 200) => {
    return res.status(statusCode).json({
      success: true,
      message,
      data,
      timestamp: new Date().toISOString()
    });
  },

  error: (res, message = MESSAGES.ERROR.SERVER_ERROR, statusCode = 500, errors = null) => {
    return res.status(statusCode).json({
      success: false,
      message,
      errors,
      timestamp: new Date().toISOString()
    });
  },

  paginated: (res, data, pagination, message = MESSAGES.SUCCESS.RETRIEVED) => {
    return res.status(200).json({
      success: true,
      message,
      data,
      pagination,
      timestamp: new Date().toISOString()
    });
  }
};

// Pagination helper
const getPagination = (page = 1, limit = PAGINATION.DEFAULT_LIMIT) => {
  const pageNumber = Math.max(1, parseInt(page));
  const limitNumber = Math.min(PAGINATION.MAX_LIMIT, Math.max(1, parseInt(limit)));
  const skip = (pageNumber - 1) * limitNumber;

  return {
    page: pageNumber,
    limit: limitNumber,
    skip
  };
};

const formatPaginationResponse = (totalItems, currentPage, limit) => {
  return {
    currentPage: parseInt(currentPage),
    totalPages: Math.ceil(totalItems / limit),
    totalItems,
    itemsPerPage: parseInt(limit),
    hasNext: currentPage < Math.ceil(totalItems / limit),
    hasPrev: currentPage > 1
  };
};

// Generate unique identifiers
const generateOrderNumber = (prefix, existingNumbers = []) => {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');

  const baseNumber = `${prefix}${year}${month}${day}`;

  // Find the highest existing number for today
  const todayNumbers = existingNumbers
    .filter(num => num.startsWith(baseNumber))
    .map(num => parseInt(num.slice(-4)) || 0)
    .sort((a, b) => b - a);

  const nextSequence = (todayNumbers[0] || 0) + 1;
  return `${baseNumber}${String(nextSequence).padStart(4, '0')}`;
};

// Date helpers
const formatDate = (date, format = 'DD/MM/YYYY') => {
  if (!date) return null;

  const d = new Date(date);
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');

  switch (format) {
    case 'DD/MM/YYYY':
      return `${day}/${month}/${year}`;
    case 'YYYY-MM-DD':
      return `${year}-${month}-${day}`;
    case 'DD/MM/YYYY HH:mm':
      return `${day}/${month}/${year} ${hours}:${minutes}`;
    case 'YYYY-MM-DD HH:mm:ss':
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    default:
      return d.toISOString();
  }
};

const getDateRange = (period = 'month') => {
  const now = new Date();
  let startDate, endDate = new Date();

  switch (period) {
    case 'today':
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'week':
      const firstDayOfWeek = now.getDate() - now.getDay();
      startDate = new Date(now.setDate(firstDayOfWeek));
      break;
    case 'month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'quarter':
      const quarterMonth = Math.floor(now.getMonth() / 3) * 3;
      startDate = new Date(now.getFullYear(), quarterMonth, 1);
      break;
    case 'year':
      startDate = new Date(now.getFullYear(), 0, 1);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  return { startDate, endDate };
};

// Calculate business metrics
const calculatePercentageChange = (current, previous) => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
};

const calculateProfitMargin = (revenue, cost) => {
  if (revenue === 0) return 0;
  return ((revenue - cost) / revenue) * 100;
};

const calculateInventoryTurnover = (costOfGoodsSold, averageInventory) => {
  if (averageInventory === 0) return 0;
  return costOfGoodsSold / averageInventory;
};

// Data formatting helpers
const formatCurrency = (amount, currency = 'PKR') => {
  if (typeof amount !== 'number') return `${currency} 0.00`;
  return `${currency} ${amount.toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const formatNumber = (number, decimals = 0) => {
  if (typeof number !== 'number') return '0';
  return number.toLocaleString('en-PK', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
};

const formatPercentage = (value, decimals = 1) => {
  if (typeof value !== 'number') return '0%';
  return `${value.toFixed(decimals)}%`;
};

// Search and filter helpers
const buildSearchQuery = (searchTerm, fields) => {
  if (!searchTerm || !fields || fields.length === 0) return {};

  const searchRegex = { $regex: searchTerm, $options: 'i' };
  return {
    $or: fields.map(field => ({ [field]: searchRegex }))
  };
};

const buildDateRangeQuery = (startDate, endDate, field = 'createdAt') => {
  const query = {};
  if (startDate || endDate) {
    query[field] = {};
    if (startDate) query[field].$gte = new Date(startDate);
    if (endDate) query[field].$lte = new Date(endDate);
  }
  return query;
};

// Validation helpers
const isValidObjectId = (id) => {
  return /^[0-9a-fA-F]{24}$/.test(id);
};

const sanitizeInput = (input) => {
  if (typeof input !== 'string') return input;
  return input.trim().replace(/[<>]/g, '');
};

// JWT helpers
const generateToken = (payload, expiresIn = '24h') => {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn });
};

const verifyToken = (token) => {
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    return null;
  }
};

// Error handling helpers
const handleAsyncError = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

const createError = (message, statusCode = 500, errors = null) => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.errors = errors;
  return error;
};

// Array helpers
const removeDuplicates = (array, key = null) => {
  if (!key) return [...new Set(array)];
  return array.filter((item, index, self) =>
    index === self.findIndex(t => t[key] === item[key])
  );
};

const groupBy = (array, key) => {
  return array.reduce((groups, item) => {
    const groupKey = item[key];
    if (!groups[groupKey]) {
      groups[groupKey] = [];
    }
    groups[groupKey].push(item);
    return groups;
  }, {});
};

// Export all helpers
module.exports = {
  sendResponse,
  getPagination,
  formatPaginationResponse,
  generateOrderNumber,
  formatDate,
  getDateRange,
  calculatePercentageChange,
  calculateProfitMargin,
  calculateInventoryTurnover,
  formatCurrency,
  formatNumber,
  formatPercentage,
  buildSearchQuery,
  buildDateRangeQuery,
  isValidObjectId,
  sanitizeInput,
  generateToken,
  verifyToken,
  handleAsyncError,
  createError,
  removeDuplicates,
  groupBy
};