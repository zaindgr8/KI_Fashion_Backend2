const Counter = require('../models/Counter');

/**
 * Atomically generate the next sale number using a counter collection.
 * Uses findOneAndUpdate with $inc for race-condition-free incrementing.
 * Format: SALYYYYMMnnnn  (e.g. SAL2025060001)
 */
async function generateSaleNumber() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const prefix = `SAL${year}${month}`;
  const counterId = `sale_${prefix}`;

  const counter = await Counter.findOneAndUpdate(
    { _id: counterId },
    { $inc: { seq: 1 } },
    { upsert: true, new: true }
  );

  return `${prefix}${String(counter.seq).padStart(4, '0')}`;
}

module.exports = { generateSaleNumber };
