const express = require('express');
const Joi = require('joi');
const multer = require('multer');
const Product = require('../models/Product');
const Inventory = require('../models/Inventory');
const QRCode = require('qrcode');
const auth = require('../middleware/auth');
const { validateImageFile, uploadImage, deleteImage, generateSignedUrls } = require('../utils/imageUpload');
const { initializeGCS } = require('../config/gcs');

const router = express.Router();

// Initialize GCS on module load
try {
  initializeGCS();
} catch (error) {
  console.warn('GCS initialization warning (will retry on first use):', error.message);
}

// Configure multer for memory storage (we'll upload directly to GCS)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10) * 1024 * 1024 // Default 5MB
  }
});

const productSchema = Joi.object({
  name: Joi.string().min(2).max(100).required(),
  sku: Joi.string().required().uppercase(),
  supplier: Joi.string().optional(), // Primary supplier ObjectId (required by model, but optional here for backward compat)
  description: Joi.string().optional(),
  season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season')).min(1).required(),
  category: Joi.string().required(),
  brand: Joi.string().optional(),
  unit: Joi.string().valid('piece', 'kg', 'g', 'liter', 'ml', 'meter', 'cm', 'dozen', 'box', 'pack').default('piece'),
  pricing: Joi.object({
    costPrice: Joi.number().min(0).required(),
    sellingPrice: Joi.number().min(0).required(),
    wholesalePrice: Joi.number().min(0).optional(),
    minSellingPrice: Joi.number().min(0).optional()
  }).required(),
  inventory: Joi.object({
    currentStock: Joi.number().min(0).default(0),
    minStockLevel: Joi.number().min(0).default(0),
    maxStockLevel: Joi.number().min(0).default(1000),
    reorderLevel: Joi.number().min(0).default(10)
  }).optional(),
  suppliers: Joi.array().items(Joi.object({
    supplier: Joi.string().required(),
    supplierPrice: Joi.number().min(0).optional(),
    isPrimary: Joi.boolean().default(false)
  })).optional(),
  specifications: Joi.object({
    weight: Joi.number().optional(),
    dimensions: Joi.object({
      length: Joi.number().optional(),
      width: Joi.number().optional(),
      height: Joi.number().optional()
    }).optional(),
    color: Joi.string().optional(),
    material: Joi.string().optional()
  }).optional(),
  images: Joi.array().items(Joi.string()).optional(),
  barcode: Joi.string().optional(),
  taxRate: Joi.number().min(0).max(100).default(0),
  size: Joi.string().allow('', null).optional(),
  color: Joi.string().allow('', null).optional()
});

const PRODUCT_QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  type: 'image/png',
  scale: 6,
  margin: 1
};

function buildProductQrPayload(product) {
  const supplierIds = (product.suppliers || [])
    .map((entry) => {
      if (!entry) return null;
      if (typeof entry.supplier === 'object' && entry.supplier !== null && entry.supplier._id) {
        return entry.supplier._id.toString();
      }
      return entry.supplier ? entry.supplier.toString() : null;
    })
    .filter(Boolean);

  return {
    productId: product._id.toString(),
    sku: product.sku,
    name: product.name,
    supplierIds,
    generatedAt: new Date().toISOString()
  };
}

async function attachQrCode(product, userId) {
  if (!product) {
    return null;
  }

  const payload = buildProductQrPayload(product);
  const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), PRODUCT_QR_OPTIONS);

  product.qrCode = {
    dataUrl,
    payload,
    generatedAt: new Date(),
    generatedBy: userId
  };

  await product.save();
  return product;
}

const PRODUCT_POPULATE_PATHS = [
  { path: 'supplier', select: 'name company phone email' },
  { path: 'suppliers.supplier', select: 'name company phone email' },
  { path: 'createdBy', select: 'name' },
  { path: 'qrCode.generatedBy', select: 'name' }
];

function populateProductQuery(query) {
  return query.populate(PRODUCT_POPULATE_PATHS);
}

async function populateProductDocument(document) {
  if (!document) {
    return null;
  }
  await document.populate(PRODUCT_POPULATE_PATHS);
  return document;
}

/**
 * Convert product images to signed URLs
 * @param {Object|Array} products - Product document(s) or array of products
 * @param {Object} options - Options for image conversion
 * @param {boolean} options.primaryOnly - If true, only return the first image (for list views)
 * @returns {Promise<Object|Array>} Product(s) with signed image URLs
 */
async function convertProductImagesToSignedUrls(products, options = {}) {
  if (!products) {
    return products;
  }

  const { primaryOnly = false } = options;
  const isArray = Array.isArray(products);
  const productsArray = isArray ? products : [products];

  // Process all products in parallel
  await Promise.all(productsArray.map(async (product) => {
    if (!product || !product.images || !Array.isArray(product.images)) {
      return;
    }

    // Convert images array to signed URLs
    if (product.images.length > 0) {
      // For list views, only process and return the first image
      if (primaryOnly) {
        const signedUrls = await generateSignedUrls([product.images[0]]);
        product.images = signedUrls;
        product.primaryImage = signedUrls[0] || null;
        product.totalImages = product.images.length; // Store total count for UI indication
      } else {
        product.images = await generateSignedUrls(product.images);
      }
    }
  }));

  return isArray ? productsArray : productsArray[0];
}

// Create product
router.post('/', auth, async (req, res) => {
  try {
    const { error } = productSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Determine supplier: from request body, or from first supplier in suppliers array, or from user's supplier
    let supplierId = req.body.supplier;
    if (!supplierId && req.body.suppliers && req.body.suppliers.length > 0) {
      supplierId = req.body.suppliers[0].supplier;
    }
    if (!supplierId && req.user.supplier) {
      supplierId = req.user.supplier;
    }

    // Product model requires supplier field
    if (!supplierId) {
      return res.status(400).json({
        success: false,
        message: 'Supplier is required. Please provide a supplier ID.'
      });
    }

    // Check if SKU already exists for this supplier (compound unique index: sku + supplier)
    const existingProduct = await Product.findOne({
      sku: req.body.sku.toUpperCase(),
      supplier: supplierId
    });
    if (existingProduct) {
      return res.status(400).json({
        success: false,
        message: 'A product with this SKU already exists for this supplier'
      });
    }

    const product = new Product({
      ...req.body,
      sku: req.body.sku.toUpperCase(),
      supplier: supplierId,
      createdBy: req.user._id
    });

    await product.save();

    // Create inventory record
    const inventory = new Inventory({
      product: product._id,
      currentStock: req.body.inventory?.currentStock || 0,
      minStockLevel: req.body.inventory?.minStockLevel || 0,
      maxStockLevel: req.body.inventory?.maxStockLevel || 1000,
      reorderLevel: req.body.inventory?.reorderLevel || 10,
      averageCostPrice: req.body.pricing.costPrice
    });

    await inventory.save();

    try {
      await attachQrCode(product, req.user._id);
    } catch (qrError) {
      console.error('Generate product QR error (create):', qrError);
    }

    await populateProductDocument(product);
    await convertProductImagesToSignedUrls(product);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product
    });

  } catch (error) {
    console.error('Create product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get public products (no authentication required)
// Returns products without pricing information
router.get('/public', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      search,
      category
    } = req.query;

    const query = { isActive: true };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }

    if (category) {
      query.category = category;
    }

    // Select only public fields (exclude pricing)
    // Note: _id is included by default in MongoDB, but explicitly including it for clarity
    const selectFields = '_id name sku description category brand images season unit isActive createdAt';

    let productsQuery = Product.find(query)
      .select(selectFields)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    let products = await productsQuery;

    // Convert images to signed URLs for public endpoint
    // Bucket is not public, so we need signed URLs even for public access
    await convertProductImagesToSignedUrls(products, { primaryOnly: true });

    const total = await Product.countDocuments(query);

    // Convert to plain objects and remove pricing if somehow included
    const publicProducts = products.map(product => {
      const productObj = product.toObject ? product.toObject() : product;
      // Ensure pricing is not included
      delete productObj.pricing;
      delete productObj.costPrice;
      delete productObj.sellingPrice;
      return productObj;
    });

    res.json({
      success: true,
      data: publicProducts,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });

  } catch (error) {
    console.error('Get public products error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get all products
router.get('/', auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 20,
      search,
      category,
      season,
      isActive,
      lowStock,
      supplier,
      supplierId,
      createdBy
    } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { sku: { $regex: search, $options: 'i' } },
        { brand: { $regex: search, $options: 'i' } },
        { barcode: { $regex: search, $options: 'i' } }
      ];
    }

    if (category) query.category = category;
    if (season) {
      // Handle both single season and array of seasons
      const seasonArray = Array.isArray(season) ? season : [season];
      query.season = { $in: seasonArray };
    }
    if (isActive !== undefined) query.isActive = isActive === 'true';

    // Support filtering by supplier (multiple ways)
    if (supplier) query['suppliers.supplier'] = supplier;
    if (supplierId) query['suppliers.supplier'] = supplierId;
    if (createdBy) query.createdBy = createdBy;

    // If both createdBy and supplier are provided, use OR logic
    if (createdBy && (supplier || supplierId)) {
      const supplierFilter = supplier || supplierId;
      query.$or = [
        { createdBy: createdBy },
        { 'suppliers.supplier': supplierFilter }
      ];
      // Remove individual filters to avoid conflicts
      delete query.createdBy;
      delete query['suppliers.supplier'];
    }

    let productsQuery = Product.find(query)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    productsQuery = populateProductQuery(productsQuery);

    let products = await productsQuery.lean();

    // Fetch inventory data for each product
    const productIds = products.map(p => p._id);
    const inventories = await Inventory.find({ product: { $in: productIds } }).lean();
    
    // Create a map of product ID to inventory
    const inventoryMap = {};
    inventories.forEach(inv => {
      inventoryMap[inv.product.toString()] = inv;
    });

    // Merge inventory data into products
    products = products.map(product => {
      const inventory = inventoryMap[product._id.toString()];
      if (inventory) {
        return {
          ...product,
          inventory: {
            currentStock: inventory.currentStock || 0,
            availableStock: inventory.availableStock || 0,
            reservedStock: inventory.reservedStock || 0,
            minStockLevel: inventory.minStockLevel || 0,
            maxStockLevel: inventory.maxStockLevel || 0,
            reorderLevel: inventory.reorderLevel || 0,
            averageCostPrice: inventory.averageCostPrice || 0,
          }
        };
      }
      return product;
    });

    if (lowStock === 'true') {
      products = products.filter(product =>
        product.inventory.currentStock <= product.inventory.reorderLevel
      );
    }

    // Convert images to signed URLs (only primary image for list views - reduces payload)
    await convertProductImagesToSignedUrls(products, { primaryOnly: true });

    const total = await Product.countDocuments(query);

    res.json({
      success: true,
      data: products,
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit
      }
    });

  } catch (error) {
    console.error('Get products error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Lookup product by product code (case-insensitive)
router.get('/lookup/:productCode', auth, async (req, res) => {
  try {
    const { productCode } = req.params;

    if (!productCode || productCode.trim() === '') {
      return res.status(400).json({
        success: false,
        message: 'Product code is required'
      });
    }

    // Search by productCode or SKU (case-insensitive)
    const product = await populateProductQuery(
      Product.findOne({
        $or: [
          { productCode: { $regex: new RegExp(`^${productCode.trim()}$`, 'i') } },
          { sku: { $regex: new RegExp(`^${productCode.trim()}$`, 'i') } }
        ]
      })
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get inventory information
    const inventory = await Inventory.findOne({ product: product._id });

    // Convert images to signed URLs
    await convertProductImagesToSignedUrls(product);

    res.json({
      success: true,
      data: {
        ...product.toObject(),
        inventoryInfo: inventory
      }
    });

  } catch (error) {
    console.error('Lookup product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get product by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const product = await populateProductQuery(
      Product.findById(req.params.id)
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Get inventory information
    const inventory = await Inventory.findOne({ product: product._id });

    // Get all available packet configurations
    const PacketStock = require('../models/PacketStock');
    const packetStocks = await PacketStock.find({ 
      product: product._id, 
      isActive: true,
      availablePackets: { $gt: 0 } 
    })
      .populate('supplier', 'name company')
      .sort({ isLoose: 1, totalItemsPerPacket: -1 }) // Prioritize packets over loose, larger packets first
      .lean();

    // Map all packet configurations for user selection
    const availablePackets = packetStocks.map(packet => ({
      barcode: packet.barcode,
      composition: packet.composition,
      totalItemsPerPacket: packet.totalItemsPerPacket,
      isLoose: packet.isLoose,
      suggestedSellingPrice: packet.suggestedSellingPrice,
      costPricePerPacket: packet.costPricePerPacket,
      availableStock: packet.availablePackets,
      supplierName: packet.supplier?.name || packet.supplier?.company || 'Unknown Supplier'
    }));

    // Keep backward compatibility: set primary packet as packetPricing
    let packetPricing = null;
    if (availablePackets.length > 0) {
      const primaryPacket = availablePackets[0];
      packetPricing = {
        barcode: primaryPacket.barcode,
        composition: primaryPacket.composition,
        totalItemsPerPacket: primaryPacket.totalItemsPerPacket,
        isLoose: primaryPacket.isLoose,
        suggestedSellingPrice: primaryPacket.suggestedSellingPrice,
        costPricePerPacket: primaryPacket.costPricePerPacket,
        availablePackets: primaryPacket.availableStock
      };
    }

    // Convert images to signed URLs
    await convertProductImagesToSignedUrls(product);

    res.json({
      success: true,
      data: {
        ...product.toObject(),
        inventoryInfo: inventory,
        packetPricing,
        availablePackets  // NEW: All packet configurations
      }
    });

  } catch (error) {
    console.error('Get product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Update product
router.put('/:id', auth, async (req, res) => {
  try {
    const updateSchema = productSchema.fork(['sku'], (schema) => schema.optional());
    const { error } = updateSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: error.details[0].message
      });
    }

    // Check if SKU is being updated and if it already exists
    if (req.body.sku) {
      const existingProduct = await Product.findOne({
        sku: req.body.sku.toUpperCase(),
        _id: { $ne: req.params.id }
      });

      if (existingProduct) {
        return res.status(400).json({
          success: false,
          message: 'SKU already exists'
        });
      }
      req.body.sku = req.body.sku.toUpperCase();
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Update inventory if inventory data is provided
    if (req.body.inventory) {
      await Inventory.findOneAndUpdate(
        { product: product._id },
        req.body.inventory,
        { new: true }
      );
    }

    const shouldRegenerateQr = Boolean(
      req.body.regenerateQr === true ||
      req.body.name !== undefined ||
      req.body.sku !== undefined ||
      req.body.suppliers !== undefined ||
      !product.qrCode ||
      !product.qrCode.dataUrl
    );

    if (shouldRegenerateQr) {
      try {
        await attachQrCode(product, req.user._id);
      } catch (qrError) {
        console.error('Generate product QR error (update):', qrError);
      }
    }

    await populateProductDocument(product);
    await convertProductImagesToSignedUrls(product);

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: product
    });

  } catch (error) {
    console.error('Update product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Delete product
router.delete('/:id', auth, async (req, res) => {
  try {
    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Deactivate inventory record
    await Inventory.findOneAndUpdate(
      { product: product._id },
      { isActive: false }
    );

    res.json({
      success: true,
      message: 'Product deactivated successfully'
    });

  } catch (error) {
    console.error('Delete product error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Get products with low stock
router.get('/reports/low-stock', auth, async (req, res) => {
  try {
    const products = await Product.aggregate([
      {
        $lookup: {
          from: 'inventories',
          localField: '_id',
          foreignField: 'product',
          as: 'inventory'
        }
      },
      {
        $unwind: '$inventory'
      },
      {
        $match: {
          isActive: true,
          $expr: {
            $lte: ['$inventory.currentStock', '$inventory.reorderLevel']
          }
        }
      },
      {
        $project: {
          name: 1,
          sku: 1,
          category: 1,
          currentStock: '$inventory.currentStock',
          reorderLevel: '$inventory.reorderLevel',
          minStockLevel: '$inventory.minStockLevel'
        }
      },
      {
        $sort: { currentStock: 1 }
      }
    ]);

    res.json({
      success: true,
      data: products
    });

  } catch (error) {
    console.error('Get low stock products error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Generate or refresh QR code for a product
router.post('/:id/qr', auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    await attachQrCode(product, req.user._id);
    await populateProductDocument(product);
    await convertProductImagesToSignedUrls(product);

    res.json({
      success: true,
      message: 'QR code generated successfully',
      data: product
    });
  } catch (error) {
    console.error('Generate product QR error (manual):', error);
    res.status(500).json({
      success: false,
      message: 'Unable to generate product QR code'
    });
  }
});

// Upload product image
router.post('/:id/images', auth, upload.single('image'), async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if user has permission (supplier can only upload to their own products)
    if (req.user.role === 'supplier') {
      const isProductSupplier = product.suppliers?.some(
        s => s.supplier?.toString() === req.user.supplier?.toString()
      );
      const isCreator = product.createdBy?.toString() === req.user._id.toString();

      if (!isProductSupplier && !isCreator) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to upload images for this product'
        });
      }
    }

    // Validate file
    const validation = validateImageFile(req.file);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    // Upload to GCS
    const { url, fileName } = await uploadImage(req.file, product._id.toString());

    // Update product images array (add to beginning)
    if (!product.images) {
      product.images = [];
    }
    product.images.unshift(url); // Add new image at the beginning
    await product.save();

    await populateProductDocument(product);
    await convertProductImagesToSignedUrls(product);

    // Generate signed URL for the newly uploaded image
    const signedImageUrl = await generateSignedUrls([url]);

    res.status(201).json({
      success: true,
      message: 'Image uploaded successfully',
      data: {
        imageUrl: signedImageUrl[0] || url,
        fileName: fileName,
        product: product
      }
    });

  } catch (error) {
    console.error('Upload product image error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to upload image'
    });
  }
});

// Delete product image
router.delete('/:id/images', auth, async (req, res) => {
  try {
    const { imageUrl } = req.body;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: 'Image URL is required'
      });
    }

    const product = await Product.findById(req.params.id);

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if user has permission
    if (req.user.role === 'supplier') {
      const isProductSupplier = product.suppliers?.some(
        s => s.supplier?.toString() === req.user.supplier?.toString()
      );
      const isCreator = product.createdBy?.toString() === req.user._id.toString();

      if (!isProductSupplier && !isCreator) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to delete images for this product'
        });
      }
    }

    // Check if image exists in product images array
    if (!product.images || !product.images.includes(imageUrl)) {
      return res.status(404).json({
        success: false,
        message: 'Image not found in product'
      });
    }

    // Delete from GCS
    try {
      await deleteImage(imageUrl);
    } catch (deleteError) {
      console.error('Error deleting image from GCS:', deleteError);
      // Continue to remove from database even if GCS delete fails
    }

    // Remove from product images array
    product.images = product.images.filter(img => img !== imageUrl);
    await product.save();

    await populateProductDocument(product);

    res.json({
      success: true,
      message: 'Image deleted successfully',
      data: product
    });

  } catch (error) {
    console.error('Delete product image error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Failed to delete image'
    });
  }
});

// Enable variant tracking for a product (Admin only)
router.patch('/:id/enable-variants', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can enable variant tracking'
      });
    }

    const { availableSizes, availableColors } = req.body;

    if (!availableSizes || !Array.isArray(availableSizes) || availableSizes.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'availableSizes array is required'
      });
    }

    if (!availableColors || !Array.isArray(availableColors) || availableColors.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'availableColors array is required'
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Check if product has existing stock - if yes, require explicit confirmation
    const inventory = await Inventory.findOne({ product: product._id });
    if (inventory && inventory.currentStock > 0 && !req.body.confirmWithExistingStock) {
      return res.status(400).json({
        success: false,
        message: 'Product has existing stock. Please adjust stock to zero before enabling variants, or pass confirmWithExistingStock=true to proceed.',
        currentStock: inventory.currentStock
      });
    }

    // Enable variant tracking
    product.variantTracking = {
      enabled: true,
      availableSizes: availableSizes.map(s => s.trim()),
      availableColors: availableColors.map(c => c.trim()),
      variants: []
    };

    await product.save();
    await populateProductDocument(product);

    res.json({
      success: true,
      message: 'Variant tracking enabled successfully',
      data: product
    });

  } catch (error) {
    console.error('Enable variant tracking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Disable variant tracking for a product (Admin only)
router.patch('/:id/disable-variants', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can disable variant tracking'
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Disable variant tracking
    product.variantTracking = {
      enabled: false,
      availableSizes: [],
      availableColors: [],
      variants: []
    };

    await product.save();

    // Clear variant composition from inventory
    const inventory = await Inventory.findOne({ product: product._id });
    if (inventory) {
      inventory.variantComposition = [];
      await inventory.save();
    }

    await populateProductDocument(product);

    res.json({
      success: true,
      message: 'Variant tracking disabled successfully',
      data: product
    });

  } catch (error) {
    console.error('Disable variant tracking error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Get variant stock levels for a product
router.get('/:id/variants', auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!product.variantTracking || !product.variantTracking.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Variant tracking is not enabled for this product'
      });
    }

    const inventory = await Inventory.findOne({ product: product._id });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    // Prepare variant data with stock levels
    const variantData = inventory.variantComposition.map(variant => ({
      size: variant.size,
      color: variant.color,
      quantity: variant.quantity,
      reservedQuantity: variant.reservedQuantity,
      availableQuantity: variant.quantity - variant.reservedQuantity
    }));

    res.json({
      success: true,
      data: {
        productId: product._id,
        productName: product.name,
        sku: product.sku,
        totalStock: inventory.currentStock,
        totalReserved: inventory.reservedStock,
        totalAvailable: inventory.availableStock,
        variants: variantData
      }
    });

  } catch (error) {
    console.error('Get variant stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Adjust variant stock (Admin only)
router.post('/:id/variants/adjust', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return res.status(403).json({
        success: false,
        message: 'Only admins can adjust variant stock'
      });
    }

    const { size, color, newQuantity, notes } = req.body;

    if (!size || !color) {
      return res.status(400).json({
        success: false,
        message: 'Size and color are required'
      });
    }

    if (newQuantity === undefined || newQuantity < 0) {
      return res.status(400).json({
        success: false,
        message: 'Valid newQuantity is required (must be >= 0)'
      });
    }

    const product = await Product.findById(req.params.id);
    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    if (!product.variantTracking || !product.variantTracking.enabled) {
      return res.status(400).json({
        success: false,
        message: 'Variant tracking is not enabled for this product'
      });
    }

    const inventory = await Inventory.findOne({ product: product._id });
    if (!inventory) {
      return res.status(404).json({
        success: false,
        message: 'Inventory not found for this product'
      });
    }

    // Find or create variant
    let variant = inventory.variantComposition.find(
      v => v.size === size && v.color === color
    );

    const oldQuantity = variant ? variant.quantity : 0;
    const difference = newQuantity - oldQuantity;

    if (variant) {
      variant.quantity = newQuantity;
    } else {
      inventory.variantComposition.push({
        size,
        color,
        quantity: newQuantity,
        reservedQuantity: 0
      });
    }

    // Adjust total stock
    inventory.currentStock += difference;

    // Add stock movement
    inventory.stockMovements.push({
      type: 'adjustment',
      quantity: difference,
      reference: 'VariantAdjustment',
      user: req.user._id,
      notes: `Variant ${color}-${size} adjusted from ${oldQuantity} to ${newQuantity}. ${notes || ''}`
    });

    inventory.lastStockUpdate = new Date();
    await inventory.save();

    res.json({
      success: true,
      message: 'Variant stock adjusted successfully',
      data: {
        size,
        color,
        oldQuantity,
        newQuantity,
        difference,
        totalStock: inventory.currentStock
      }
    });

  } catch (error) {
    console.error('Adjust variant stock error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

// Get product images gallery (full resolution with signed URLs)
// This endpoint is called when user opens image gallery, not for list views
router.get('/:id/images', auth, async (req, res) => {
  try {
    const product = await Product.findById(req.params.id)
      .select('_id name sku images')
      .lean();

    if (!product) {
      return res.status(404).json({
        success: false,
        message: 'Product not found'
      });
    }

    // Generate signed URLs for all images
    let signedImages = [];
    if (product.images && product.images.length > 0) {
      signedImages = await generateSignedUrls(product.images);
    }

    res.json({
      success: true,
      data: {
        productId: product._id,
        name: product.name,
        sku: product.sku,
        images: signedImages,
        totalImages: signedImages.length
      }
    });

  } catch (error) {
    console.error('Get product images error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;