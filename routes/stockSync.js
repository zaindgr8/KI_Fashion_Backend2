/**
 * Stock Sync and Alerts Routes
 * 
 * API endpoints for stock validation, alerts, and reconciliation
 */

const express = require('express');
const auth = require('../middleware/auth');
const StockSyncService = require('../services/StockSyncService');
const Inventory = require('../models/Inventory');
const PacketStock = require('../models/PacketStock');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

/**
 * @route   GET /api/stock-sync/validate/:productId
 * @desc    Validate stock synchronization for a product
 * @access  Private (Admin)
 */
router.get('/validate/:productId', auth, async (req, res) => {
  try {
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Access denied', 403);
    }

    const result = await StockSyncService.validateStockSync(req.params.productId);
    return sendResponse.success(res, result);
  } catch (error) {
    console.error('Stock validation error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

/**
 * @route   GET /api/stock-sync/validate-all
 * @desc    Validate stock synchronization for all products
 * @access  Private (Admin)
 */
router.get('/validate-all', auth, async (req, res) => {
  try {
    if (!['super-admin', 'admin'].includes(req.user.role)) {
      return sendResponse.error(res, 'Access denied', 403);
    }

    const inventories = await Inventory.find({ isActive: true }).select('product');
    const results = [];
    const issues = [];

    for (const inv of inventories) {
      const validation = await StockSyncService.validateStockSync(inv.product);
      results.push(validation);
      if (!validation.isValid) {
        issues.push(validation);
      }
    }

    return sendResponse.success(res, {
      totalProducts: results.length,
      syncedProducts: results.filter(r => r.isValid).length,
      issuesFound: issues.length,
      issues
    });
  } catch (error) {
    console.error('Bulk stock validation error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

/**
 * @route   GET /api/stock-sync/low-stock-alerts
 * @desc    Get low stock alerts for inventory and packets
 * @access  Private
 */
router.get('/low-stock-alerts', auth, async (req, res) => {
  try {
    const { limit = 50, includePackets = 'true' } = req.query;
    
    const alerts = await StockSyncService.getLowStockAlerts({
      limit: parseInt(limit),
      includePackets: includePackets === 'true'
    });

    // Calculate summary stats
    const criticalCount = (alerts.inventory?.filter(i => i.alertLevel === 'critical').length || 0) +
                          (alerts.packets?.filter(p => p.alertLevel === 'critical').length || 0);
    const highCount = (alerts.inventory?.filter(i => i.alertLevel === 'high').length || 0) +
                      (alerts.packets?.filter(p => p.alertLevel === 'high').length || 0);

    return sendResponse.success(res, {
      summary: {
        critical: criticalCount,
        high: highCount,
        total: (alerts.inventory?.length || 0) + (alerts.packets?.length || 0)
      },
      ...alerts
    });
  } catch (error) {
    console.error('Low stock alerts error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

/**
 * @route   POST /api/stock-sync/reconcile/:productId
 * @desc    Reconcile stock between Inventory and PacketStock
 * @access  Private (Super-Admin only)
 */
router.post('/reconcile/:productId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'super-admin') {
      return sendResponse.error(res, 'Only super-admin can reconcile stock', 403);
    }

    const { source = 'packets' } = req.body;
    
    if (!['inventory', 'packets'].includes(source)) {
      return sendResponse.error(res, 'Source must be "inventory" or "packets"', 400);
    }

    const result = await StockSyncService.reconcileStock(req.params.productId, source);
    
    if (!result.success) {
      return sendResponse.error(res, result.error, 400);
    }

    return sendResponse.success(res, result, 'Stock reconciled successfully');
  } catch (error) {
    console.error('Stock reconciliation error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

/**
 * @route   GET /api/stock-sync/packet-summary/:productId
 * @desc    Get detailed packet stock summary for a product
 * @access  Private
 */
router.get('/packet-summary/:productId', auth, async (req, res) => {
  try {
    const packetStocks = await PacketStock.find({ 
      product: req.params.productId, 
      isActive: true 
    })
      .populate('supplier', 'name company')
      .sort({ createdAt: -1 });

    const summary = {
      totalPackets: 0,
      totalItems: 0,
      reservedPackets: 0,
      soldPackets: 0,
      compositions: []
    };

    for (const ps of packetStocks) {
      summary.totalPackets += ps.availablePackets;
      summary.totalItems += ps.availablePackets * ps.totalItemsPerPacket;
      summary.reservedPackets += ps.reservedPackets;
      summary.soldPackets += ps.soldPackets;
      
      summary.compositions.push({
        barcode: ps.barcode,
        supplier: ps.supplier?.name || ps.supplier?.company,
        composition: ps.composition,
        itemsPerPacket: ps.totalItemsPerPacket,
        available: ps.availablePackets,
        reserved: ps.reservedPackets,
        sold: ps.soldPackets,
        isLoose: ps.isLoose,
        suggestedPrice: ps.suggestedSellingPrice,
        costPrice: ps.costPricePerPacket
      });
    }

    return sendResponse.success(res, summary);
  } catch (error) {
    console.error('Packet summary error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

/**
 * @route   GET /api/stock-sync/dashboard
 * @desc    Get stock sync dashboard data
 * @access  Private
 */
router.get('/dashboard', auth, async (req, res) => {
  try {
    // Get total inventory count
    const totalProducts = await Inventory.countDocuments({ isActive: true });
    
    // Get low stock count
    const lowStockCount = await Inventory.countDocuments({
      isActive: true,
      $expr: { $lte: ['$currentStock', '$reorderLevel'] }
    });
    
    // Get out of stock count
    const outOfStockCount = await Inventory.countDocuments({
      isActive: true,
      currentStock: 0
    });
    
    // Get packet stock summary
    const packetSummary = await PacketStock.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: null,
          totalPackets: { $sum: '$availablePackets' },
          reservedPackets: { $sum: '$reservedPackets' },
          soldPackets: { $sum: '$soldPackets' },
          uniqueBarcodes: { $addToSet: '$barcode' }
        }
      },
      {
        $project: {
          totalPackets: 1,
          reservedPackets: 1,
          soldPackets: 1,
          uniqueBarcodeCount: { $size: '$uniqueBarcodes' }
        }
      }
    ]);
    
    // Get low packet stock count
    const lowPacketStockCount = await PacketStock.countDocuments({
      isActive: true,
      availablePackets: { $lte: 5, $gt: 0 }
    });
    
    const outOfPacketStockCount = await PacketStock.countDocuments({
      isActive: true,
      availablePackets: 0
    });

    return sendResponse.success(res, {
      inventory: {
        totalProducts,
        lowStockCount,
        outOfStockCount,
        healthyStockCount: totalProducts - lowStockCount
      },
      packets: {
        totalPackets: packetSummary[0]?.totalPackets || 0,
        reservedPackets: packetSummary[0]?.reservedPackets || 0,
        soldPackets: packetSummary[0]?.soldPackets || 0,
        uniqueBarcodes: packetSummary[0]?.uniqueBarcodeCount || 0,
        lowStockCount: lowPacketStockCount,
        outOfStockCount: outOfPacketStockCount
      }
    });
  } catch (error) {
    console.error('Stock dashboard error:', error);
    return sendResponse.error(res, error.message, 500);
  }
});

module.exports = router;
