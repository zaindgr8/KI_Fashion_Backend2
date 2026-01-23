/**
 * Migration: Break History Schema Update
 * 
 * This migration converts the old breakHistory.loosePacketStockCreated (single ObjectId)
 * to the new breakHistory.loosePacketStocksCreated (array of variant-specific loose stocks).
 * 
 * Run with: node migrations/migrate-break-history-schema.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PacketStock = require('../models/PacketStock');

async function migrate() {
  try {
    // Connect to database
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/kifashion';
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB');

    // Find all packet stocks with break history that has the old schema
    const packetStocks = await PacketStock.find({
      'breakHistory.loosePacketStockCreated': { $exists: true, $ne: null },
      'breakHistory.loosePacketStocksCreated': { $exists: false }
    });

    console.log(`Found ${packetStocks.length} packet stocks to migrate`);

    let migratedCount = 0;
    let errorCount = 0;

    for (const packetStock of packetStocks) {
      try {
        let modified = false;

        for (const breakRecord of packetStock.breakHistory) {
          // Skip if already migrated or no loose stock was created
          if (breakRecord.loosePacketStocksCreated?.length > 0 || !breakRecord.loosePacketStockCreated) {
            continue;
          }

          // Get the old loose stock reference
          const oldLooseStock = await PacketStock.findById(breakRecord.loosePacketStockCreated);

          if (oldLooseStock) {
            // Convert old single reference to new array format
            // Since old system created one loose stock with all remaining items as composition,
            // we'll reference the same loose stock for backward compatibility
            breakRecord.loosePacketStocksCreated = [{
              looseStockId: oldLooseStock._id,
              barcode: oldLooseStock.barcode,
              size: oldLooseStock.composition?.[0]?.size || 'Mixed',
              color: oldLooseStock.composition?.[0]?.color || 'Mixed',
              quantity: oldLooseStock.totalItemsPerPacket || 1
            }];

            modified = true;
            console.log(`  Migrated break record for packet ${packetStock.barcode} -> ${oldLooseStock.barcode}`);
          } else {
            // Loose stock was deleted, skip migration for this record
            console.warn(`  Skipping break record for packet ${packetStock.barcode}: loose stock not found`);
          }
        }

        if (modified) {
          await packetStock.save();
          migratedCount++;
        }
      } catch (err) {
        console.error(`  Error migrating packet ${packetStock.barcode}:`, err.message);
        errorCount++;
      }
    }

    console.log('\n--- Migration Complete ---');
    console.log(`Successfully migrated: ${migratedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log(`Total processed: ${packetStocks.length}`);

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run migration
migrate();
