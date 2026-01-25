const express = require('express');
const router = express.Router();
const PacketStock = require('../models/PacketStock');
const Product = require('../models/Product');
const auth = require('../middleware/auth');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const { generatePacketBarcode, generateLooseItemBarcode, normalizeBarcode, parseBarcodeType } = require('../utils/barcodeGenerator');

// Helper function to generate ITF barcode image from barcode string
async function generateITFBarcodeImage(barcodeText) {
  try {
    // Extract the hex part from barcode (e.g., "PKT-A1B2C3D4" -> "A1B2C3D4")
    const barcodePart = barcodeText.split('-')[1] || barcodeText;
    
    // Convert hex characters to numeric string for ITF
    // ITF requires even-length numeric strings
    let numericBarcode = '';
    for (let i = 0; i < barcodePart.length; i++) {
      const char = barcodePart[i];
      if (char >= '0' && char <= '9') {
        numericBarcode += char;
      } else if (char >= 'A' && char <= 'F') {
        numericBarcode += (char.charCodeAt(0) - 65 + 10).toString();
      }
    }
    
    // Ensure even length for ITF
    if (numericBarcode.length % 2 !== 0) {
      numericBarcode = '0' + numericBarcode;
    }

    // Generate barcode using ITF format
    const png = await bwipjs.toBuffer({
      bcid: 'interleaved2of5',
      text: numericBarcode,
      scale: 3,
      height: 10,
      includetext: false,
      textxalign: 'center',
    });

    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (error) {
    console.error('Error generating ITF barcode:', error);
    return null;
  }
}

/**
 * @route   GET /api/packet-stock/scan/:barcode
 * @desc    Lookup packet by barcode for sales
 * @access  Private
 */
router.get('/scan/:barcode', auth, async (req, res) => {
  try {
    const barcode = normalizeBarcode(req.params.barcode);
    
    if (!barcode) {
      return res.status(400).json({
        success: false,
        message: 'Barcode is required'
      });
    }
    
    const barcodeInfo = parseBarcodeType(barcode);
    if (!barcodeInfo.isValid) {
      return res.status(400).json({
        success: false,
        message: 'Invalid barcode format. Expected PKT-XXXXXXXX or LSE-XXXXXXXX'
      });
    }
    
    const packetStock = await PacketStock.findOne({ 
      barcode, 
      isActive: true 
    })
      .populate('product', 'name sku productCode images pricing season')
      .populate('supplier', 'name company');
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet not found or inactive'
      });
    }
    
    const actualAvailable = packetStock.availablePackets - packetStock.reservedPackets;
    
    if (actualAvailable <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No packets available in stock',
        data: {
          barcode: packetStock.barcode,
          productName: packetStock.product?.name,
          availablePackets: 0
        }
      });
    }
    
    return res.json({
      success: true,
      data: {
        packetStockId: packetStock._id,
        barcode: packetStock.barcode,
        isLoose: packetStock.isLoose,
        product: {
          _id: packetStock.product?._id,
          name: packetStock.product?.name,
          sku: packetStock.product?.sku,
          productCode: packetStock.product?.productCode,
          images: packetStock.product?.images,
          season: packetStock.product?.season
        },
        supplier: {
          _id: packetStock.supplier?._id,
          name: packetStock.supplier?.name || packetStock.supplier?.company
        },
        composition: packetStock.composition,
        totalItemsPerPacket: packetStock.totalItemsPerPacket,
        availablePackets: actualAvailable,
        suggestedSellingPrice: packetStock.suggestedSellingPrice,
        landedPricePerPacket: packetStock.landedPricePerPacket,
        costPricePerPacket: packetStock.costPricePerPacket
      }
    });
  } catch (error) {
    console.error('Barcode scan error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   GET /api/packet-stock
 * @desc    Get all packet stocks with filters
 * @access  Private
 */
router.get('/', auth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 20, 
      product, 
      supplier, 
      isLoose,
      hasStock,
      search 
    } = req.query;
    
    const query = { isActive: true };
    
    if (product) query.product = product;
    if (supplier) query.supplier = supplier;
    if (isLoose !== undefined) query.isLoose = isLoose === 'true';
    if (hasStock === 'true') query.availablePackets = { $gt: 0 };
    
    let packetStocks = await PacketStock.find(query)
      .populate('product', 'name sku productCode images')
      .populate('supplier', 'name company')
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();
    
    // If search term provided, filter by product name or barcode
    if (search) {
      const searchLower = search.toLowerCase();
      packetStocks = packetStocks.filter(ps => 
        ps.barcode?.toLowerCase().includes(searchLower) ||
        ps.product?.name?.toLowerCase().includes(searchLower) ||
        ps.product?.productCode?.toLowerCase().includes(searchLower)
      );
    }
    
    const total = await PacketStock.countDocuments(query);
    
    return res.json({
      success: true,
      data: packetStocks,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Get packet stocks error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   GET /api/packet-stock/:id
 * @desc    Get packet stock by ID
 * @access  Private
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const packetStock = await PacketStock.findById(req.params.id)
      .populate('product', 'name sku productCode images pricing')
      .populate('supplier', 'name company')
      .populate('dispatchOrderHistory.dispatchOrderId', 'orderNumber');
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    return res.json({
      success: true,
      data: packetStock
    });
  } catch (error) {
    console.error('Get packet stock error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   POST /api/packet-stock/add-stock
 * @desc    Add stock to existing packet or create new packet stock
 * @access  Private (used internally by dispatch confirmation)
 */
router.post('/add-stock', auth, async (req, res) => {
  try {
    const {
      productId,
      supplierId,
      composition,
      totalItemsPerPacket,
      quantity,
      costPricePerPacket,
      landedPricePerPacket,
      dispatchOrderId,
      isLoose = false
    } = req.body;
    
    // Validate required fields
    if (!productId || !supplierId || !composition || !totalItemsPerPacket || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: productId, supplierId, composition, totalItemsPerPacket, quantity'
      });
    }
    
    // Generate deterministic barcode
    const barcode = generatePacketBarcode(supplierId, productId, composition, isLoose);
    
    // Find existing packet stock or create new
    let packetStock = await PacketStock.findOne({ barcode });
    
    if (packetStock) {
      // Add to existing stock
      await packetStock.addStock(
        quantity,
        dispatchOrderId,
        costPricePerPacket,
        landedPricePerPacket
      );
    } else {
      // Create new packet stock
      packetStock = new PacketStock({
        barcode,
        product: productId,
        supplier: supplierId,
        composition,
        totalItemsPerPacket,
        availablePackets: quantity,
        costPricePerPacket,
        landedPricePerPacket,
        suggestedSellingPrice: landedPricePerPacket * 1.20,
        isLoose,
        dispatchOrderHistory: [{
          dispatchOrderId,
          quantity,
          costPricePerPacket,
          landedPricePerPacket,
          addedAt: new Date()
        }]
      });
      
      // Generate QR code for barcode
      try {
        const qrDataUrl = await QRCode.toDataURL(barcode, {
          errorCorrectionLevel: 'M',
          type: 'image/png',
          scale: 6,
          margin: 1
        });
        packetStock.qrCode = {
          dataUrl: qrDataUrl,
          generatedAt: new Date()
        };
      } catch (qrError) {
        console.warn('QR code generation failed:', qrError.message);
      }
      
      await packetStock.save();
    }
    
    return res.status(201).json({
      success: true,
      message: packetStock.isNew ? 'Packet stock created' : 'Stock added to existing packet',
      data: {
        barcode: packetStock.barcode,
        availablePackets: packetStock.availablePackets,
        packetStockId: packetStock._id
      }
    });
  } catch (error) {
    console.error('Add packet stock error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   POST /api/packet-stock/reserve
 * @desc    Reserve packets for a pending sale
 * @access  Private
 */
router.post('/reserve', auth, async (req, res) => {
  try {
    const { packetStockId, quantity } = req.body;
    
    if (!packetStockId || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'packetStockId and quantity are required'
      });
    }
    
    const packetStock = await PacketStock.findById(packetStockId);
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    await packetStock.reservePackets(quantity);
    
    return res.json({
      success: true,
      message: 'Packets reserved successfully',
      data: {
        barcode: packetStock.barcode,
        reservedPackets: packetStock.reservedPackets,
        availablePackets: packetStock.availablePackets
      }
    });
  } catch (error) {
    console.error('Reserve packets error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to reserve packets'
    });
  }
});

/**
 * @route   POST /api/packet-stock/release
 * @desc    Release reserved packets (sale cancelled)
 * @access  Private
 */
router.post('/release', auth, async (req, res) => {
  try {
    const { packetStockId, quantity } = req.body;
    
    if (!packetStockId || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'packetStockId and quantity are required'
      });
    }
    
    const packetStock = await PacketStock.findById(packetStockId);
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    await packetStock.releaseReservedPackets(quantity);
    
    return res.json({
      success: true,
      message: 'Reserved packets released',
      data: {
        barcode: packetStock.barcode,
        reservedPackets: packetStock.reservedPackets,
        availablePackets: packetStock.availablePackets
      }
    });
  } catch (error) {
    console.error('Release packets error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Failed to release packets'
    });
  }
});

/**
 * @route   POST /api/packet-stock/sell
 * @desc    Mark packets as sold (after sale delivery)
 * @access  Private
 */
router.post('/sell', auth, async (req, res) => {
  try {
    const { packetStockId, quantity } = req.body;
    
    if (!packetStockId || !quantity) {
      return res.status(400).json({
        success: false,
        message: 'packetStockId and quantity are required'
      });
    }
    
    const packetStock = await PacketStock.findById(packetStockId);
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    await packetStock.sellPackets(quantity);
    
    return res.json({
      success: true,
      message: 'Packets sold successfully',
      data: {
        barcode: packetStock.barcode,
        soldPackets: packetStock.soldPackets,
        availablePackets: packetStock.availablePackets
      }
    });
  } catch (error) {
    console.error('Sell packets error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Failed to sell packets'
    });
  }
});

/**
 * @route   GET /api/packet-stock/barcode-label/:id
 * @desc    Get barcode label data for printing
 * @access  Private
 */
router.get('/barcode-label/:id', auth, async (req, res) => {
  try {
    const packetStock = await PacketStock.findById(req.params.id)
      .populate('product', 'name productCode')
      .populate('supplier', 'name company');
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    // Generate fresh QR code if not exists
    if (!packetStock.qrCode?.dataUrl) {
      const qrDataUrl = await QRCode.toDataURL(packetStock.barcode, {
        errorCorrectionLevel: 'M',
        type: 'image/png',
        scale: 6,
        margin: 1
      });
      packetStock.qrCode = {
        dataUrl: qrDataUrl,
        generatedAt: new Date()
      };
      await packetStock.save();
    }
    
    // Generate ITF barcode image
    const itfBarcodeImage = await generateITFBarcodeImage(packetStock.barcode);
    
    const responseData = {
      barcode: packetStock.barcode,
      barcodeImage: itfBarcodeImage,
      qrCode: packetStock.qrCode?.dataUrl,
      productName: packetStock.product?.name,
      productCode: packetStock.product?.productCode,
      supplierName: packetStock.supplier?.name || packetStock.supplier?.company,
      composition: packetStock.composition,
      totalItemsPerPacket: packetStock.totalItemsPerPacket,
      isLoose: packetStock.isLoose,
      availablePackets: packetStock.availablePackets,
      suggestedSellingPrice: packetStock.suggestedSellingPrice
    };
    
    console.log('[Barcode Label] Response data:', JSON.stringify(responseData, null, 2));
    
    return res.json({
      success: true,
      data: responseData
    });
  } catch (error) {
    console.error('Get barcode label error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   GET /api/packet-stock/print-label/:id
 * @desc    Render a printable HTML page with barcode label
 * @access  Public (for print popup)
 */
router.get('/print-label/:id', async (req, res) => {
  try {
    const packetStock = await PacketStock.findById(req.params.id)
      .populate('product', 'name productCode')
      .populate('supplier', 'name company');
    
    if (!packetStock) {
      return res.status(404).send('Packet not found');
    }
    
    // Generate ITF barcode image
    const itfBarcodeImage = await generateITFBarcodeImage(packetStock.barcode);
    
    const compositionText = packetStock.composition
      ?.map(c => `${c.color}/${c.size} × ${c.quantity}`)
      .join(', ') || '—';
    
    const productName = packetStock.product?.name || 'Unknown Product';
    const productCode = packetStock.product?.productCode || 'N/A';
    const supplierName = packetStock.supplier?.name || packetStock.supplier?.company || 'N/A';
    const isLoose = packetStock.isLoose;
    const price = packetStock.suggestedSellingPrice || 0;
    
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Barcode: ${packetStock.barcode}</title>
  <style>
    @page {
      size: 80mm 50mm;
      margin: 2mm;
    }
    
    * {
      box-sizing: border-box;
    }
    
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      padding: 10px;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      background: #f5f5f5;
    }
    
    .label-container {
      background: white;
      border: 2px solid #333;
      border-radius: 8px;
      padding: 15px;
      width: 300px;
      text-align: center;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    
    .product-name {
      font-size: 14px;
      font-weight: bold;
      color: #333;
      margin-bottom: 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    
    .product-code {
      font-size: 11px;
      color: #666;
      margin-bottom: 8px;
      font-family: 'Courier New', monospace;
    }
    
    .barcode-image {
      margin: 10px 0;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 60px;
    }
    
    .barcode-image img {
      max-width: 100%;
      height: auto;
    }
    
    .barcode-number {
      font-size: 16px;
      font-weight: bold;
      font-family: 'Courier New', monospace;
      letter-spacing: 2px;
      color: #000;
      margin: 8px 0;
    }
    
    .composition {
      font-size: 10px;
      color: #666;
      margin-bottom: 8px;
    }
    
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    
    .badge-packet {
      background: #e3f2fd;
      color: #1976d2;
    }
    
    .badge-loose {
      background: #fff3e0;
      color: #f57c00;
    }
    
    .price {
      font-size: 18px;
      font-weight: bold;
      color: #2e7d32;
    }
    
    .print-button {
      margin-top: 15px;
      padding: 10px 25px;
      background: #1976d2;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      cursor: pointer;
    }
    
    .print-button:hover {
      background: #1565c0;
    }
    
    @media print {
      body {
        background: white;
        padding: 0;
        min-height: auto;
      }
      
      .label-container {
        box-shadow: none;
        border: 1px solid #000;
      }
      
      .no-print {
        display: none !important;
      }
    }
  </style>
</head>
<body>
  <div class="label-container">
    <div class="product-name">${productName}</div>
    <div class="product-code">SKU: ${productCode}</div>
    ${itfBarcodeImage ? `<div class="barcode-image"><img src="${itfBarcodeImage}" alt="Barcode" /></div>` : ''}
    <div class="barcode-number">${packetStock.barcode}</div>
    <div class="composition">${compositionText}</div>
    <span class="badge ${isLoose ? 'badge-loose' : 'badge-packet'}">${isLoose ? 'LOOSE' : 'PACKET'}</span>
    <div class="price">£${price.toFixed(2)}</div>
    <button class="print-button no-print" onclick="window.print();">🖨️ Print Label</button>
  </div>
</body>
</html>
    `;
    
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (error) {
    console.error('Print label error:', error);
    return res.status(500).send('Failed to generate label');
  }
});

/**
 * @route   POST /api/packet-stock/generate-barcode
 * @desc    Generate barcode for a given composition (preview only, doesn't save)
 * @access  Private
 */
router.post('/generate-barcode', auth, async (req, res) => {
  try {
    const { productId, supplierId, composition, isLoose = false } = req.body;
    
    if (!productId || !supplierId || !composition) {
      return res.status(400).json({
        success: false,
        message: 'productId, supplierId, and composition are required'
      });
    }
    
    const barcode = generatePacketBarcode(supplierId, productId, composition, isLoose);
    
    // Check if this barcode already exists
    const existing = await PacketStock.findOne({ barcode });
    
    return res.json({
      success: true,
      data: {
        barcode,
        exists: !!existing,
        existingStock: existing ? existing.availablePackets : 0
      }
    });
  } catch (error) {
    console.error('Generate barcode error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   POST /api/packet-stock/:id/break
 * @desc    Break a packet and optionally sell some items, creating loose stock for remaining items
 * @access  Private
 * 
 * This endpoint supports two modes:
 * 1. Break during inventory management (no sale) - just creates loose stock
 * 2. Break during sale - sells specific items and creates loose stock for remainder
 */
router.post('/:id/break', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { 
      itemsToSell = [],  // Array of { size, color, quantity } to sell
      saleReference = null,  // Optional: Sale ID if breaking during sale
      notes = '',
      mode = 'inventory'  // 'inventory' (just break) or 'sale' (break and sell)
    } = req.body;
    
    // Find the packet stock
    const packetStock = await PacketStock.findById(id)
      .populate('product', 'name sku productCode')
      .populate('supplier', 'name company');
    
    if (!packetStock) {
      return res.status(404).json({
        success: false,
        message: 'Packet stock not found'
      });
    }
    
    if (packetStock.isLoose) {
      return res.status(400).json({
        success: false,
        message: 'Cannot break a loose item. This is already a single-item stock.'
      });
    }
    
    const actualAvailable = packetStock.availablePackets - packetStock.reservedPackets;
    if (actualAvailable <= 0) {
      return res.status(400).json({
        success: false,
        message: 'No packets available to break'
      });
    }
    
    // Validate itemsToSell against composition
    const compositionMap = new Map();
    packetStock.composition.forEach(c => {
      const key = `${c.size}-${c.color}`;
      compositionMap.set(key, c.quantity);
    });
    
    // Check if itemsToSell is valid
    let totalItemsToSell = 0;
    for (const item of itemsToSell) {
      const key = `${item.size}-${item.color}`;
      const availableInPacket = compositionMap.get(key) || 0;
      
      if (item.quantity > availableInPacket) {
        return res.status(400).json({
          success: false,
          message: `Cannot sell ${item.quantity} of ${item.color}/${item.size}. Only ${availableInPacket} available in packet.`
        });
      }
      
      if (item.quantity <= 0) {
        return res.status(400).json({
          success: false,
          message: 'Quantity must be greater than 0'
        });
      }
      
      totalItemsToSell += item.quantity;
    }
    
    // Calculate remaining items after selling
    const remainingItems = [];
    for (const comp of packetStock.composition) {
      const sellItem = itemsToSell.find(s => s.size === comp.size && s.color === comp.color);
      const soldQty = sellItem ? sellItem.quantity : 0;
      const remaining = comp.quantity - soldQty;
      
      if (remaining > 0) {
        remainingItems.push({
          size: comp.size,
          color: comp.color,
          quantity: remaining
        });
      }
    }
    
    // Decrement the packet count
    packetStock.availablePackets -= 1;
    
    // Create separate loose stock entries for each remaining variant (size/color combination)
    const looseStocksCreated = [];
    const pricePerItem = packetStock.landedPricePerPacket / packetStock.totalItemsPerPacket;
    
    if (remainingItems.length > 0) {
      for (const remainingItem of remainingItems) {
        // Create single-item composition for this variant
        const singleVariantComposition = [{
          size: remainingItem.size,
          color: remainingItem.color,
          quantity: 1  // Each loose stock unit represents 1 item
        }];
        
        // Find or create loose stock for this specific variant
        const { looseStock, isNew } = await PacketStock.findOrCreateLooseStock(
          packetStock.product._id,
          packetStock.supplier._id,
          singleVariantComposition,
          packetStock._id
        );
        
        // For newly created loose stock, set the pricing
        if (isNew) {
          looseStock.costPricePerPacket = pricePerItem;
          looseStock.landedPricePerPacket = pricePerItem;
          looseStock.suggestedSellingPrice = pricePerItem * 1.20;
          await looseStock.save();
        }
        
        // Add additional units if quantity > 1 (first unit already added by findOrCreateLooseStock)
        if (remainingItem.quantity > 1) {
          looseStock.availablePackets += (remainingItem.quantity - 1);
          await looseStock.save();
        }
        
        // Track this loose stock creation
        looseStocksCreated.push({
          looseStockId: looseStock._id,
          barcode: looseStock.barcode,
          size: remainingItem.size,
          color: remainingItem.color,
          quantity: remainingItem.quantity
        });
        
        console.log(`[Packet Break] Created/updated loose stock ${looseStock.barcode} for ${remainingItem.color}/${remainingItem.size} x${remainingItem.quantity}`);
      }
    }
    
    // Record break history with new array format
    packetStock.breakHistory.push({
      brokenAt: new Date(),
      brokenBy: req.user._id,
      itemsSold: itemsToSell,
      remainingItems: remainingItems,
      loosePacketStocksCreated: looseStocksCreated,
      // Keep backward compatibility - set first loose stock as the legacy field
      loosePacketStockCreated: looseStocksCreated.length > 0 ? looseStocksCreated[0].looseStockId : null,
      saleReference: saleReference,
      notes: notes
    });
    
    await packetStock.save();
    
    // Build response with detailed loose stock info
    const totalRemainingItems = remainingItems.reduce((s, r) => s + r.quantity, 0);
    
    const response = {
      success: true,
      message: `Packet broken successfully. ${itemsToSell.length > 0 ? `${totalItemsToSell} items marked for sale.` : ''} ${remainingItems.length > 0 ? `${totalRemainingItems} items moved to ${looseStocksCreated.length} loose stock variant(s).` : 'No remaining items.'}`,
      data: {
        originalPacket: {
          id: packetStock._id,
          barcode: packetStock.barcode,
          remainingPackets: packetStock.availablePackets
        },
        itemsSold: itemsToSell,
        itemsRemaining: remainingItems,
        looseStocks: looseStocksCreated.map(ls => ({
          id: ls.looseStockId,
          barcode: ls.barcode,
          size: ls.size,
          color: ls.color,
          quantity: ls.quantity,
          pricePerItem: pricePerItem
        })),
        // Keep backward compatible single looseStock response
        looseStock: looseStocksCreated.length > 0 ? {
          id: looseStocksCreated[0].looseStockId,
          barcode: looseStocksCreated[0].barcode,
          isNew: true,
          totalItems: totalRemainingItems,
          availableUnits: totalRemainingItems
        } : null,
        pricing: {
          originalPacketPrice: packetStock.landedPricePerPacket,
          pricePerItem: pricePerItem,
          soldItemsValue: pricePerItem * totalItemsToSell,
          looseStockValue: pricePerItem * totalRemainingItems
        }
      }
    };
    
    console.log(`[Packet Break] Packet ${packetStock.barcode} broken by user ${req.user._id}. Sold: ${totalItemsToSell} items. Remaining: ${totalRemainingItems} items across ${looseStocksCreated.length} variants.`);
    
    return res.json(response);
    
  } catch (error) {
    console.error('Break packet error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   GET /api/packet-stock/loose/:productId
 * @desc    Get all loose stock entries for a product (for returns)
 * @access  Private
 */
router.get('/loose/:productId', auth, async (req, res) => {
  try {
    const { productId } = req.params;
    
    const looseStocks = await PacketStock.find({
      product: productId,
      isLoose: true,
      isActive: true,
      availablePackets: { $gt: 0 }
    })
      .populate('supplier', 'name company')
      .sort({ updatedAt: -1 });
    
    return res.json({
      success: true,
      data: looseStocks
    });
  } catch (error) {
    console.error('Get loose stock error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

/**
 * @route   POST /api/packet-stock/loose/:id/add-items
 * @desc    Add items back to existing loose stock (for returns)
 * @access  Private
 */
router.post('/loose/:id/add-items', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity = 1, reason = 'Return', notes = '' } = req.body;
    
    const looseStock = await PacketStock.findById(id);
    
    if (!looseStock) {
      return res.status(404).json({
        success: false,
        message: 'Loose stock not found'
      });
    }
    
    if (!looseStock.isLoose) {
      return res.status(400).json({
        success: false,
        message: 'This is a packet stock, not loose stock. Use different endpoint for packets.'
      });
    }
    
    await looseStock.addLooseItems(quantity, reason);
    
    console.log(`[Loose Stock] Added ${quantity} units to loose stock ${looseStock.barcode}. Reason: ${reason}. Notes: ${notes}`);
    
    return res.json({
      success: true,
      message: `Added ${quantity} unit(s) to loose stock`,
      data: {
        barcode: looseStock.barcode,
        newAvailable: looseStock.availablePackets
      }
    });
  } catch (error) {
    console.error('Add to loose stock error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Server error'
    });
  }
});

module.exports = router;
