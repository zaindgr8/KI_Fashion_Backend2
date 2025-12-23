const mongoose = require('mongoose');
require('dotenv').config();

// Import all models
const Sale = require('../models/Sale');
const DispatchOrder = require('../models/DispatchOrder');
const Ledger = require('../models/Ledger');
const Expense = require('../models/Expense');
const ExpenseVoucher = require('../models/ExpenseVoucher');
const Return = require('../models/Return');
const SaleReturn = require('../models/SaleReturn');
const Inventory = require('../models/Inventory');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');

// Connect to MongoDB
const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB Connected');
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
};

// Reset all transactional data
const resetDatabase = async () => {
  try {
    console.log('Starting database reset...\n');

    // Delete all sales
    const salesCount = await Sale.countDocuments();
    await Sale.deleteMany({});
    console.log(`✓ Deleted ${salesCount} sales`);

    // Delete all dispatch orders
    const dispatchOrdersCount = await DispatchOrder.countDocuments();
    await DispatchOrder.deleteMany({});
    console.log(`✓ Deleted ${dispatchOrdersCount} dispatch orders`);

    // Delete all ledger entries
    const ledgerCount = await Ledger.countDocuments();
    await Ledger.deleteMany({});
    console.log(`✓ Deleted ${ledgerCount} ledger entries`);

    // Delete all expenses
    const expensesCount = await Expense.countDocuments();
    await Expense.deleteMany({});
    console.log(`✓ Deleted ${expensesCount} expenses`);

    // Delete all expense vouchers
    const expenseVouchersCount = await ExpenseVoucher.countDocuments();
    await ExpenseVoucher.deleteMany({});
    console.log(`✓ Deleted ${expenseVouchersCount} expense vouchers`);

    // Delete all returns
    const returnsCount = await Return.countDocuments();
    await Return.deleteMany({});
    console.log(`✓ Deleted ${returnsCount} returns`);

    // Delete all sale returns
    const saleReturnsCount = await SaleReturn.countDocuments();
    await SaleReturn.deleteMany({});
    console.log(`✓ Deleted ${saleReturnsCount} sale returns`);

    // Reset inventory - set stock to 0 and clear movements
    const inventoryCount = await Inventory.countDocuments();
    await Inventory.updateMany(
      {},
      {
        $set: {
          currentStock: 0,
          reservedStock: 0,
          availableStock: 0,
          totalValue: 0,
          averageCostPrice: 0,
          needsReorder: false,
          stockMovements: [],
          lastStockUpdate: new Date()
        }
      }
    );
    console.log(`✓ Reset ${inventoryCount} inventory records`);

    // Reset supplier balances
    const suppliersCount = await Supplier.countDocuments();
    await Supplier.updateMany(
      {},
      { $set: { currentBalance: 0 } }
    );
    console.log(`✓ Reset ${suppliersCount} supplier balances`);

    // Reset buyer balances
    const buyersCount = await Buyer.countDocuments();
    await Buyer.updateMany(
      {},
      { $set: { currentBalance: 0 } }
    );
    console.log(`✓ Reset ${buyersCount} buyer balances`);

    console.log('\n✅ Database reset completed successfully!');
    console.log('\nAll transactional data has been deleted and balances reset to zero.');
    console.log('The dashboard should now show all metrics as zero.');

  } catch (error) {
    console.error('Error resetting database:', error);
    throw error;
  }
};

// Main execution
const main = async () => {
  try {
    await connectDB();
    await resetDatabase();
    await mongoose.connection.close();
    console.log('\nDatabase connection closed.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    await mongoose.connection.close();
    process.exit(1);
  }
};

// Run the script
main();

