const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const DispatchOrder = require('../models/DispatchOrder');
const Inventory = require('../models/Inventory');
const Return = require('../models/Return');
const PacketStock = require('../models/PacketStock');
const PacketTemplate = require('../models/PacketTemplate');
const SupplierPaymentReceipt = require('../models/SupplierPaymentReceipt');
const Ledger = require('../models/Ledger');
const User = require('../models/User');

class SupplierDeletionService {
  static ensureValidSupplierId(supplierId) {
    if (!mongoose.Types.ObjectId.isValid(supplierId)) {
      const error = new Error('Invalid supplier id');
      error.status = 400;
      throw error;
    }

    return new mongoose.Types.ObjectId(supplierId);
  }

  static buildScopedQuery(query, session = null) {
    if (session) {
      query.session(session);
    }

    return query;
  }

  static async collectCascadeTargets(supplierId, session = null) {
    const supplierObjectId = this.ensureValidSupplierId(supplierId);

    const supplier = await this.buildScopedQuery(
      Supplier.findById(supplierObjectId).select('name company supplierId email phone'),
      session
    ).lean();

    if (!supplier) {
      const error = new Error('Supplier not found');
      error.status = 404;
      throw error;
    }

    const [primaryProducts, mappedProducts, dispatchOrders, supplierUsers, linkedNonSupplierUsers] = await Promise.all([
      this.buildScopedQuery(
        Product.find({ supplier: supplierObjectId }).select('_id'),
        session
      ).lean(),
      this.buildScopedQuery(
        Product.find({
          supplier: { $ne: supplierObjectId },
          'suppliers.supplier': supplierObjectId,
        }).select('_id'),
        session
      ).lean(),
      this.buildScopedQuery(
        DispatchOrder.find({ supplier: supplierObjectId }).select('_id'),
        session
      ).lean(),
      this.buildScopedQuery(
        User.find({ supplier: supplierObjectId, role: 'supplier' }).select('_id'),
        session
      ).lean(),
      this.buildScopedQuery(
        User.find({ supplier: supplierObjectId, role: { $ne: 'supplier' } }).select('_id'),
        session
      ).lean(),
    ]);

    const primaryProductIds = primaryProducts.map((product) => product._id);
    const mappedProductIds = mappedProducts.map((product) => product._id);
    const dispatchOrderIds = dispatchOrders.map((order) => order._id);
    const supplierUserIds = supplierUsers.map((user) => user._id);
    const linkedNonSupplierUserIds = linkedNonSupplierUsers.map((user) => user._id);

    const inventoryBatchMatch = {
      'purchaseBatches.supplierId': supplierObjectId,
    };

    if (primaryProductIds.length > 0) {
      inventoryBatchMatch.product = { $nin: primaryProductIds };
    }

    const inventoryBatchAggregation = Inventory.aggregate([
      { $match: inventoryBatchMatch },
      {
        $project: {
          batchesToRemove: {
            $size: {
              $filter: {
                input: '$purchaseBatches',
                as: 'batch',
                cond: { $eq: ['$$batch.supplierId', supplierObjectId] },
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          totalBatches: { $sum: '$batchesToRemove' },
        },
      },
    ]);

    if (session) {
      inventoryBatchAggregation.session(session);
    }

    const [
      supplierLedgerEntries,
      supplierPaymentReceipts,
      supplierReturns,
      supplierPacketStock,
      supplierPacketTemplates,
      deletedInventoryRecords,
      dispatchLinkedLedgerEntries,
      inventoryBatchResults,
    ] = await Promise.all([
      this.buildScopedQuery(
        Ledger.countDocuments({ type: 'supplier', entityId: supplierObjectId }),
        session
      ),
      this.buildScopedQuery(
        SupplierPaymentReceipt.countDocuments({ supplierId: supplierObjectId }),
        session
      ),
      this.buildScopedQuery(
        Return.countDocuments({ supplier: supplierObjectId }),
        session
      ),
      this.buildScopedQuery(
        PacketStock.countDocuments({ supplier: supplierObjectId }),
        session
      ),
      this.buildScopedQuery(
        PacketTemplate.countDocuments({ supplier: supplierObjectId }),
        session
      ),
      primaryProductIds.length > 0
        ? this.buildScopedQuery(
            Inventory.countDocuments({ product: { $in: primaryProductIds } }),
            session
          )
        : Promise.resolve(0),
      dispatchOrderIds.length > 0
        ? this.buildScopedQuery(
            Ledger.countDocuments({
              referenceModel: 'DispatchOrder',
              referenceId: { $in: dispatchOrderIds },
              type: { $ne: 'supplier' },
            }),
            session
          )
        : Promise.resolve(0),
      inventoryBatchAggregation,
    ]);

    const counts = {
      productsToDelete: primaryProductIds.length,
      productMappingsToRemove: mappedProductIds.length,
      dispatchOrdersToDelete: dispatchOrderIds.length,
      supplierLedgerEntriesToDelete: supplierLedgerEntries,
      dispatchLinkedLedgerEntriesToDelete: dispatchLinkedLedgerEntries,
      supplierPaymentReceiptsToDelete: supplierPaymentReceipts,
      returnsToDelete: supplierReturns,
      packetStockToDelete: supplierPacketStock,
      packetTemplatesToDelete: supplierPacketTemplates,
      inventoryRecordsToDelete: deletedInventoryRecords,
      inventoryPurchaseBatchesToRemove: inventoryBatchResults[0]?.totalBatches || 0,
      supplierUsersToDelete: supplierUserIds.length,
      linkedUsersToUnlink: linkedNonSupplierUserIds.length,
    };

    const totalAffectedRecords = Object.values(counts).reduce((sum, count) => sum + count, 0);

    return {
      supplier,
      supplierObjectId,
      primaryProductIds,
      mappedProductIds,
      dispatchOrderIds,
      supplierUserIds,
      linkedNonSupplierUserIds,
      counts,
      totalAffectedRecords,
    };
  }

  static async getDeletionSummary(supplierId) {
    const cascadeTargets = await this.collectCascadeTargets(supplierId);

    return {
      supplier: cascadeTargets.supplier,
      counts: cascadeTargets.counts,
      totalAffectedRecords: cascadeTargets.totalAffectedRecords,
    };
  }

  static async hardDeleteSupplier(supplierId) {
    const session = await mongoose.startSession();
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });

    try {
      const cascadeTargets = await this.collectCascadeTargets(supplierId, session);
      const {
        supplier,
        supplierObjectId,
        primaryProductIds,
        mappedProductIds,
        dispatchOrderIds,
        supplierUserIds,
        linkedNonSupplierUserIds,
        counts,
        totalAffectedRecords,
      } = cascadeTargets;

      await SupplierPaymentReceipt.deleteMany({ supplierId: supplierObjectId }).session(session);
      await Ledger.deleteMany({ type: 'supplier', entityId: supplierObjectId }).session(session);

      if (dispatchOrderIds.length > 0) {
        await Ledger.deleteMany({
          referenceModel: 'DispatchOrder',
          referenceId: { $in: dispatchOrderIds },
          type: { $ne: 'supplier' },
        }).session(session);
      }

      await Return.deleteMany({ supplier: supplierObjectId }).session(session);
      await PacketStock.deleteMany({ supplier: supplierObjectId }).session(session);
      await PacketTemplate.deleteMany({ supplier: supplierObjectId }).session(session);

      if (dispatchOrderIds.length > 0) {
        await DispatchOrder.deleteMany({ _id: { $in: dispatchOrderIds } }).session(session);
      }

      if (primaryProductIds.length > 0) {
        await Inventory.deleteMany({ product: { $in: primaryProductIds } }).session(session);
      }

      if (mappedProductIds.length > 0) {
        await Product.updateMany(
          { _id: { $in: mappedProductIds } },
          { $pull: { suppliers: { supplier: supplierObjectId } } }
        ).session(session);
      }

      const inventoryBatchCleanupQuery = {
        'purchaseBatches.supplierId': supplierObjectId,
      };

      if (primaryProductIds.length > 0) {
        inventoryBatchCleanupQuery.product = { $nin: primaryProductIds };
      }

      await Inventory.updateMany(
        inventoryBatchCleanupQuery,
        { $pull: { purchaseBatches: { supplierId: supplierObjectId } } }
      ).session(session);

      if (primaryProductIds.length > 0) {
        await Product.deleteMany({ _id: { $in: primaryProductIds } }).session(session);
      }

      if (supplierUserIds.length > 0) {
        await User.deleteMany({ _id: { $in: supplierUserIds } }).session(session);
      }

      if (linkedNonSupplierUserIds.length > 0) {
        await User.updateMany(
          { _id: { $in: linkedNonSupplierUserIds } },
          { $unset: { supplier: '' } }
        ).session(session);
      }

      await Supplier.findByIdAndDelete(supplierObjectId).session(session);

      await session.commitTransaction();

      return {
        supplier,
        counts,
        totalAffectedRecords,
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

module.exports = SupplierDeletionService;