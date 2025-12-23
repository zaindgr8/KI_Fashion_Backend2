const Joi = require('joi');

// Common validation schemas
const schemas = {
  objectId: Joi.string().regex(/^[0-9a-fA-F]{24}$/).message('Invalid ObjectId format'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20)
  }),

  dateRange: Joi.object({
    startDate: Joi.date().iso().optional(),
    endDate: Joi.date().iso().min(Joi.ref('startDate')).optional()
  }),

  address: Joi.object({
    street: Joi.string().optional(),
    city: Joi.string().optional(),
    state: Joi.string().optional(),
    zipCode: Joi.string().optional(),
    country: Joi.string().default('Pakistan')
  }),

  phone: Joi.string()
    .pattern(/^(\+92|0092|92)?-?0?(3[0-9]{2}[0-9]{7}|[2-9][0-9]{1,2}[0-9]{7,8})$/)
    .message('Please enter a valid Pakistani phone number (mobile: 03XX-XXXXXXX or landline with area code: 0XX-XXXXXXXX)'),

  email: Joi.string()
    .email()
    .lowercase()
    .trim(),

  currency: Joi.number().precision(2).min(0),

  percentage: Joi.number().min(0).max(100)
};

// Validation middleware factory
const validateRequest = (schema, property = 'body') => {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,
      stripUnknown: true,
      allowUnknown: property === 'query'
    });

    if (error) {
      const errorMessage = error.details
        .map(detail => detail.message)
        .join(', ');

      return res.status(400).json({
        success: false,
        message: `Validation error: ${errorMessage}`,
        errors: error.details
      });
    }

    req[property] = value;
    next();
  };
};

// Custom validation functions
const customValidators = {
  isValidSKU: (value) => {
    const skuRegex = /^[A-Z0-9-_]{3,20}$/;
    return skuRegex.test(value);
  },

  isValidEmployeeId: (value) => {
    const empIdRegex = /^[A-Z0-9]{3,10}$/;
    return empIdRegex.test(value);
  },

  isValidCostTypeId: (value) => {
    const costTypeRegex = /^[A-Z][0-9]{1,3}$/;
    return costTypeRegex.test(value);
  },

  isStrongPassword: (value) => {
    // At least 8 characters, 1 uppercase, 1 lowercase, 1 number
    const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
    return passwordRegex.test(value);
  }
};

// Error response formatter
const formatValidationError = (error) => {
  const errors = {};

  if (error.details) {
    error.details.forEach((detail) => {
      const field = detail.path.join('.');
      errors[field] = detail.message;
    });
  }

  return {
    success: false,
    message: 'Validation failed',
    errors
  };
};

module.exports = {
  schemas,
  validateRequest,
  customValidators,
  formatValidationError
};