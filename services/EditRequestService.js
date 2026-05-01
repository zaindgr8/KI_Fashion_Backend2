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
const Expense = require('../models/Expense');
const Return = require('../models/Return');
const SaleReturn = require('../models/SaleReturn');
const { generateSaleNumber } = require('../utils/sale-number');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const LogisticsCompany = require('../models/LogisticsCompany');
const { generatePacketBarcode, generateLooseItemBarcode } = require('../utils/barcodeGenerator');
const { generateDispatchOrderQR } = require('../utils/qrCode');
const { getTransactionDate } = require('../utils/helpers');

// Map entityType → Mongoose Model
const ENTITY_MODELS = {
  'dispatch-order': DispatchOrder,
  'sale': Sale,
  'payment': Payment,
  'supplier-payment': SupplierPaymentReceipt,
  'expense': Expense,
  'return': Return,
  'sale-return': SaleReturn
};

// Map entityType → entityModel string (for polymorphic ref)
const ENTITY_MODEL_NAMES = {
  'dispatch-order': 'DispatchOrder',
  'sale': 'Sale',
  'payment': 'Payment',
  'supplier-payment': 'SupplierPaymentReceipt',
  'expense': 'Expense',
  'return': 'Return',
  'sale-return': 'SaleReturn'
};

class EditRequestService {

  /**
   * Submit a new edit/delete/create request
   */
  static async submitRequest({ entityType, entityId, requestType, requestedChanges, rawPayload, reason, requestedBy, entityRef }) {
    const Model = ENTITY_MODELS[entityType];
    if (!Model) throw new Error(`Unknown entity type: ${entityType}`);

    let entity = null;
    if (requestType !== 'create') {
      // Validate entity exists for edit/delete
      entity = await Model.findById(entityId).lean();
      if (!entity) throw new Error(`${entityType} not found`);

      // Check for duplicate pending request on same entity
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
    }

    const requestNumber = await EditRequest.getNextRequestNumber();

    const editRequest = new EditRequest({
      requestNumber,
      entityType,
      entityId,
      entityModel: ENTITY_MODEL_NAMES[entityType],
      requestType,
      requestedChanges: requestType === 'edit' ? requestedChanges : null,
      rawPayload: (requestType === 'edit' || requestType === 'create') ? rawPayload : null,
      reason,
      entitySnapshot: entity,
      requestedBy,
      entityRef: entityRef || (entity ? EditRequestService.getEntityRef(entityType, entity) : 'New Record')
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

      let result;
      
      if (editRequest.requestType === 'create') {
        // Creation doesn't need conflict check
        result = await EditRequestService.applyCreate(editRequest, reviewerId, session);
      } else {
        // Conflict check: compare snapshot version with current entity for edits/deletes
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
      }

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

  /**
   * Apply a create request — creates the entity and handles side effects
   */
  static async applyCreate(editRequest, reviewerId, session) {
    const { entityType, rawPayload, requestedBy } = editRequest;

    if (entityType === 'sale') {
      return EditRequestService.applySaleCreate(rawPayload, requestedBy._id || requestedBy, session);
    } else if (entityType === 'payment') {
      return EditRequestService.applyPaymentCreate(rawPayload, requestedBy._id || requestedBy, session);
    } else if (entityType === 'supplier-payment') {
      return EditRequestService.applySupplierPaymentCreate(rawPayload, requestedBy._id || requestedBy, session);
    } else if (entityType === 'dispatch-order') {
      return EditRequestService.applyDispatchOrderCreate(rawPayload, requestedBy._id || requestedBy, session);
    } else if (entityType === 'expense') {
      return EditRequestService.applyExpenseCreate(rawPayload, requestedBy._id || requestedBy, session);
    }

    throw new Error(`Creation not implemented for entity type: ${entityType}`);
  }

  /**
   * Sale creation logic — extracted from routes/sales.js
   */
  static async applySaleCreate(payload, userId, session) {
    const { buyer, manualCustomer, items, totalDiscount, shippingCost, cashPayment, bankPayment, saleDate, saleType, notes } = payload;

    // 1. Generate Sale Number
    const saleNumber = await generateSaleNumber();

    // 2. Calculate Totals
    let subtotal = 0;
    let totalTax = 0;
    const processedItems = items.map(item => {
      const itemTotal = (item.quantity * item.unitPrice) - (item.discount || 0);
      const itemTax = itemTotal * ((item.taxRate || 0) / 100);
      subtotal += itemTotal;
      totalTax += itemTax;
      return {
        ...item,
        totalPrice: itemTotal + itemTax
      };
    });

    const grandTotal = Math.max(0, subtotal + totalTax - (totalDiscount || 0) + (shippingCost || 0));

    // 3. Process Stock (Atomic)
    for (const item of processedItems) {
      const product = await mongoose.model('Product').findById(item.product).session(session);
      const inventory = await Inventory.findOne({ product: item.product }).session(session);

      if (!inventory) throw new Error(`Inventory not found for product ${item.product}`);

      // Basic stock check (even for backdates, we check current stock unless we want to allow negative)
      // Usually, for backdates, we assume stock was there or we allow it to go negative if configured.
      // Here we just update.
      inventory.currentStock -= item.quantity;
      inventory.stockMovements.push({
        type: 'out',
        quantity: item.quantity,
        reference: 'Sale',
        referenceId: null, // Will update after save
        user: userId,
        notes: `Sale ${saleNumber} (Backdated Approval)`,
        date: getTransactionDate(saleDate)
      });

      if (product.variantTracking?.enabled && item.variant) {
        const variant = inventory.variantComposition.find(
          v => v.size === item.variant.size && v.color === item.variant.color
        );
        if (variant) {
          variant.quantity -= item.quantity;
        } else {
          // If variant wasn't in inventory, we might want to error or just subtract
          inventory.variantComposition.push({
            ...item.variant,
            quantity: -item.quantity,
            reservedQuantity: 0
          });
        }
      }
      await inventory.save({ session });

      if (item.isPacketSale && item.packetStock) {
        const packetStock = await PacketStock.findById(item.packetStock).session(session);
        if (packetStock) {
          packetStock.availablePackets -= (item.packetQuantity || 1);
          packetStock.soldPackets += (item.packetQuantity || 1);
          await packetStock.save({ session });
        }
      }
    }

    // 4. Create Sale Record
    const sale = new Sale({
      saleNumber,
      buyer,
      manualCustomer,
      items: processedItems,
      subtotal,
      totalTax,
      totalDiscount,
      shippingCost,
      grandTotal,
      cashPayment,
      bankPayment,
      saleDate: getTransactionDate(saleDate),
      saleType: saleType || 'retail',
      notes,
      createdBy: userId,
      paymentStatus: (cashPayment + bankPayment) >= grandTotal ? 'paid' : (cashPayment + bankPayment > 0 ? 'partial' : 'pending')
    });
    await sale.save({ session });

    // 5. Update stock movement references
    for (const item of processedItems) {
      await Inventory.updateOne(
        { product: item.product, 'stockMovements.notes': `Sale ${saleNumber} (Backdated Approval)` },
        { $set: { 'stockMovements.$.referenceId': sale._id } },
        { session }
      );
    }

    // 6. Ledger entry & Buyer balance
    if (buyer) {
      // Debit buyer for sale
      const debitEntry = new Ledger({
        type: 'buyer',
        entityId: buyer,
        entityModel: 'Buyer',
        transactionType: 'sale',
        referenceId: sale._id,
        referenceModel: 'Sale',
        debit: grandTotal,
        credit: 0,
        date: sale.saleDate,
        description: `Sale ${saleNumber}`,
        createdBy: userId
      });
      await debitEntry.save({ session });

      // Credit buyer for payments
      if (cashPayment > 0) {
        await new Ledger({
          type: 'buyer',
          entityId: buyer,
          entityModel: 'Buyer',
          transactionType: 'receipt',
          referenceId: sale._id,
          referenceModel: 'Sale',
          debit: 0,
          credit: cashPayment,
          date: sale.saleDate,
          description: `Cash payment for Sale ${saleNumber}`,
          paymentMethod: 'cash',
          isSaleTimePayment: true,
          createdBy: userId
        }).save({ session });
      }

      if (bankPayment > 0) {
        await new Ledger({
          type: 'buyer',
          entityId: buyer,
          entityModel: 'Buyer',
          transactionType: 'receipt',
          referenceId: sale._id,
          referenceModel: 'Sale',
          debit: 0,
          credit: bankPayment,
          date: sale.saleDate,
          description: `Bank payment for Sale ${saleNumber}`,
          paymentMethod: 'bank',
          isSaleTimePayment: true,
          createdBy: userId
        }).save({ session });
      }

      // Update buyer balance
      const balanceImpact = grandTotal - (cashPayment + bankPayment);
      await Buyer.findByIdAndUpdate(buyer, {
        $inc: {
          currentBalance: balanceImpact,
          totalSales: grandTotal
        }
      }, { session });
    }

    return sale;
  }

  /**
   * Customer Payment creation logic
   */
  static async applyPaymentCreate(payload, userId, session) {
    const { customerId, amount, paymentMethod, date, description, paymentDirection = 'credit', debitReason } = payload;
    const BalanceService = require('./BalanceService');

    const paymentNumber = await Payment.getNextPaymentNumber(session);
    const paymentDate = getTransactionDate(date);
    const balanceBefore = await BalanceService.getBuyerBalance(customerId);

    let distributions = [];
    let advanceAmount = 0;
    let balanceAfter = balanceBefore;

    if (paymentDirection === 'debit') {
      // Handle Debit (Refund/Adjustment)
      const debitReasonLabels = {
        'refund': 'Refund',
        'credit_note': 'Credit Note',
        'price_adjustment': 'Price Adjustment',
        'goodwill': 'Goodwill Credit',
        'other': 'Adjustment'
      };

      const debitLedgerEntry = await Ledger.createEntry({
        type: 'buyer',
        entityId: customerId,
        entityModel: 'Buyer',
        transactionType: 'adjustment',
        debit: parseFloat(amount),
        credit: 0,
        paymentMethod,
        date: paymentDate,
        description: description || `${debitReasonLabels[debitReason] || 'Adjustment'} - ${paymentNumber}`,
        createdBy: userId,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? parseFloat(amount) : 0,
          bankPayment: paymentMethod === 'bank' ? parseFloat(amount) : 0,
          remainingBalance: 0
        }
      }, session);

      distributions.push({
        saleId: null,
        saleNumber: (debitReasonLabels[debitReason] || 'ADJUSTMENT').toUpperCase(),
        amountApplied: parseFloat(amount),
        previousBalance: 0,
        newBalance: parseFloat(amount),
        ledgerEntryId: debitLedgerEntry._id,
        isAdvance: false
      });

      balanceAfter = balanceBefore + parseFloat(amount);
    } else {
      // Handle Credit (Normal Payment)
      const result = await BalanceService.distributeBuyerPayment({
        buyerId: customerId,
        amount: parseFloat(amount),
        paymentMethod,
        createdBy: userId,
        description,
        date: paymentDate,
        session
      });

      distributions = result.distributions;
      advanceAmount = result.remainingCredit || 0;
      balanceAfter = balanceBefore - parseFloat(amount);
    }

    const payment = new Payment({
      paymentNumber,
      paymentType: 'customer',
      paymentDirection,
      debitReason: paymentDirection === 'debit' ? debitReason : undefined,
      customerId,
      totalAmount: parseFloat(amount),
      cashAmount: paymentMethod === 'cash' ? parseFloat(amount) : 0,
      bankAmount: paymentMethod === 'bank' ? parseFloat(amount) : 0,
      paymentMethod,
      paymentDate,
      description,
      distributions,
      advanceAmount,
      balanceBefore,
      balanceAfter,
      status: 'active',
      createdBy: userId
    });

    await payment.save({ session });
    return payment;
  }

  /**
   * Supplier Payment creation logic
   */
  static async applySupplierPaymentCreate(payload, userId, session) {
    const { supplierId, amount, paymentMethod, date, description } = payload;
    const BalanceService = require('./BalanceService');

    const result = await BalanceService.distributeUniversalPayment({
      supplierId,
      amount: parseFloat(amount),
      paymentMethod,
      createdBy: userId,
      description,
      date: getTransactionDate(date),
      session
    });

    return await mongoose.model('SupplierPaymentReceipt').findById(result.receiptId).session(session);
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
    } else if (entityType === 'expense') {
      return { message: 'Expense edit applied' };
    }
  }

  /**
   * Expense creation logic
   */
  static async applyExpenseCreate(payload, userId, session) {
    const expense = new Expense({
      ...payload,
      expenseNumber: `EXP-B-${Date.now()}`, // B prefix for backdated approval
      status: 'approved',
      approvedBy: userId,
      createdBy: userId
    });

    await expense.save({ session });
    return expense;
  }

  /**
   * Apply dispatch order edit — mirrors logic from PATCH /:id/edit-confirmed
   */
  static async applyDispatchOrderEdit(orderId, payload, reviewerId, session) {
    const { exchangeRate, percentage, discount, dispatchDate, items: updatedItems } = payload;

    const dispatchOrder = await DispatchOrder.findById(orderId).populate('supplier').session(session);
    if (!dispatchOrder) throw new Error('Dispatch order not found');

    if (dispatchOrder.status === 'pending' && payload.status === 'confirmed') {
      return EditRequestService.applyDispatchOrderConfirm(orderId, payload, reviewerId, session);
    }

    const editableStatuses = ['confirmed', 'pending', 'in_transit', 'delivered'];
    if (!editableStatuses.includes(dispatchOrder.status)) {
      throw new Error(`Cannot edit order with status: ${dispatchOrder.status}`);
    }

    const oldSupplierPaymentTotal = dispatchOrder.supplierPaymentTotal || 0;
    const oldDispatchDate = dispatchOrder.dispatchDate ? new Date(dispatchOrder.dispatchDate) : null;
    let dateChanged = false;

    if (dispatchDate !== undefined && dispatchDate !== null) {
      const newD = new Date(dispatchDate);
      if (!isNaN(newD.getTime())) {
        if (!oldDispatchDate || oldDispatchDate.getTime() !== newD.getTime()) {
          dispatchOrder.dispatchDate = newD;
          dateChanged = true;
        }
      }
    }

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

    // Sync with Ledger
    const paymentDifference = supplierPaymentTotal - oldSupplierPaymentTotal;
    const originalPurchaseEntry = await Ledger.findOne({
      referenceId: dispatchOrder._id,
      transactionType: 'purchase'
    }).session(session);

    if (originalPurchaseEntry) {
      // Update the original entry directly
      originalPurchaseEntry.debit = supplierPaymentTotal;
      originalPurchaseEntry.date = dispatchOrder.dispatchDate; // Update date
      originalPurchaseEntry.description = `Confirmed Order ${dispatchOrder.orderNumber} confirmed (Edited) - Supplier Payment: €${supplierPaymentTotal.toFixed(2)}, Final Amount (inc discount): €${supplierPaymentTotal.toFixed(2)}`;
      
      await originalPurchaseEntry.save({ session });

      // Recalculate balances from the earlier of old/new date
      const recalcStartDate = (oldDispatchDate && oldDispatchDate < dispatchOrder.dispatchDate) ? oldDispatchDate : dispatchOrder.dispatchDate;
      await Ledger.recalculateBalances('supplier', dispatchOrder.supplier._id || dispatchOrder.supplier, recalcStartDate);
    } else if (Math.abs(paymentDifference) > 0.01) {
      // Fallback to adjustment if original missing
      const adjustmentEntry = new Ledger({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id || dispatchOrder.supplier,
        entityModel: 'Supplier',
        transactionType: 'adjustment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: paymentDifference > 0 ? paymentDifference : 0,
        credit: paymentDifference < 0 ? Math.abs(paymentDifference) : 0,
        date: dispatchOrder.dispatchDate || new Date(),
        description: `Edit request adjustment for order ${dispatchOrder.orderNumber}`,
        createdBy: reviewerId
      });
      await adjustmentEntry.save({ session });
    }

    // Update inventory batch dates
    if (dateChanged) {
      for (const item of dispatchOrder.items) {
        if (!item.product) continue;
        const inv = await Inventory.findOne({ product: item.product }).session(session);
        if (inv) {
          await inv.updateBatchDate(dispatchOrder._id, dispatchOrder.dispatchDate);
        }
      }
    }

    // Update Supplier currentBalance if changed
    if (Math.abs(paymentDifference) > 0.001) {
      await Supplier.findByIdAndUpdate(
        dispatchOrder.supplier._id || dispatchOrder.supplier,
        { $inc: { currentBalance: paymentDifference } }
      ).session(session);
    }

    return { order: dispatchOrder };
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

    // Calculate total paid and new payment status
    const totalPaid = (payload.cashPayment ?? currentSale.cashPayment ?? 0) + 
                      (payload.bankPayment ?? currentSale.bankPayment ?? 0);
    const paymentStatus = totalPaid >= grandTotal ? 'paid' : totalPaid > 0 ? 'partial' : 'pending';

    const sale = await Sale.findByIdAndUpdate(
      saleId,
      { ...payload, subtotal, totalTax, grandTotal, paymentStatus },
      { new: true, runValidators: true, session }
    );
    if (!sale) throw new Error('Sale not found after update');

    // Re-sync ledger entries with the updated sale amounts
    if (sale.buyer) {
      try {
        const buyerId = sale.buyer;
        const grandTotalValue = sale.grandTotal || 0;
        const cashPaymentTotal = sale.cashPayment || 0;
        const bankPaymentTotal = sale.bankPayment || 0;
        const saleDate = sale.saleDate || sale.createdAt || new Date();
        const originalSaleDate = currentSale.saleDate || currentSale.createdAt || saleDate;

        // 1. Calculate standalone payment amounts (recorded via Add Payment modal, NOT at sale time)
        const standalonePayments = (currentSale.paymentReferences || []).reduce((acc, ref) => {
          const amount = Number(ref.amountApplied || 0);
          if (ref.paymentMethod === 'cash') acc.cash += amount;
          else acc.bank += amount;
          return acc;
        }, { cash: 0, bank: 0 });

        const saleTimeCash = Math.max(0, cashPaymentTotal - standalonePayments.cash);
        const saleTimeBank = Math.max(0, bankPaymentTotal - standalonePayments.bank);

        // 2. Update existing Sale Debit entry instead of deleting (Preserves Entry # and chronological order)
        const existingSaleDebit = await Ledger.findOneAndUpdate(
          { referenceId: saleId, transactionType: 'sale' },
          {
            debit: grandTotalValue,
            date: saleDate, // Sync date if it changed
            description: `Sale ${sale.saleNumber} - Total: ${grandTotalValue.toFixed(2)} (edited)`,
            paymentDetails: {
              cashPayment: cashPaymentTotal,
              bankPayment: bankPaymentTotal,
              remainingBalance: Math.max(0, grandTotalValue - cashPaymentTotal - bankPaymentTotal)
            }
          },
          { session, new: true }
        );

        if (!existingSaleDebit) {
          // Fallback if no sale entry exists (legacy data)
          await Ledger.createEntry({
            type: 'buyer',
            entityId: buyerId,
            entityModel: 'Buyer',
            transactionType: 'sale',
            referenceId: saleId,
            referenceModel: 'Sale',
            debit: grandTotalValue,
            credit: 0,
            date: saleDate,
            description: `Sale ${sale.saleNumber} - Total: ${grandTotalValue.toFixed(2)} (edited)`,
            paymentDetails: {
              cashPayment: cashPaymentTotal,
              bankPayment: bankPaymentTotal,
              remainingBalance: Math.max(0, grandTotalValue - cashPaymentTotal - bankPaymentTotal)
            },
            createdBy: sale.createdBy
          }, session);
        }

        // 3. Update or Create/Delete Cash Payment entry
        const existingCashEntry = await Ledger.findOne({
          referenceId: saleId,
          isSaleTimePayment: true,
          paymentMethod: 'cash'
        }).session(session);

        if (saleTimeCash > 0) {
          if (existingCashEntry) {
            await Ledger.findByIdAndUpdate(existingCashEntry._id, {
              credit: saleTimeCash,
              date: saleDate,
              description: `Cash payment for Sale ${sale.saleNumber} (at sale time)`,
              paymentDetails: { cashPayment: saleTimeCash, bankPayment: 0, remainingBalance: 0 }
            }, { session });
          } else {
            await Ledger.createEntry({
              type: 'buyer',
              entityId: buyerId,
              entityModel: 'Buyer',
              transactionType: 'receipt',
              referenceId: saleId,
              referenceModel: 'Sale',
              debit: 0,
              credit: saleTimeCash,
              date: saleDate,
              description: `Cash payment for Sale ${sale.saleNumber} (at sale time)`,
              paymentMethod: 'cash',
              isSaleTimePayment: true,
              paymentDetails: { cashPayment: saleTimeCash, bankPayment: 0, remainingBalance: 0 },
              createdBy: sale.createdBy
            }, session);
          }
        } else if (existingCashEntry) {
          await Ledger.deleteOne({ _id: existingCashEntry._id }).session(session);
        }

        // 4. Update or Create/Delete Bank Payment entry
        const existingBankEntry = await Ledger.findOne({
          referenceId: saleId,
          isSaleTimePayment: true,
          paymentMethod: 'bank'
        }).session(session);

        if (saleTimeBank > 0) {
          if (existingBankEntry) {
            await Ledger.findByIdAndUpdate(existingBankEntry._id, {
              credit: saleTimeBank,
              date: saleDate,
              description: `Bank/Card payment for Sale ${sale.saleNumber} (at sale time)`,
              paymentDetails: { cashPayment: 0, bankPayment: saleTimeBank, remainingBalance: 0 }
            }, { session });
          } else {
            await Ledger.createEntry({
              type: 'buyer',
              entityId: buyerId,
              entityModel: 'Buyer',
              transactionType: 'receipt',
              referenceId: saleId,
              referenceModel: 'Sale',
              debit: 0,
              credit: saleTimeBank,
              date: saleDate,
              description: `Bank/Card payment for Sale ${sale.saleNumber} (at sale time)`,
              paymentMethod: 'bank',
              isSaleTimePayment: true,
              paymentDetails: { cashPayment: 0, bankPayment: saleTimeBank, remainingBalance: 0 },
              createdBy: sale.createdBy
            }, session);
          }
        } else if (existingBankEntry) {
          await Ledger.deleteOne({ _id: existingBankEntry._id }).session(session);
        }

        // 5. Recalculate running balances from the earlier of old/new date
        const recalcStartDate = originalSaleDate < saleDate ? originalSaleDate : saleDate;
        await Ledger.recalculateBalances('buyer', buyerId, recalcStartDate, session);

        // 6. Sync buyer's currentBalance from aggregated ledger
        const newBalance = await Ledger.getBalance('buyer', buyerId, session);
        await Buyer.findByIdAndUpdate(buyerId, { currentBalance: newBalance }).session(session);


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

  // ===================== DISPATCH ORDER (BUYING) LOGIC =====================

  /**
   * Dispatch Order (Manual Purchase) creation logic
   */
  static async applyDispatchOrderCreate(payload, userId, session) {
    const {
      supplierId,
      items,
      exchangeRate,
      percentage,
      discount = 0,
      cashPayment = 0,
      bankPayment = 0,
      totalBoxes = 0,
      logisticsCompanyId,
      dispatchDate
    } = payload;

    const supplier = await Supplier.findById(supplierId).session(session);
    if (!supplier) throw new Error('Supplier not found');

    const orderDate = dispatchDate ? new Date(dispatchDate) : new Date();

    // 1. Create DispatchOrder (already confirmed)
    const orderNumber = `PUR-${Date.now()}`; // Simplified for service
    const dispatchOrder = new DispatchOrder({
      orderNumber,
      supplier: supplierId,
      status: 'confirmed',
      items: items.map(item => ({
        ...item,
        supplierPaymentAmount: item.costPrice || 0,
        supplierPaymentTotal: (item.costPrice || 0) * (item.quantity || 0),
        landedPrice: EditRequestService.truncateToTwoDecimals((item.costPrice || 0) / (exchangeRate || 1) * (1 + (percentage || 0) / 100)),
        landedTotal: EditRequestService.truncateToTwoDecimals(((item.costPrice || 0) / (exchangeRate || 1) * (1 + (percentage || 0) / 100)) * (item.quantity || 0))
      })),
      totalQuantity: items.reduce((sum, item) => sum + (item.quantity || 0), 0),
      totalBoxes,
      logisticsCompany: logisticsCompanyId,
      dispatchDate: orderDate,
      exchangeRate,
      percentage,
      totalDiscount: discount,
      paymentDetails: {
        cashPayment,
        bankPayment,
        remainingBalance: 0, // Will be calculated
        paymentStatus: 'pending'
      },
      createdBy: userId,
      confirmedBy: userId,
      confirmedAt: new Date()
    });

    // Re-calculate totals
    let supplierPaymentTotal = dispatchOrder.items.reduce((sum, item) => sum + (item.supplierPaymentTotal || 0), 0);
    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - discount);
    const paidAmount = cashPayment + bankPayment;
    dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal;
    dispatchOrder.paymentDetails.remainingBalance = Math.max(0, discountedSupplierPaymentTotal - paidAmount);
    dispatchOrder.paymentDetails.paymentStatus = dispatchOrder.paymentDetails.remainingBalance <= 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending');

    await dispatchOrder.save({ session });

    // 2. Ledger Entries
    // Purchase Entry
    await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'purchase',
      referenceId: dispatchOrder._id,
      referenceModel: 'DispatchOrder',
      debit: discountedSupplierPaymentTotal,
      credit: 0,
      date: orderDate,
      description: `Manual Purchase ${dispatchOrder.orderNumber}`,
      createdBy: userId
    }, session);

    // Payment Entries
    if (cashPayment > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: cashPayment,
        paymentMethod: 'cash',
        date: orderDate,
        description: `Cash payment for Manual Purchase ${dispatchOrder.orderNumber}`,
        createdBy: userId
      }, session);
    }
    if (bankPayment > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: bankPayment,
        paymentMethod: 'bank',
        date: orderDate,
        description: `Bank payment for Manual Purchase ${dispatchOrder.orderNumber}`,
        createdBy: userId
      }, session);
    }

    // 3. Inventory & Products
    for (const item of dispatchOrder.items) {
      let product = await Product.findOne({ sku: item.productCode.toUpperCase(), supplier: supplierId }).session(session);
      if (!product) {
        product = new Product({
          name: item.productName,
          sku: item.productCode.toUpperCase(),
          supplier: supplierId,
          productCode: item.productCode,
          season: item.season,
          category: 'General',
          unit: 'piece',
          pricing: {
            costPrice: item.landedPrice,
            sellingPrice: item.landedPrice * 1.2
          },
          size: EditRequestService.normalizeToArray(item.size),
          color: EditRequestService.normalizeToArray(item.primaryColor),
          isActive: true,
          createdBy: userId
        });
        await product.save({ session });
      }

      // Update Inventory
      let inventory = await Inventory.findOne({ product: product._id }).session(session);
      if (!inventory) {
        inventory = new Inventory({ product: product._id, currentStock: 0 });
      }

      const batchInfo = {
        dispatchOrderId: dispatchOrder._id,
        supplierId,
        purchaseDate: orderDate,
        costPrice: item.costPrice,
        landedPrice: item.landedPrice,
        exchangeRate
      };

      if (item.useVariantTracking && item.packets?.length > 0) {
        const variantComposition = [];
        item.packets.forEach(p => {
          p.composition.forEach(c => {
            const existing = variantComposition.find(v => v.size === c.size && v.color === c.color);
            if (existing) existing.quantity += c.quantity;
            else variantComposition.push({ size: c.size, color: c.color, quantity: c.quantity });
          });
        });
        await inventory.addStockWithVariants(item.quantity, variantComposition, 'DispatchOrder', dispatchOrder._id, userId, `Manual Purchase ${dispatchOrder.orderNumber}`, orderDate, session);
      } else {
        await inventory.addStockWithBatch(item.quantity, batchInfo, 'DispatchOrder', dispatchOrder._id, userId, `Manual Purchase ${dispatchOrder.orderNumber}`, orderDate, session);
      }
      await inventory.save({ session });
    }

    // 4. Supplier Balance
    await Supplier.findByIdAndUpdate(supplierId, {
      $inc: {
        totalPurchases: discountedSupplierPaymentTotal,
        currentBalance: discountedSupplierPaymentTotal - paidAmount
      }
    }, { session });

    return dispatchOrder;
  }

  /**
   * Dispatch Order Confirmation logic (Update)
   */
  static async applyDispatchOrderConfirm(orderId, payload, userId, session) {
    const dispatchOrder = await DispatchOrder.findById(orderId).populate('supplier').session(session);
    if (!dispatchOrder) throw new Error('Order not found');

    const {
      cashPayment = 0,
      bankPayment = 0,
      exchangeRate,
      percentage,
      discount = 0,
      items,
      dispatchDate
    } = payload;

    const orderDate = dispatchDate ? new Date(dispatchDate) : dispatchOrder.dispatchDate;

    // 1. Update Order Fields
    dispatchOrder.status = 'confirmed';
    dispatchOrder.confirmedBy = userId;
    dispatchOrder.confirmedAt = new Date();
    dispatchOrder.exchangeRate = exchangeRate || dispatchOrder.exchangeRate;
    dispatchOrder.percentage = percentage || dispatchOrder.percentage;
    dispatchOrder.totalDiscount = discount;
    dispatchOrder.dispatchDate = orderDate;

    if (items) {
      dispatchOrder.items = items;
      dispatchOrder.markModified('items');
    }

    // Calculate Prices & Totals (Mirroring route logic)
    let supplierPaymentTotal = 0;
    for (const item of dispatchOrder.items) {
      item.supplierPaymentAmount = item.costPrice || 0;
      item.supplierPaymentTotal = item.supplierPaymentAmount * (item.quantity || 0);
      item.landedPrice = EditRequestService.truncateToTwoDecimals((item.costPrice || 0) / (dispatchOrder.exchangeRate || 1) * (1 + (dispatchOrder.percentage || 0) / 100));
      item.landedTotal = EditRequestService.truncateToTwoDecimals(item.landedPrice * (item.quantity || 0));
      supplierPaymentTotal += item.supplierPaymentTotal;
    }

    const discountedSupplierPaymentTotal = Math.max(0, supplierPaymentTotal - discount);
    const paidAmount = cashPayment + bankPayment;
    dispatchOrder.supplierPaymentTotal = discountedSupplierPaymentTotal;
    dispatchOrder.paymentDetails = {
      cashPayment,
      bankPayment,
      remainingBalance: Math.max(0, discountedSupplierPaymentTotal - paidAmount),
      paymentStatus: (discountedSupplierPaymentTotal - paidAmount) <= 0 ? 'paid' : (paidAmount > 0 ? 'partial' : 'pending')
    };

    await dispatchOrder.save({ session });

    // 2. Ledger Entries (Purchase + Payments)
    await Ledger.createEntry({
      type: 'supplier',
      entityId: dispatchOrder.supplier._id,
      entityModel: 'Supplier',
      transactionType: 'purchase',
      referenceId: dispatchOrder._id,
      referenceModel: 'DispatchOrder',
      debit: discountedSupplierPaymentTotal,
      credit: 0,
      date: orderDate,
      description: `Confirmed Purchase ${dispatchOrder.orderNumber}`,
      createdBy: userId
    }, session);

    if (cashPayment > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: cashPayment,
        paymentMethod: 'cash',
        date: orderDate,
        description: `Cash payment for Order ${dispatchOrder.orderNumber}`,
        createdBy: userId
      }, session);
    }
    if (bankPayment > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: dispatchOrder.supplier._id,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrder._id,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: bankPayment,
        paymentMethod: 'bank',
        date: orderDate,
        description: `Bank payment for Order ${dispatchOrder.orderNumber}`,
        createdBy: userId
      }, session);
    }

    // 3. Inventory Updates
    for (const item of dispatchOrder.items) {
      let product = await Product.findOne({ sku: item.productCode.toUpperCase(), supplier: dispatchOrder.supplier._id }).session(session);
      if (!product) {
        product = new Product({
          name: item.productName,
          sku: item.productCode.toUpperCase(),
          supplier: dispatchOrder.supplier._id,
          productCode: item.productCode,
          season: item.season,
          pricing: { costPrice: item.landedPrice, sellingPrice: item.landedPrice * 1.2 },
          isActive: true,
          createdBy: userId
        });
        await product.save({ session });
      }

      let inventory = await Inventory.findOne({ product: product._id }).session(session);
      if (!inventory) inventory = new Inventory({ product: product._id, currentStock: 0 });

      const batchInfo = {
        dispatchOrderId: dispatchOrder._id,
        supplierId: dispatchOrder.supplier._id,
        purchaseDate: orderDate,
        costPrice: item.costPrice,
        landedPrice: item.landedPrice,
        exchangeRate: dispatchOrder.exchangeRate
      };

      if (item.useVariantTracking && item.packets?.length > 0) {
        const variantComposition = [];
        item.packets.forEach(p => {
          p.composition.forEach(c => {
            const existing = variantComposition.find(v => v.size === c.size && v.color === c.color);
            if (existing) existing.quantity += c.quantity;
            else variantComposition.push({ size: c.size, color: c.color, quantity: c.quantity });
          });
        });
        await inventory.addStockWithVariants(item.quantity, variantComposition, 'DispatchOrder', dispatchOrder._id, userId, `Confirmed Order ${dispatchOrder.orderNumber}`, orderDate, session);
      } else {
        await inventory.addStockWithBatch(item.quantity, batchInfo, 'DispatchOrder', dispatchOrder._id, userId, `Confirmed Order ${dispatchOrder.orderNumber}`, orderDate, session);
      }
      await inventory.save({ session });
    }

    // 4. Update Supplier Balance
    await Supplier.findByIdAndUpdate(dispatchOrder.supplier._id, {
      $inc: {
        totalPurchases: discountedSupplierPaymentTotal,
        currentBalance: discountedSupplierPaymentTotal - paidAmount
      }
    }, { session });

    return dispatchOrder;
  }

  // ===================== PRIVATE HELPERS =====================

  static truncateToTwoDecimals(value) {
    if (typeof value !== 'number' || isNaN(value)) return 0;
    return Math.floor(value * 100) / 100;
  }

  static normalizeToArray(val) {
    if (!val) return [];
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
    return [val];
  }
}

module.exports = EditRequestService;
