
const mongoose = require('mongoose');
require('dotenv').config();

async function findProductWithPrice() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/kifashion');
    console.log('Connected to MongoDB');

    const Inventory = mongoose.model('Inventory', new mongoose.Schema({}, { strict: false }), 'inventories');
    const inv = await Inventory.findOne({ 
      $or: [
        { averageCostPrice: 10.92 },
        { "purchaseBatches.landedPrice": 10.92 }
      ]
    });

    if (inv) {
      console.log('Found Inventory:', JSON.stringify(inv, null, 2));
    } else {
      console.log('No inventory found with price 10.92');
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('Error:', error);
  }
}

findProductWithPrice();
