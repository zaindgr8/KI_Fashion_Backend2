const mongoose = require('mongoose');

const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true }, // e.g. "sale_SAL202506"
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model('Counter', counterSchema);
