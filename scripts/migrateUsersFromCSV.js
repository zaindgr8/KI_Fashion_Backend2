const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
require('dotenv').config();

// Import models
const User = require('../models/User');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');

// Configuration
const DEFAULT_PASSWORD = '123456789';
const MIGRATION_BOT_EMAIL = 'migrationbot@kifashion.com';
const MIGRATION_BOT_NAME = 'Migration Bot';

// Stats tracking
const stats = {
  suppliers: { created: 0, skipped: 0, errors: [] },
  buyers: { created: 0, skipped: 0, errors: [] },
  users: { created: 0 }
};

// ID Mappings for subsequent migrations
const idMappings = {
  suppliers: {},
  buyers: {}
};

/**
 * Connect to MongoDB
 */
async function connectDB() {
  try {
    const uri = process.env.MONGODB_URI || 'mongodb+srv://klfashionuk:admin@cluster0.vndfpcl.mongodb.net/migration_db';
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
    });
    console.log('MongoDB Connected');
  } catch (error) {
    console.error('Database connection failed:', error.message);
    process.exit(1);
  }
}

/**
 * Get or create Migration Bot user
 */
async function getOrCreateMigrationBot() {
  let bot = await User.findOne({ email: MIGRATION_BOT_EMAIL });

  if (!bot) {
    bot = await User.create({
      name: MIGRATION_BOT_NAME,
      email: MIGRATION_BOT_EMAIL,
      password: DEFAULT_PASSWORD,
      role: 'admin',
      portalAccess: ['crm'],
      signupSource: 'import',
      isActive: true,
      permissions: ['users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery']
    });
    console.log('Migration Bot user created');
  } else {
    console.log('Migration Bot user found');
  }

  return bot;
}

/**
 * Parse CSV file and return array of records
 */
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', (error) => reject(error));
  });
}

/**
 * Sanitize string for email use (remove spaces, special chars, convert to lowercase)
 */
function sanitizeForEmail(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '') // Remove all non-alphanumeric characters
    .trim();
}

/**
 * Generate unique email for supplier: supplier_firstname_legacyid@kifashion.com
 */
async function generateUniqueSupplierEmail(name, legacyId, attempt = 0) {
  // Extract first name (first word of the name)
  const firstName = name.split(/\s+/)[0];
  const sanitizedFirstName = sanitizeForEmail(firstName);
  const sanitizedLegacyId = sanitizeForEmail(legacyId);

  const suffix = attempt > 0 ? attempt : '';
  const email = `${sanitizedFirstName}_${sanitizedLegacyId}@kifashion.com`;

  const exists = await User.findOne({ email });

  if (exists) {
    return generateUniqueSupplierEmail(name, legacyId, attempt + 1);
  }

  return email;
}

/**
 * Migrate Suppliers
 */
async function migrateSuppliers(csvPath, migrationBot) {
  console.log('\nStarting Supplier Migration...');
  const suppliers = await parseCSV(csvPath);
  console.log('Found ' + suppliers.length + ' suppliers in CSV');

  for (const row of suppliers) {
    try {
      const legacyId = (row.Sup_Id || row.sup_id || '').trim();
      const name = (row.Name || '').trim();
      const phone = (row.Phone || '').trim() || ('MIGRATED-SUP-' + legacyId);
      const email = (row.Email || '').trim() || null;
      const address = (row.Address || '').trim() || null;

      if (!legacyId || !name) {
        stats.suppliers.errors.push({ legacyId, error: 'Missing legacyId or name' });
        stats.suppliers.skipped++;
        continue;
      }

      // Idempotency: skip if already migrated
      const existingSupplier = await Supplier.findOne({ 'metadata.legacyId': legacyId });
      if (existingSupplier) {
        idMappings.suppliers[legacyId] = {
          mongoId: existingSupplier._id.toString(),
          userId: existingSupplier.userId?.toString(),
          supplierId: existingSupplier.supplierId,
          loginEmail: 'existing'
        };
        stats.suppliers.skipped++;
        continue;
      }

      // Generate unique email: supplier_firstname_legacyid@kifashion.com
      const userEmail = await generateUniqueSupplierEmail(name, legacyId);

      // Create User account for supplier (with login access)
      const user = await User.create({
        name: name,
        email: userEmail,
        password: DEFAULT_PASSWORD,
        role: 'supplier',
        phone: phone.startsWith('MIGRATED-') ? undefined : phone,
        address: address || undefined,
        portalAccess: ['supplier'],
        signupSource: 'import',
        isActive: true,
        profileComplete: false, // Flag for incomplete profile
        requiresProfileUpdate: true, // Admin can filter by this
        metadata: {
          isMigrated: true,
          migratedAt: new Date(),
          needsInfoUpdate: true,
          legacyId: legacyId
        }
      });
      stats.users.created++;

      // Create Supplier record
      const supplier = await Supplier.create({
        supplierId: legacyId, // Set legacy ID as supplierId
        name: name,
        phone: phone,
        email: email || undefined,
        address: address ? { street: address, country: 'UK' } : { country: 'UK' },
        supplierType: 'wholesale',
        paymentTerms: 'net30',
        isActive: true,
        createdBy: migrationBot._id,
        userId: user._id,
        notes: '[MIGRATED] Legacy ID: ' + legacyId + ' | Imported: ' + new Date().toISOString(),
        metadata: {
          isMigrated: true,
          migratedAt: new Date(),
          requiresVerification: true,
          legacyId: legacyId
        }
      });

      // Link User to Supplier
      user.supplier = supplier._id;
      await user.save();

      // Store mapping
      idMappings.suppliers[legacyId] = {
        mongoId: supplier._id.toString(),
        userId: user._id.toString(),
        supplierId: legacyId, // This is now the same as legacy ID
        loginEmail: userEmail
      };

      stats.suppliers.created++;

      if (stats.suppliers.created % 50 === 0) {
        console.log('Processed ' + stats.suppliers.created + ' suppliers...');
      }

    } catch (error) {
      const legacyId = (row.Sup_Id || row.sup_id || 'unknown').trim();
      stats.suppliers.errors.push({ legacyId, error: error.message });
      stats.suppliers.skipped++;
    }
  }

  console.log('Supplier migration complete: ' + stats.suppliers.created + ' created, ' + stats.suppliers.skipped + ' skipped');
}

/**
 * Migrate Buyers (NO login access - just Buyer records)
 */
async function migrateBuyers(csvPath, migrationBot) {
  console.log('\nStarting Buyer Migration...');
  const buyers = await parseCSV(csvPath);
  console.log('Found ' + buyers.length + ' buyers in CSV');

  for (const row of buyers) {
    try {
      const legacyId = (row.Buyer_Id || row.buyer_id || '').trim();
      const name = (row.Name || '').trim();
      const phone = (row.Phone || '').trim() || ('MIGRATED-BUY-' + legacyId);
      const email = (row.Email || '').trim() || null;
      const address = (row.Address || '').trim() || null;

      if (!legacyId || !name) {
        stats.buyers.errors.push({ legacyId, error: 'Missing legacyId or name' });
        stats.buyers.skipped++;
        continue;
      }

      // Idempotency: skip if already migrated
      const existingBuyer = await Buyer.findOne({ 'metadata.legacyId': legacyId });
      if (existingBuyer) {
        idMappings.buyers[legacyId] = {
          mongoId: existingBuyer._id.toString(),
          buyerId: existingBuyer.buyerId
        };
        stats.buyers.skipped++;
        continue;
      }

      // Create Buyer record (NO User account for buyers)
      const buyer = await Buyer.create({
        buyerId: legacyId, // Set legacy ID as buyerId
        name: name,
        phone: phone,
        email: email || undefined,
        address: address ? { street: address, country: 'UK' } : { country: 'UK' },
        customerType: 'retail',
        paymentTerms: 'cash',
        isActive: true,
        createdBy: migrationBot._id,
        notes: '[MIGRATED] Legacy ID: ' + legacyId + ' | Imported: ' + new Date().toISOString(),
        metadata: {
          isMigrated: true,
          migratedAt: new Date(),
          requiresVerification: true,
          needsContactUpdate: true,
          legacyId: legacyId
        }
      });

      // Store mapping
      idMappings.buyers[legacyId] = {
        mongoId: buyer._id.toString(),
        buyerId: legacyId // This is now the same as legacy ID
      };

      stats.buyers.created++;

      if (stats.buyers.created % 100 === 0) {
        console.log('Processed ' + stats.buyers.created + ' buyers...');
      }

    } catch (error) {
      const legacyId = (row.Buyer_Id || row.buyer_id || 'unknown').trim();
      stats.buyers.errors.push({ legacyId, error: error.message });
      stats.buyers.skipped++;
    }
  }

  console.log('Buyer migration complete: ' + stats.buyers.created + ' created, ' + stats.buyers.skipped + ' skipped');
}

/**
 * Save ID mappings to JSON files
 */
function saveMappings(outputDir) {
  const supplierMappingPath = path.join(outputDir, 'supplier-id-mapping.json');
  const buyerMappingPath = path.join(outputDir, 'buyer-id-mapping.json');

  fs.writeFileSync(supplierMappingPath, JSON.stringify(idMappings.suppliers, null, 2));
  fs.writeFileSync(buyerMappingPath, JSON.stringify(idMappings.buyers, null, 2));

  console.log('\nID mappings saved to:');
  console.log('  - ' + supplierMappingPath);
  console.log('  - ' + buyerMappingPath);
}

/**
 * Rollback migration (delete all migrated records)
 */
async function rollback() {
  console.log('\nRolling back migration...');

  // Find all migrated suppliers and their users
  const migratedSuppliers = await Supplier.find({ notes: /\[MIGRATED\]/ });
  const supplierUserIds = migratedSuppliers.map(s => s.userId).filter(Boolean);

  // Delete supplier users
  const userResult = await User.deleteMany({
    $or: [
      { _id: { $in: supplierUserIds } },
      { email: MIGRATION_BOT_EMAIL }
    ]
  });
  console.log('Deleted ' + userResult.deletedCount + ' users');

  // Delete suppliers
  const supplierResult = await Supplier.deleteMany({ notes: /\[MIGRATED\]/ });
  console.log('Deleted ' + supplierResult.deletedCount + ' suppliers');

  // Delete buyers
  const buyerResult = await Buyer.deleteMany({ notes: /\[MIGRATED\]/ });
  console.log('Deleted ' + buyerResult.deletedCount + ' buyers');

  console.log('Rollback complete');
}

/**
 * Main execution
 */
async function main() {
  const args = process.argv.slice(2);

  // Check for rollback flag
  if (args.includes('--rollback')) {
    await connectDB();
    await rollback();
    await mongoose.connection.close();
    process.exit(0);
  }

  // Check for clean flag (delete existing migrated data, then re-import)
  const isClean = args.includes('--clean');
  if (isClean) {
    console.log('--clean flag detected: will delete existing migrated data before importing');
  }

  // Parse arguments
  const suppliersIndex = args.indexOf('--suppliers');
  const buyersIndex = args.indexOf('--buyers');
  const suppliersCsvPath = suppliersIndex !== -1 ? args[suppliersIndex + 1] : null;
  const buyersCsvPath = buyersIndex !== -1 ? args[buyersIndex + 1] : null;

  if (!suppliersCsvPath && !buyersCsvPath) {
    console.log('Usage:');
    console.log('  node migrateUsersFromCSV.js --suppliers <suppliers.csv> --buyers <buyers.csv>');
    console.log('  node migrateUsersFromCSV.js --rollback');
    process.exit(1);
  }

  // Validate file paths
  if (suppliersCsvPath && !fs.existsSync(suppliersCsvPath)) {
    console.error('Suppliers CSV not found: ' + suppliersCsvPath);
    process.exit(1);
  }
  if (buyersCsvPath && !fs.existsSync(buyersCsvPath)) {
    console.error('Buyers CSV not found: ' + buyersCsvPath);
    process.exit(1);
  }

  console.log('KI Fashion Data Migration - Users (Suppliers & Buyers)');
  console.log('=========================================================');

  await connectDB();

  // If --clean, rollback first then continue with fresh import
  if (isClean) {
    await rollback();
    console.log('\nClean rollback complete. Starting fresh import...\n');
  }

  // Get or create migration bot
  const migrationBot = await getOrCreateMigrationBot();

  // Run migrations
  if (suppliersCsvPath) {
    await migrateSuppliers(suppliersCsvPath, migrationBot);
  }

  if (buyersCsvPath) {
    await migrateBuyers(buyersCsvPath, migrationBot);
  }

  // Save mappings
  const outputDir = path.dirname(suppliersCsvPath || buyersCsvPath);
  saveMappings(outputDir);

  // Print summary
  console.log('\nMigration Summary');
  console.log('====================');
  console.log('Suppliers: ' + stats.suppliers.created + ' created, ' + stats.suppliers.skipped + ' skipped');
  console.log('Buyers: ' + stats.buyers.created + ' created, ' + stats.buyers.skipped + ' skipped');
  console.log('Users: ' + stats.users.created + ' created (for suppliers only)');

  if (stats.suppliers.errors.length > 0 || stats.buyers.errors.length > 0) {
    console.log('\nErrors:');
    stats.suppliers.errors.forEach(e => console.log('  Supplier ' + e.legacyId + ': ' + e.error));
    stats.buyers.errors.forEach(e => console.log('  Buyer ' + e.legacyId + ': ' + e.error));
  }

  console.log('\nMigration complete!');
  console.log('\nSupplier Login Credentials:');
  console.log('  Email format: supplier_firstname_legacyid@kifashion.com');
  console.log('  Password: 123456789');

  await mongoose.connection.close();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});