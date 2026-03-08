/**
 * PacketReturnService
 * 
 * Handles packet stock adjustments when items are returned to suppliers.
 * Supports both full packet returns (via barcode) and variant-specific returns (by color/size).
 * 
 * Key responsibilities:
 * - Find packets matching return criteria
 * - Validate packet availability before return
 * - Calculate which packets to adjust (FIFO order)
 * - Handle partial returns by breaking packets
 * - Maintain consistency between Inventory and PacketStock
 */

const PacketStock = require('../models/PacketStock');
const { generatePacketBarcode } = require('../utils/barcodeGenerator');

class PacketReturnService {

  /**
   * Find packet stock by barcode
   * @param {string} barcode - The packet barcode
   * @param {string} supplierId - Supplier ID for validation
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object|null} PacketStock document or null
   */
  static async findPacketByBarcode(barcode, supplierId, session = null) {
    const query = PacketStock.findOne({
      barcode,
      isActive: true
    });

    if (session) {
      query.session(session);
    }

    const packet = await query.populate('product', 'name sku productCode');

    if (packet && packet.supplier.toString() !== supplierId.toString()) {
      throw new Error(`Packet ${barcode} does not belong to specified supplier`);
    }

    return packet;
  }

  /**
   * Find all packets for a product+supplier with available stock
   * @param {string} productId - Product ID
   * @param {string} supplierId - Supplier ID
   * @param {Object} session - MongoDB session for transaction
   * @returns {Array} Array of PacketStock documents
   */
  static async findPacketsForProduct(productId, supplierId, session = null) {
    const query = PacketStock.find({
      product: productId,
      supplier: supplierId,
      isActive: true,
      availablePackets: { $gt: 0 }
    }).sort({ createdAt: 1 }); // FIFO order

    if (session) {
      query.session(session);
    }

    return query.exec();
  }

  /**
   * Find packets that contain specific variant (color/size)
   * @param {string} productId - Product ID
   * @param {string} supplierId - Supplier ID
   * @param {string} color - Color to match
   * @param {string} size - Size to match
   * @param {Object} session - MongoDB session for transaction
   * @returns {Array} Array of PacketStock documents containing the variant
   */
  static async findPacketsWithVariant(productId, supplierId, color, size, session = null) {
    const query = PacketStock.find({
      product: productId,
      supplier: supplierId,
      isActive: true,
      availablePackets: { $gt: 0 },
      'composition': {
        $elemMatch: {
          color: color,
          size: size,
          quantity: { $gte: 1 }
        }
      }
    }).sort({ isLoose: -1, createdAt: 1 }); // Prefer loose stock first, then FIFO

    if (session) {
      query.session(session);
    }

    return query.exec();
  }

  /**
   * Validate packet availability for return
   * @param {string} packetStockId - PacketStock ID
   * @param {number} requiredPackets - Number of packets needed
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object} Validation result with availability info
   */
  static async validatePacketAvailability(packetStockId, requiredPackets, session = null) {
    const query = PacketStock.findById(packetStockId);
    if (session) query.session(session);
    
    const packet = await query;

    if (!packet) {
      return {
        valid: false,
        error: `Packet stock ${packetStockId} not found`,
        available: 0,
        required: requiredPackets
      };
    }

    if (packet.availablePackets < requiredPackets) {
      return {
        valid: false,
        error: `Insufficient packets. Available: ${packet.availablePackets}, Required: ${requiredPackets}`,
        available: packet.availablePackets,
        required: requiredPackets,
        barcode: packet.barcode
      };
    }

    return {
      valid: true,
      available: packet.availablePackets,
      required: requiredPackets,
      barcode: packet.barcode,
      packet
    };
  }

  /**
   * Calculate how to adjust packets for variant-specific returns
   * This determines which packets to reduce/break based on return composition
   * 
   * @param {string} productId - Product ID
   * @param {string} supplierId - Supplier ID
   * @param {Array} variantReturns - Array of {color, size, quantity} to return
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object} Adjustment plan with packets to modify
   */
  static async calculateVariantReturnAdjustments(productId, supplierId, variantReturns, session = null) {
    const adjustmentPlan = {
      valid: true,
      errors: [],
      adjustments: [],
      totalItemsToReturn: 0,
      warnings: []
    };

    // Group returns by variant
    const returnMap = new Map();
    for (const vr of variantReturns) {
      const key = `${vr.color}|${vr.size}`;
      returnMap.set(key, (returnMap.get(key) || 0) + vr.quantity);
      adjustmentPlan.totalItemsToReturn += vr.quantity;
    }

    // Track planned breaks per packet to avoid duplicate break plans.
    // Key: packetStockId.toString(), Value: { plannedBreaks: number, adjustmentIndex: number, availableRemaining: number }
    const packetBreakTracker = new Map();

    // For each variant, find available packets
    for (const [key, requiredQty] of returnMap) {
      const [color, size] = key.split('|');
      let remainingQty = requiredQty;

      // First, try to find loose stock with this exact variant
      const looseStocks = await this.findPacketsWithVariant(productId, supplierId, color, size, session);
      const looseOnly = looseStocks.filter(p => p.isLoose);
      const packets = looseStocks.filter(p => !p.isLoose);

      // Use loose stock first
      for (const loose of looseOnly) {
        if (remainingQty <= 0) break;

        // For loose stock, availablePackets = available items
        const canReturn = Math.min(loose.availablePackets, remainingQty);

        if (canReturn > 0) {
          adjustmentPlan.adjustments.push({
            packetStockId: loose._id,
            barcode: loose.barcode,
            isLoose: true,
            adjustmentType: 'loose-return',
            color,
            size,
            itemsToReturn: canReturn,
            packetsToReturn: canReturn // For loose, 1 packet = 1 item
          });
          remainingQty -= canReturn;
        }
      }

      // If still need more, break packets (packets containing the variant)
      for (const packet of packets) {
        if (remainingQty <= 0) break;

        const variantInPacket = packet.composition.find(
          c => c.color === color && c.size === size
        );

        if (!variantInPacket) continue;

        const packetIdStr = packet._id.toString();
        const itemsPerPacket = variantInPacket.quantity;

        // Check if this packet is already planned for a break (from a different variant)
        const existing = packetBreakTracker.get(packetIdStr);

        if (existing) {
          // Packet already planned for breaking — merge this variant into the existing adjustment
          const existingAdj = adjustmentPlan.adjustments[existing.adjustmentIndex];
          const itemsToTake = Math.min(itemsPerPacket, remainingQty);

          // Add this variant to the existing break's itemsToReturn
          const existingVariant = existingAdj.itemsToReturn.find(
            i => i.color === color && i.size === size
          );
          if (existingVariant) {
            existingVariant.quantity += itemsToTake;
          } else {
            existingAdj.itemsToReturn.push({ color, size, quantity: itemsToTake });
          }

          remainingQty -= itemsToTake;

          // If we still need more from additional packets of the same type, handle overflow
          if (remainingQty > 0 && existing.availableRemaining > 0) {
            const additionalPacketsNeeded = Math.min(
              Math.ceil(remainingQty / itemsPerPacket),
              existing.availableRemaining
            );
            if (additionalPacketsNeeded > 0) {
              const itemsFromAdditional = Math.min(additionalPacketsNeeded * itemsPerPacket, remainingQty);
              existingAdj.packetsToBreak += additionalPacketsNeeded;
              existing.availableRemaining -= additionalPacketsNeeded;
              existing.plannedBreaks += additionalPacketsNeeded;

              // Update variant quantity
              const variantEntry = existingAdj.itemsToReturn.find(
                i => i.color === color && i.size === size
              );
              if (variantEntry) {
                variantEntry.quantity += itemsFromAdditional;
              }
              remainingQty -= itemsFromAdditional;
            }
          }
        } else {
          // New packet — plan a break
          const availablePackets = packet.availablePackets;

          if (availablePackets > 0) {
            const packetsToUse = Math.min(
              Math.ceil(remainingQty / itemsPerPacket),
              availablePackets
            );
            const itemsToTake = Math.min(packetsToUse * itemsPerPacket, remainingQty);

            const adjustmentIndex = adjustmentPlan.adjustments.length;
            adjustmentPlan.adjustments.push({
              packetStockId: packet._id,
              barcode: packet.barcode,
              isLoose: false,
              adjustmentType: 'partial-break',
              itemsToReturn: [{ color, size, quantity: itemsToTake }],
              packetsToBreak: packetsToUse,
              packetsToReturn: 0
            });

            // Track this packet so subsequent variants merge into it
            packetBreakTracker.set(packetIdStr, {
              plannedBreaks: packetsToUse,
              adjustmentIndex,
              availableRemaining: availablePackets - packetsToUse
            });

            remainingQty -= itemsToTake;
          }
        }
      }

      // If we still have remaining quantity, record as warning (not error) for best-effort
      if (remainingQty > 0) {
        adjustmentPlan.warnings.push(
          `Insufficient packet stock for ${color}/${size}. Short by ${remainingQty} items. Inventory will still be adjusted.`
        );
      }
    }

    return adjustmentPlan;
  }

  /**
   * Execute packet adjustments based on calculated plan
   * @param {Array} adjustments - Array of adjustment operations
   * @param {string} userId - User performing the return
   * @param {string} returnId - Return document ID for reference
   * @param {Object} session - MongoDB session for transaction
   * @returns {Object} Execution result with created loose stocks
   */
  static async executePacketAdjustments(adjustments, userId, returnId, session) {
    const results = {
      success: true,
      packetAdjustments: [],
      errors: [],
      warnings: [],
      totalItemsAdjusted: 0
    };

    for (const adj of adjustments) {
      try {
        const packet = await PacketStock.findById(adj.packetStockId).session(session);
        
        if (!packet) {
          results.warnings.push(`Packet ${adj.packetStockId} not found — skipped`);
          continue;
        }

        if (adj.adjustmentType === 'full-packet-return') {
          // Return full packets
          await packet.returnToSupplier(adj.packetsToReturn, returnId);
          
          results.packetAdjustments.push({
            packetStockId: packet._id,
            barcode: packet.barcode,
            adjustmentType: 'full-packet-return',
            packetsReturned: adj.packetsToReturn,
            itemsReturned: adj.packetsToReturn * packet.totalItemsPerPacket,
            looseStocksCreated: []
          });
          
          results.totalItemsAdjusted += adj.packetsToReturn * packet.totalItemsPerPacket;

        } else if (adj.adjustmentType === 'loose-return') {
          // Return loose items
          await packet.returnLooseToSupplier(adj.itemsToReturn, returnId);
          
          results.packetAdjustments.push({
            packetStockId: packet._id,
            barcode: packet.barcode,
            adjustmentType: 'loose-return',
            packetsReturned: 0,
            itemsReturned: adj.itemsToReturn,
            looseStocksCreated: []
          });
          
          results.totalItemsAdjusted += adj.itemsToReturn;

        } else if (adj.adjustmentType === 'partial-break') {
          // Break packet(s) and return specified items
          // breakForSupplierReturn breaks 1 packet at a time, so loop for multiple
          const packetsToBreak = adj.packetsToBreak || 1;
          let totalItemsReturned = 0;
          const allLooseStocks = [];

          for (let i = 0; i < packetsToBreak; i++) {
            // Re-fetch packet to get updated availablePackets count
            const freshPacket = i === 0 ? packet : await PacketStock.findById(adj.packetStockId).session(session);
            if (!freshPacket || freshPacket.availablePackets < 1) {
              results.warnings.push(`Packet ${adj.barcode}: could only break ${i} of ${packetsToBreak} planned packets`);
              break;
            }

            const breakResult = await freshPacket.breakForSupplierReturn(
              adj.itemsToReturn,
              userId,
              returnId,
              session
            );
            totalItemsReturned += breakResult.totalItemsReturned;
            allLooseStocks.push(...(breakResult.looseStocksCreated || []));
          }

          results.packetAdjustments.push({
            packetStockId: packet._id,
            barcode: packet.barcode,
            adjustmentType: 'partial-break',
            packetsReturned: 0,
            itemsReturned: totalItemsReturned,
            looseStocksCreated: allLooseStocks
          });

          results.totalItemsAdjusted += totalItemsReturned;
        }

      } catch (error) {
        // Packet adjustment errors are warnings, not hard failures.
        // The inventory reduction is the source of truth; packet stock is best-effort.
        results.warnings.push(`Error adjusting packet ${adj.barcode}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Main entry point for handling packet adjustments during product-level returns
   * Automatically determines return mode and executes appropriate adjustments
   * 
   * @param {Object} params - Return parameters
   * @param {string} params.productId - Product ID
   * @param {string} params.supplierId - Supplier ID
   * @param {number} params.quantity - Total quantity being returned
   * @param {Array} params.returnComposition - Variant breakdown [{color, size, quantity}]
   * @param {string} params.packetBarcode - Optional: specific packet barcode for packet-mode
   * @param {string} params.userId - User performing the return
   * @param {string} params.returnId - Return document ID (can be set after creation)
   * @param {Object} params.session - MongoDB session for transaction
   * @returns {Object} Result with packet adjustments made
   */
  static async processPacketAdjustmentsForReturn(params) {
    const {
      productId,
      supplierId,
      quantity,
      returnComposition,
      packetBarcode,
      userId,
      returnId,
      session
    } = params;

    const result = {
      success: true,
      returnMode: 'legacy',
      packetAdjustments: [],
      errors: [],
      warnings: [],
      totalPacketItemsAdjusted: 0
    };

    // Determine return mode
    if (packetBarcode) {
      result.returnMode = 'packet-barcode';
    } else if (returnComposition && returnComposition.length > 0) {
      result.returnMode = 'variant-specific';
    } else {
      // No variant info - cannot adjust packets, return as legacy
      result.warnings.push('No variant composition provided - packet stock not adjusted');
      return result;
    }

    try {
      if (result.returnMode === 'packet-barcode') {
        // Full packet return via barcode
        const packet = await this.findPacketByBarcode(packetBarcode, supplierId, session);
        
        if (!packet) {
          result.errors.push(`Packet with barcode ${packetBarcode} not found`);
          result.success = false;
          return result;
        }

        // Calculate packets needed
        const packetsNeeded = Math.ceil(quantity / packet.totalItemsPerPacket);
        
        // Validate availability
        const validation = await this.validatePacketAvailability(packet._id, packetsNeeded, session);
        if (!validation.valid) {
          result.errors.push(validation.error);
          result.success = false;
          return result;
        }

        // Execute full packet return
        const adjustments = [{
          packetStockId: packet._id,
          barcode: packet.barcode,
          adjustmentType: 'full-packet-return',
          packetsToReturn: packetsNeeded
        }];

        const execResult = await this.executePacketAdjustments(adjustments, userId, returnId, session);
        
        result.success = execResult.success;
        result.packetAdjustments = execResult.packetAdjustments;
        result.errors = result.errors.concat(execResult.errors);
        result.totalPacketItemsAdjusted = execResult.totalItemsAdjusted;

      } else {
        // Variant-specific return
        const adjustmentPlan = await this.calculateVariantReturnAdjustments(
          productId,
          supplierId,
          returnComposition,
          session
        );

        if (!adjustmentPlan.valid) {
          result.errors = result.errors.concat(adjustmentPlan.errors);
          result.success = false;
          return result;
        }

        result.warnings = result.warnings.concat(adjustmentPlan.warnings);

        // Execute the adjustments
        const execResult = await this.executePacketAdjustments(
          adjustmentPlan.adjustments,
          userId,
          returnId,
          session
        );

        result.success = execResult.success;
        result.packetAdjustments = execResult.packetAdjustments;
        result.errors = result.errors.concat(execResult.errors);
        result.totalPacketItemsAdjusted = execResult.totalItemsAdjusted;
      }

    } catch (error) {
      result.success = false;
      result.errors.push(`Packet adjustment error: ${error.message}`);
    }

    return result;
  }

  /**
   * Get packet stock summary for a product (for validation UI)
   * @param {string} productId - Product ID
   * @param {string} supplierId - Supplier ID
   * @returns {Object} Summary of available packets and loose stock
   */
  static async getPacketStockSummary(productId, supplierId) {
    const packets = await PacketStock.find({
      product: productId,
      supplier: supplierId,
      isActive: true,
      availablePackets: { $gt: 0 }
    }).populate('product', 'name sku productCode');

    const summary = {
      totalPackets: 0,
      totalLooseItems: 0,
      totalItems: 0,
      packetConfigurations: [],
      looseVariants: [],
      variantBreakdown: {}
    };

    for (const packet of packets) {
      if (packet.isLoose) {
        summary.totalLooseItems += packet.availablePackets;
        summary.totalItems += packet.availablePackets;
        
        // Track loose variants
        for (const comp of packet.composition) {
          const key = `${comp.color}|${comp.size}`;
          summary.variantBreakdown[key] = (summary.variantBreakdown[key] || 0) + packet.availablePackets;
          
          summary.looseVariants.push({
            barcode: packet.barcode,
            color: comp.color,
            size: comp.size,
            available: packet.availablePackets
          });
        }
      } else {
        summary.totalPackets += packet.availablePackets;
        const itemsInPackets = packet.availablePackets * packet.totalItemsPerPacket;
        summary.totalItems += itemsInPackets;

        // Track packet compositions
        summary.packetConfigurations.push({
          barcode: packet.barcode,
          availablePackets: packet.availablePackets,
          itemsPerPacket: packet.totalItemsPerPacket,
          totalItems: itemsInPackets,
          composition: packet.composition
        });

        // Track variants in packets
        for (const comp of packet.composition) {
          const key = `${comp.color}|${comp.size}`;
          const itemsForVariant = packet.availablePackets * comp.quantity;
          summary.variantBreakdown[key] = (summary.variantBreakdown[key] || 0) + itemsForVariant;
        }
      }
    }

    return summary;
  }

  /**
   * Compare Inventory stock with PacketStock total to find discrepancies
   * @param {string} productId - Product ID (optional, null for all products)
   * @returns {Array} List of discrepancies
   */
  static async findStockDiscrepancies(productId = null) {
    const Inventory = require('../models/Inventory');
    
    const matchStage = productId 
      ? { $match: { product: new (require('mongoose').Types.ObjectId)(productId) } }
      : { $match: {} };

    // Aggregate inventory data
    const inventories = await Inventory.aggregate([
      matchStage,
      {
        $lookup: {
          from: 'products',
          localField: 'product',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      {
        $unwind: '$productInfo'
      },
      {
        $project: {
          _id: 1,
          productId: '$product',
          productName: '$productInfo.name',
          productCode: '$productInfo.productCode',
          inventoryStock: '$currentStock'
        }
      }
    ]);

    const discrepancies = [];

    for (const inv of inventories) {
      // Get total items in packet stock for this product
      const packetTotals = await PacketStock.aggregate([
        {
          $match: {
            product: inv.productId,
            isActive: true
          }
        },
        {
          $group: {
            _id: null,
            totalPacketItems: {
              $sum: {
                $cond: [
                  '$isLoose',
                  '$availablePackets', // For loose, each "packet" is 1 item
                  { $multiply: ['$availablePackets', '$totalItemsPerPacket'] }
                ]
              }
            }
          }
        }
      ]);

      const packetStock = packetTotals[0]?.totalPacketItems || 0;
      const diff = inv.inventoryStock - packetStock;

      if (Math.abs(diff) > 0.001) { // Allow tiny floating point differences
        discrepancies.push({
          productId: inv.productId,
          productName: inv.productName,
          productCode: inv.productCode,
          inventoryStock: inv.inventoryStock,
          packetStock: packetStock,
          difference: diff,
          status: diff > 0 ? 'inventory_higher' : 'packets_higher'
        });
      }
    }

    return discrepancies;
  }
}

module.exports = PacketReturnService;
