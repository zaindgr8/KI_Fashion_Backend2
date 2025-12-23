const mongoose = require('mongoose');
const ProductType = require('../models/ProductType');
const User = require('../models/User');
require('dotenv').config();

const productTypesData = [
  {
    name: 'Denim Jeans',
    description: 'Denim pants and jeans in various styles',
    category: 'Bottoms',
    attributes: [
      { name: 'Fit', type: 'text', required: true },
      { name: 'Wash', type: 'text', required: false },
      { name: 'Rise', type: 'text', required: false }
    ]
  },
  {
    name: 'T-Shirts',
    description: 'Casual t-shirts and tops',
    category: 'Tops',
    attributes: [
      { name: 'Neck Style', type: 'text', required: true },
      { name: 'Sleeve Length', type: 'text', required: true },
      { name: 'Fit', type: 'text', required: false }
    ]
  },
  {
    name: 'Jackets',
    description: 'Outerwear jackets and coats',
    category: 'Outerwear',
    attributes: [
      { name: 'Style', type: 'text', required: true },
      { name: 'Lining', type: 'text', required: false },
      { name: 'Season', type: 'text', required: true }
    ]
  },
  {
    name: 'Shirts',
    description: 'Formal and casual shirts',
    category: 'Tops',
    attributes: [
      { name: 'Collar Style', type: 'text', required: true },
      { name: 'Sleeve Length', type: 'text', required: true },
      { name: 'Fit', type: 'text', required: false }
    ]
  },
  {
    name: 'Hoodies & Sweatshirts',
    description: 'Casual hoodies and sweatshirts',
    category: 'Tops',
    attributes: [
      { name: 'Style', type: 'text', required: true },
      { name: 'Hood Type', type: 'text', required: false },
      { name: 'Zipper', type: 'boolean', required: false }
    ]
  },
  {
    name: 'Dresses',
    description: 'Women\'s dresses in various styles',
    category: 'Dresses',
    attributes: [
      { name: 'Length', type: 'text', required: true },
      { name: 'Occasion', type: 'text', required: false },
      { name: 'Silhouette', type: 'text', required: false }
    ]
  },
  {
    name: 'Skirts',
    description: 'Women\'s skirts',
    category: 'Bottoms',
    attributes: [
      { name: 'Length', type: 'text', required: true },
      { name: 'Style', type: 'text', required: true },
      { name: 'Waist Type', type: 'text', required: false }
    ]
  },
  {
    name: 'Shorts',
    description: 'Casual and athletic shorts',
    category: 'Bottoms',
    attributes: [
      { name: 'Length', type: 'text', required: true },
      { name: 'Style', type: 'text', required: false },
      { name: 'Elastic Waist', type: 'boolean', required: false }
    ]
  },
  {
    name: 'Activewear',
    description: 'Sports and fitness clothing',
    category: 'Activewear',
    attributes: [
      { name: 'Activity Type', type: 'text', required: true },
      { name: 'Compression', type: 'boolean', required: false },
      { name: 'Moisture Wicking', type: 'boolean', required: false }
    ]
  },
  {
    name: 'Sweaters & Cardigans',
    description: 'Knit sweaters and cardigans',
    category: 'Tops',
    attributes: [
      { name: 'Knit Type', type: 'text', required: true },
      { name: 'Closure', type: 'text', required: false },
      { name: 'Weight', type: 'text', required: false }
    ]
  },
  {
    name: 'Accessories',
    description: 'Fashion accessories',
    category: 'Accessories',
    attributes: [
      { name: 'Type', type: 'text', required: true },
      { name: 'Size', type: 'text', required: false }
    ]
  },
  {
    name: 'Footwear',
    description: 'Shoes and sandals',
    category: 'Footwear',
    attributes: [
      { name: 'Type', type: 'text', required: true },
      { name: 'Sole Material', type: 'text', required: false },
      { name: 'Heel Height', type: 'text', required: false }
    ]
  }
];

async function seedProductTypes() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    console.log('MongoDB connected successfully');

    // Find an admin user or create a system user
    let adminUser = await User.findOne({ role: 'admin' });
    
    if (!adminUser) {
      console.log('No admin user found. Creating system user for seeding...');
      adminUser = new User({
        name: 'System Admin',
        email: 'admin@klfashion.com',
        password: 'Admin@123', // This will be hashed automatically
        role: 'admin',
        permissions: ['users', 'suppliers', 'buyers', 'products', 'sales', 'purchases', 'inventory', 'reports', 'expenses', 'delivery']
      });
      await adminUser.save();
      console.log('System admin user created');
    }

    console.log('Checking existing product types...');
    const existingCount = await ProductType.countDocuments();
    
    if (existingCount > 0) {
      console.log(`Found ${existingCount} existing product types.`);
      const userInput = process.argv[2];
      
      if (userInput !== '--force') {
        console.log('Use --force flag to delete existing product types and reseed');
        console.log('Example: node scripts/seedProductTypes.js --force');
        process.exit(0);
      }
      
      console.log('Deleting existing product types...');
      await ProductType.deleteMany({});
      console.log('Existing product types deleted');
    }

    console.log('Seeding product types...');
    
    const productTypesWithCreator = productTypesData.map(pt => ({
      ...pt,
      createdBy: adminUser._id
    }));

    const result = await ProductType.insertMany(productTypesWithCreator);
    
    console.log(`\n✅ Successfully seeded ${result.length} product types:`);
    result.forEach((pt, index) => {
      console.log(`   ${index + 1}. ${pt.name} (${pt.category})`);
    });

    console.log('\n📊 Summary:');
    console.log(`   Total product types created: ${result.length}`);
    console.log(`   Admin user: ${adminUser.email}`);
    console.log('\n✨ Product types are now available for suppliers to use!');

  } catch (error) {
    console.error('❌ Error seeding product types:', error);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('\nMongoDB connection closed');
    process.exit(0);
  }
}

// Run the seed function
seedProductTypes();
