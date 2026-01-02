/**
 * Cleanup Redundant Fields Script
 * 
 * This script removes deprecated balance-related fields after validating
 * that all balances are calculated correctly from the Ledger.
 * 
 * IMPORTANT: Run validateBalanceCalculations.js first!
 * 
 * Usage: node scripts/cleanupRedundantFields.js [--dry-run] [--force]
 * 
 * Options:
 *   --dry-run  Show what would be changed without making changes
 *   --force    Skip validation check and proceed with cleanup
 * 
 * What it removes:
 * 1. Supplier.currentBalance (sets to null, field still exists in schema)
 * 2. Buyer.currentBalance (sets to null, field still exists in schema)
 * 3. DispatchOrder.paymentDetails.remainingBalance (sets to null)
 * 4. DispatchOrder flat payment fields (sets to null)
 * 5. Ledger.balance running balance field (sets to null)
 * 
 * Note: This script does NOT modify the schema - you'll need to remove
 * the deprecated fields from the model files separately after confirming
 * the cleanup works correctly.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');
const DispatchOrder = require('../models/DispatchOrder');

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ki_fashion';

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✓ Connected to MongoDB');
  } catch (error) {
    console.error('✗ MongoDB connection error:', error.message);
    process.exit(1);
  }
}

async function runValidation() {
  console.log('\nRunning balance validation...');
  
  // Check supplier balances
  const suppliers = await Supplier.find({}).lean();
  let supplierMismatches = 0;
  
  for (const supplier of suppliers) {
    const cached = supplier.currentBalance || 0;
    const calculated = await Ledger.getBalance('supplier', supplier._id);
    if (Math.abs(cached - calculated) > 0.01) {
      supplierMismatches++;
    }
  }
  
  // Check buyer balances
  const buyers = await Buyer.find({}).lean();
  let buyerMismatches = 0;
  
  for (const buyer of buyers) {
    const cached = buyer.currentBalance || 0;
    const calculated = await Ledger.getBalance('buyer', buyer._id);
    if (Math.abs(cached - calculated) > 0.01) {
      buyerMismatches++;
    }
  }
  
  const totalMismatches = supplierMismatches + buyerMismatches;
  
  if (totalMismatches > 0) {
    console.log(`⚠️  Found ${totalMismatches} balance mismatches`);
    console.log(`   Suppliers: ${supplierMismatches}, Buyers: ${buyerMismatches}`);
    return false;
  }
  
  console.log('✓ All balance validations passed');
  return true;
}

async function cleanupSupplierBalances() {
  console.log('\n--- Cleaning up Supplier.currentBalance ---');
  
  const count = await Supplier.countDocuments({ currentBalance: { $exists: true, $ne: null } });
  console.log(`Found ${count} suppliers with currentBalance set`);
  
  if (!DRY_RUN) {
    const result = await Supplier.updateMany(
      { currentBalance: { $exists: true } },
      { $unset: { currentBalance: '' } }
    );
    console.log(`✓ Removed currentBalance from ${result.modifiedCount} suppliers`);
    return result.modifiedCount;
  } else {
    console.log('[DRY RUN] Would remove currentBalance from suppliers');
    return 0;
  }
}

async function cleanupBuyerBalances() {
  console.log('\n--- Cleaning up Buyer.currentBalance ---');
  
  const count = await Buyer.countDocuments({ currentBalance: { $exists: true, $ne: null } });
  console.log(`Found ${count} buyers with currentBalance set`);
  
  if (!DRY_RUN) {
    const result = await Buyer.updateMany(
      { currentBalance: { $exists: true } },
      { $unset: { currentBalance: '' } }
    );
    console.log(`✓ Removed currentBalance from ${result.modifiedCount} buyers`);
    return result.modifiedCount;
  } else {
    console.log('[DRY RUN] Would remove currentBalance from buyers');
    return 0;
  }
}

async function cleanupDispatchOrderPaymentFields() {
  console.log('\n--- Cleaning up DispatchOrder payment fields ---');
  
  const count = await DispatchOrder.countDocuments({
    $or: [
      { 'paymentDetails.remainingBalance': { $exists: true } },
      { remainingBalance: { $exists: true } },
      { cashPayment: { $exists: true } },
      { bankPayment: { $exists: true } },
      { paymentStatus: { $exists: true } }
    ]
  });
  console.log(`Found ${count} dispatch orders with payment fields set`);
  
  if (!DRY_RUN) {
    // Note: We're unsetting the flat fields but keeping paymentDetails for now
    // as it may still be used for backward compatibility
    const result = await DispatchOrder.updateMany(
      {},
      {
        $unset: {
          cashPayment: '',
          bankPayment: '',
          remainingBalance: '',
          paymentStatus: ''
        }
      }
    );
    console.log(`✓ Removed flat payment fields from ${result.modifiedCount} dispatch orders`);
    return result.modifiedCount;
  } else {
    console.log('[DRY RUN] Would remove flat payment fields from dispatch orders');
    return 0;
  }
}

async function cleanupLedgerRunningBalances() {
  console.log('\n--- Cleaning up Ledger.balance running balances ---');
  
  const count = await Ledger.countDocuments({ balance: { $exists: true, $ne: null } });
  console.log(`Found ${count} ledger entries with running balance set`);
  
  if (!DRY_RUN) {
    const result = await Ledger.updateMany(
      { balance: { $exists: true } },
      { $unset: { balance: '' } }
    );
    console.log(`✓ Removed running balance from ${result.modifiedCount} ledger entries`);
    return result.modifiedCount;
  } else {
    console.log('[DRY RUN] Would remove running balance from ledger entries');
    return 0;
  }
}

async function main() {
  await connectDB();
  
  console.log('='.repeat(50));
  console.log('CLEANUP REDUNDANT FIELDS SCRIPT');
  if (DRY_RUN) console.log('MODE: DRY RUN (no changes will be made)');
  if (FORCE) console.log('MODE: FORCE (skipping validation)');
  console.log('='.repeat(50));
  
  // Run validation unless --force is passed
  if (!FORCE) {
    const isValid = await runValidation();
    if (!isValid) {
      console.log('\n✗ Validation failed. Fix discrepancies first or use --force to skip.');
      console.log('  Run: node scripts/validateBalanceCalculations.js for details');
      await mongoose.connection.close();
      process.exit(1);
    }
  }
  
  // Perform cleanup
  const results = {
    suppliers: await cleanupSupplierBalances(),
    buyers: await cleanupBuyerBalances(),
    dispatchOrders: await cleanupDispatchOrderPaymentFields(),
    ledgerEntries: await cleanupLedgerRunningBalances()
  };
  
  console.log('\n========================================');
  console.log('CLEANUP SUMMARY');
  console.log('========================================\n');
  
  if (DRY_RUN) {
    console.log('DRY RUN COMPLETE - No changes were made');
    console.log('Run without --dry-run to apply changes');
  } else {
    console.log('Cleanup complete!');
    console.log(`  Suppliers updated: ${results.suppliers}`);
    console.log(`  Buyers updated: ${results.buyers}`);
    console.log(`  Dispatch Orders updated: ${results.dispatchOrders}`);
    console.log(`  Ledger entries updated: ${results.ledgerEntries}`);
    
    console.log('\n⚠️  NEXT STEPS:');
    console.log('1. Test the application thoroughly');
    console.log('2. Once confirmed working, remove deprecated fields from model schemas:');
    console.log('   - models/Supplier.js: Remove currentBalance field');
    console.log('   - models/Buyer.js: Remove currentBalance field');
    console.log('   - models/DispatchOrder.js: Remove flat payment fields');
    console.log('   - models/Ledger.js: Remove balance field');
  }
  
  await mongoose.connection.close();
  console.log('\n✓ Database connection closed');
}

main().catch(error => {
  console.error('Script error:', error);
  process.exit(1);
});

