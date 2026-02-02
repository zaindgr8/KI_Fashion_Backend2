const express = require('express');
const Joi = require('joi');
const Product = require('../models/Product');
const PacketStock = require('../models/PacketStock');
const auth = require('../middleware/auth');

const router = express.Router();

// Validation schema for cart items
const cartItemSchema = Joi.object({
  id: Joi.string().required(),
  productId: Joi.string().required(),
  name: Joi.string().required(),
  price: Joi.number().min(0).required(),
  quantity: Joi.number().min(1).required(),
  image: Joi.string().allow('', null).optional(),
  sku: Joi.string().optional(),
  inventoryType: Joi.string().valid('packet', 'loose').required(),
  packetBarcode: Joi.string().when('inventoryType', {
    is: 'packet',
    then: Joi.string().required(),
    otherwise: Joi.string().optional()
  }),
  packetInfo: Joi.object({
    composition: Joi.array().items(Joi.object({
      size: Joi.string().required(),
      color: Joi.string().required(),
      quantity: Joi.number().min(1).required()
    })).optional(),
    itemsPerPacket: Joi.number().min(1).optional(),
    pricePerItem: Joi.number().min(0).optional(),
    supplierName: Joi.string().optional()
  }).optional(),
  variant: Joi.object({
    size: Joi.string().required(),
    color: Joi.string().required(),
    sku: Joi.string().optional()
  }).optional(),
  // Legacy support
  color: Joi.string().optional(),
  size: Joi.string().optional()
});

const validateCartSchema = Joi.object({
  items: Joi.array().items(cartItemSchema).min(1).required()
});

/**
 * Validate cart items against current product data
 * Checks:
 * - Product existence and active status
 * - Price accuracy (has prices changed?)
 * - Stock availability
 * Returns validated cart with issues flagged
 */
router.post('/validate', auth, async (req, res) => {
  try {
    const { error } = validateCartSchema.validate(req.body);
    if (error) {
      return res.status(400).json({
        success: false,
        message: 'Invalid cart data: ' + error.details[0].message,
        validationError: true
      });
    }

    const { items } = req.body;
    const validatedItems = [];
    const issues = [];
    let hasErrors = false;

    // Extract unique product IDs
    const productIds = [...new Set(items.map(item => item.productId))];
    
    // Fetch all products at once
    const products = await Product.find({ 
      _id: { $in: productIds } 
    }).lean();
    
    const productMap = new Map(products.map(p => [p._id.toString(), p]));

    // Extract unique packet barcodes
    const packetBarcodes = items
      .filter(item => item.packetBarcode)
      .map(item => item.packetBarcode);
    
    // Fetch packet stocks
    const packetStocks = await PacketStock.find({
      barcode: { $in: packetBarcodes },
      isActive: true
    }).lean();
    
    const packetMap = new Map(packetStocks.map(p => [p.barcode, p]));

    // Validate each cart item
    for (const item of items) {
      const product = productMap.get(item.productId);
      const validatedItem = { ...item };
      const itemIssues = [];

      // 1. Check product existence
      if (!product) {
        itemIssues.push({
          type: 'PRODUCT_NOT_FOUND',
          message: 'Product no longer available',
          severity: 'error'
        });
        hasErrors = true;
        validatedItem.isValid = false;
        validatedItems.push({ item: validatedItem, issues: itemIssues });
        continue;
      }

      // 2. Check product active status
      if (!product.isActive) {
        itemIssues.push({
          type: 'PRODUCT_INACTIVE',
          message: 'Product has been discontinued',
          severity: 'error'
        });
        hasErrors = true;
        validatedItem.isValid = false;
        validatedItems.push({ item: validatedItem, issues: itemIssues });
        continue;
      }

      // 3. Update product name if changed
      if (product.name !== item.name) {
        validatedItem.name = product.name;
        itemIssues.push({
          type: 'NAME_UPDATED',
          message: 'Product name has been updated',
          severity: 'info',
          oldValue: item.name,
          newValue: product.name
        });
      }

      // 4. Check stock availability based on inventory type
      if (item.inventoryType === 'packet' && item.packetBarcode) {
        const packetStock = packetMap.get(item.packetBarcode);
        
        if (!packetStock) {
          itemIssues.push({
            type: 'PACKET_NOT_FOUND',
            message: 'Packet configuration no longer available',
            severity: 'error'
          });
          hasErrors = true;
          validatedItem.isValid = false;
        } else {
          // Check price changes
          if (packetStock.suggestedSellingPrice !== item.price) {
            itemIssues.push({
              type: 'PRICE_CHANGED',
              message: `Price has changed from £${item.price.toFixed(2)} to £${packetStock.suggestedSellingPrice.toFixed(2)}`,
              severity: 'warning',
              oldPrice: item.price,
              newPrice: packetStock.suggestedSellingPrice
            });
            validatedItem.price = packetStock.suggestedSellingPrice;
            validatedItem.priceUpdated = true;
          }

          // Check stock availability
          const availableStock = packetStock.availablePackets - packetStock.reservedPackets;
          if (availableStock < item.quantity) {
            if (availableStock <= 0) {
              itemIssues.push({
                type: 'OUT_OF_STOCK',
                message: 'Item is out of stock',
                severity: 'error'
              });
              hasErrors = true;
              validatedItem.isValid = false;
            } else {
              itemIssues.push({
                type: 'INSUFFICIENT_STOCK',
                message: `Only ${availableStock} unit(s) available`,
                severity: 'warning',
                requestedQuantity: item.quantity,
                availableStock: availableStock
              });
              validatedItem.maxQuantity = availableStock;
            }
          }

          validatedItem.currentStock = availableStock;
        }
      } else if (item.inventoryType === 'loose' && item.variant) {
        // For loose items, find matching packet stock
        const matchingPackets = packetStocks.filter(ps => 
          ps.product.toString() === item.productId &&
          ps.isLoose &&
          ps.composition.some(c => 
            c.color === item.variant.color && 
            c.size === item.variant.size
          )
        );

        if (matchingPackets.length > 0) {
          const primaryPacket = matchingPackets[0];
          const availableStock = primaryPacket.availablePackets - primaryPacket.reservedPackets;
          
          // Check price changes
          if (primaryPacket.suggestedSellingPrice !== item.price) {
            itemIssues.push({
              type: 'PRICE_CHANGED',
              message: `Price has changed from £${item.price.toFixed(2)} to £${primaryPacket.suggestedSellingPrice.toFixed(2)}`,
              severity: 'warning',
              oldPrice: item.price,
              newPrice: primaryPacket.suggestedSellingPrice
            });
            validatedItem.price = primaryPacket.suggestedSellingPrice;
            validatedItem.priceUpdated = true;
          }

          if (availableStock < item.quantity) {
            if (availableStock <= 0) {
              itemIssues.push({
                type: 'OUT_OF_STOCK',
                message: `${item.variant.color}/${item.variant.size} is out of stock`,
                severity: 'error'
              });
              hasErrors = true;
              validatedItem.isValid = false;
            } else {
              itemIssues.push({
                type: 'INSUFFICIENT_STOCK',
                message: `Only ${availableStock} unit(s) available for ${item.variant.color}/${item.variant.size}`,
                severity: 'warning',
                requestedQuantity: item.quantity,
                availableStock: availableStock
              });
              validatedItem.maxQuantity = availableStock;
            }
          }
          
          validatedItem.currentStock = availableStock;
        } else {
          // Fallback: Check general product stock
          // This handles legacy cart items that don't have packet tracking
          itemIssues.push({
            type: 'VARIANT_NOT_TRACKED',
            message: 'Variant stock not tracked (legacy item)',
            severity: 'info'
          });
        }
      }

      // Mark as valid if no errors
      if (validatedItem.isValid === undefined) {
        validatedItem.isValid = true;
      }

      validatedItems.push({ 
        item: validatedItem, 
        issues: itemIssues 
      });

      // Collect all issues
      if (itemIssues.length > 0) {
        issues.push({
          itemId: item.id,
          productName: validatedItem.name,
          issues: itemIssues
        });
      }
    }

    // Calculate new totals
    const validItems = validatedItems.filter(v => v.item.isValid);
    const subtotal = validItems.reduce(
      (sum, v) => sum + (v.item.price * v.item.quantity), 
      0
    );

    // Summary of changes
    const priceChanges = validatedItems.filter(v => v.item.priceUpdated);
    const stockIssues = issues.filter(i => 
      i.issues.some(issue => 
        issue.type === 'OUT_OF_STOCK' || 
        issue.type === 'INSUFFICIENT_STOCK'
      )
    );

    res.json({
      success: true,
      data: {
        isValid: !hasErrors,
        items: validatedItems,
        validItemCount: validItems.length,
        invalidItemCount: validatedItems.length - validItems.length,
        issues,
        summary: {
          subtotal,
          priceChangesCount: priceChanges.length,
          stockIssuesCount: stockIssues.length,
          totalIssues: issues.length
        }
      }
    });

  } catch (error) {
    console.error('Cart validation error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during cart validation'
    });
  }
});

/**
 * Get quick stock check for multiple products
 * Lightweight endpoint for checking stock without full validation
 */
router.post('/stock-check', auth, async (req, res) => {
  try {
    const { barcodes = [], productIds = [] } = req.body;

    const result = {};

    // Check packet stocks by barcode
    if (barcodes.length > 0) {
      const packets = await PacketStock.find({
        barcode: { $in: barcodes },
        isActive: true
      })
        .select('barcode availablePackets reservedPackets suggestedSellingPrice')
        .lean();

      packets.forEach(p => {
        result[p.barcode] = {
          available: p.availablePackets - p.reservedPackets,
          price: p.suggestedSellingPrice
        };
      });

      // Mark missing barcodes
      barcodes.forEach(bc => {
        if (!result[bc]) {
          result[bc] = { available: 0, price: null, notFound: true };
        }
      });
    }

    // Check products exist
    if (productIds.length > 0) {
      const products = await Product.find({
        _id: { $in: productIds },
        isActive: true
      })
        .select('_id name')
        .lean();

      const activeProductIds = new Set(products.map(p => p._id.toString()));
      
      productIds.forEach(id => {
        result[`product_${id}`] = {
          exists: activeProductIds.has(id)
        };
      });
    }

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Stock check error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error during stock check'
    });
  }
});

module.exports = router;
