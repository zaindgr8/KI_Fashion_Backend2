const express = require('express');
const mongoose = require('mongoose');
const DispatchOrder = require('../models/DispatchOrder');
const Ledger = require('../models/Ledger');
const Return = require('../models/Return');
const auth = require('../middleware/auth');
const { sendResponse } = require('../utils/helpers');
const BalanceService = require('../services/BalanceService');

const router = express.Router();

// Get pending balances from dispatch orders and purchases
router.get('/pending', auth, async (req, res) => {
  try {
    let { supplierId } = req.query;

    // Authorization check: Suppliers can only query their own pending balances
    if (req.user.role === 'supplier') {
      const userSupplierId = req.user.supplier?._id?.toString() || req.user.supplier?.toString();
      if (!userSupplierId) {
        return res.status(403).json({
          success: false,
          message: 'Supplier account not found'
        });
      }
      // Force supplierId to logged-in supplier's ID
      supplierId = userSupplierId;
    }

    // Build query for dispatch orders - only filter by status
    // We'll calculate remaining balance dynamically from ledger entries
    const dispatchOrderQuery = {
      status: 'confirmed'
    };

    // Filter by supplier if provided
    if (supplierId && supplierId !== 'all') {
      dispatchOrderQuery.supplier = supplierId;
    }

    // Fetch all confirmed dispatch orders (both manual entries and supplier portal entries)
const dispatchOrders = await DispatchOrder.find(dispatchOrderQuery)
      .populate('supplier', 'name company')
      .select('orderNumber paymentDetails dispatchDate createdAt supplier items exchangeRate percentage confirmedQuantities supplierUser grandTotal cashPayment bankPayment remainingBalance paymentStatus supplierPaymentTotal totalDiscount')
      .sort({ createdAt: -1 });

    // Process dispatch orders (supplier portal entries only - exclude manual entries)
    const dispatchOrderBalances = await Promise.all(
      dispatchOrders
        .filter(order => order.supplierUser !== null) // Only supplier portal entries
        .map(async (order) => {
      // Calculate total amount from items
      // Use supplierPaymentTotal (already has discount applied) if order is confirmed
      // Otherwise calculate from items
      let totalAmount = 0;
      let originalAmountBeforeDiscount = 0;
      let discount = order.totalDiscount || 0;
      
      if (order.status === 'confirmed' && order.supplierPaymentTotal !== undefined) {
        // Use the supplierPaymentTotal which already has discount applied
        totalAmount = order.supplierPaymentTotal;
        // Calculate original amount before discount by adding discount back
        originalAmountBeforeDiscount = totalAmount + discount;
      } else {
        // For pending orders, calculate from items (discount will be applied on confirmation)
        const itemsWithDetails = order.items?.map((item, index) => {
          const confirmedQty = order.confirmedQuantities?.find(cq => cq.itemIndex === index)?.quantity 
            || item.quantity;
          const supplierPaymentAmount = item.supplierPaymentAmount || item.costPrice;
          return supplierPaymentAmount * confirmedQty;
        }) || [];
        originalAmountBeforeDiscount = itemsWithDetails.reduce((sum, amount) => sum + amount, 0);
        // Apply discount if set
        totalAmount = Math.max(0, originalAmountBeforeDiscount - discount);
      }
      
      // Calculate cumulative payments from ledger entries
      const paymentEntries = await Ledger.find({
        type: 'supplier',
        entityId: order.supplier._id,
        referenceModel: 'DispatchOrder',
        referenceId: order._id,
        transactionType: 'payment'
      });
      
      const totalPaid = paymentEntries.reduce((sum, entry) => {
        return sum + (entry.credit || 0);
      }, 0);
      
      const remainingBalance = totalAmount - totalPaid;
      
      // Include ALL entries regardless of payment status (paid, partial, or pending)
      const paymentDetails = order.paymentDetails || {};
      
      // Calculate cash and bank payments from ledger entries
      const cashPaid = paymentEntries.reduce((sum, entry) => {
        return sum + (entry.paymentMethod === 'cash' ? (entry.credit || 0) : 0);
      }, 0);
      const bankPaid = paymentEntries.reduce((sum, entry) => {
        return sum + (entry.paymentMethod === 'bank' ? (entry.credit || 0) : 0);
      }, 0);
      
      // Calculate return amount - find returns linked to this dispatch order
      const returnDocs = await Return.find({
        dispatchOrder: order._id,
        supplier: order.supplier._id
      });
      
      const returnAmount = returnDocs.reduce((sum, returnDoc) => {
        return sum + (returnDoc.totalReturnValue || 0);
      }, 0);
      
      // Debug logging for payment tracking (after all calculations)
      console.log(`[Pending Balances] Order ${order.orderNumber}: totalAmount=${totalAmount}, discount=${discount}, cashPaid=${cashPaid}, bankPaid=${bankPaid}, returnAmount=${returnAmount}, totalPaid=${totalPaid}, remaining=${remainingBalance}, paymentEntries=${paymentEntries.length}`);
      
      // Determine cashPending and bankPending based on payment history
      let cashPending = 0;
      let bankPending = 0;
      let paymentType = 'cash'; // default
      
      if (totalPaid === 0) {
        // No payments made yet - use initial payment method from confirmation
        const initialCash = paymentDetails.cashPayment || 0;
        const initialBank = paymentDetails.bankPayment || 0;
        if (initialCash > 0 && initialBank === 0) {
          // Initial payment was cash, remaining is cash pending
          cashPending = remainingBalance;
          paymentType = 'cash';
        } else if (initialBank > 0 && initialCash === 0) {
          // Initial payment was bank, remaining is bank pending
          bankPending = remainingBalance;
          paymentType = 'bank';
        } else {
          // No initial payment or mixed - default to cash
          cashPending = remainingBalance;
          paymentType = 'cash';
        }
      } else {
        // Payments exist - determine split based on payment history
        const cashRatio = cashPaid / totalPaid;
        const bankRatio = bankPaid / totalPaid;
        
        if (cashRatio >= 0.7) {
          // Mostly cash payments - remaining is cash pending
          cashPending = remainingBalance;
          paymentType = 'cash';
        } else if (bankRatio >= 0.7) {
          // Mostly bank payments - remaining is bank pending
          bankPending = remainingBalance;
          paymentType = 'bank';
        } else {
          // Mixed payments - split proportionally
          cashPending = remainingBalance * cashRatio;
          bankPending = remainingBalance * bankRatio;
          // Use the larger portion for payment type
          paymentType = cashRatio > bankRatio ? 'cash' : 'bank';
        }
      }
      
      // Determine status based on payments made
      let status = 'pending';
      if (remainingBalance <= 0 && totalPaid > 0) {
        status = 'paid';
      } else if (totalPaid > 0 && totalPaid < totalAmount) {
        status = 'partial';
      }

      return {
        id: order._id,
        type: 'dispatchOrder',
        date: order.dispatchDate || order.createdAt,
        supplierName: order.supplier?.name || order.supplier?.company || 'Unknown',
        supplierId: order.supplier._id,
        totalAmount: totalAmount,
        totalPaid: totalPaid,
        amount: remainingBalance, // Remaining balance (can be 0 for paid orders)
        paymentType: paymentType,
        status: status,
        reference: order.orderNumber,
        referenceId: order._id,
        referenceModel: 'DispatchOrder',
        cashPending: cashPending,
        bankPending: bankPending,
        cashPaid: cashPaid,
        bankPaid: bankPaid,
        returnAmount: returnAmount,
        discount: discount
      };
        })
    );
    
    // All entries are now included (no null filtering needed)
    const validDispatchOrderBalances = dispatchOrderBalances.filter(balance => balance !== null);

    // Process manual entries (supplierUser is null) - calculate remaining balance from ledger entries
    const manualEntryBalances = await Promise.all(
      dispatchOrders
        .filter(order => order.supplierUser === null) // Manual entries
        .map(async (order) => {
          // For manual entries, use grandTotal if available, otherwise calculate from items
          let totalAmount = order.grandTotal || 0;
          if (totalAmount === 0 && order.items && order.items.length > 0) {
            totalAmount = order.items.reduce((sum, item) => {
              return sum + (item.landedTotal || 0);
            }, 0);
          }
          
          // Calculate payments from ledger entries
          const paymentEntries = await Ledger.find({
            type: 'supplier',
            entityId: order.supplier._id,
            referenceModel: 'DispatchOrder',
            referenceId: order._id,
            transactionType: 'payment'
          });
          
          const totalPaid = paymentEntries.reduce((sum, entry) => {
            return sum + (entry.credit || 0);
          }, 0);
          
          const remainingBalance = totalAmount - totalPaid;
          
          // Include ALL entries regardless of payment status (paid, partial, or pending)
          // Calculate cash and bank payments from ledger entries
          const cashPaid = paymentEntries.reduce((sum, entry) => {
            return sum + (entry.paymentMethod === 'cash' ? (entry.credit || 0) : 0);
          }, 0);
          const bankPaid = paymentEntries.reduce((sum, entry) => {
            return sum + (entry.paymentMethod === 'bank' ? (entry.credit || 0) : 0);
          }, 0);
          
          // Calculate return amount - find returns linked to this dispatch order
          const returnDocs = await Return.find({
            dispatchOrder: order._id,
            supplier: order.supplier._id
          });
          
          const returnAmount = returnDocs.reduce((sum, returnDoc) => {
            return sum + (returnDoc.totalReturnValue || 0);
          }, 0);
          
          // Get discount amount
          const discount = order.totalDiscount || 0;
          
          // Determine cashPending and bankPending based on payment history
          let cashPending = 0;
          let bankPending = 0;
          let paymentType = 'cash';
          
          if (totalPaid === 0) {
            const initialCash = order.cashPayment || 0;
            const initialBank = order.bankPayment || 0;
            if (initialCash > 0 && initialBank === 0) {
              cashPending = remainingBalance;
              paymentType = 'cash';
            } else if (initialBank > 0 && initialCash === 0) {
              bankPending = remainingBalance;
              paymentType = 'bank';
            } else {
              cashPending = remainingBalance;
              paymentType = 'cash';
            }
          } else {
            const cashRatio = cashPaid / totalPaid;
            const bankRatio = bankPaid / totalPaid;
            
            if (cashRatio >= 0.7) {
              cashPending = remainingBalance;
              paymentType = 'cash';
            } else if (bankRatio >= 0.7) {
              bankPending = remainingBalance;
              paymentType = 'bank';
            } else {
              cashPending = remainingBalance * cashRatio;
              bankPending = remainingBalance * bankRatio;
              paymentType = cashRatio > bankRatio ? 'cash' : 'bank';
            }
          }
          
          // Determine status based on payments made
          let status = 'pending';
          if (remainingBalance <= 0 && totalPaid > 0) {
            status = 'paid';
          } else if (totalPaid > 0 && totalPaid < totalAmount) {
            status = 'partial';
          }

          return {
            id: order._id,
            type: 'purchase',
            date: order.dispatchDate || order.createdAt,
            supplierName: order.supplier?.name || order.supplier?.company || 'Unknown',
            supplierId: order.supplier._id,
            totalAmount: totalAmount,
            totalPaid: totalPaid,
            amount: remainingBalance, // Remaining balance (can be 0 for paid orders)
            paymentType: paymentType,
            status: status,
            reference: order.orderNumber,
            referenceId: order._id,
            referenceModel: 'DispatchOrder',
            cashPending: cashPending,
            bankPending: bankPending,
            cashPaid: cashPaid,
            bankPaid: bankPaid,
            returnAmount: returnAmount,
            discount: discount
          };
        })
    );
    
    // All entries are now included (no null filtering needed)
    const validPurchaseBalances = manualEntryBalances.filter(balance => balance !== null);

    // Combine and sort by date
    const allBalances = [...validDispatchOrderBalances, ...validPurchaseBalances].sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    // Calculate totals - use cashPending and bankPending from each balance
    const totalCashPending = allBalances.reduce((sum, balance) => {
      return sum + (balance.cashPending || 0);
    }, 0);

    const totalBankPending = allBalances.reduce((sum, balance) => {
      return sum + (balance.bankPending || 0);
    }, 0);

    // Total pending should be the sum of cashPending + bankPending, not individual amounts
    // This ensures totals match and avoids double-counting
    const totalPending = totalCashPending + totalBankPending;

    // Calculate total paid - sum of all payment ledger entries
    const paymentQuery = { transactionType: 'payment', type: 'supplier' };
    if (supplierId && supplierId !== 'all') {
      paymentQuery.entityId = supplierId;
    }
    const paymentEntries = await Ledger.find(paymentQuery);
    const totalPaid = paymentEntries.reduce((sum, entry) => {
      return sum + (entry.credit || 0);
    }, 0);

    // Debug logging
    console.log('Pending balances query:', {
      supplierId,
      dispatchOrdersCount: dispatchOrders.length,
      manualEntriesCount: dispatchOrders.filter(o => o.supplierUser === null).length,
      supplierPortalEntriesCount: dispatchOrders.filter(o => o.supplierUser !== null).length,
      validDispatchOrderBalancesCount: validDispatchOrderBalances.length,
      validPurchaseBalancesCount: validPurchaseBalances.length,
      allBalancesCount: allBalances.length
    });

    return sendResponse.success(res, {
      balances: allBalances,
      totals: {
        cashPending: totalCashPending,
        bankPending: totalBankPending,
        totalPending: totalPending,
        totalPaid: totalPaid
      }
    });

  } catch (error) {
    console.error('Get pending balances error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

// Get pending balances for logistics companies
router.get('/pending-logistics', auth, async (req, res) => {
  try {
    let { logisticsCompanyId } = req.query;

    // Build query for dispatch orders - only confirmed orders
    const dispatchOrderQuery = {
      status: 'confirmed',
      logisticsCompany: { $exists: true, $ne: null }
    };

    // Filter by logistics company if provided
    if (logisticsCompanyId && logisticsCompanyId !== 'all') {
      dispatchOrderQuery.logisticsCompany = logisticsCompanyId;
    }

    // Fetch all confirmed dispatch orders with logistics companies
    const dispatchOrders = await DispatchOrder.find(dispatchOrderQuery)
      .populate('logisticsCompany', 'name rates')
      .select('orderNumber dispatchDate createdAt logisticsCompany totalBoxes')
      .sort({ createdAt: -1 });

    // Process dispatch orders for logistics charges
    const logisticsBalances = await Promise.all(
      dispatchOrders.map(async (order) => {
        if (!order.logisticsCompany) return null;

        // Get box rate from logistics company
        const boxRate = order.logisticsCompany.rates?.boxRate || 0;
        const totalBoxes = order.totalBoxes || 0;
        
        // Calculate total logistics charge
        const totalAmount = totalBoxes * boxRate;

        // Calculate cumulative payments from ledger entries
        const paymentEntries = await Ledger.find({
          type: 'logistics',
          entityId: order.logisticsCompany._id,
          referenceModel: 'DispatchOrder',
          referenceId: order._id,
          transactionType: 'payment'
        });

        const totalPaid = paymentEntries.reduce((sum, entry) => {
          return sum + (entry.credit || 0);
        }, 0);

        const remainingBalance = totalAmount - totalPaid;

        // Calculate cash and bank payments from ledger entries
        const cashPaid = paymentEntries.reduce((sum, entry) => {
          return sum + (entry.paymentMethod === 'cash' ? (entry.credit || 0) : 0);
        }, 0);
        const bankPaid = paymentEntries.reduce((sum, entry) => {
          return sum + (entry.paymentMethod === 'bank' ? (entry.credit || 0) : 0);
        }, 0);

        // Determine cashPending and bankPending based on payment history
        let cashPending = 0;
        let bankPending = 0;
        let paymentType = 'cash'; // default

        if (totalPaid === 0) {
          // No payments made yet - default to cash
          cashPending = remainingBalance;
          paymentType = 'cash';
        } else {
          // Payments exist - determine split based on payment history
          const cashRatio = cashPaid / totalPaid;
          const bankRatio = bankPaid / totalPaid;

          if (cashRatio >= 0.7) {
            // Mostly cash payments - remaining is cash pending
            cashPending = remainingBalance;
            paymentType = 'cash';
          } else if (bankRatio >= 0.7) {
            // Mostly bank payments - remaining is bank pending
            bankPending = remainingBalance;
            paymentType = 'bank';
          } else {
            // Mixed payments - split proportionally
            cashPending = remainingBalance * cashRatio;
            bankPending = remainingBalance * bankRatio;
            // Use the larger portion for payment type
            paymentType = cashRatio > bankRatio ? 'cash' : 'bank';
          }
        }

        // Determine status based on payments made
        let status = 'pending';
        if (remainingBalance <= 0 && totalPaid > 0) {
          status = 'paid';
        } else if (totalPaid > 0 && totalPaid < totalAmount) {
          status = 'partial';
        }

        return {
          id: order._id,
          type: 'dispatchOrder',
          date: order.dispatchDate || order.createdAt,
          companyName: order.logisticsCompany?.name || 'Unknown',
          logisticsCompanyId: order.logisticsCompany._id,
          totalBoxes: totalBoxes,
          boxRate: boxRate,
          totalAmount: totalAmount,
          totalPaid: totalPaid,
          amount: remainingBalance, // Remaining balance
          paymentType: paymentType,
          status: status,
          reference: order.orderNumber,
          cashPending: cashPending,
          bankPending: bankPending
        };
      })
    );

    // Filter out null entries
    const validBalances = logisticsBalances.filter(balance => balance !== null);

    // Sort by date
    const allBalances = validBalances.sort((a, b) => {
      return new Date(b.date) - new Date(a.date);
    });

    // Filter out fully paid orders (remainingBalance <= 0 or status === 'paid')
    const pendingBalances = allBalances.filter(balance => {
      return (balance.amount || balance.remainingBalance || 0) > 0 && balance.status !== 'paid';
    });

    // Calculate totals (only for pending balances)
    const totalCashPending = pendingBalances.reduce((sum, balance) => {
      return sum + (balance.cashPending || 0);
    }, 0);

    const totalBankPending = pendingBalances.reduce((sum, balance) => {
      return sum + (balance.bankPending || 0);
    }, 0);

    const totalPending = totalCashPending + totalBankPending;

    // Calculate total paid - sum of all payment ledger entries
    const paymentQuery = { transactionType: 'payment', type: 'logistics' };
    if (logisticsCompanyId && logisticsCompanyId !== 'all') {
      paymentQuery.entityId = logisticsCompanyId;
    }
    const paymentEntries = await Ledger.find(paymentQuery);
    const totalPaid = paymentEntries.reduce((sum, entry) => {
      return sum + (entry.credit || 0);
    }, 0);

    // Debug logging
    console.log('Logistics pending balances query:', {
      logisticsCompanyId,
      dispatchOrdersCount: dispatchOrders.length,
      validBalancesCount: validBalances.length,
      pendingBalancesCount: pendingBalances.length
    });

    return sendResponse.success(res, {
      balances: pendingBalances, // Only return pending (non-fully-paid) balances
      totals: {
        cashPending: totalCashPending,
        bankPending: totalBankPending,
        totalPending: totalPending,
        totalPaid: totalPaid
      }
    });

  } catch (error) {
    console.error('Get logistics pending balances error:', error);
    return sendResponse.error(res, 'Server error', 500);
  }
});

module.exports = router;

