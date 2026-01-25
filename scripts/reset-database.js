/**
 * Database Reset Script
 * 
 * Clears all transactional data while preserving master data (users, suppliers, buyers).
 * Resets balances for suppliers and buyers to zero.
 * Creates 3 sample dispatch orders for a random supplier.
 * 
 * Usage:
 *   node scripts/reset-database.js              # Run with confirmation prompt
 *   node scripts/reset-database.js --dry-run   # Preview what will be deleted
 *   node scripts/reset-database.js --force     # Skip confirmation (use with caution!)
 */

require('dotenv').config();
const mongoose = require('mongoose');
const readline = require('readline');

// Import database config
const connectDB = require('../config/database');

// Import models for seeding
const DispatchOrder = require('../models/DispatchOrder');
const Supplier = require('../models/Supplier');
const User = require('../models/User');

// Collections to completely DELETE
const COLLECTIONS_TO_DELETE = [
  'dispatchorders',
  'sales',
  'salereturns',
  'returns',
  'ledgers',
  'payments',
  'inventories',
  'packetstocks',
  'expenses',
  'expensevouchers',
  'passwordresetrequests',
  'products',  // Also deleting products as requested
];

// Collections to RESET (update balances to 0)
const COLLECTIONS_TO_RESET = {
  suppliers: { currentBalance: 0 },
  buyers: { currentBalance: 0, totalSales: 0 },
};

// Counter keys to reset
const COUNTER_KEYS_TO_RESET = [
  'ledgerEntryNumber',
  'paymentNumber',
];

// Sample product data for dispatch orders
const SAMPLE_PRODUCTS = [
  {
    productName: 'Winter Jacket - Premium',
    productCode: 'WJ-001',
    season: ['winter'],
    costPrice: 45.00,
    primaryColor: ['Black', 'Navy', 'Grey'],
    size: ['S', 'M', 'L', 'XL'],
    quantity: 50,
  },
  {
    productName: 'Cotton T-Shirt Basic',
    productCode: 'CT-002',
    season: ['summer', 'spring'],
    costPrice: 8.50,
    primaryColor: ['White', 'Black', 'Red', 'Blue'],
    size: ['S', 'M', 'L', 'XL', 'XXL'],
    quantity: 100,
  },
  {
    productName: 'Denim Jeans Slim Fit',
    productCode: 'DJ-003',
    season: ['all_season'],
    costPrice: 25.00,
    primaryColor: ['Blue', 'Black', 'Grey'],
    size: ['28', '30', '32', '34', '36'],
    quantity: 75,
  },
  {
    productName: 'Wool Sweater Cable Knit',
    productCode: 'WS-004',
    season: ['winter', 'autumn'],
    costPrice: 35.00,
    primaryColor: ['Cream', 'Brown', 'Burgundy'],
    size: ['S', 'M', 'L', 'XL'],
    quantity: 40,
  },
  {
    productName: 'Summer Dress Floral',
    productCode: 'SD-005',
    season: ['summer', 'spring'],
    costPrice: 22.00,
    primaryColor: ['Pink', 'Yellow', 'White'],
    size: ['XS', 'S', 'M', 'L'],
    quantity: 60,
  },
  {
    productName: 'Cargo Pants Utility',
    productCode: 'CP-006',
    season: ['all_season'],
    costPrice: 28.00,
    primaryColor: ['Khaki', 'Olive', 'Black'],
    size: ['S', 'M', 'L', 'XL'],
    quantity: 55,
  },
];

async function promptConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

async function getCollectionStats(db) {
  const stats = {};
  
  for (const collectionName of COLLECTIONS_TO_DELETE) {
    try {
      const count = await db.collection(collectionName).countDocuments();
      stats[collectionName] = count;
    } catch (err) {
      stats[collectionName] = 0; // Collection might not exist
    }
  }
  
  for (const collectionName of Object.keys(COLLECTIONS_TO_RESET)) {
    try {
      const count = await db.collection(collectionName).countDocuments();
      stats[collectionName] = count;
    } catch (err) {
      stats[collectionName] = 0;
    }
  }
  
  return stats;
}

async function createSampleDispatchOrders() {
  console.log('\n📦 Creating sample dispatch orders...\n');

  // Find a random active supplier
  const suppliers = await Supplier.find({ isActive: true }).limit(10);
  if (suppliers.length === 0) {
    console.log('   ⚠ No active suppliers found. Skipping dispatch order creation.');
    return;
  }
  const randomSupplier = suppliers[Math.floor(Math.random() * suppliers.length)];
  console.log(`   Using supplier: ${randomSupplier.name} (${randomSupplier.supplierId})`);

  // Find an admin user for createdBy
  const adminUser = await User.findOne({ role: { $in: ['super-admin', 'admin'] } });
  if (!adminUser) {
    console.log('   ⚠ No admin user found. Skipping dispatch order creation.');
    return;
  }
  console.log(`   Using admin: ${adminUser.name}\n`);

  // Create 3 dispatch orders
  for (let i = 0; i < 3; i++) {
    // Pick 2-4 random products for each order
    const numProducts = Math.floor(Math.random() * 3) + 2; // 2-4 products
    const shuffledProducts = [...SAMPLE_PRODUCTS].sort(() => Math.random() - 0.5);
    const selectedProducts = shuffledProducts.slice(0, numProducts);

    // Create items array
    const items = selectedProducts.map((product, idx) => {
      const quantity = Math.floor(Math.random() * 50) + 20; // 20-70 items
      return {
        productName: product.productName,
        productCode: product.productCode,
        season: product.season,
        costPrice: product.costPrice,
        primaryColor: product.primaryColor,
        size: product.size,
        quantity: quantity,
        totalBoxes: Math.ceil(quantity / 10),
        productImage: [],
      };
    });

    // Calculate totals
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const totalBoxes = items.reduce((sum, item) => sum + item.totalBoxes, 0);

    // Create dispatch date (random within last 30 days)
    const dispatchDate = new Date();
    dispatchDate.setDate(dispatchDate.getDate() - Math.floor(Math.random() * 30));

    const dispatchOrder = new DispatchOrder({
      supplier: randomSupplier._id,
      items: items,
      totalQuantity: totalQuantity,
      totalBoxes: totalBoxes,
      status: 'pending',
      dispatchDate: dispatchDate,
      notes: `Sample dispatch order ${i + 1} created by reset script`,
      createdBy: adminUser._id,
    });

    await dispatchOrder.save();
    console.log(`   ✓ Created dispatch order: ${dispatchOrder.orderNumber}`);
    console.log(`     - ${items.length} products, ${totalQuantity} total items, ${totalBoxes} boxes`);
  }

  console.log('\n   ✅ Sample dispatch orders created successfully!');
}

async function resetDatabase(isDryRun = false) {
  console.log('\n========================================');
  console.log('       DATABASE RESET SCRIPT');
  console.log('========================================\n');
  
  if (isDryRun) {
    console.log('🔍 DRY RUN MODE - No changes will be made\n');
  }

  // Connect to database
  await connectDB();
  const db = mongoose.connection.db;
  
  console.log(`📊 Connected to database: ${db.databaseName}\n`);

  // Get current stats
  console.log('Current collection counts:');
  console.log('─'.repeat(40));
  const stats = await getCollectionStats(db);
  
  console.log('\n📋 Collections to DELETE:');
  let totalToDelete = 0;
  for (const collectionName of COLLECTIONS_TO_DELETE) {
    const count = stats[collectionName] || 0;
    totalToDelete += count;
    console.log(`   • ${collectionName}: ${count} documents`);
  }
  
  console.log('\n🔄 Collections to RESET (balances → 0):');
  for (const [collectionName, resetFields] of Object.entries(COLLECTIONS_TO_RESET)) {
    const count = stats[collectionName] || 0;
    const fields = Object.keys(resetFields).join(', ');
    console.log(`   • ${collectionName}: ${count} documents (reset: ${fields})`);
  }

  console.log('\n🔢 Counters to RESET:');
  for (const key of COUNTER_KEYS_TO_RESET) {
    console.log(`   • ${key} → 0`);
  }

  console.log('\n✅ Collections PRESERVED (no changes):');
  console.log('   • users');
  console.log('   • suppliers (balance reset only)');
  console.log('   • buyers (balance reset only)');
  console.log('   • producttypes');
  console.log('   • costtypes');
  console.log('   • logisticscompanies');
  console.log('   • deliverypersonnels');
  console.log('   • packettemplates');

  console.log('\n📦 After reset:');
  console.log('   • 3 sample dispatch orders will be created');

  console.log('\n' + '─'.repeat(40));
  console.log(`Total documents to delete: ${totalToDelete}`);
  console.log('─'.repeat(40) + '\n');

  if (isDryRun) {
    console.log('✅ Dry run complete. No changes were made.');
    return;
  }

  // Perform the reset
  console.log('\n⏳ Starting database reset...\n');

  // 1. Delete transactional collections
  console.log('Step 1/5: Deleting transactional data...');
  for (const collectionName of COLLECTIONS_TO_DELETE) {
    try {
      const result = await db.collection(collectionName).deleteMany({});
      console.log(`   ✓ ${collectionName}: deleted ${result.deletedCount} documents`);
    } catch (err) {
      console.log(`   ⚠ ${collectionName}: ${err.message}`);
    }
  }

  // 2. Reset supplier balances
  console.log('\nStep 2/5: Resetting supplier balances...');
  try {
    const supplierResult = await db.collection('suppliers').updateMany(
      {},
      { $set: { currentBalance: 0 } }
    );
    console.log(`   ✓ suppliers: reset ${supplierResult.modifiedCount} documents`);
  } catch (err) {
    console.log(`   ⚠ suppliers: ${err.message}`);
  }

  // 3. Reset buyer balances
  console.log('\nStep 3/5: Resetting buyer balances...');
  try {
    const buyerResult = await db.collection('buyers').updateMany(
      {},
      { $set: { currentBalance: 0, totalSales: 0 } }
    );
    console.log(`   ✓ buyers: reset ${buyerResult.modifiedCount} documents`);
  } catch (err) {
    console.log(`   ⚠ buyers: ${err.message}`);
  }

  // 4. Reset counters
  console.log('\nStep 4/5: Resetting counters...');
  try {
    for (const key of COUNTER_KEYS_TO_RESET) {
      await db.collection('counters').updateOne(
        { _id: key },
        { $set: { seq: 0 } },
        { upsert: true }
      );
      console.log(`   ✓ ${key}: reset to 0`);
    }
  } catch (err) {
    console.log(`   ⚠ counters: ${err.message}`);
  }

  // 5. Create sample dispatch orders
  console.log('\nStep 5/5: Creating sample dispatch orders...');
  await createSampleDispatchOrders();

  console.log('\n========================================');
  console.log('   ✅ DATABASE RESET COMPLETE');
  console.log('========================================\n');

  // Show final counts
  console.log('Final collection counts:');
  const finalStats = await getCollectionStats(db);
  for (const collectionName of COLLECTIONS_TO_DELETE) {
    console.log(`   • ${collectionName}: ${finalStats[collectionName] || 0} documents`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const isForce = args.includes('--force');

  try {
    if (!isDryRun && !isForce) {
      console.log('\n⚠️  WARNING: This will permanently delete all transactional data!');
      console.log('   Run with --dry-run first to see what will be deleted.\n');
      
      const confirmed = await promptConfirmation('Type "yes" to proceed: ');
      if (!confirmed) {
        console.log('\n❌ Operation cancelled.\n');
        process.exit(0);
      }
    }

    await resetDatabase(isDryRun);
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('Database connection closed.\n');
    process.exit(0);
  }
}

main();
