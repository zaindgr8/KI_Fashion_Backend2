const express = require("express");
const mongoose = require("mongoose");

const Ledger = require("../models/Ledger");
const DispatchOrder = require("../models/DispatchOrder");
const Supplier = require("../models/Supplier");
const Buyer = require("../models/Buyer");
const auth = require("../middleware/auth");
const BalanceService = require("../services/BalanceService");

const router = express.Router()

// Helper function to get buyer ID for distributor/buyer users
async function getBuyerIdForUser(user) {
  // If buyer is already linked, use it
  if (user.buyer) {
    return user.buyer;
  }

  // If user is distributor/buyer, try to find buyer by email
  if ((user.role === "distributor" || user.role === "buyer") && user.email) {
    const buyer = await Buyer.findOne({
      email: user.email.toLowerCase(),
      customerType: "distributor",
    });
    if (buyer) {
      return buyer._id;
    }
  }

  return null;
}

// Helper function to calculate total payments for a dispatch order
async function calculateDispatchOrderPayments(dispatchOrderId, supplierId) {
  const paymentEntries = await Ledger.find({
    type: "supplier",
    entityId: supplierId,
    referenceModel: "DispatchOrder",
    referenceId: dispatchOrderId,
    transactionType: "payment",
  });

  const totalPaid = paymentEntries.reduce((sum, entry) => {
    return (
      sum +
      (entry.paymentDetails?.cashPayment || 0) +
      (entry.paymentDetails?.bankPayment || 0)
    );
  }, 0);

  return totalPaid;
}

router.get("/supplier/:id", auth, async (req, res) => {
  try {
    // Authorization check: Suppliers can only access their own ledger
    if (req.user.role === "supplier") {
      const supplierId =
        req.user.supplier?._id?.toString() || req.user.supplier?.toString();
      if (supplierId !== req.params.id) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only view your own ledger.",
        });
      }
    }

    const {
      page = 1,
      limit = 50,
      startDate,
      endDate,
      transactionType,
    } = req.query;

    const query = {
      type: "supplier",
      entityId: req.params.id,
    };

    // Add transaction type filter if provided
    if (transactionType && transactionType !== "all") {
      query.transactionType = transactionType;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    // Fetch entries
    let entries = await Ledger.find(query)
      .populate("createdBy", "name")
      .sort({ date: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    // Populate referenceId for DispatchOrder references (same as /suppliers endpoint)
    const DispatchOrderModel = require("../models/DispatchOrder");
    entries = await Promise.all(
      entries.map(async (entry) => {
        if (entry.referenceId && entry.referenceModel) {
          try {
            let refDoc;
            if (entry.referenceModel === "DispatchOrder") {
              refDoc = await DispatchOrderModel.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities totalDiscount discount")
                .lean();
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  orderNumber: refDoc.orderNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                  totalDiscount: refDoc.totalDiscount || 0,
                  discount: refDoc.discount || 0,
                };
            } else if (entry.referenceModel === "Purchase") {
              refDoc = await DispatchOrderModel.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities totalDiscount discount")
                .lean();
              if (refDoc) {
                refDoc.purchaseNumber = refDoc.orderNumber;
                entry.referenceId = {
                  _id: refDoc._id,
                  purchaseNumber: refDoc.purchaseNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                  totalDiscount: refDoc.totalDiscount || 0,
                  discount: refDoc.discount || 0,
                };
              }
            }
          } catch (err) {
            console.error("Error populating reference:", err);
          }
        }
        return entry;
      })
    );

    const total = await Ledger.countDocuments(query);

    // Use BalanceService for all stats calculations (SSOT)
    const stats = await BalanceService.getSupplierDashboardStats(req.params.id);

    res.json({
      success: true,
      data: {
        entries,
        currentBalance: stats.currentBalance,
        totalBalance: stats.totalBalance,
        totalCashPayment: stats.totalCashPayment,
        totalBankPayment: stats.totalBankPayment,
        totalRemainingBalance: stats.totalRemainingBalance,
        totalOutstandingBalance: stats.totalOutstandingBalance,
        supplierCount: 1,
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error("Get supplier ledger error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// Get all supplier ledger entries (optionally filtered by supplier)
router.get("/suppliers", auth, async (req, res) => {
  try {
    const { page = 1, limit = 100, supplierId, startDate, endDate } = req.query;

    const query = {
      type: "supplier",
    };

    // Filter by specific supplier if provided
    if (supplierId && supplierId !== "all") {
      query.entityId = supplierId;
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    // Find entries
    let entries = await Ledger.find(query)
      .populate("createdBy", "name")
      .populate("entityId", "name company") // Populate supplier info
      .lean() // Use lean for better performance
      .sort({ date: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Populate reference documents dynamically
    // Purchase model removed - use DispatchOrder for manual entries
    const Return = mongoose.model("Return");

    entries = await Promise.all(
      entries.map(async (entry) => {
        if (entry.referenceId && entry.referenceModel) {
          try {
            let refDoc;
            if (entry.referenceModel === "DispatchOrder") {
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities totalDiscount discount")
                .lean();
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  orderNumber: refDoc.orderNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                  totalDiscount: refDoc.totalDiscount || 0,
                  discount: refDoc.discount || 0,
                  entryNumber: refDoc.entryNumber || null,
                };
            } else if (entry.referenceModel === "Purchase") {
              // Legacy Purchase references - now use DispatchOrder (manual entries have supplierUser: null)
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities totalDiscount discount")
                .lean();
              if (refDoc) {
                refDoc.purchaseNumber = refDoc.orderNumber; // For compatibility
              }
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  purchaseNumber: refDoc.purchaseNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                  totalDiscount: refDoc.totalDiscount || 0,
                  discount: refDoc.discount || 0,
                  entryNumber: refDoc.entryNumber || null,
                };
            } else if (entry.referenceModel === "Return") {
              refDoc = await Return.findById(entry.referenceId)
                .select("_id")
                .lean();
              if (refDoc) entry.referenceId = { _id: refDoc._id };
            }
          } catch (err) {
            // If model doesn't exist or populate fails, continue without reference
            console.error("Error populating reference:", err);
          }
        }
        return entry;
      })
    );

    const total = await Ledger.countDocuments(query);

    // Calculate total balance using BalanceService (SSOT)
    let totalBalance = 0;
    if (supplierId && supplierId !== "all") {
      // Single supplier balance
      totalBalance = await BalanceService.getSupplierBalance(supplierId);
    } else {
      // Total balance across all suppliers
      totalBalance = await BalanceService.getTotalSupplierBalance();
    }

    console.log("totalBalance:", totalBalance);

    res.json({
      success: true,
      data: {
        entries,
        totalBalance,
        supplierCount:
          supplierId && supplierId !== "all"
            ? 1
            : await Ledger.distinct("entityId", { type: "supplier" }).then(
              (ids) => ids.length
            ),
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error("Get all supplier ledgers error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// Get buyer ledger (auto-detect buyer ID for distributors)
router.get("/buyer", auth, async (req, res) => {
  try {
    // Only for distributors/buyers - auto-detect their buyer ID
    if (req.user.role === "distributor" || req.user.role === "buyer") {
      const buyerId = await getBuyerIdForUser(req.user);
      if (!buyerId) {
        return res.json({
          success: true,
          data: {
            entries: [],
            currentBalance: 0,
          },
          pagination: {
            currentPage: 1,
            totalPages: 0,
            totalItems: 0,
            itemsPerPage: 50,
          },
        });
      }

      // Use the same logic as /buyer/:id route
      const { page = 1, limit = 50, startDate, endDate } = req.query;

      const query = {
        type: "buyer",
        entityId: buyerId,
      };

      if (startDate || endDate) {
        query.date = {};
        if (startDate) query.date.$gte = new Date(startDate);
        if (endDate) query.date.$lte = new Date(endDate);
      }

      const entries = await Ledger.find(query)
        .populate("createdBy", "name")
        .sort({ date: -1, createdAt: -1 })
        .limit(limit * 1)
        .skip((page - 1) * limit);

      const total = await Ledger.countDocuments(query);
      const balance = await Ledger.getBalance("buyer", buyerId);

      return res.json({
        success: true,
        data: {
          entries,
          currentBalance: balance,
        },
        pagination: {
          currentPage: page,
          totalPages: Math.ceil(total / limit),
          totalItems: total,
          itemsPerPage: limit,
        },
      });
    } else {
      return res.status(403).json({
        success: false,
        message: "Access denied. This endpoint is for distributors only.",
      });
    }
  } catch (error) {
    console.error("Get buyer ledger (auto) error:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.get("/buyer/:id", auth, async (req, res) => {
  try {
    // Authorization check: Distributors can only access their own ledger
    if (req.user.role === "distributor" || req.user.role === "buyer") {
      const buyerId = await getBuyerIdForUser(req.user);
      if (!buyerId || buyerId.toString() !== req.params.id) {
        return res.status(403).json({
          success: false,
          message: "Access denied. You can only view your own ledger.",
        });
      }
    }

    const { page = 1, limit = 50, startDate, endDate } = req.query;

    const query = {
      type: "buyer",
      entityId: req.params.id,
    };

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const entries = await Ledger.find(query)
      .populate("createdBy", "name")
      .sort({ date: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Ledger.countDocuments(query);
    const balance = await Ledger.getBalance("buyer", req.params.id);

    res.json({
      success: true,
      data: {
        entries,
        currentBalance: balance,
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error("Get buyer ledger error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

router.post("/entry", auth, async (req, res) => {
  try {
    const entryData = {
      ...req.body,
      createdBy: req.user._id,
    };

    console.log(`\n[LEDGER ENTRY] Creating entry:`, {
      type: entryData.type,
      transactionType: entryData.transactionType,
      referenceModel: entryData.referenceModel,
      referenceId: entryData.referenceId,
      credit: entryData.credit,
      entityId: entryData.entityId
    });

    // Handle supplier payments with universal distribution
    if (
      entryData.type === "supplier" &&
      entryData.transactionType === "payment" &&
      (!entryData.referenceId || entryData.referenceId === "none")
    ) {
      console.log(`[LEDGER ENTRY] Taking UNIVERSAL PAYMENT route`);
      // Universal payment - distribute across pending orders
      const { entityId, paymentMethod, credit } = entryData;

      if (!entityId || !credit) {
        return res.status(400).json({
          success: false,
          message: "Supplier ID and payment amount are required",
        });
      }

      try {
        const result = await BalanceService.distributeUniversalPayment({
          supplierId: entityId,
          amount: credit,
          paymentMethod: paymentMethod || "cash",
          createdBy: req.user._id,
          description: entryData.description,
          date: entryData.date || new Date(),
        });

        return res.status(201).json({
          success: true,
          message: "Payment distributed successfully",
          data: result,
        });
      } catch (error) {
        console.error("Universal payment distribution error:", error);
        return res.status(500).json({
          success: false,
          message: error.message || "Failed to distribute payment",
        });
      }
    }

    // Handle dispatch order payments (specific order)
    if (
      entryData.referenceModel === "DispatchOrder" &&
      entryData.transactionType === "payment"
    ) {
      console.log(`[LEDGER ENTRY] Taking DISPATCH ORDER PAYMENT route`);

      const { referenceId, entityId, paymentMethod, paymentDetails } =
        entryData;

      // Validate required fields
      if (!referenceId || !entityId) {
        return res.status(400).json({
          success: false,
          message: "Dispatch order ID and supplier ID are required",
        });
      }

      // Fetch dispatch order
      const dispatchOrder = await DispatchOrder.findById(referenceId);
      if (!dispatchOrder) {
        return res.status(404).json({
          success: false,
          message: "Dispatch order not found",
        });
      }

      // Check if dispatch order is confirmed
      if (dispatchOrder.status !== "confirmed") {
        return res.status(400).json({
          success: false,
          message: "Only confirmed dispatch orders can receive payments",
        });
      }

      // Calculate total amount for the dispatch order
      // Use supplierPaymentTotal (already has discount applied) if order is confirmed
      // Otherwise calculate from items
      let totalAmount = 0;
      if (
        dispatchOrder.status === "confirmed" &&
        dispatchOrder.supplierPaymentTotal !== undefined
      ) {
        // Use the supplierPaymentTotal which already has discount applied
        totalAmount = dispatchOrder.supplierPaymentTotal;
      } else {
        // For pending orders, calculate from items (discount will be applied on confirmation)
        const itemsWithDetails =
          dispatchOrder.items?.map((item, index) => {
            const confirmedQty =
              dispatchOrder.confirmedQuantities?.find(
                (cq) => cq.itemIndex === index
              )?.quantity || item.quantity;
            const supplierPaymentAmount =
              item.supplierPaymentAmount ||
              item.costPrice / (dispatchOrder.exchangeRate || 1.0);
            return supplierPaymentAmount * confirmedQty;
          }) || [];
        totalAmount = itemsWithDetails.reduce((sum, amount) => sum + amount, 0);
        // Apply discount if set
        const discount = dispatchOrder.totalDiscount || 0;
        totalAmount = Math.max(0, totalAmount - discount);
      }

      // IMPORTANT: Subtract return amounts from totalAmount
      // Returns reduce what admin owes supplier
      const returnEntries = await Ledger.find({
        type: "supplier",
        entityId: entityId,
        referenceModel: "Return",
        transactionType: "return",
      })
        .where("description")
        .regex(new RegExp(dispatchOrder.orderNumber, "i"));

      const totalReturns = returnEntries.reduce(
        (sum, entry) => sum + (entry.credit || 0),
        0
      );
      totalAmount = Math.max(0, totalAmount - totalReturns);

      // Calculate cumulative payments from ledger entries
      const totalPaid = await calculateDispatchOrderPayments(
        referenceId,
        entityId
      );

      // Calculate remaining balance for this specific order
      const orderRemainingBalance = totalAmount - totalPaid;

      console.log(`[Payment Check] Order: ${dispatchOrder.orderNumber}`);
      console.log(`[Payment Check] Total amount: €${totalAmount.toFixed(2)}`);
      console.log(`[Payment Check] Total paid: €${totalPaid.toFixed(2)}`);
      console.log(`[Payment Check] Order remaining: €${orderRemainingBalance.toFixed(2)}`);

      // Get payment amount from the current entry
      const paymentAmount = entryData.credit || 0;
      const cashPayment =
        paymentMethod === "cash"
          ? paymentAmount
          : paymentDetails?.cashPayment || 0;
      const bankPayment =
        paymentMethod === "bank"
          ? paymentAmount
          : paymentDetails?.bankPayment || 0;
      const newPaymentTotal = cashPayment + bankPayment;

      console.log(`[Payment Check] New payment: €${newPaymentTotal.toFixed(2)}`);
      console.log(`[Payment Check] Will split: ${newPaymentTotal > orderRemainingBalance}`);

      // CHECK IF PAYMENT EXCEEDS ORDER REMAINING - SPLIT IT
      if (newPaymentTotal > orderRemainingBalance && orderRemainingBalance > 0) {
        // Payment is more than what's owed - split it
        const paymentForOrder = orderRemainingBalance;
        const excessPayment = newPaymentTotal - orderRemainingBalance;

        console.log(`[Payment Split] Payment (€${newPaymentTotal.toFixed(2)}) exceeds order remaining (€${orderRemainingBalance.toFixed(2)})`);
        console.log(`[Payment Split] Splitting: €${paymentForOrder.toFixed(2)} to order + €${excessPayment.toFixed(2)} as credit`);

        // ============================================
        // START TRANSACTION - Ensure atomic operations
        // ============================================
        const session = await mongoose.startSession();
        session.startTransaction();

        try {
          // 1. Create payment entry for the order (exact remaining amount)
          const orderPaymentEntry = {
            type: entryData.type,
            entityId: entryData.entityId,
            entityModel: entryData.entityModel,
            transactionType: 'payment',
            referenceId: referenceId,
            referenceModel: 'DispatchOrder',
            debit: 0,
            credit: paymentForOrder,
            paymentMethod: paymentMethod,
            date: entryData.date || new Date(),
            description: entryData.description || `Payment for ${dispatchOrder.orderNumber}`,
            createdBy: req.user._id,
            paymentDetails: {
              cashPayment: paymentMethod === 'cash' ? paymentForOrder : 0,
              bankPayment: paymentMethod === 'bank' ? paymentForOrder : 0,
              remainingBalance: 0
            }
          };

          await Ledger.createEntry(orderPaymentEntry, session);

          // 2. Create credit entry for overpayment (no reference)
          const creditEntry = {
            type: entryData.type,
            entityId: entryData.entityId,
            entityModel: entryData.entityModel,
            transactionType: 'payment',
            debit: 0,
            credit: excessPayment,
            paymentMethod: paymentMethod,
            date: entryData.date || new Date(),
            description: `Overpayment credit (excess from ${dispatchOrder.orderNumber})`,
            createdBy: req.user._id,
            paymentDetails: {
              cashPayment: paymentMethod === 'cash' ? excessPayment : 0,
              bankPayment: paymentMethod === 'bank' ? excessPayment : 0,
              remainingBalance: 0
            }
          };

          await Ledger.createEntry(creditEntry, session);

          // 3. Update dispatch order to mark as fully paid
          dispatchOrder.paymentDetails = {
            cashPayment: (dispatchOrder.paymentDetails?.cashPayment || 0) + (paymentMethod === 'cash' ? paymentForOrder : 0),
            bankPayment: (dispatchOrder.paymentDetails?.bankPayment || 0) + (paymentMethod === 'bank' ? paymentForOrder : 0),
            remainingBalance: 0,
            paymentStatus: 'paid'
          };

          await dispatchOrder.save({ session });
          await session.commitTransaction();

          console.log(`[Payment Split] Successfully split payment and updated order`);

          return res.status(201).json({
            success: true,
            message: `Payment split: €${paymentForOrder.toFixed(2)} applied to order, €${excessPayment.toFixed(2)} as credit`,
            data: {
              orderPayment: paymentForOrder,
              creditAmount: excessPayment,
              dispatchOrder: dispatchOrder
            }
          });

        } catch (error) {
          await session.abortTransaction();
          console.error('Payment split transaction error:', error);
          throw error;
        } finally {
          session.endSession();
        }
      }

      // Normal flow: payment does not exceed remaining
      const remainingAfterPayment = totalAmount - totalPaid - newPaymentTotal;

      // Calculate outstanding balance (when payment exceeds what's owed, supplier owes admin)
      // Use the value from CRM if provided, otherwise calculate
      const outstandingBalance =
        paymentDetails?.outstandingBalance !== undefined
          ? paymentDetails.outstandingBalance
          : remainingAfterPayment < 0
            ? Math.abs(remainingAfterPayment)
            : 0;

      // Ensure paymentDetails is populated for the ledger entry (preserve outstandingBalance)
      entryData.paymentDetails = {
        cashPayment,
        bankPayment,
        remainingBalance: Math.max(0, remainingAfterPayment),
        outstandingBalance: outstandingBalance,
      };

      // Calculate new total paid amount (including this payment)
      const newTotalPaid = totalPaid + newPaymentTotal;

      // Calculate remaining balance (can be negative for overpayments)
      // Negative remaining = supplier owes admin (credit with supplier)
      const remainingBalance = totalAmount - totalPaid;

      // ============================================
      // START TRANSACTION - Ensure atomic operations
      // ============================================
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Create ledger entry within transaction
        const entry = await Ledger.createEntry(entryData, session);

        // OPTIMIZED: Use incremental calculation instead of querying all entries
        // Get current payment details from dispatch order
        const currentPaymentDetails = dispatchOrder.paymentDetails || {
          cashPayment: 0,
          bankPayment: 0,
          remainingBalance: totalAmount,
          paymentStatus: "pending",
        };

        // Increment by new payment (O(1) instead of O(n))
        const calculatedCashPayment =
          (currentPaymentDetails.cashPayment || 0) +
          (paymentMethod === "cash" ? paymentAmount : 0);
        const calculatedBankPayment =
          (currentPaymentDetails.bankPayment || 0) +
          (paymentMethod === "bank" ? paymentAmount : 0);

        const calculatedTotalPaid =
          calculatedCashPayment + calculatedBankPayment;
        const calculatedRemainingBalance = totalAmount - calculatedTotalPaid;

        // Determine payment status
        let paymentStatus = "pending";
        if (calculatedRemainingBalance <= 0) {
          paymentStatus = "paid";
        } else if (calculatedTotalPaid > 0) {
          paymentStatus = "partial";
        }

        // Update dispatch order payment details with incremented values
        dispatchOrder.paymentDetails = {
          cashPayment: calculatedCashPayment,
          bankPayment: calculatedBankPayment,
          remainingBalance: calculatedRemainingBalance,
          paymentStatus: paymentStatus,
        };

        await dispatchOrder.save({ session });

        // Update supplier balance (decrease by payment amount)
        await Supplier.findByIdAndUpdate(
          entityId,
          { $inc: { currentBalance: -newPaymentTotal } },
          { session }
        );

        // Commit transaction - all operations succeeded
        await session.commitTransaction();
        console.log(
          `[Payment Transaction] Successfully committed payment for dispatch order ${referenceId}`
        );

        return res.status(201).json({
          success: true,
          message: "Payment recorded successfully",
          data: entry,
        });
      } catch (transactionError) {
        // Rollback transaction on any error
        await session.abortTransaction();
        console.error(
          `[Payment Transaction] Rolled back payment for dispatch order ${referenceId}:`,
          {
            message: transactionError.message,
            stack: transactionError.stack,
            name: transactionError.name,
            referenceId: referenceId,
            entryData: entryData
          }
        );

        // Handle version errors (optimistic locking conflicts)
        if (transactionError.name === "VersionError") {
          return res.status(409).json({
            success: false,
            message:
              "This order was modified by another user. Please refresh and try again.",
            error: "CONCURRENT_MODIFICATION",
          });
        }

        throw transactionError;
      } finally {
        session.endSession();
      }
    }

    // Handle Purchase payments (similar to DispatchOrder)
    if (
      entryData.referenceModel === "Purchase" &&
      entryData.transactionType === "payment"
    ) {
      const { referenceId, entityId, paymentMethod, paymentDetails } =
        entryData;

      // Validate required fields
      if (!referenceId || !entityId) {
        return res.status(400).json({
          success: false,
          message: "Purchase ID and supplier ID are required",
        });
      }

      // Fetch DispatchOrder (manual entry - supplierUser is null)
      const dispatchOrder = await DispatchOrder.findById(referenceId).populate(
        "supplier"
      );
      if (!dispatchOrder) {
        return res.status(404).json({
          success: false,
          message: "Purchase not found",
        });
      }

      // For manual entries, use grandTotal if available, otherwise calculate from items
      let totalAmount = dispatchOrder.grandTotal || 0;
      if (
        totalAmount === 0 &&
        dispatchOrder.items &&
        dispatchOrder.items.length > 0
      ) {
        totalAmount = dispatchOrder.items.reduce((sum, item) => {
          return sum + (item.landedTotal || 0);
        }, 0);
      }

      // Calculate cumulative payments from ledger entries (before creating new entry)
      const existingPaymentEntries = await Ledger.find({
        type: "supplier",
        entityId: entityId,
        $or: [
          { referenceModel: "Purchase", referenceId: referenceId },
          { referenceModel: "DispatchOrder", referenceId: referenceId },
        ],
        transactionType: "payment",
      });

      const totalPaid = existingPaymentEntries.reduce((sum, entry) => {
        return sum + (entry.credit || 0);
      }, 0);

      // Get payment amount from the current entry
      const paymentAmount = entryData.credit || 0;
      const cashPayment =
        paymentMethod === "cash"
          ? paymentAmount
          : paymentDetails?.cashPayment || 0;
      const bankPayment =
        paymentMethod === "bank"
          ? paymentAmount
          : paymentDetails?.bankPayment || 0;
      const newPaymentTotal = cashPayment + bankPayment;

      // Ensure paymentDetails is populated for the ledger entry
      entryData.paymentDetails = {
        cashPayment,
        bankPayment,
        remainingBalance: totalAmount - totalPaid - newPaymentTotal,
      };

      // Calculate new total paid amount (including this payment)
      const newTotalPaid = totalPaid + newPaymentTotal;

      // Calculate remaining balance (can be negative for overpayments)
      // Negative remaining = supplier owes admin (credit with supplier)
      const remainingBalance = totalAmount - totalPaid;

      // ============================================
      // START TRANSACTION - Ensure atomic operations
      // ============================================
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // Create ledger entry within transaction
        const entry = await Ledger.createEntry(entryData, session);

        // OPTIMIZED: Use incremental calculation instead of querying all entries
        // Get current payment details from dispatch order
        const currentPaymentDetails = dispatchOrder.paymentDetails || {
          cashPayment: 0,
          bankPayment: 0,
          remainingBalance: totalAmount,
          paymentStatus: "pending",
        };

        // Increment by new payment (O(1) instead of O(n))
        const calculatedCashPayment =
          (currentPaymentDetails.cashPayment ||
            dispatchOrder.cashPayment ||
            0) + (paymentMethod === "cash" ? paymentAmount : 0);
        const calculatedBankPayment =
          (currentPaymentDetails.bankPayment ||
            dispatchOrder.bankPayment ||
            0) + (paymentMethod === "bank" ? paymentAmount : 0);

        const calculatedTotalPaid =
          calculatedCashPayment + calculatedBankPayment;
        const calculatedRemainingBalance = totalAmount - calculatedTotalPaid;

        // Determine payment status
        let paymentStatus = "pending";
        if (calculatedRemainingBalance <= 0) {
          paymentStatus = "paid";
        } else if (calculatedTotalPaid > 0) {
          paymentStatus = "partial";
        }

        // Update purchase payment details with incremented values
        // Update DispatchOrder (manual entry) payment fields
        dispatchOrder.cashPayment = calculatedCashPayment;
        dispatchOrder.bankPayment = calculatedBankPayment;
        dispatchOrder.remainingBalance = calculatedRemainingBalance;
        dispatchOrder.paymentStatus = paymentStatus;
        // Also update nested paymentDetails for consistency
        dispatchOrder.paymentDetails = {
          cashPayment: calculatedCashPayment,
          bankPayment: calculatedBankPayment,
          remainingBalance: calculatedRemainingBalance,
          paymentStatus: paymentStatus,
        };

        await dispatchOrder.save({ session });

        // Update supplier balance (decrease by payment amount)
        await Supplier.findByIdAndUpdate(
          entityId,
          { $inc: { currentBalance: -newPaymentTotal } },
          { session }
        );

        // Commit transaction - all operations succeeded
        await session.commitTransaction();
        console.log(
          `[Payment Transaction] Successfully committed payment for purchase ${referenceId}`
        );

        return res.status(201).json({
          success: true,
          message: "Payment recorded successfully",
          data: entry,
        });
      } catch (transactionError) {
        // Rollback transaction on any error
        await session.abortTransaction();
        console.error(
          `[Payment Transaction] Rolled back payment for purchase ${referenceId}:`,
          {
            message: transactionError.message,
            stack: transactionError.stack,
            name: transactionError.name,
            referenceId: referenceId,
            entryData: entryData
          }
        );

        // Handle version errors (optimistic locking conflicts)
        if (transactionError.name === "VersionError") {
          return res.status(409).json({
            success: false,
            message:
              "This purchase was modified by another user. Please refresh and try again.",
            error: "CONCURRENT_MODIFICATION",
          });
        }

        throw transactionError;
      } finally {
        session.endSession();
      }
    }

    // For non-dispatch order/purchase payments, create entry with transaction
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Update supplier balance for regular payments (if it's a supplier payment)
      if (
        entryData.type === "supplier" &&
        entryData.transactionType === "payment"
      ) {
        const paymentAmount = entryData.credit || 0;

        // Ensure paymentDetails is populated for the ledger entry
        if (!entryData.paymentDetails) {
          entryData.paymentDetails = {
            cashPayment: entryData.paymentMethod === "cash" ? paymentAmount : 0,
            bankPayment: entryData.paymentMethod === "bank" ? paymentAmount : 0,
            remainingBalance: 0, // We don't track total balance per DO here
          };
        }

        await Supplier.findByIdAndUpdate(
          entryData.entityId,
          { $inc: { currentBalance: -paymentAmount } },
          { session }
        );
      }

      const entry = await Ledger.createEntry(entryData, session);

      // Commit transaction
      await session.commitTransaction();
      console.log(
        "[Payment Transaction] Successfully committed regular payment"
      );

      res.status(201).json({
        success: true,
        message: "Ledger entry created successfully",
        data: entry,
      });
    } catch (transactionError) {
      await session.abortTransaction();
      console.error(
        "[Payment Transaction] Rolled back regular payment:",
        {
          message: transactionError.message,
          stack: transactionError.stack,
          name: transactionError.name,
          entryData: entryData
        }
      );
      throw transactionError;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Create ledger entry error:", {
      message: error.message,
      stack: error.stack,
      name: error.name,
      entryData: req.body,
      user: req.user?._id
    });
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
      error: process.env.NODE_ENV === 'development' ? {
        name: error.name,
        stack: error.stack
      } : undefined
    });
  }
});

router.get("/balance/:type/:id", auth, async (req, res) => {
  try {
    const balance = await Ledger.getBalance(req.params.type, req.params.id);

    res.json({
      success: true,
      data: { balance },
    });
  } catch (error) {
    console.error("Get balance error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// Get logistics company ledger
router.get("/logistics/:id", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { limit = 100, offset = 0 } = req.query;

    // Fetch ledger entries for this logistics company
    const entries = await Ledger.find({
      type: "logistics",
      entityId: id,
    })
      .sort({ date: -1, createdAt: -1 })
      .skip(parseInt(offset))
      .limit(parseInt(limit))
      .populate("createdBy", "name email");

    // Get current balance
    const balance = await Ledger.getBalance("logistics", id);

    res.json({
      success: true,
      data: {
        entries,
        balance,
        count: entries.length,
      },
    });
  } catch (error) {
    console.error("Get logistics ledger error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch logistics company ledger",
    });
  }
});

// Get all logistics ledger entries (optionally filtered by company)
router.get("/logistics", auth, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 100,
      logisticsCompanyId,
      startDate,
      endDate,
    } = req.query;

    const query = {
      type: "logistics",
    };

    // Filter by specific logistics company if provided
    if (logisticsCompanyId && logisticsCompanyId !== "all") {
      query.entityId = logisticsCompanyId;
    }

    // Debug logging
    console.log("Get all logistics ledgers query:", {
      logisticsCompanyId,
      query,
      page,
      limit,
    });

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    // Find entries
    let entries = await Ledger.find(query)
      .populate("createdBy", "name")
      .populate("entityId", "name rates") // Populate logistics company info and rates
      .lean() // Use lean for better performance
      .sort({ date: -1, createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    // Populate reference documents dynamically
    entries = await Promise.all(
      entries.map(async (entry) => {
        if (entry.referenceId && entry.referenceModel) {
          try {
            let refDoc;
            if (entry.referenceModel === "DispatchOrder") {
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber totalBoxes")
                .lean();
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  orderNumber: refDoc.orderNumber,
                  totalBoxes: refDoc.totalBoxes,
                };
            }
          } catch (err) {
            // If model doesn't exist or populate fails, continue without reference
            console.error("Error populating reference:", err);
          }
        }
        return entry;
      })
    );

    const total = await Ledger.countDocuments(query);

    // Calculate total balance for all logistics companies or specific company
    let totalBalance = 0;
    if (logisticsCompanyId && logisticsCompanyId !== "all") {
      totalBalance = await Ledger.getBalance("logistics", logisticsCompanyId);
    } else {
      // Get balance for all logistics companies
      const companyIds = await Ledger.distinct("entityId", {
        type: "logistics",
      });
      const balances = await Promise.all(
        companyIds.map((id) => Ledger.getBalance("logistics", id))
      );
      totalBalance = balances.reduce((sum, balance) => sum + (balance || 0), 0);
    }

    // Debug logging
    console.log("Get all logistics ledgers response:", {
      entriesCount: entries.length,
      total,
      totalBalance,
      logisticsCompanyId,
    });

    res.json({
      success: true,
      data: {
        entries,
        totalBalance,
        logisticsCount:
          logisticsCompanyId && logisticsCompanyId !== "all"
            ? 1
            : await Ledger.distinct("entityId", { type: "logistics" }).then(
              (ids) => ids.length
            ),
      },
      pagination: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: limit,
      },
    });
  } catch (error) {
    console.error("Get all logistics ledgers error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch logistics ledgers",
    });
  }
});

// =====================================================
// NEW ENDPOINTS - Universal Payment Distribution (SSOT)
// =====================================================

/**
 * POST /ledger/supplier/:id/distribute-payment
 * Distribute a bulk payment across pending orders for a supplier
 */
// router.post("/supplier/:id/distribute-payment", auth, async (req, res) => {
//   try {
//     const { amount, paymentMethod, date, description } = req.body;

//     if (!amount || amount <= 0) {
//       return res.status(400).json({
//         success: false,
//         message: "Amount must be greater than 0"
//       });
//     }

//     if (!paymentMethod || !['cash', 'bank'].includes(paymentMethod)) {
//       return res.status(400).json({
//         success: false,
//         message: "Payment method must be 'cash' or 'bank'"
//       });
//     }

//     const result = await BalanceService.distributeUniversalPayment({
//       supplierId: req.params.id,
//       amount: parseFloat(amount),
//       paymentMethod,
//       date: date ? new Date(date) : new Date(),
//       description,
//       createdBy: req.user._id,
//     });

//     res.json({
//       success: true,
//       message: `Payment distributed to ${result.distributions.length} orders`,
//       data: result
//     });
//   } catch (error) {
//     console.error("Distribute supplier payment error:", error);
//     res.status(500).json({
//       success: false,
//       message: error.message || "Failed to distribute payment"
//     });
//   }
// });


/**
 * POST /ledger/supplier/:id/distribute-payment
 * Distribute a bulk payment across pending orders for a supplier (FIFO)
 */
router.post("/supplier/:id/distribute-payment", auth, async (req, res) => {
  try {
    const { amount, paymentMethod, date, description } = req.body;

    // Verify supplier exists
    const supplierExists = await Supplier.findById(req.params.id);
    if (!supplierExists) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found'
      });
    }

    // Get current balance before payment
    const beforeSummary = await BalanceService.getSupplierBalanceSummary(req.params.id);

    // Distribute payment
    const result = await BalanceService.distributeUniversalPayment({
      supplierId: req.params.id,
      amount: parseFloat(amount),
      paymentMethod,
      date: date ? new Date(date) : new Date(),
      description,
      createdBy: req.user._id,
    });

    // Get updated balance
    const afterSummary = await BalanceService.getSupplierBalanceSummary(req.params.id);

    res.json({
      success: true,
      message: `Payment of €${amount.toFixed(2)} distributed successfully`,
      data: {
        payment: {
          amount: parseFloat(amount),
          method: paymentMethod,
          date: date || new Date()
        },
        distribution: {
          ordersAffected: result.distributions.length,
          fullyPaidOrders: result.distributions.filter(d => d.fullyPaid).length,
          distributedAmount: result.totalDistributed,
          advanceAmount: result.remainingCredit
        },
        balance: {
          before: beforeSummary.currentBalance,
          after: afterSummary.currentBalance,
          change: beforeSummary.currentBalance - afterSummary.currentBalance
        },
        distributions: result.distributions.map(d => ({
          orderReference: d.orderNumber,
          originalAmount: d.totalAmount || (d.previousRemaining + d.amountApplied),
          previouslyPaid: d.totalPaid || 0,
          currentPayment: d.amountApplied,
          remainingBalance: d.newRemaining,
          status: d.fullyPaid ? 'PAID' : d.isAdvance ? 'ADVANCE' : 'PARTIAL'
        }))
      }
    });

  } catch (error) {
    console.error("Distribute supplier payment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to distribute payment",
      ...(process.env.NODE_ENV === 'development' && {
        stack: error.stack
      })
    });
  }
}
);


/**
 * POST /ledger/supplier/:id/debit-adjustment
 * Create a manual debit adjustment for a supplier
 */
router.post("/supplier/:id/debit-adjustment", auth, async (req, res) => {
  try {
    const { amount, date, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0"
      });
    }

    const entry = await BalanceService.recordDebitAdjustment({
      supplierId: req.params.id,
      amount: parseFloat(amount),
      date: date ? new Date(date) : new Date(),
      description,
      createdBy: req.user._id
    });

    res.json({
      success: true,
      message: "Debit adjustment recorded",
      data: entry
    });
  } catch (error) {
    console.error("Record debit adjustment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to record adjustment"
    });
  }
});

/**
 * POST /ledger/logistics/:id/distribute-payment
 * Distribute a bulk payment across pending charges for a logistics company
 */
router.post("/logistics/:id/distribute-payment", auth, async (req, res) => {
  try {
    const { amount, paymentMethod, date, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0"
      });
    }

    if (!paymentMethod || !['cash', 'bank'].includes(paymentMethod)) {
      return res.status(400).json({
        success: false,
        message: "Payment method must be 'cash' or 'bank'"
      });
    }

    const result = await BalanceService.distributeLogisticsPayment({
      logisticsCompanyId: req.params.id,
      amount: parseFloat(amount),
      paymentMethod,
      date: date ? new Date(date) : new Date(),
      description,
      createdBy: req.user._id
    });

    res.json({
      success: true,
      message: `Payment distributed to ${result.distributions.length} orders`,
      data: result
    });
  } catch (error) {
    console.error("Distribute logistics payment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to distribute payment"
    });
  }
});

/**
 * POST /ledger/logistics/:id/debit-adjustment
 * Create a manual debit adjustment for a logistics company
 */
router.post("/logistics/:id/debit-adjustment", auth, async (req, res) => {
  try {
    const { amount, date, description } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Amount must be greater than 0"
      });
    }

    const entry = await BalanceService.recordLogisticsDebitAdjustment({
      logisticsCompanyId: req.params.id,
      amount: parseFloat(amount),
      date: date ? new Date(date) : new Date(),
      description,
      createdBy: req.user._id
    });

    res.json({
      success: true,
      message: "Debit adjustment recorded",
      data: entry
    });
  } catch (error) {
    console.error("Record logistics debit adjustment error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Failed to record adjustment"
    });
  }
});

module.exports = router;
