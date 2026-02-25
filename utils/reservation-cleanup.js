const mongoose = require('mongoose');
const Sale = require('../models/Sale');
const Inventory = require('../models/Inventory');
const PacketStock = require('../models/PacketStock');

/**
 * Release reserved stock for expired reservations.
 * Finds sales with stockReserved=true and reservationExpiresAt in the past,
 * then releases their reserved inventory.
 */
async function cleanupExpiredReservations() {
  try {
    const expiredSales = await Sale.find({
      stockReserved: true,
      reservationExpiresAt: { $lt: new Date() },
      paymentStatus: { $in: ['pending', 'awaiting_payment'] },
    }).limit(50); // Process in batches

    if (expiredSales.length === 0) return;

    console.log(`[Reservation Cleanup] Found ${expiredSales.length} expired reservations`);

    for (const sale of expiredSales) {
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        for (const item of sale.items) {
          if (item.isPacketSale && item.packetBarcode) {
            const packetStock = await PacketStock.findOne({
              barcode: item.packetBarcode,
            }).session(session);

            if (packetStock) {
              packetStock.reservedPackets = Math.max(0, packetStock.reservedPackets - item.quantity);
              await packetStock.save({ session });
            }
          } else if (item.variant) {
            const inventory = await Inventory.findOne({
              product: item.product,
            }).session(session);

            if (inventory) {
              if (inventory.variantComposition && inventory.variantComposition.length > 0) {
                const variantIdx = inventory.variantComposition.findIndex(
                  (v) => v.size === item.variant.size && v.color === item.variant.color
                );
                if (variantIdx >= 0) {
                  inventory.variantComposition[variantIdx].reservedQuantity = Math.max(
                    0,
                    (inventory.variantComposition[variantIdx].reservedQuantity || 0) - item.quantity
                  );
                }
              }
              inventory.reservedStock = Math.max(0, (inventory.reservedStock || 0) - item.quantity);
              await inventory.save({ session });
            }
          }
        }

        // Mark sale as no longer reserved and set payment to failed
        sale.stockReserved = false;
        sale.paymentStatus = 'failed';
        await sale.save({ session });

        await session.commitTransaction();
        session.endSession();
        console.log(`[Reservation Cleanup] Released stock for sale ${sale.saleNumber}`);
      } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error(`[Reservation Cleanup] Error processing sale ${sale.saleNumber}:`, error.message);
      }
    }
  } catch (error) {
    console.error('[Reservation Cleanup] Error:', error.message);
  }
}

// Run cleanup every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

function startReservationCleanup() {
  console.log('[Reservation Cleanup] Starting periodic cleanup (every 5 minutes)');
  // Run once on startup after a short delay
  setTimeout(cleanupExpiredReservations, 10000);
  // Then run periodically
  setInterval(cleanupExpiredReservations, CLEANUP_INTERVAL_MS);
}

module.exports = { startReservationCleanup, cleanupExpiredReservations };
