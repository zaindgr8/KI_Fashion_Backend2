// Application Constants

const USER_ROLES = {
  ADMIN: 'admin',
  MANAGER: 'manager',
  EMPLOYEE: 'employee',
  ACCOUNTANT: 'accountant'
};

const PERMISSIONS = {
  USERS: 'users',
  SUPPLIERS: 'suppliers',
  BUYERS: 'buyers',
  PRODUCTS: 'products',
  SALES: 'sales',
  PURCHASES: 'purchases',
  INVENTORY: 'inventory',
  REPORTS: 'reports',
  EXPENSES: 'expenses',
  DELIVERY: 'delivery'
};

const PAYMENT_TERMS = {
  CASH: 'cash',
  NET15: 'net15',
  NET30: 'net30',
  NET45: 'net45',
  NET60: 'net60'
};

const PAYMENT_METHODS = {
  CASH: 'cash',
  CARD: 'card',
  BANK_TRANSFER: 'bank_transfer',
  CHEQUE: 'cheque',
  ONLINE: 'online',
  CREDIT: 'credit'
};

const PRODUCT_UNITS = {
  PIECE: 'piece',
  KG: 'kg',
  G: 'g',
  LITER: 'liter',
  ML: 'ml',
  METER: 'meter',
  CM: 'cm',
  DOZEN: 'dozen',
  BOX: 'box',
  PACK: 'pack'
};

const ORDER_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  RETURNED: 'returned'
};

const PAYMENT_STATUS = {
  PENDING: 'pending',
  PARTIAL: 'partial',
  PAID: 'paid',
  OVERDUE: 'overdue',
  REFUNDED: 'refunded'
};

const EXPENSE_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  PAID: 'paid'
};

const CUSTOMER_TYPES = {
  RETAIL: 'retail',
  WHOLESALE: 'wholesale',
  DISTRIBUTOR: 'distributor'
};

const SALE_TYPES = {
  RETAIL: 'retail',
  WHOLESALE: 'wholesale',
  BULK: 'bulk'
};

const STOCK_MOVEMENT_TYPES = {
  IN: 'in',
  OUT: 'out',
  ADJUSTMENT: 'adjustment',
  TRANSFER: 'transfer'
};

const COST_CATEGORIES = {
  OPERATIONAL: 'operational',
  ADMINISTRATIVE: 'administrative',
  MARKETING: 'marketing',
  INVENTORY: 'inventory',
  UTILITIES: 'utilities',
  MAINTENANCE: 'maintenance',
  OTHER: 'other'
};

const EXPENSE_FREQUENCIES = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly'
};

// Default cost types for initialization
const DEFAULT_COST_TYPES = [
  { id: 'A1', name: 'Meals & Food', category: 'operational' },
  { id: 'A2', name: 'Office Supplies', category: 'administrative' },
  { id: 'A3', name: 'Utilities - Electricity', category: 'utilities' },
  { id: 'A4', name: 'Utilities - Water', category: 'utilities' },
  { id: 'A5', name: 'Internet & Phone', category: 'utilities' },
  { id: 'B1', name: 'Marketing & Advertising', category: 'marketing' },
  { id: 'B2', name: 'Equipment Maintenance', category: 'maintenance' },
  { id: 'B3', name: 'Vehicle Expenses', category: 'operational' },
  { id: 'C1', name: 'Rent', category: 'operational' },
  { id: 'C2', name: 'Insurance', category: 'administrative' },
  { id: 'D1', name: 'Packaging Materials', category: 'inventory' },
  { id: 'D2', name: 'Transportation', category: 'operational' },
  { id: 'E1', name: 'Staff Training', category: 'administrative' },
  { id: 'E2', name: 'Legal & Professional', category: 'administrative' },
  { id: 'F1', name: 'Miscellaneous', category: 'other' }
];

// API Response Messages
const MESSAGES = {
  SUCCESS: {
    CREATED: 'Created successfully',
    UPDATED: 'Updated successfully',
    DELETED: 'Deleted successfully',
    RETRIEVED: 'Retrieved successfully',
    LOGIN: 'Login successful',
    LOGOUT: 'Logout successful',
    APPROVED: 'Approved successfully',
    REJECTED: 'Rejected successfully',
    DELIVERED: 'Marked as delivered successfully',
    CANCELLED: 'Cancelled successfully'
  },
  ERROR: {
    NOT_FOUND: 'Resource not found',
    ALREADY_EXISTS: 'Resource already exists',
    INVALID_CREDENTIALS: 'Invalid credentials',
    UNAUTHORIZED: 'Unauthorized access',
    FORBIDDEN: 'Forbidden access',
    VALIDATION_ERROR: 'Validation error',
    SERVER_ERROR: 'Internal server error',
    INSUFFICIENT_STOCK: 'Insufficient stock',
    INVALID_OPERATION: 'Invalid operation',
    DATABASE_ERROR: 'Database operation failed'
  }
};

// Pagination defaults
const PAGINATION = {
  DEFAULT_PAGE: 1,
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100
};

// Date formats
const DATE_FORMATS = {
  ISO: 'YYYY-MM-DD',
  DISPLAY: 'DD/MM/YYYY',
  TIMESTAMP: 'YYYY-MM-DD HH:mm:ss'
};

// Regular expressions
const REGEX = {
  SKU: /^[A-Z0-9-_]{3,20}$/,
  EMPLOYEE_ID: /^[A-Z0-9]{3,10}$/,
  COST_TYPE_ID: /^[A-Z][0-9]{1,3}$/,
  // Accepts mobile (03XX-XXXXXXX) and landline (0XX-XXXXXXXX) with area codes
  // Mobile: 03XX followed by 7 digits (e.g., 0300-1234567)
  // Landline: 0 + 2-3 digit area code + 7-8 digits (e.g., 021-12345678, 042-1234567)
  PHONE_PK: /^(\+92|0092|92)?-?0?(3[0-9]{2}[0-9]{7}|[2-9][0-9]{1,2}[0-9]{7,8})$/,
  STRONG_PASSWORD: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/,
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/
};

module.exports = {
  USER_ROLES,
  PERMISSIONS,
  PAYMENT_TERMS,
  PAYMENT_METHODS,
  PRODUCT_UNITS,
  ORDER_STATUS,
  PAYMENT_STATUS,
  EXPENSE_STATUS,
  CUSTOMER_TYPES,
  SALE_TYPES,
  STOCK_MOVEMENT_TYPES,
  COST_CATEGORIES,
  EXPENSE_FREQUENCIES,
  DEFAULT_COST_TYPES,
  MESSAGES,
  PAGINATION,
  DATE_FORMATS,
  REGEX
};