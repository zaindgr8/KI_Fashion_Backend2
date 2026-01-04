// MongoDB shell script to add logistics companies
// Run this in MongoDB shell: mongosh <database_name> < add-logistics-companies.js
// Or run: mongosh "mongodb://localhost:27017/erp_database" < add-logistics-companies.js

// Get an admin user ID (required for createdBy field)
const adminUser = db.users.findOne({ role: 'super-admin' });

if (!adminUser) {
  print('Error: No admin user found. Please create an admin user first.');
  print('Alternatively, find any user ID and replace the createdBy field below.');
} else {
  print('Using admin user:', adminUser.email, 'as createdBy');
}

// If no admin found, you can manually set a user ID
// const adminUserId = ObjectId('YOUR_USER_ID_HERE');

const adminUserId = adminUser ? adminUser._id : null;

if (!adminUserId) {
  print('\nERROR: Cannot proceed without a user ID.');
  print('Please either:');
  print('1. Create an admin user first, or');
  print('2. Find any user ID and update the script');
  quit(1);
}

// Insert logistics companies
const companies = [
  {
    name: 'FedEx',
    code: 'LOG0001',
    contactInfo: {
      phone: '+1-800-463-3339',
      email: 'contact@fedex.com',
      address: {
        country: 'Pakistan'
      }
    },
    isActive: true,
    rating: 5,
    notes: 'FedEx Corporation - Express shipping services',
    createdBy: adminUserId,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'DHL',
    code: 'LOG0002',
    contactInfo: {
      phone: '+92-21-111-345-111',
      email: 'pakistan@dhl.com',
      address: {
        country: 'Pakistan'
      }
    },
    isActive: true,
    rating: 5,
    notes: 'DHL Express - International shipping and logistics',
    createdBy: adminUserId,
    createdAt: new Date(),
    updatedAt: new Date()
  },
  {
    name: 'BritGo',
    code: 'LOG0003',
    contactInfo: {
      phone: '+92-300-1234567',
      email: 'info@britgo.com',
      address: {
        country: 'Pakistan'
      }
    },
    isActive: true,
    rating: 4,
    notes: 'BritGo Logistics - Local and international shipping',
    createdBy: adminUserId,
    createdAt: new Date(),
    updatedAt: new Date()
  }
];

// Insert companies
const result = db.logisticscompanies.insertMany(companies);

print('\n✅ Successfully inserted', result.insertedCount, 'logistics companies:');
print('- FedEx');
print('- DHL');
print('- BritGo');
print('\nInserted IDs:', result.insertedIds);

