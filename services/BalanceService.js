/**
 * BalanceService - Single Source of Truth for all balance calculations
 * 
 * CRITICAL FIX: Payment distribution now uses FIFO (First In, First Out)
 * Payments are applied to oldest orders first, not newest.
 * 
 * Key principles:
 * - All balances are calculated on-demand from Ledger entries
 * - No cached balance values in other models (Supplier, Buyer, DispatchOrder)
 * - Uses MongoDB aggregations for efficient calculations
 * - Handles both supplier and buyer accounting (debit/credit model)
 */

const mongoose = require('mongoose');
const Ledger = require('../models/Ledger');
const DispatchOrder = require('../models/DispatchOrder');
const Return = require('../models/Return');

class BalanceService {
  // =====================================================
  // ENTITY BALANCE METHODS
  // =====================================================

  /**
   * Get current balance for any entity type
   * @param {string} type - 'supplier', 'buyer', or 'logistics'
   * @param {string} entityId - The entity's MongoDB ObjectId
   * @returns {number} Current balance (positive = entity owes/is owed depending on type)
   */
  static async getEntityBalance(type, entityId) {
    return await Ledger.getBalance(type, entityId);
  }

  /**
   * Get supplier balance (positive = admin owes supplier)
   */
  static async getSupplierBalance(supplierId) {
    return await this.getEntityBalance('supplier', supplierId);
  }

  /**
   * Get buyer balance (positive = buyer owes admin)
   */
  static async getBuyerBalance(buyerId) {
    return await this.getEntityBalance('buyer', buyerId);
  }

  /**
   * Get logistics company balance (positive = admin owes logistics)
   */
  static async getLogisticsBalance(logisticsCompanyId) {
    return await this.getEntityBalance('logistics', logisticsCompanyId);
  }

/**
    * Get supplier balance summary (simple format for API responses)
    * @param {string} supplierId - The supplier's MongoDB ObjectId
    * @returns {Object} { currentBalance: number }
 */
static async getSupplierBalanceSummary(supplierId) {
  const currentBalance = await this.getSupplierBalance(supplierId);
  return { currentBalance };
}
  // =====================================================
  // ORDER-LEVEL BALANCE METHODS
  // =====================================================

  /**
   * Get payment summary for a specific order
   * @param {string} orderId - The DispatchOrder ObjectId
   * @returns {Object} { cash: number, bank: number, total: number }
   */
  static async getOrderPaymentSummary(orderId) {
    return await Ledger.getOrderPayments(orderId);
  }

  /**
   * Get remaining balance for an order
   * @param {string} orderId - The DispatchOrder ObjectId
   * @param {number} orderTotal - The total amount for the order (after discount)
   * @returns {number} Remaining balance (positive = still owed, negative = overpaid)
   */
  static async getOrderRemainingBalance(orderId, orderTotal) {
    const payments = await this.getOrderPaymentSummary(orderId);
    const returnTotal = await Ledger.getOrderReturnTotal(orderId);
    return orderTotal - payments.total - returnTotal;
  }

  /**
   * Enrich an order object with computed payment status
   * For use when returning order data from API
   */
  static async enrichOrderWithPaymentStatus(order) {
    const payments = await Ledger.getOrderPayments(order._id);
    const returnTotal = await Ledger.getOrderReturnTotal(order._id);

    // Calculate the current order value considering returns
    const currentOrderValue = await this.calculateCurrentOrderValue(order);
    const totalPaid = payments.total;
    const remaining = currentOrderValue - totalPaid - returnTotal;

    let paymentStatus = 'pending';
    if (remaining <= 0 && totalPaid > 0) {
      paymentStatus = 'paid';
    } else if (totalPaid > 0) {
      paymentStatus = 'partial';
    }

    return {
      ...order,
      computedPaymentDetails: {
        cashPayment: payments.cash,
        bankPayment: payments.bank,
        totalPaid: totalPaid,
        returnTotal: returnTotal,
        remainingBalance: Math.max(0, remaining),
        outstandingBalance: remaining < 0 ? Math.abs(remaining) : 0,
        paymentStatus: paymentStatus
      }
    };
  }

  /**
   * Calculate current order value considering confirmed quantities and discount
   */
  static calculateCurrentOrderValue(order) {
    let currentOrderValue = 0;

    if (order.items && order.items.length > 0) {
      order.items.forEach((item, index) => {
        const costPrice = item.costPrice || item.supplierPaymentAmount || 0;
        const confirmedQtyObj = order.confirmedQuantities?.find(cq => cq.itemIndex === index);
        const confirmedQty = confirmedQtyObj?.quantity ?? item.quantity;
        currentOrderValue += costPrice * confirmedQty;
      });
    } else {
      currentOrderValue = order.supplierPaymentTotal || 0;
    }

    const discount = order.totalDiscount || 0;
    return Math.max(0, currentOrderValue - discount);
  }

  /**
   * Get all pending orders for a supplier (for payment distribution)
   * 
   * FIFO based on confirmedAt - First confirmed, first paid
   * This ensures payment distribution matches ledger display order
   */
  static async getPendingOrdersForSupplier(supplierId) {
    const orders = await DispatchOrder.find({
      supplier: supplierId,
      status: 'confirmed'
    }).select('_id orderNumber items confirmedQuantities supplierPaymentTotal totalDiscount createdAt confirmedAt').lean();

    const ordersWithBalances = await Promise.all(
      orders.map(async (order) => {
        const currentValue = this.calculateCurrentOrderValue(order);
        const payments = await Ledger.getOrderPayments(order._id);
        const returnTotal = await Ledger.getOrderReturnTotal(order._id);
        const remainingBalance = currentValue - payments.total - returnTotal;

        return {
          _id: order._id,
          orderNumber: order.orderNumber,
          totalAmount: currentValue,
          totalPaid: payments.total,
          returnTotal: returnTotal,
          remainingBalance: remainingBalance,
          createdAt: order.createdAt,
          confirmedAt: order.confirmedAt
        };
      })
    );

    // FIFO: Sort by confirmedAt ASCENDING (first confirmed = first paid)
    // This matches the ledger display order where entries are created at confirmation time
    return ordersWithBalances
      .filter(o => o.remainingBalance > 0)
      .sort((a, b) => new Date(a.confirmedAt) - new Date(b.confirmedAt)); // Sort by confirmation date
  }

  /**
   * Get all pending logistics charges for a company (for payment distribution)
   * FIFO based on confirmedAt from dispatch orders - matches ledger display order
   * 
   * Gets charges directly from ledger entries (type: 'logistics', transactionType: 'charge')
   * and calculates remaining by subtracting only logistics payments (not supplier payments)
   */
  static async getPendingLogisticsCharges(logisticsCompanyId) {
    // Get all charge entries for this logistics company from ledger
    const chargeEntries = await Ledger.find({
      type: 'logistics',
      entityId: logisticsCompanyId,
      transactionType: 'charge'
    }).select('_id referenceId debit credit date createdAt').lean();

    // Get the dispatch orders for these charges to get confirmedAt
    const orderIds = chargeEntries
      .filter(e => e.referenceId)
      .map(e => e.referenceId);
    
    const orders = await DispatchOrder.find({
      _id: { $in: orderIds }
    }).select('_id orderNumber confirmedAt totalBoxes').lean();

    // Create a map for quick lookup
    const orderMap = new Map(orders.map(o => [o._id.toString(), o]));

    // Calculate remaining balance for each charge
    const chargesWithBalances = await Promise.all(
      chargeEntries.map(async (charge) => {
        const order = charge.referenceId ? orderMap.get(charge.referenceId.toString()) : null;
        const totalAmount = charge.debit || 0;

        // Get ONLY logistics payments for this specific order (not supplier payments)
        const logisticsPayments = await Ledger.aggregate([
          {
            $match: {
              type: 'logistics',
              entityId: new mongoose.Types.ObjectId(logisticsCompanyId),
              referenceId: charge.referenceId,
              transactionType: 'payment'
            }
          },
          {
            $group: {
              _id: null,
              total: { $sum: '$credit' }
            }
          }
        ]);

        const totalPaid = logisticsPayments[0]?.total || 0;
        const remainingBalance = totalAmount - totalPaid;

        return {
          chargeId: charge._id,
          orderId: charge.referenceId,
          orderNumber: order?.orderNumber || 'Unknown',
          totalBoxes: order?.totalBoxes || 0,
          totalAmount: totalAmount,
          totalPaid: totalPaid,
          remainingBalance: remainingBalance,
          chargeDate: charge.date,
          confirmedAt: order?.confirmedAt || charge.createdAt // Use order confirmedAt, fallback to charge createdAt
        };
      })
    );

    // Sort by confirmedAt ASCENDING for FIFO distribution (first confirmed = first paid)
    return chargesWithBalances
      .filter(c => c.remainingBalance > 0)
      .sort((a, b) => new Date(a.confirmedAt) - new Date(b.confirmedAt));
  }

  // =====================================================
  // DASHBOARD STATS METHODS
  // =====================================================

  /**
   * Get all dashboard stats for a supplier in one call
   */
  static async getSupplierDashboardStats(supplierId) {
    // Get current ledger balance
    const currentBalance = await this.getSupplierBalance(supplierId);

    // Get payment totals by method
    const paymentTotals = await Ledger.getPaymentTotalsByMethod('supplier', supplierId);

    // Calculate remaining and outstanding from confirmed orders
    const pendingOrders = await this.getPendingOrdersForSupplier(supplierId);
    const totalRemainingBalance = pendingOrders.reduce((sum, o) => sum + Math.max(0, o.remainingBalance), 0);

    // Outstanding balance = overpayments (when remaining is negative)
    const allOrders = await DispatchOrder.find({
      supplier: supplierId,
      status: 'confirmed'
    }).select('_id orderNumber items confirmedQuantities supplierPaymentTotal totalDiscount').lean();

    let totalOutstandingBalance = 0;
    for (const order of allOrders) {
      const currentValue = this.calculateCurrentOrderValue(order);
      const payments = await Ledger.getOrderPayments(order._id);
      const returnTotal = await Ledger.getOrderReturnTotal(order._id);
      const remaining = currentValue - payments.total - returnTotal;
      if (remaining < 0) {
        totalOutstandingBalance += Math.abs(remaining);
      }
    }

    return {
      currentBalance,
      totalBalance: currentBalance, // Alias for backward compatibility
      totalCashPayment: paymentTotals.cash,
      totalBankPayment: paymentTotals.bank,
      totalRemainingBalance,
      totalOutstandingBalance,
      supplierCount: 1
    };
  }

  /**
   * Get all dashboard stats for a buyer in one call
   */
  static async getBuyerDashboardStats(buyerId) {
    const currentBalance = await this.getBuyerBalance(buyerId);
    const paymentTotals = await Ledger.getPaymentTotalsByMethod('buyer', buyerId);

    return {
      currentBalance,
      totalBalance: currentBalance,
      totalCashPayment: paymentTotals.cash,
      totalBankPayment: paymentTotals.bank
    };
  }

  /**
   * Get all dashboard stats for a logistics company in one call
   */
  static async getLogisticsDashboardStats(logisticsCompanyId) {
    const currentBalance = await this.getLogisticsBalance(logisticsCompanyId);
    const paymentTotals = await Ledger.getPaymentTotalsByMethod('logistics', logisticsCompanyId);

    // Calculate pending from confirmed orders
    const pendingCharges = await this.getPendingLogisticsCharges(logisticsCompanyId);
    const totalRemainingBalance = pendingCharges.reduce((sum, c) => sum + c.remainingBalance, 0);

    return {
      currentBalance,
      totalRemainingBalance,
      totalCashPayment: paymentTotals.cash,
      totalBankPayment: paymentTotals.bank
    };
  }

  // =====================================================
  // AGGREGATE BALANCE METHODS
  // =====================================================

  /**
   * Get total balance across all suppliers
   * Uses aggregation to sum: SUM(debit - credit) for all suppliers
   * @returns {number} Total balance across all suppliers (positive = admin owes suppliers)
   */
  static async getTotalSupplierBalance() {
    const supplierIds = await Ledger.distinct("entityId", {
      type: "supplier"
    });

    console.log(`\n========== TOTAL SUPPLIER BALANCE (All Suppliers) ==========`);
    console.log(`Number of suppliers with ledger entries: ${supplierIds.length}\n`);

    const balances = await Promise.all(
      supplierIds.map(id => this.getSupplierBalance(id))
    );

    // Calculate total and round to 2 decimal places to avoid floating-point precision issues
    const total = balances.reduce((sum, balance) => sum + (balance || 0), 0);
    const roundedTotal = Math.round(total * 100) / 100;

    console.log(`Balances for each supplier: [ ${balances.map(b => (b || 0).toFixed(2)).join(', ')} ]`);
    console.log(`totalBalance: ${roundedTotal.toFixed(2)}`);
    console.log(`=========================================\n`);

    return roundedTotal;
  }

  /**
   * Get total balance across all buyers
   * @returns {number} Total balance across all buyers (positive = buyers owe admin)
   */
  static async getTotalBuyerBalance() {
    const buyerIds = await Ledger.distinct("entityId", {
      type: "buyer"
    });

    const balances = await Promise.all(
      buyerIds.map(id => this.getBuyerBalance(id))
    );

    return balances.reduce((sum, balance) => sum + (balance || 0), 0);
  }

  /**
   * Get total balance across all logistics companies
   * @returns {number} Total balance across all logistics companies (positive = admin owes logistics)
   */
  static async getTotalLogisticsBalance() {
    const logisticsIds = await Ledger.distinct("entityId", {
      type: "logistics"
    });

    const balances = await Promise.all(
      logisticsIds.map(id => this.getLogisticsBalance(id))
    );

    return balances.reduce((sum, balance) => sum + (balance || 0), 0);
  }

  // =====================================================
  // TRANSACTION RECORDING METHODS (SUPPLIER)
  // =====================================================

  /**
   * Record purchase and initial payments when confirming a dispatch order
   */
  static async confirmDispatchOrder({
    dispatchOrderId,
    supplierId,
    supplierPaymentTotal,
    discount = 0,
    cashPayment = 0,
    bankPayment = 0,
    createdBy,
    description,
    session = null
  }) {
    const discountedTotal = Math.max(0, supplierPaymentTotal - discount);
    const entryDate = new Date();
    const entries = [];

    // 1. Create purchase entry (debit - what we owe supplier)
    const purchaseEntry = await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'purchase',
      referenceId: dispatchOrderId,
      referenceModel: 'DispatchOrder',
      debit: discountedTotal,
      credit: 0,
      date: entryDate,
      description: description || `Purchase - Order confirmed`,
      paymentDetails: {
        cashPayment: cashPayment,
        bankPayment: bankPayment,
        remainingBalance: discountedTotal - cashPayment - bankPayment
      },
      createdBy
    }, session);
    entries.push(purchaseEntry);

    // 2. Create cash payment entry if applicable
    if (cashPayment > 0) {
      const cashEntry = await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrderId,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: cashPayment,
        paymentMethod: 'cash',
        date: entryDate,
        description: `Payment (Cash) - Order confirmed`,
        createdBy
      }, session);
      entries.push(cashEntry);
    }

    // 3. Create bank payment entry if applicable
    if (bankPayment > 0) {
      const bankEntry = await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment',
        referenceId: dispatchOrderId,
        referenceModel: 'DispatchOrder',
        debit: 0,
        credit: bankPayment,
        paymentMethod: 'bank',
        date: entryDate,
        description: `Payment (Bank) - Order confirmed`,
        createdBy
      }, session);
      entries.push(bankEntry);
    }

    return {
      purchaseEntry: entries[0],
      paymentEntries: entries.slice(1),
      totalPurchase: discountedTotal,
      totalPayment: cashPayment + bankPayment,
      remainingBalance: discountedTotal - cashPayment - bankPayment
    };
  }

  /**
   * Record a payment for a specific order
   */
  static async recordOrderPayment({
    supplierId,
    referenceId,
    referenceModel = 'DispatchOrder',
    amount,
    paymentMethod,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'payment',
      referenceId,
      referenceModel,
      debit: 0,
      credit: amount,
      paymentMethod,
      date,
      description: description || `Payment (${paymentMethod})`,
      createdBy
    }, session);
  }

  /**
   * Record a return that reduces what admin owes supplier
   */
  static async recordReturn({
    supplierId,
    dispatchOrderId,
    returnValue,
    returnId,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'return',
      referenceId: returnId || dispatchOrderId,
      referenceModel: returnId ? 'Return' : 'DispatchOrder',
      debit: 0,
      credit: returnValue, // Reduces what we owe
      date,
      description: description || 'Product return',
      createdBy
    }, session);
  }

  /**
   * Distribute a universal payment across pending orders using FIFO (First In, First Out)
   * 
   * CRITICAL FIX: This method now correctly applies payments to oldest orders first
   * 
   * Payment Distribution Logic:
   * 1. Get pending orders sorted by createdAt ASCENDING (oldest first)
   * 2. Apply payment to each order sequentially until:
   *    - Payment is exhausted, OR
   *    - All orders are fully paid
   * 3. If payment exceeds all order balances, create advance/credit entry
   * 
   * @param {Object} params - Payment parameters
   * @returns {Object} Distribution result with affected orders
   */
  static async distributeUniversalPayment({
    supplierId,
    amount,
    paymentMethod,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    // 1. Get pending orders sorted by confirmedAt ASCENDING (FIFO - first confirmed, first paid)
    const pendingOrders = await this.getPendingOrdersForSupplier(supplierId);

    console.log("\n========== PAYMENT DISTRIBUTION (FIFO) ==========");
    console.log(`Supplier ID: ${supplierId}`);
    console.log(`Payment Amount: €${amount.toFixed(2)}`);
    console.log(`Payment Method: ${paymentMethod}`);
    console.log(`Pending Orders (sorted by confirmation date - first confirmed first):`);
    pendingOrders.forEach((order, index) => {
      console.log(`  ${index + 1}. ${order.orderNumber} - Remaining: €${order.remainingBalance.toFixed(2)} (Confirmed: ${order.confirmedAt})`);
    });
    console.log("=================================================\n");

    // Handle case when there are no pending orders - create advance/credit entry
    if (pendingOrders.length === 0) {
      console.log(`No pending orders found - Creating advance/credit entry for full amount: €${amount.toFixed(2)}`);

      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment',
        // referenceId and referenceModel omitted - no dispatch order reference for advance payments
        debit: 0,
        credit: amount,
        paymentMethod,
        date,
        description: description || `Advance payment (credit to supplier account - no pending orders)`,
        createdBy,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? amount : 0,
          bankPayment: paymentMethod === 'bank' ? amount : 0,
          remainingBalance: 0
        }
      }, session);

      console.log("\n========== DISTRIBUTION COMPLETE ==========");
      console.log(`Total Distributed: €${amount.toFixed(2)}`);
      console.log(`Orders Affected: 0`);
      console.log(`Fully Paid Orders: 0`);
      console.log(`Advance/Credit: €${amount.toFixed(2)}`);
      console.log("==========================================\n");

      return {
        totalDistributed: amount,
        distributions: [{
          orderId: null,
          orderNumber: 'ADVANCE_CREDIT',
          amountApplied: amount,
          previousRemaining: 0,
          newRemaining: -amount, // Negative = supplier has credit
          fullyPaid: false,
          isAdvance: true,
          totalAmount: undefined, // Not applicable
          totalPaid: undefined // Not applicable
        }],
        remainingCredit: amount
      };
    }

    let remainingAmount = amount;
    const distributions = [];

    // 2. Distribute payment across orders in FIFO order
    for (let i = 0; i < pendingOrders.length; i++) {
      if (remainingAmount <= 0) break;

      const order = pendingOrders[i];
      const orderRemaining = order.remainingBalance;

      // Calculate payment for this specific order
      // Pay exactly what the order needs, up to the remaining payment amount
      const paymentForOrder = Math.min(remainingAmount, orderRemaining);

      if (paymentForOrder > 0) {
        // Calculate the new remaining balance for this order after this payment
        const newOrderRemaining = orderRemaining - paymentForOrder;

        console.log(`Applying €${paymentForOrder.toFixed(2)} to ${order.orderNumber} (Remaining after: €${newOrderRemaining.toFixed(2)})`);

        // Create ledger entry linked to this specific order
        await Ledger.createEntry({
          type: 'supplier',
          entityId: supplierId,
          entityModel: 'Supplier',
          transactionType: 'payment',
          referenceId: order._id,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: paymentForOrder,
          paymentMethod,
          date,
          description: description || `Distributed payment to ${order.orderNumber}`,
          createdBy,
          paymentDetails: {
            cashPayment: paymentMethod === 'cash' ? paymentForOrder : 0,
            bankPayment: paymentMethod === 'bank' ? paymentForOrder : 0,
            remainingBalance: Math.max(0, newOrderRemaining)
          }
        }, session);

        distributions.push({
          orderId: order._id,
          orderNumber: order.orderNumber,
          amountApplied: paymentForOrder,
          previousRemaining: orderRemaining,
          newRemaining: newOrderRemaining,
          fullyPaid: newOrderRemaining === 0,
          totalAmount: order.totalAmount,
          totalPaid: order.totalPaid
        });

        remainingAmount -= paymentForOrder;
      }
    }

    // 3. Handle excess payment (if any)
    // If payment exceeds all order balances, create advance/credit entry
    if (remainingAmount > 0) {
      console.log(`\nExcess payment: €${remainingAmount.toFixed(2)} - Creating advance/credit entry`);

      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'payment', // Keep as 'payment' for consistency
        // referenceId and referenceModel omitted - no dispatch order reference for excess payments
        debit: 0,
        credit: remainingAmount,
        paymentMethod,
        date,
        description: description || `Advance payment (credit to supplier account)`,
        createdBy,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? remainingAmount : 0,
          bankPayment: paymentMethod === 'bank' ? remainingAmount : 0,
          remainingBalance: 0 // No remaining balance for excess/credit entries
        }
      }, session);

      distributions.push({
        orderId: null,
        orderNumber: 'ADVANCE_CREDIT',
        amountApplied: remainingAmount,
        previousRemaining: 0,
        newRemaining: -remainingAmount, // Negative = supplier has credit
        fullyPaid: false,
        isAdvance: true,
        totalAmount: undefined, // Not applicable
        totalPaid: undefined // Not applicable
      });
    }

    console.log("\n========== DISTRIBUTION COMPLETE ==========");
    console.log(`Total Distributed: €${amount.toFixed(2)}`);
    console.log(`Orders Affected: ${distributions.filter(d => !d.isAdvance).length}`);
    console.log(`Fully Paid Orders: ${distributions.filter(d => d.fullyPaid).length}`);
    console.log(`Advance/Credit: €${(remainingAmount > 0 ? remainingAmount : 0).toFixed(2)}`);
    console.log("==========================================\n");

    return {
      totalDistributed: amount,
      distributions,
      remainingCredit: remainingAmount > 0 ? remainingAmount : 0
    };
  }

  /**
   * Record a debit adjustment (manual charge to increase what we owe supplier)
   */
  static async recordDebitAdjustment({
    supplierId,
    amount,
    description,
    createdBy,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'supplier',
      entityId: supplierId,
      entityModel: 'Supplier',
      transactionType: 'adjustment',
      debit: amount,
      credit: 0,
      date,
      description: description || 'Manual debit adjustment',
      createdBy
    }, session);
  }

  /**
   * Apply supplier credit to a new order (when supplier has negative balance)
   */
  static async applySupplierCreditToOrder({
    supplierId,
    orderId,
    orderTotal,
    createdBy,
    session = null
  }) {
    const currentBalance = await this.getSupplierBalance(supplierId);

    // Only apply if balance is negative (supplier has credit)
    if (currentBalance >= 0) return { creditApplied: 0 };

    const availableCredit = Math.abs(currentBalance);
    const creditToApply = Math.min(availableCredit, orderTotal);

    if (creditToApply > 0) {
      await Ledger.createEntry({
        type: 'supplier',
        entityId: supplierId,
        entityModel: 'Supplier',
        transactionType: 'credit_application',
        referenceId: orderId,
        referenceModel: 'DispatchOrder',
        debit: creditToApply, // Reduces supplier credit
        credit: 0,
        date: new Date(),
        description: `Credit applied from supplier account`,
        createdBy
      }, session);
    }

    return { creditApplied: creditToApply };
  }

  // =====================================================
  // TRANSACTION RECORDING METHODS (BUYER)
  // =====================================================

  /**
   * Record a sale to a buyer (debit - buyer owes us)
   */
  static async recordSale({
    buyerId,
    saleId,
    amount,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'buyer',
      entityId: buyerId,
      entityModel: 'Buyer',
      transactionType: 'sale',
      referenceId: saleId,
      referenceModel: 'Sale',
      debit: amount,
      credit: 0,
      date,
      description: description || 'Sale',
      createdBy
    }, session);
  }

  /**
   * Record a receipt from a buyer (credit - buyer paid us)
   */
  static async recordReceipt({
    buyerId,
    saleId,
    amount,
    paymentMethod,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'buyer',
      entityId: buyerId,
      entityModel: 'Buyer',
      transactionType: 'receipt',
      referenceId: saleId,
      referenceModel: 'Sale',
      debit: 0,
      credit: amount,
      paymentMethod,
      date,
      description: description || 'Receipt',
      createdBy
    }, session);
  }

  // =====================================================
  // TRANSACTION RECORDING METHODS (LOGISTICS)
  // =====================================================

  /**
   * Record logistics charge when confirming an order
   */
  static async recordLogisticsCharge({
    logisticsCompanyId,
    dispatchOrderId,
    totalBoxes,
    boxRate,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    const logisticsCharge = totalBoxes * boxRate;

    if (logisticsCharge <= 0) return null;

    return await Ledger.createEntry({
      type: 'logistics',
      entityId: logisticsCompanyId,
      entityModel: 'LogisticsCompany',
      transactionType: 'charge',
      referenceId: dispatchOrderId,
      referenceModel: 'DispatchOrder',
      debit: logisticsCharge,
      credit: 0,
      date,
      description: description || `Logistics charge - ${totalBoxes} boxes × £${boxRate}/box`,
      createdBy
    }, session);
  }

  /**
   * Record a payment to logistics company for a specific order
   */
  static async recordLogisticsPayment({
    logisticsCompanyId,
    referenceId,
    amount,
    paymentMethod,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'logistics',
      entityId: logisticsCompanyId,
      entityModel: 'LogisticsCompany',
      transactionType: 'payment',
      referenceId,
      referenceModel: 'DispatchOrder',
      debit: 0,
      credit: amount,
      paymentMethod,
      date,
      description: description || `Logistics payment (${paymentMethod})`,
      createdBy
    }, session);
  }

  /**
   * Distribute a universal payment across pending logistics charges using FIFO
   */
  static async distributeLogisticsPayment({
    logisticsCompanyId,
    amount,
    paymentMethod,
    createdBy,
    description,
    date = new Date(),
    session = null
  }) {
    // Get pending charges sorted by createdAt ASCENDING (FIFO)
    const pendingCharges = await this.getPendingLogisticsCharges(logisticsCompanyId);

    // Handle case when there are no pending charges - create advance/credit entry
    if (pendingCharges.length === 0) {
      await Ledger.createEntry({
        type: 'logistics',
        entityId: logisticsCompanyId,
        entityModel: 'LogisticsCompany',
        transactionType: 'payment',
        // referenceId and referenceModel omitted - no dispatch order reference for advance payments
        debit: 0,
        credit: amount,
        paymentMethod,
        date,
        description: description || `Advance payment (credit to logistics company account - no pending charges)`,
        createdBy,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? amount : 0,
          bankPayment: paymentMethod === 'bank' ? amount : 0,
          remainingBalance: 0
        }
      }, session);

      return {
        totalDistributed: amount,
        distributions: [{
          orderId: null,
          orderNumber: 'ADVANCE_CREDIT',
          amountApplied: amount,
          previousRemaining: 0,
          newRemaining: -amount, // Negative = logistics company has credit
          fullyPaid: false,
          isAdvance: true,
          totalAmount: undefined, // Not applicable
          totalPaid: undefined // Not applicable
        }],
        remainingCredit: amount
      };
    }

    let remainingAmount = amount;
    const distributions = [];

    // Distribute payment across charges in FIFO order
    for (let i = 0; i < pendingCharges.length; i++) {
      if (remainingAmount <= 0) break;

      const charge = pendingCharges[i];
      const chargeRemaining = charge.remainingBalance;

      // Calculate payment for this charge
      // Pay exactly what the charge needs, up to the remaining payment amount
      const paymentForCharge = Math.min(remainingAmount, chargeRemaining);

      if (paymentForCharge > 0) {
        // Calculate new remaining balance for this charge
        const newChargeRemaining = chargeRemaining - paymentForCharge;

        await Ledger.createEntry({
          type: 'logistics',
          entityId: logisticsCompanyId,
          entityModel: 'LogisticsCompany',
          transactionType: 'payment',
          referenceId: charge.orderId,
          referenceModel: 'DispatchOrder',
          debit: 0,
          credit: paymentForCharge,
          paymentMethod,
          date,
          description: description || `Distributed payment to ${charge.orderNumber}`,
          createdBy,
          paymentDetails: {
            cashPayment: paymentMethod === 'cash' ? paymentForCharge : 0,
            bankPayment: paymentMethod === 'bank' ? paymentForCharge : 0,
            remainingBalance: Math.max(0, newChargeRemaining)
          }
        }, session);

        distributions.push({
          orderId: charge.orderId,
          orderNumber: charge.orderNumber,
          amountApplied: paymentForCharge,
          previousRemaining: chargeRemaining,
          newRemaining: newChargeRemaining,
          fullyPaid: newChargeRemaining === 0,
          isAdvance: false,
          totalAmount: charge.totalAmount,
          totalPaid: charge.totalPaid
        });

        remainingAmount -= paymentForCharge;
      }
    }

    // Handle excess payment (if any)
    // If payment exceeds all charge balances, create advance/credit entry
    if (remainingAmount > 0) {
      await Ledger.createEntry({
        type: 'logistics',
        entityId: logisticsCompanyId,
        entityModel: 'LogisticsCompany',
        transactionType: 'payment',
        // referenceId and referenceModel omitted - no dispatch order reference for excess payments
        debit: 0,
        credit: remainingAmount,
        paymentMethod,
        date,
        description: description || `Advance payment (credit to logistics company account)`,
        createdBy,
        paymentDetails: {
          cashPayment: paymentMethod === 'cash' ? remainingAmount : 0,
          bankPayment: paymentMethod === 'bank' ? remainingAmount : 0,
          remainingBalance: 0 // No remaining balance for excess/credit entries
        }
      }, session);

      distributions.push({
        orderId: null,
        orderNumber: 'ADVANCE_CREDIT',
        amountApplied: remainingAmount,
        previousRemaining: 0,
        newRemaining: -remainingAmount, // Negative = logistics company has credit
        fullyPaid: false,
        isAdvance: true,
        totalAmount: undefined, // Not applicable
        totalPaid: undefined // Not applicable
      });
    }

    return {
      totalDistributed: amount,
      distributions,
      remainingCredit: remainingAmount > 0 ? remainingAmount : 0
    };
  }

  /**
   * Record a debit adjustment for logistics (manual charge)
   */
  static async recordLogisticsDebitAdjustment({
    logisticsCompanyId,
    amount,
    description,
    createdBy,
    date = new Date(),
    session = null
  }) {
    return await Ledger.createEntry({
      type: 'logistics',
      entityId: logisticsCompanyId,
      entityModel: 'LogisticsCompany',
      transactionType: 'adjustment',
      debit: amount,
      credit: 0,
      date,
      description: description || 'Manual debit adjustment',
      createdBy
    }, session);
  }

  // =====================================================
  // PENDING BALANCE METHODS (for balance routes)
  // =====================================================

  /**
   * Get pending balances for all suppliers or a specific supplier
   * Returns data in format compatible with current /balances/pending API
   */
  static async getPendingSupplierBalances(supplierId = null) {
    const query = { status: 'confirmed' };
    if (supplierId) query.supplier = supplierId;

    const orders = await DispatchOrder.find(query)
      .populate('supplier', 'name company')
      .select('orderNumber items confirmedQuantities supplierPaymentTotal totalDiscount dispatchDate createdAt supplier supplierUser')
      .lean();

    const balances = await Promise.all(
      orders.map(async (order) => {
        const currentValue = this.calculateCurrentOrderValue(order);
        const payments = await Ledger.getOrderPayments(order._id);
        const returnTotal = await Ledger.getOrderReturnTotal(order._id);
        const remainingBalance = currentValue - payments.total - returnTotal;

        // Determine cash/bank pending based on payment history
        let cashPending = 0;
        let bankPending = 0;

        if (payments.total === 0) {
          cashPending = remainingBalance; // Default to cash
        } else {
          const cashRatio = payments.cash / payments.total;
          if (cashRatio >= 0.7) {
            cashPending = remainingBalance;
          } else if (cashRatio <= 0.3) {
            bankPending = remainingBalance;
          } else {
            cashPending = remainingBalance * cashRatio;
            bankPending = remainingBalance * (1 - cashRatio);
          }
        }

        let status = 'pending';
        if (remainingBalance <= 0 && payments.total > 0) {
          status = 'paid';
        } else if (payments.total > 0) {
          status = 'partial';
        }

        return {
          id: order._id,
          type: order.supplierUser ? 'dispatchOrder' : 'purchase',
          date: order.dispatchDate || order.createdAt,
          supplierName: order.supplier?.name || order.supplier?.company || 'Unknown',
          supplierId: order.supplier._id,
          totalAmount: currentValue,
          totalPaid: payments.total,
          amount: remainingBalance,
          cashPending,
          bankPending,
          cashPaid: payments.cash,
          bankPaid: payments.bank,
          returnAmount: returnTotal,
          status,
          reference: order.orderNumber,
          referenceId: order._id,
          referenceModel: 'DispatchOrder'
        };
      })
    );

    return balances.sort((a, b) => new Date(b.date) - new Date(a.date));
  }

  /**
   * Get pending balances for logistics companies
   */
  static async getPendingLogisticsBalances(logisticsCompanyId = null) {
    const LogisticsCompany = require('../models/LogisticsCompany');

    const query = {
      status: 'confirmed',
      logisticsCompany: { $exists: true, $ne: null }
    };
    if (logisticsCompanyId) query.logisticsCompany = logisticsCompanyId;

    const orders = await DispatchOrder.find(query)
      .populate('logisticsCompany', 'name rates')
      .select('orderNumber totalBoxes dispatchDate createdAt logisticsCompany')
      .lean();

    const balances = await Promise.all(
      orders.map(async (order) => {
        if (!order.logisticsCompany) return null;

        const boxRate = order.logisticsCompany.rates?.boxRate || 0;
        const totalAmount = (order.totalBoxes || 0) * boxRate;
        const payments = await Ledger.getOrderPayments(order._id);
        const remainingBalance = totalAmount - payments.total;

        let cashPending = 0;
        let bankPending = 0;

        if (payments.total === 0) {
          cashPending = remainingBalance;
        } else {
          const cashRatio = payments.cash / payments.total;
          if (cashRatio >= 0.7) {
            cashPending = remainingBalance;
          } else if (cashRatio <= 0.3) {
            bankPending = remainingBalance;
          } else {
            cashPending = remainingBalance * cashRatio;
            bankPending = remainingBalance * (1 - cashRatio);
          }
        }

        let status = 'pending';
        if (remainingBalance <= 0 && payments.total > 0) {
          status = 'paid';
        } else if (payments.total > 0) {
          status = 'partial';
        }

        return {
          id: order._id,
          type: 'dispatchOrder',
          date: order.dispatchDate || order.createdAt,
          companyName: order.logisticsCompany?.name || 'Unknown',
          logisticsCompanyId: order.logisticsCompany._id,
          totalBoxes: order.totalBoxes || 0,
          boxRate,
          totalAmount,
          totalPaid: payments.total,
          amount: remainingBalance,
          cashPending,
          bankPending,
          status,
          reference: order.orderNumber
        };
      })
    );

    return balances.filter(b => b !== null).sort((a, b) => new Date(b.date) - new Date(a.date));
  }
}

module.exports = BalanceService;