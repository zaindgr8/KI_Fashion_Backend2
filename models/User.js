const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const ROLE_OPTIONS = ['super-admin', 'admin', 'supplier', 'distributor', 'buyer'];
const PORTAL_ACCESS_OPTIONS = ['crm', 'supplier', 'distributor'];
const SIGNUP_SOURCES = ['crm', 'supplier-portal', 'distributor-portal', 'import'];

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ROLE_OPTIONS,
    default: 'employee'
  },
  phone: {
    type: String,
    trim: true
  },
  phoneAreaCode: {
    type: String,
    trim: true,
    maxlength: 5
  },
  address: {
    type: String,
    trim: true
  },
  supplier: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Supplier'
  },
  buyer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Buyer'
  },
  portalAccess: {
    type: [String],
    enum: PORTAL_ACCESS_OPTIONS,
    default: function () {
      if (this.role === 'supplier') return ['supplier'];
      if (this.role === 'distributor' || this.role === 'buyer') return ['distributor'];
      return ['crm'];
    }
  },
  signupSource: {
    type: String,
    enum: SIGNUP_SOURCES,
    default: 'crm'
  },
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date
  },
  permissions: [{
    type: String,
    enum: ['users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery']
  }]
}, {
  timestamps: true
});

userSchema.pre('save', async function(next) {
  if (Array.isArray(this.portalAccess) && this.portalAccess.length) {
    this.portalAccess = Array.from(new Set(this.portalAccess));
  }

  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

userSchema.methods.comparePassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('User', userSchema);