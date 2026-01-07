/**
 * Migration Script: Populate Supplier for Existing Products
 * 
 * This script populates the `supplier` field for existing products that don't have one.
 * It uses the inventory's purchaseBatches to determine the primary supplier.
 * 
 * Run: node migrations/migrate-product-suppliers.js
 */

const mongoose = require('mongoose');
require('dotenv').config();

// Connect to MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/ki_fashion';

async function migrate() {
    try {
        console.log('Connecting to MongoDB...');
        await mongoose.connect(MONGODB_URI);
        console.log('Connected to MongoDB');

        const Product = require('../models/Product');
        const Inventory = require('../models/Inventory');

        // Find all products without a supplier field
        const productsWithoutSupplier = await Product.find({
            $or: [
                { supplier: { $exists: false } },
                { supplier: null }
            ]
        });

        console.log(`Found ${productsWithoutSupplier.length} products without supplier`);

        let updated = 0;
        let skipped = 0;
        let errors = 0;

        for (const product of productsWithoutSupplier) {
            try {
                // Try to find supplier from inventory purchaseBatches
                const inventory = await Inventory.findOne({ product: product._id });

                let supplierId = null;

                // Strategy 1: Get supplier from purchaseBatches (most reliable)
                if (inventory && inventory.purchaseBatches && inventory.purchaseBatches.length > 0) {
                    // Get the most recent batch's supplier
                    const sortedBatches = inventory.purchaseBatches
                        .filter(b => b.supplierId)
                        .sort((a, b) => new Date(b.purchaseDate) - new Date(a.purchaseDate));

                    if (sortedBatches.length > 0) {
                        supplierId = sortedBatches[0].supplierId;
                    }
                }

                // Strategy 2: Get from product.suppliers array
                if (!supplierId && product.suppliers && product.suppliers.length > 0) {
                    // Prefer primary supplier
                    const primarySupplier = product.suppliers.find(s => s.isPrimary);
                    if (primarySupplier && primarySupplier.supplier) {
                        supplierId = primarySupplier.supplier;
                    } else if (product.suppliers[0].supplier) {
                        supplierId = product.suppliers[0].supplier;
                    }
                }

                if (supplierId) {
                    // Update product with supplier
                    await Product.updateOne(
                        { _id: product._id },
                        { $set: { supplier: supplierId } }
                    );
                    updated++;
                    console.log(`✓ Updated product ${product.sku} with supplier ${supplierId}`);
                } else {
                    skipped++;
                    console.log(`⚠ Skipped product ${product.sku} - no supplier found`);
                }
            } catch (err) {
                errors++;
                console.error(`✗ Error updating product ${product.sku}:`, err.message);
            }
        }

        console.log('\n=== Migration Summary ===');
        console.log(`Total products without supplier: ${productsWithoutSupplier.length}`);
        console.log(`Updated: ${updated}`);
        console.log(`Skipped (no supplier found): ${skipped}`);
        console.log(`Errors: ${errors}`);

        // Drop the old unique index on sku and create new compound index
        console.log('\n=== Updating Indexes ===');
        try {
            const collection = mongoose.connection.collection('products');

            // List existing indexes
            const indexes = await collection.indexes();
            console.log('Current indexes:', indexes.map(i => i.name));

            // Drop old sku_1 unique index if it exists
            const skuIndex = indexes.find(i => i.name === 'sku_1' && i.unique);
            if (skuIndex) {
                console.log('Dropping old sku_1 unique index...');
                await collection.dropIndex('sku_1');
                console.log('Old index dropped');
            }

            // The new compound index {sku: 1, supplier: 1} should be created by Mongoose
            // when the model is loaded with the updated schema
            console.log('New compound index will be created on next app start');

        } catch (indexError) {
            console.error('Index update error:', indexError.message);
            console.log('Note: You may need to manually update indexes');
        }

        await mongoose.disconnect();
        console.log('\nMigration complete!');

    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
