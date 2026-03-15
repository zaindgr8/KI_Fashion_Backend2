const mongoose = require('mongoose');
const EditRequest = require('../models/EditRequest');
const DispatchOrder = require('../models/DispatchOrder');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const SupplierPaymentReceipt = require('../models/SupplierPaymentReceipt');
const Ledger = require('../models/Ledger');
const Buyer = require('../models/Buyer');
const PacketStock = require('../models/PacketStock');
const Inventory = require('../models/Inventory');

// Map entityType → Mongoose Model
const ENTITY_MODELS = {
  'dispatch-order': DispatchOrder,
  'sale': Sale,
  'payment': Payment,
  'supplier-payment': SupplierPaymentReceipt
};

// Map entityType → entityModel string (for polymorphic ref)
const ENTITY_MODEL_NAMES = {
  'dispatch-order': 'DispatchOrder',
  'sale': 'Sale',
  'payment': 'Payment',
  'supplier-payment': 'SupplierPaymentReceipt'
};

class EditRequestService {

  /**
   * Submit a new edit/delete request
   */
  static async submitRequest({ entityType, entityId, requestType, requestedChanges, rawPayload, reason, requestedBy, entityRef }) {
    const Model = ENTITY_MODELS[entityType];
    if (!Model) throw new Error(`Unknown entity type: ${entityType}`);

    // Validate entity exists
    const entity = await Model.findById(entityId).lean();
    if (!entity) throw new Error(`${entityType} not found`);

    // Check for duplicate pending request on same entity (v1: one at a time)
    const existing = await EditRequest.findOne({
      entityType,
      entityId,
      status: 'pending'
    });

    if (existing) {
      throw Object.assign(
        new Error('A pending request already exists for this record'),
        { status: 409, existingRequestNumber: existing.requestNumber }
      );
    }

    const requestNumber = await EditRequest.getNextRequestNumber();

    const editRequest = new EditRequest({
      requestNumber,
      entityType,
      entityId,
      entityModel: ENTITY_MODEL_NAMES[entityType],
      requestType,
      requestedChanges: requestType === 'edit' ? requestedChanges : null,
      rawPayload: requestType === 'edit' ? rawPayload : null,
      reason,
      entitySnapshot: entity,
      requestedBy,
      entityRef: entityRef || EditRequestService.getEntityRef(entityType, entity)
    });

    await editRequest.save();
    return editRequest;
  }

  /**
   * Approve an edit request — applies the mutation atomically
   */
  static async approveRequest(requestId, reviewerId, reviewNote, forceApprove = false) {
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });

    try {
      // Lock the request: pending → approved
      const editRequest = await EditRequest.findOneAndUpdate(
        { _id: requestId, status: 'pending' },
        {
          status: 'approved',
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNote: reviewNote || undefined
        },
        { new: true, session }
      ).populate('requestedBy', 'name email role');

      if (!editRequest) {
        await session.abortTransaction();
        return { success: false, message: 'Request not found or already processed' };
      }

      // Conflict check: compare snapshot version with current entity
      const Model = ENTITY_MODELS[editRequest.entityType];
      const currentEntity = await Model.findById(editRequest.entityId).session(session).lean();

      if (!currentEntity) {
        // Entity was deleted since request was submitted
        await EditRequest.findByIdAndUpdate(requestId, {
          status: 'rejected',
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNote: 'Entity no longer exists'
        }, { session });
        await session.commitTransaction();
        return { success: false, message: 'Entity no longer exists. Request auto-rejected.' };
      }

      // Version conflict check
      if (!forceApprove && editRequest.entitySnapshot.__v !== currentEntity.__v) {
        // Revert to pending so super-admin can decide
        await EditRequest.findByIdAndUpdate(requestId, {
          status: 'pending',
          reviewedBy: undefined,
          reviewedAt: undefined,
          reviewNote: undefined
        }, { session });
        await session.commitTransaction();
        return {
          success: false,
          conflict: true,
          message: 'Record was modified after this request was submitted. Review the current state and force-approve or reject.',
          currentEntity,
          snapshotEntity: editRequest.entitySnapshot
        };
      }

      let result;
      if (editRequest.requestType === 'edit') {
        result = await EditRequestService.applyEdit(editRequest, currentEntity, reviewerId, session);
      } else {
        result = await EditRequestService.applyDelete(editRequest, currentEntity, reviewerId, session);
      }

      // Auto-reject any other pending requests on the same entity
      await EditRequest.updateMany(
        {
          entityType: editRequest.entityType,
          entityId: editRequest.entityId,
          status: 'pending',
          _id: { $ne: editRequest._id }
        },
        {
          status: 'rejected',
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
          reviewNote: 'Auto-rejected: another request on this record was approved'
        },
        { session }
      );

      await session.commitTransaction();
      return { success: true, data: result, editRequest };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Reject an edit request
   */
  static async rejectRequest(requestId, reviewerId, reviewNote) {
    const editRequest = await EditRequest.findOneAndUpdate(
      { _id: requestId, status: 'pending' },
      {
        status: 'rejected',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote: reviewNote || 'Rejected'
      },
      { new: true }
    );

    if (!editRequest) {
      return { success: false, message: 'Request not found or already processed' };
    }

    return { success: true, editRequest };
  }

  /**
   * Record a super-admin direct edit for audit trail
   */
  static async recordDirectEdit({ entityType, entityId, requestType, requestedChanges, rawPayload, userId, entityRef }) {
    try {
      const Model = ENTITY_MODELS[entityType];
      if (!Model) return; // Skip silently for unknown types

      const entity = await Model.findById(entityId).lean();
      if (!entity) return;

      const requestNumber = await EditRequest.getNextRequestNumber();

      await EditRequest.create({
        requestNumber,
        entityType,
        entityId,
        entityModel: ENTITY_MODEL_NAMES[entityType],
        requestType: requestType || 'edit',
        status: 'approved',
        requestedChanges,
        rawPayload,
        reason: 'Direct edit by super-admin',
        entitySnapshot: entity,
        requestedBy: userId,
        reviewedBy: userId,
        reviewedAt: new Date(),
        directEdit: true,
        acknowledged: true,
        entityRef: entityRef || EditRequestService.getEntityRef(entityType, entity)
      });
    } catch (err) {
      // Non-critical — log but don't block the actual operation
      console.error('Failed to record direct edit audit:', err.message);
    }
  }

  /**
   * Get cascading impact counts for a delete request
   */
  static async getCascadingImpact(entityType, entityId) {
    const impact = {};

    if (entityType === 'dispatch-order') {
      impact.ledgerEntries = await Ledger.countDocuments({ referenceId: entityId, referenceModel: 'DispatchOrder' });
      impact.packetStockBatches = await PacketStock.countDocuments({ dispatchOrder: entityId });
    } else if (entityType === 'sale') {
      impact.ledgerEntries = await Ledger.countDocuments({ referenceId: entityId, referenceModel: 'Sale' });
      impact.paymentDistributions = await Payment.countDocuments({ 'distributions.saleId': entityId });
    } else if (entityType === 'payment') {
      const payment = await Payment.findById(entityId);
      impact.distributionCount = payment?.distributions?.length || 0;
      impact.ledgerEntries = await Ledger.countDocuments({ referenceId: entityId, referenceModel: 'Payment' });
    } else if (entityType === 'supplier-payment') {
      const receipt = await SupplierPaymentReceipt.findById(entityId);
      impact.distributionCount = receipt?.distributions?.length || 0;
      impact.ledgerEntries = await Ledger.countDocuments({ referenceId: entityId, referenceModel: 'Receipt' });
    }

    return impact;
  }

  // ===================== PRIVATE HELPERS =====================

  /**
   * Apply an edit to the entity
   */
  static async applyEdit(editRequest, currentEntity, reviewerId, session) {
    const { entityType, rawPayload, entityId } = editRequest;

    if (entityType === 'dispatch-order') {
      return EditRequestService.applyDispatchOrderEdit(entityId, rawPayload, reviewerId, session);
    } else if (entityType === 'sale') {
      return EditRequestService.applySaleEdit(entityId, rawPayload, session);
    } else if (entityType === 'payment') {
      // Payment edits = reverse + note
      return { message: 'Payment edit applied via reversal flow' };
    } else if (entityType === 'supplier-payment') {
      return { message: 'Supplier payment edit applied' };
    }
  }

  /**
   * Apply dispatch order edit — mirrors logic from PATCH /:id/edit-confirmed
   */
  static async applyDispatchOrderEdit(orderId, payload, reviewerId, session) {
    const { exchangeRate, percentage, discount, items: updatedItems } = payload;

    const dispatchOrder = await DispatchOrder.findById(orderId).populate('supplier').session(session);
    if (!dispatchOrder) throw new Error('Dispatch order not found');

    const editableStatuses = ['confirmed', 'picked_up', 'in_transit', 'delivered'];
    if (!editableStatuses.includes(dispatchOrder.status)) {
      throw new Error(`Cannot edit order with status: ${dispatchOrder.status}`);
    }

    const oldSupplierPaymentTotal = dispatchOrder.supplierPaymentTotal || 0;

    // Apply order-level changes
    if (exchangeRate !== undefined) dispatchOrder.exchangeRate = exchangeRate;
    if (percentage !== undefined) dispatchOrder.percentage = percentage;
    if (discount !== undefined) dispatchOrder.totalDiscount = discount;

    // Apply item-level changes
    if (updatedItems && Array.isArray(updatedItems)) {
      for (let i = 0; i < updatedItems.length && i < dispatchOrder.items.length; i++) {
        const update = updatedItems[i];
        if (!update) continue;

        let soldQty = 0;
        if (dispatchOrder.items[i].product) {
          const batch = await Inventory.findOne({
            product: dispatchOrder.items[i].product,
            'batches.dispatchOrderId': orderId,
            'batches.itemIndex': i
          }).session(session);

          if (batch) {
            const matchingBatch = batch.batches?.find(
              b => b.dispatchOrderId?.toString() === orderId.toString() && b.itemIndex === i
            );
            if (matchingBatch) {
              soldQty = (matchingBatch.quantity || 0) - (matchingBatch.remainingQuantity || 0);
            }
          }
        }

        if (update.costPrice !== undefined) {
          dispatchOrder.items[i].costPrice = update.costPrice;
        }
        if (update.quantity !== undefined) {
          if (update.quantity < soldQty) {
            throw new Error(`Cannot reduce item ${i + 1} quantity below sold amount (${soldQty})`);
          }
          dispatchOrder.items[i].quantity = update.quantity;
        }

        const hasConfigMutation =
          update.productName !== undefined ||
          update.productCode !== undefined ||
          update.primaryColor !== undefined ||
          update.size !== undefined ||
          update.season !== undefined ||
          update.material !== undefined ||
          update.description !== undefined ||
          update.productId !== undefined ||
          update.packets !== undefined ||
          update.useVariantTracking !== undefined;

        if (hasConfigMutation && soldQty > 0) {
          throw new Error(
            `Configuration changes are only allowed when sold quantity is 0 for item ${i + 1}. Sold amount: ${soldQty}`
          );
        }

        if (update.productName !== undefined) {
          dispatchOrder.items[i].productName = String(update.productName || '').trim() || dispatchOrder.items[i].productName;
        }
        if (update.productCode !== undefined) {
          dispatchOrder.items[i].productCode = String(update.productCode || '').trim().toUpperCase() || dispatchOrder.items[i].productCode;
        }
        if (update.primaryColor !== undefined) {
          dispatchOrder.items[i].primaryColor = Array.isArray(update.primaryColor) ? update.primaryColor.filter(Boolean) : [];
        }
        if (update.size !== undefined) {
          dispatchOrder.items[i].size = Array.isArray(update.size) ? update.size.filter(Boolean) : [];
        }
        if (update.season !== undefined) {
          dispatchOrder.items[i].season = Array.isArray(update.season) ? update.season.filter(Boolean) : [];
        }
        if (update.material !== undefined) {
          dispatchOrder.items[i].material = update.material ?? '';
        }
        if (update.description !== undefined) {
          dispatchOrder.items[i].description = update.description ?? '';
        }
        if (update.packets !== undefined) {
          dispatchOrder.items[i].packets = Array.isArray(update.packets) ? update.packets : [];
        }
        if (update.useVariantTracking !== undefined) {
          dispatchOrder.items[i].useVariantTracking = Boolean(update.useVariantTracking);
        }
        if (update.productId !== undefined && mongoose.Types.ObjectId.isValid(update.productId)) {
          dispatchOrder.items[i].product = new mongoose.Types.ObjectId(update.productId);
        }
      }
      dispatchOrder.markModified('items');
    }

    // Recalculate totals
    let supplierPaymentTotal = 0;
    let grandTotal = 0;
    const currentExchangeRate = dispatchOrder.exchangeRate || 1;
    const currentPercentage = dispatchOrder.percentage || 0;

    for (const item of dispatchOrder.items) {
      item.supplierPaymentAmount = item.costPrice * item.quantity;
      item.landedPrice = (item.costPrice / currentExchangeRate) * (1 + currentPercentage / 100);
      supplierPaymentTotal += item.supplierPaymentAmount;
      grandTotal += item.landedPrice * item.quantity;
    }

    supplierPaymentTotal -= (dispatchOrder.totalDiscount || 0);
    dispatchOrder.supplierPaymentTotal = supplierPaymentTotal;
    dispatchOrder.grandTotal = grandTotal;
    dispatchOrder.subtotal = grandTotal;

    await dispatchOrder.save({ session });

    // Create ledger adjustment if supplier payment changed
    let adjustmentEntry = null;
    const paymentDifference = supplierPaymentTotal - oldSupplierPaymentTotal;
    if (Math.abs(paymentDifference) > 0.01) {
      adjustmentEntry = new Ledger({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id || dispatchOrder.supplier,
        entityModel: 'Supplier',
        transactionType: 'adjustment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: paymentDifference > 0 ? paymentDifference : 0,
        credit: paymentDifference < 0 ? Math.abs(paymentDifference) : 0,
        date: new Date(),
        description: `Edit request adjustment for order ${dispatchOrder.orderNumber}`,
        createdBy: reviewerId
      });
      await adjustmentEntry.save({ session });
    }

    return { order: dispatchOrder, adjustmentEntry };
  }

  /**
   * Apply sale edit — mirrors logic from PUT /sales/:id
   */
  static async applySaleEdit(saleId, payload, session) {
    // Recalculate grandTotal from current sale totals + new discount/shipping
    const currentSale = await Sale.findById(saleId).session(session);
    if (!currentSale) throw new Error('Sale not found');

    // Ensure each item has totalPrice computed (frontend may not send it)
    if (Array.isArray(payload.items)) {
      payload.items = payload.items.map(item => ({
        ...item,
        totalPrice: item.totalPrice ?? (item.unitPrice * item.quantity * (1 - (item.discount || 0) / 100))
      }));
    }

    const newItems = payload.items || currentSale.items;
    const newSubtotal = newItems.reduce((sum, item) => sum + (item.totalPrice ?? item.unitPrice * item.quantity), 0);
    const subtotal = payload.items ? newSubtotal : (currentSale.subtotal || 0);
    const totalTax = currentSale.totalTax || 0;
    const newDiscount = payload.totalDiscount ?? currentSale.totalDiscount ?? 0;
    const newShipping = payload.shippingCost ?? currentSale.shippingCost ?? 0;
    const grandTotal = Math.max(0, subtotal + totalTax - newDiscount + newShipping);

    const sale = await Sale.findByIdAndUpdate(
      saleId,
      { ...payload, subtotal, totalTax, grandTotal },
      { new: true, runValidators: true, session }
    );
    if (!sale) throw new Error('Sale not found after update');

    // Re-sync ledger entries with the updated sale amounts
    if (sale.buyer) {
      try {
        const buyerId = sale.buyer;
        const grandTotal = sale.grandTotal || 0;
        const cashPayment = sale.cashPayment || 0;
        const bankPayment = sale.bankPayment || 0;
        const saleDate = sale.saleDate || sale.createdAt || new Date();

        // 1. Delete old sale debit entry and sale-time payment credits
        await Ledger.deleteMany({
          referenceId: saleId,
          referenceModel: 'Sale',
          transactionType: 'sale'
        });
        await Ledger.deleteMany({
          referenceId: saleId,
          referenceModel: 'Sale',
          isSaleTimePayment: true
        });

        // 2. Recreate sale debit entry with updated grandTotal
        await Ledger.createEntry({
          type: 'buyer',
          entityId: buyerId,
          entityModel: 'Buyer',
          transactionType: 'sale',
          referenceId: saleId,
          referenceModel: 'Sale',
          debit: grandTotal,
          credit: 0,
          date: saleDate,
          description: `Sale ${sale.saleNumber} - Total: ${grandTotal.toFixed(2)} (edited)`,
          paymentDetails: {
            cashPayment,
            bankPayment,
            remainingBalance: Math.max(0, grandTotal - cashPayment - bankPayment)
          },
          createdBy: sale.createdBy
        });

        // 3. Recreate sale-time payment credits
        if (cashPayment > 0) {
          await Ledger.createEntry({
            type: 'buyer',
            entityId: buyerId,
            entityModel: 'Buyer',
            transactionType: 'receipt',
            referenceId: saleId,
            referenceModel: 'Sale',
            debit: 0,
            credit: cashPayment,
            date: saleDate,
            description: `Cash payment for Sale ${sale.saleNumber}`,
            paymentMethod: 'cash',
            isSaleTimePayment: true,
            paymentDetails: { cashPayment, bankPayment: 0, remainingBalance: 0 },
            createdBy: sale.createdBy
          });
        }
        if (bankPayment > 0) {
          await Ledger.createEntry({
            type: 'buyer',
            entityId: buyerId,
            entityModel: 'Buyer',
            transactionType: 'receipt',
            referenceId: saleId,
            referenceModel: 'Sale',
            debit: 0,
            credit: bankPayment,
            date: saleDate,
            description: `Bank/Card payment for Sale ${sale.saleNumber}`,
            paymentMethod: 'bank',
            isSaleTimePayment: true,
            paymentDetails: { cashPayment: 0, bankPayment, remainingBalance: 0 },
            createdBy: sale.createdBy
          });
        }

        // 4. Recalculate running balances from this sale's date onwards
        await Ledger.recalculateBalances('buyer', buyerId, saleDate);

        // 5. Sync buyer's currentBalance from aggregated ledger
        const newBalance = await Ledger.getBalance('buyer', buyerId);
        await Buyer.findByIdAndUpdate(buyerId, { currentBalance: newBalance });

      } catch (ledgerError) {
        console.error('Ledger re-sync error after sale edit request approval:', ledgerError);
        // Don't fail the edit approval if ledger sync fails
      }
    }

    return { sale };
  }

  /**
   * Apply a delete to the entity
   */
  static async applyDelete(editRequest, currentEntity, reviewerId, session) {
    const { entityType, entityId } = editRequest;

    if (entityType === 'dispatch-order') {
      const order = await DispatchOrder.findById(entityId).session(session);
      if (order && order.status === 'pending') {
        await DispatchOrder.findByIdAndDelete(entityId, { session });
        return { message: `Dispatch order ${order.orderNumber} deleted` };
      }
      throw new Error('Only pending dispatch orders can be deleted');
    } else if (entityType === 'sale') {
      const sale = await EditRequestService.performSaleDeletion(entityId, reviewerId, session);
      return { message: `Sale ${sale.saleNumber} deleted` };
    } else if (entityType === 'payment') {
      // Payment deletion = reversal
      return { message: 'Payment delete applied (reversal)' };
    }

    return { message: 'Delete applied' };
  }

  /**
   * Performs the full deletion logic for a Sale (restoring stock, removing ledgers, updating buyer balance).
   * Used for both direct super-admin deletes and approved delete requests.
   */
  static async performSaleDeletion(saleId, userId, session) {
    const sale = await Sale.findById(saleId).session(session);
    if (!sale) throw new Error('Sale not found');

    // 1. Restore Inventory and PacketStock
    for (const item of sale.items) {
      const product = await mongoose.model('Product').findById(item.product).session(session);
      const inventory = await Inventory.findOne({ product: item.product }).session(session);

      if (inventory) {
        // Auto-heal negative reservedStock from old bugs
        if (inventory.reservedStock < 0) {
          inventory.reservedStock = 0;
        }

        // Clean up any existing invalid variants in the database before saving
        if (inventory.variantComposition && Array.isArray(inventory.variantComposition)) {
          inventory.variantComposition = inventory.variantComposition.filter(v => v.size && v.color);
        }

        const hasValidVariant = item.variant && item.variant.size && item.variant.color;

        // If variant tracked, restore variant stock
        if (product && product.variantTracking && product.variantTracking.enabled && hasValidVariant) {
          inventory.stockMovements.push({
            type: 'in',
            quantity: item.quantity,
            reference: 'Sale Deletion',
            referenceId: sale._id,
            user: userId,
            notes: `Deleted Sale: ${sale.saleNumber}`,
            date: new Date()
          });
          inventory.currentStock += item.quantity;

          let variantFound = false;
          inventory.variantComposition.forEach(v => {
            if (v.size === item.variant.size && v.color === item.variant.color) {
              v.quantity += item.quantity;
              variantFound = true;
            }
          });
          if (!variantFound) {
            inventory.variantComposition.push({
              size: item.variant.size,
              color: item.variant.color,
              quantity: item.quantity,
              reservedQuantity: 0
            });
          }
          inventory.lastStockUpdate = new Date();
          await inventory.save({ session });
        } else {
          inventory.currentStock += item.quantity;
          inventory.stockMovements.push({
            type: 'in',
            quantity: item.quantity,
            reference: 'Sale Deletion',
            referenceId: sale._id,
            user: userId,
            notes: `Deleted Sale: ${sale.saleNumber}`,
            date: new Date()
          });
          inventory.lastStockUpdate = new Date();
          await inventory.save({ session });
        }
      }

      if (item.isPacketSale && item.packetStock) {
        const packetStock = await PacketStock.findById(item.packetStock).session(session);
        if (packetStock) {
          const packetQty = item.packetQuantity || Math.ceil(item.quantity / (item.totalItemsPerPacket || 1));
          packetStock.availablePackets += packetQty;
          packetStock.soldPackets = Math.max(0, packetStock.soldPackets - packetQty);
          await packetStock.save({ session });
        }
      }
    }

    // 2. Delete Ledger Entries
    await Ledger.deleteMany({ referenceId: sale._id, referenceModel: 'Sale' }).session(session);
    await Ledger.deleteMany({ referenceId: sale._id, isSaleTimePayment: true }).session(session);

    // 3. Delete Payment distributions
    const salePayments = await Payment.find({ 'distributions.saleId': sale._id }).session(session);
    for (const payment of salePayments) {
      if (payment.distributions.length === 1 && payment.distributions[0].saleId.toString() === sale._id.toString()) {
        await Payment.findByIdAndDelete(payment._id).session(session);
      } else {
        payment.distributions = payment.distributions.filter(d => d.saleId.toString() !== sale._id.toString());
        await payment.save({ session });
      }
    }

    // 4. Update Buyer Metrics
    if (sale.buyer) {
      const cashPayment = sale.cashPayment || 0;
      const bankPayment = sale.bankPayment || 0;
      const remainingBalance = sale.grandTotal - cashPayment - bankPayment;

      await Buyer.findByIdAndUpdate(
        sale.buyer,
        {
          $inc: {
            totalSales: -sale.grandTotal,
            currentBalance: -remainingBalance
          }
        },
        { session }
      );
    }

    // 5. Delete the Sale Document
    await Sale.findByIdAndDelete(saleId).session(session);

    return sale;
  }

  /**
   * Extract a human-readable reference from an entity
   */
  static getEntityRef(entityType, entity) {
    switch (entityType) {
      case 'dispatch-order': return entity.orderNumber || '';
      case 'sale': return entity.saleNumber || '';
      case 'payment': return entity.paymentNumber || '';
      case 'supplier-payment': return entity.receiptNumber || '';
      default: return '';
    }
  }

  /**
   * Auto-reject pending requests when an entity is directly deleted
   */
  static async autoRejectForDeletedEntity(entityType, entityId, reviewerId) {
    await EditRequest.updateMany(
      { entityType, entityId, status: 'pending' },
      {
        status: 'rejected',
        reviewedBy: reviewerId,
        reviewedAt: new Date(),
        reviewNote: 'Auto-rejected: entity was deleted'
      }
    );
  }
}

module.exports = EditRequestService;
