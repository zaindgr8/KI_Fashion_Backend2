/**
 * StockSyncService
 * 
 * Service for ensuring Inventory and PacketStock remain in sync.
 * Provides validation and atomic operations for stock management.
 */

const mongoose = require('mongoose');
const Inventory = require('../models/Inventory');
const PacketStock = require('../models/PacketStock');

class StockSyncService {
  /**
   * Validate that PacketStock total items match Inventory stock for a product
   * @param {string} productId - The product ID to validate
   * @returns {Object} Validation result with details
   */
  static async validateStockSync(productId) {
    const inventory = await Inventory.findOne({ product: productId });
    const packetStocks = await PacketStock.find({ product: productId, isActive: true });
    
    if (!inventory) {
      return {
        isValid: false,
        error: 'Inventory not found',
        productId
      };
    }
    
    // Calculate total items from all packet stocks
    let totalPacketItems = 0;
    const packetDetails = [];
    
    for (const ps of packetStocks) {
      const packetItems = ps.availablePackets * ps.totalItemsPerPacket;
      totalPacketItems += packetItems;
      packetDetails.push({
        barcode: ps.barcode,
        availablePackets: ps.availablePackets,
        itemsPerPacket: ps.totalItemsPerPacket,
        totalItems: packetItems,
        isLoose: ps.isLoose
      });
    }
    
    const inventoryTotal = inventory.currentStock;
    const difference = Math.abs(inventoryTotal - totalPacketItems);
    
    // Allow small rounding differences
    const isValid = difference <= 1;
    
    return {
      isValid,
      productId,
      inventoryStock: inventoryTotal,
      packetStockItems: totalPacketItems,
      difference,
      packetDetails,
      message: isValid 
        ? 'Stock is synchronized' 
        : `Stock mismatch: Inventory has ${inventoryTotal} items, PacketStock has ${totalPacketItems} items`
    };
  }
  
  /**
   * Get low stock alerts for products below reorder level
   * @param {Object} options - Filter options
   * @returns {Array} List of products with low stock
   */
  static async getLowStockAlerts(options = {}) {
    const { limit = 50, includePackets = true } = options;
    
    const lowStockInventory = await Inventory.aggregate([
      {
        $match: {
          isActive: true,
          $expr: { $lte: ['$currentStock', '$reorderLevel'] }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $project: {
          productId: '$product',
          productName: '$productInfo.name',
          productCode: '$productInfo.productCode',
          sku: '$productInfo.sku',
          currentStock: 1,
          reorderLevel: 1,
          reorderQuantity: 1,
          stockDeficit: { $subtract: ['$reorderLevel', '$currentStock'] },
          alertLevel: {
            $cond: [
              { $eq: ['$currentStock', 0] }, 'critical',
              { $cond: [
                { $lte: ['$currentStock', { $divide: ['$reorderLevel', 2] }] }, 
                'high', 
                'medium'
              ]}
            ]
          }
        }
      },
      { $sort: { alertLevel: 1, stockDeficit: -1 } },
      { $limit: limit }
    ]);
    
    if (includePackets) {
      // Also check packet stock levels
      const lowPacketStock = await PacketStock.aggregate([
        {
          $match: {
            isActive: true,
            availablePackets: { $lte: 5 } // Alert when 5 or fewer packets available
          }
        },
        {
          $lookup: {
            from: 'products',
            localField: 'product',
            foreignField: '_id',
            as: 'productInfo'
          }
        },
        { $unwind: '$productInfo' },
        {
          $project: {
            barcode: 1,
            productId: '$product',
            productName: '$productInfo.name',
            productCode: '$productInfo.productCode',
            availablePackets: 1,
            totalItemsPerPacket: 1,
            isLoose: 1,
            alertLevel: {
              $cond: [
                { $eq: ['$availablePackets', 0] }, 'critical',
                { $cond: [
                  { $lte: ['$availablePackets', 2] }, 
                  'high', 
                  'medium'
                ]}
              ]
            }
          }
        },
        { $sort: { alertLevel: 1, availablePackets: 1 } },
        { $limit: limit }
      ]);
      
      return {
        inventory: lowStockInventory,
        packets: lowPacketStock
      };
    }
    
    return { inventory: lowStockInventory };
  }
  
  /**
   * Perform atomic stock update for both Inventory and PacketStock
   * @param {Object} params - Update parameters
   * @returns {Object} Result of the operation
   */
  static async atomicStockUpdate({
    productId,
    inventoryUpdate,
    packetStockId,
    packetStockUpdate,
    reason,
    userId
  }) {
    const session = await mongoose.startSession();
    session.startTransaction();
    
    try {
      // Update Inventory
      const inventory = await Inventory.findOne({ product: productId }).session(session);
      if (!inventory) {
        throw new Error(`Inventory not found for product ${productId}`);
      }
      
      if (inventoryUpdate.type === 'decrease') {
        inventory.currentStock = Math.max(0, inventory.currentStock - inventoryUpdate.quantity);
        inventory.reservedStock = Math.max(0, inventory.reservedStock - (inventoryUpdate.releaseReserved || 0));
        
        inventory.stockMovements.push({
          type: 'out',
          quantity: inventoryUpdate.quantity,
          reference: reason,
          referenceId: inventoryUpdate.referenceId,
          user: userId,
          notes: inventoryUpdate.notes,
          date: new Date()
        });
      } else if (inventoryUpdate.type === 'increase') {
        inventory.currentStock += inventoryUpdate.quantity;
        
        inventory.stockMovements.push({
          type: 'in',
          quantity: inventoryUpdate.quantity,
          reference: reason,
          referenceId: inventoryUpdate.referenceId,
          user: userId,
          notes: inventoryUpdate.notes,
          date: new Date()
        });
      }
      
      inventory.lastStockUpdate = new Date();
      await inventory.save({ session });
      
      // Update PacketStock if provided
      let packetStock = null;
      if (packetStockId) {
        packetStock = await PacketStock.findById(packetStockId).session(session);
        if (!packetStock) {
          throw new Error(`PacketStock not found: ${packetStockId}`);
        }
        
        if (packetStockUpdate.type === 'sell') {
          packetStock.availablePackets = Math.max(0, packetStock.availablePackets - packetStockUpdate.quantity);
          packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - packetStockUpdate.quantity);
          packetStock.soldPackets += packetStockUpdate.quantity;
        } else if (packetStockUpdate.type === 'restore') {
          packetStock.availablePackets += packetStockUpdate.quantity;
          packetStock.soldPackets = Math.max(0, packetStock.soldPackets - packetStockUpdate.quantity);
        } else if (packetStockUpdate.type === 'reserve') {
          packetStock.reservedPackets += packetStockUpdate.quantity;
        } else if (packetStockUpdate.type === 'release') {
          packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - packetStockUpdate.quantity);
        }
        
        await packetStock.save({ session });
      }
      
      await session.commitTransaction();
      session.endSession();
      
      return {
        success: true,
        inventory: {
          currentStock: inventory.currentStock,
          reservedStock: inventory.reservedStock
        },
        packetStock: packetStock ? {
          availablePackets: packetStock.availablePackets,
          reservedPackets: packetStock.reservedPackets,
          soldPackets: packetStock.soldPackets
        } : null
      };
      
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      
      console.error('[StockSyncService] Atomic stock update failed:', error.message);
      throw error;
    }
  }
  
  /**
   * Reconcile stock between Inventory and PacketStock
   * Use with caution - this modifies data
   * @param {string} productId - Product to reconcile
   * @param {string} source - 'inventory' or 'packets' - which to use as source of truth
   * @returns {Object} Reconciliation result
   */
  static async reconcileStock(productId, source = 'inventory') {
    const inventory = await Inventory.findOne({ product: productId });
    const packetStocks = await PacketStock.find({ product: productId, isActive: true });
    
    if (!inventory) {
      return { success: false, error: 'Inventory not found' };
    }
    
    const totalPacketItems = packetStocks.reduce(
      (sum, ps) => sum + (ps.availablePackets * ps.totalItemsPerPacket), 
      0
    );
    
    const before = {
      inventoryStock: inventory.currentStock,
      packetStockItems: totalPacketItems
    };
    
    if (source === 'inventory') {
      // Note: Cannot easily reconcile packets from inventory 
      // because we don't know how to distribute items across packet compositions
      return {
        success: false,
        error: 'Cannot auto-reconcile from inventory to packets. Manual adjustment required.',
        before
      };
    } else {
      // Use packet stock as source of truth
      inventory.currentStock = totalPacketItems;
      inventory.stockMovements.push({
        type: 'adjustment',
        quantity: totalPacketItems - before.inventoryStock,
        reference: 'StockReconciliation',
        notes: `Auto-reconciled from PacketStock totals`,
        date: new Date()
      });
      await inventory.save();
      
      return {
        success: true,
        before,
        after: {
          inventoryStock: inventory.currentStock,
          packetStockItems: totalPacketItems
        },
        adjustment: totalPacketItems - before.inventoryStock
      };
    }
  }
}

module.exports = StockSyncService;
