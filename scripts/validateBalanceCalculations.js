/**
 * Balance Validation Script
 * 
 * This script compares the old (cached) balance values with the new (aggregation-based)
 * balance calculations to ensure consistency before removing deprecated fields.
 * 
 * Usage: node scripts/validateBalanceCalculations.js
 * 
 * What it validates:
 * 1. Supplier.currentBalance vs Ledger.getBalance('supplier', supplierId)
 * 2. Buyer.currentBalance vs Ledger.getBalance('buyer', buyerId)
 * 3. DispatchOrder.paymentDetails.remainingBalance vs calculated from Ledger
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');
const DispatchOrder = require('../models/DispatchOrder');

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

async function validateSupplierBalances() {
  console.log('\n========================================');
  console.log('VALIDATING SUPPLIER BALANCES');
  console.log('========================================\n');
  
  const suppliers = await Supplier.find({}).lean();
  let passed = 0;
  let failed = 0;
  const discrepancies = [];
  
  for (const supplier of suppliers) {
    const cachedBalance = supplier.currentBalance || 0;
    const calculatedBalance = await Ledger.getBalance('supplier', supplier._id);
    
    const diff = Math.abs(cachedBalance - calculatedBalance);
    const isMatch = diff < 0.01; // Allow for floating point precision
    
    if (isMatch) {
      passed++;
    } else {
      failed++;
      discrepancies.push({
        type: 'supplier',
        id: supplier._id,
        name: supplier.name,
        cached: cachedBalance,
        calculated: calculatedBalance,
        difference: cachedBalance - calculatedBalance
      });
    }
  }
  
  console.log(`Suppliers validated: ${suppliers.length}`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  
  if (discrepancies.length > 0) {
    console.log('\nDiscrepancies found:');
    discrepancies.forEach(d => {
      console.log(`  - ${d.name} (${d.id})`);
      console.log(`    Cached: ${d.cached.toFixed(2)}, Calculated: ${d.calculated.toFixed(2)}, Diff: ${d.difference.toFixed(2)}`);
    });
  }
  
  return { passed, failed, discrepancies };
}

async function validateBuyerBalances() {
  console.log('\n========================================');
  console.log('VALIDATING BUYER BALANCES');
  console.log('========================================\n');
  
  const buyers = await Buyer.find({}).lean();
  let passed = 0;
  let failed = 0;
  const discrepancies = [];
  
  for (const buyer of buyers) {
    const cachedBalance = buyer.currentBalance || 0;
    const calculatedBalance = await Ledger.getBalance('buyer', buyer._id);
    
    const diff = Math.abs(cachedBalance - calculatedBalance);
    const isMatch = diff < 0.01;
    
    if (isMatch) {
      passed++;
    } else {
      failed++;
      discrepancies.push({
        type: 'buyer',
        id: buyer._id,
        name: buyer.name,
        cached: cachedBalance,
        calculated: calculatedBalance,
        difference: cachedBalance - calculatedBalance
      });
    }
  }
  
  console.log(`Buyers validated: ${buyers.length}`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  
  if (discrepancies.length > 0) {
    console.log('\nDiscrepancies found:');
    discrepancies.forEach(d => {
      console.log(`  - ${d.name} (${d.id})`);
      console.log(`    Cached: ${d.cached.toFixed(2)}, Calculated: ${d.calculated.toFixed(2)}, Diff: ${d.difference.toFixed(2)}`);
    });
  }
  
  return { passed, failed, discrepancies };
}

async function validateDispatchOrderBalances() {
  console.log('\n========================================');
  console.log('VALIDATING DISPATCH ORDER PAYMENT STATUS');
  console.log('========================================\n');
  
  const orders = await DispatchOrder.find({ status: 'confirmed' }).lean();
  let passed = 0;
  let failed = 0;
  const discrepancies = [];
  
  for (const order of orders) {
    const cachedRemaining = order.paymentDetails?.remainingBalance ?? order.remainingBalance ?? 0;
    
    // Calculate remaining from ledger
    const payments = await Ledger.getOrderPayments(order._id);
    const orderTotal = order.supplierPaymentTotal - (order.totalDiscount || 0);
    const calculatedRemaining = orderTotal - payments.total;
    
    const diff = Math.abs(cachedRemaining - calculatedRemaining);
    const isMatch = diff < 0.01;
    
    if (isMatch) {
      passed++;
    } else {
      failed++;
      discrepancies.push({
        type: 'dispatchOrder',
        id: order._id,
        orderNumber: order.orderNumber,
        cached: cachedRemaining,
        calculated: calculatedRemaining,
        difference: cachedRemaining - calculatedRemaining
      });
    }
  }
  
  console.log(`Dispatch Orders validated: ${orders.length}`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  
  if (discrepancies.length > 0 && discrepancies.length <= 20) {
    console.log('\nDiscrepancies found:');
    discrepancies.forEach(d => {
      console.log(`  - ${d.orderNumber} (${d.id})`);
      console.log(`    Cached: ${d.cached.toFixed(2)}, Calculated: ${d.calculated.toFixed(2)}, Diff: ${d.difference.toFixed(2)}`);
    });
  } else if (discrepancies.length > 20) {
    console.log(`\n${discrepancies.length} discrepancies found (showing first 20):`);
    discrepancies.slice(0, 20).forEach(d => {
      console.log(`  - ${d.orderNumber}: Cached ${d.cached.toFixed(2)}, Calculated ${d.calculated.toFixed(2)}`);
    });
  }
  
  return { passed, failed, discrepancies };
}

async function validateLedgerRunningBalances() {
  console.log('\n========================================');
  console.log('VALIDATING LEDGER RUNNING BALANCES');
  console.log('========================================\n');
  
  // Get unique entity types and IDs
  const entities = await Ledger.aggregate([
    { $group: { _id: { type: '$type', entityId: '$entityId' } } }
  ]);
  
  let passed = 0;
  let failed = 0;
  const discrepancies = [];
  
  for (const entity of entities) {
    const { type, entityId } = entity._id;
    
    // Get last entry's running balance (legacy method)
    const lastEntry = await Ledger.findOne({ type, entityId }).sort({ date: -1, createdAt: -1 });
    const cachedBalance = lastEntry?.balance || 0;
    
    // Calculate via aggregation (new method)
    const calculatedBalance = await Ledger.getBalance(type, entityId);
    
    const diff = Math.abs(cachedBalance - calculatedBalance);
    const isMatch = diff < 0.01;
    
    if (isMatch) {
      passed++;
    } else {
      failed++;
      discrepancies.push({
        type,
        entityId,
        cached: cachedBalance,
        calculated: calculatedBalance,
        difference: cachedBalance - calculatedBalance
      });
    }
  }
  
  console.log(`Ledger entities validated: ${entities.length}`);
  console.log(`  ✓ Passed: ${passed}`);
  console.log(`  ✗ Failed: ${failed}`);
  
  if (discrepancies.length > 0 && discrepancies.length <= 20) {
    console.log('\nDiscrepancies found:');
    discrepancies.forEach(d => {
      console.log(`  - ${d.type}:${d.entityId}`);
      console.log(`    Cached: ${d.cached.toFixed(2)}, Calculated: ${d.calculated.toFixed(2)}, Diff: ${d.difference.toFixed(2)}`);
    });
  }
  
  return { passed, failed, discrepancies };
}

async function main() {
  await connectDB();
  
  console.log('='.repeat(50));
  console.log('BALANCE VALIDATION SCRIPT');
  console.log('Comparing cached values vs aggregation calculations');
  console.log('='.repeat(50));
  
  const results = {
    supplier: await validateSupplierBalances(),
    buyer: await validateBuyerBalances(),
    dispatchOrder: await validateDispatchOrderBalances(),
    ledgerRunning: await validateLedgerRunningBalances()
  };
  
  console.log('\n========================================');
  console.log('SUMMARY');
  console.log('========================================\n');
  
  let totalPassed = 0;
  let totalFailed = 0;
  
  for (const [category, result] of Object.entries(results)) {
    console.log(`${category}: ${result.passed} passed, ${result.failed} failed`);
    totalPassed += result.passed;
    totalFailed += result.failed;
  }
  
  console.log('\n----------------------------------------');
  console.log(`TOTAL: ${totalPassed} passed, ${totalFailed} failed`);
  
  if (totalFailed > 0) {
    console.log('\n⚠️  DISCREPANCIES FOUND');
    console.log('The cached values do not match aggregation calculations.');
    console.log('Review the discrepancies above before removing deprecated fields.');
    console.log('You may need to sync cached values with ledger data first.');
  } else {
    console.log('\n✓ ALL VALIDATIONS PASSED');
    console.log('Cached values match aggregation calculations.');
    console.log('Safe to proceed with removing deprecated fields.');
  }
  
  await mongoose.connection.close();
  console.log('\n✓ Database connection closed');
  
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(error => {
  console.error('Script error:', error);
  process.exit(1);
});

