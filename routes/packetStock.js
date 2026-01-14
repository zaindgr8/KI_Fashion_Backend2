const express = require('express');
const router = express.Router();
const PacketStock = require('../models/PacketStock');
const Product = require('../models/Product');
const auth = require('../middleware/auth');
const QRCode = require('qrcode');
const { generatePacketBarcode, generateLooseItemBarcode, normalizeBarcode, parseBarcodeType } = require('../utils/barcodeGenerator');

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
    
    return res.json({
      success: true,
      data: {
        barcode: packetStock.barcode,
        qrCode: packetStock.qrCode?.dataUrl,
        productName: packetStock.product?.name,
        productCode: packetStock.product?.productCode,
        supplierName: packetStock.supplier?.name || packetStock.supplier?.company,
        composition: packetStock.composition,
        totalItemsPerPacket: packetStock.totalItemsPerPacket,
        isLoose: packetStock.isLoose,
        availablePackets: packetStock.availablePackets
      }
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

module.exports = router;
