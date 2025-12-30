const express = require("express");
const mongoose = require("mongoose");

const Ledger = require("../models/Ledger");
const DispatchOrder = require("../models/DispatchOrder");
const Supplier = require("../models/Supplier");
const Buyer = require("../models/Buyer");
const auth = require("../middleware/auth");

const router = express.Router();

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
    const DispatchOrder = require("../models/DispatchOrder");
    entries = await Promise.all(
      entries.map(async (entry) => {
        if (entry.referenceId && entry.referenceModel) {
          try {
            let refDoc;
            if (entry.referenceModel === "DispatchOrder") {
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities")
                .lean();
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  orderNumber: refDoc.orderNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                };
            } else if (entry.referenceModel === "Purchase") {
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities")
                .lean();
              if (refDoc) {
                refDoc.purchaseNumber = refDoc.orderNumber;
                entry.referenceId = {
                  _id: refDoc._id,
                  purchaseNumber: refDoc.purchaseNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
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
    const balance = await Ledger.getBalance("supplier", req.params.id);

    // Calculate total cash and bank payments for the supplier
    const allPayments = await Ledger.find({
      type: "supplier",
      entityId: req.params.id,
      transactionType: "payment",
    })
      .select("paymentDetails paymentMethod credit")
      .lean();

    const totalCashPayment = allPayments.reduce((sum, p) => {
      // Priority 1: Check paymentDetails (set by DispatchOrder specific payment logic)
      if (p.paymentDetails?.cashPayment)
        return sum + p.paymentDetails.cashPayment;
      // Priority 2: Check top-level paymentMethod and credit (set by general SupplierPaymentModal)
      if (p.paymentMethod === "cash") return sum + (p.credit || 0);
      return sum;
    }, 0);

    const totalBankPayment = allPayments.reduce((sum, p) => {
      // Priority 1: Check paymentDetails
      if (p.paymentDetails?.bankPayment)
        return sum + p.paymentDetails.bankPayment;
      // Priority 2: Check top-level paymentMethod and credit
      if (p.paymentMethod === "bank") return sum + (p.credit || 0);
      return sum;
    }, 0);

    // Calculate totals from dispatch orders (same calculation as CRM)
    // Must calculate based on CURRENT confirmed quantities (after returns)
    // IMPORTANT: Use outstandingBalance from ledger entries (stored by CRM) for accuracy
    const confirmedOrders = await DispatchOrder.find({
      supplier: req.params.id,
      status: "confirmed",
    })
      .select(
        "items confirmedQuantities returnedItems paymentDetails totalDiscount supplierPaymentTotal"
      )
      .lean();

    // Calculate outstanding balance from ledger entries (stored by CRM when payments are made)
    // This ensures consistency with CRM's calculation
    let totalOutstandingBalance = allPayments.reduce((sum, p) => {
      return sum + (p.paymentDetails?.outstandingBalance || 0);
    }, 0);

    // Calculate remaining balance dynamically (same as CRM calculation)
    // For each order: remaining = totalAmountOwed - totalPaid
    // Only positive values (admin owes supplier)
    let totalRemainingBalance = 0;

    for (const order of confirmedOrders) {
      // Calculate supplier payment based on CURRENT confirmed quantities (after returns)
      let currentOrderValue = 0;
      let originalOrderValue = 0;

      if (order.items && order.items.length > 0) {
        order.items.forEach((item, index) => {
          const costPrice = item.costPrice || 0;
          const originalQty = item.quantity || 0;
          originalOrderValue += costPrice * originalQty;

          const confirmedQtyObj = order.confirmedQuantities?.find(
            (cq) => cq.itemIndex === index
          );
          const confirmedQty = confirmedQtyObj?.quantity ?? item.quantity;
          currentOrderValue += costPrice * confirmedQty;
        });
      } else {
        currentOrderValue = order.supplierPaymentTotal || 0;
        originalOrderValue = currentOrderValue;
      }

      // Calculate proportional discount if items were returned
      let discount = 0;
      const originalDiscount = order.totalDiscount || 0;

      if (originalOrderValue > 0 && currentOrderValue !== originalOrderValue) {
        const discountPercentage = originalDiscount / originalOrderValue;
        discount = currentOrderValue * discountPercentage;
      } else {
        discount = originalDiscount;
      }

      const totalAmountOwed = Math.max(0, currentOrderValue - discount);

      // Get total paid from ledger entries (most accurate, includes all payments)
      const totalPaid = await calculateDispatchOrderPayments(
        order._id,
        req.params.id
      );

      // Calculate remaining: positive = admin owes supplier
      const remaining = totalAmountOwed - totalPaid;

      if (remaining > 0) {
        totalRemainingBalance += remaining;
      }
    }

    res.json({
      success: true,
      data: {
        entries,
        currentBalance: balance,
        totalBalance: balance,
        totalCashPayment,
        totalBankPayment,
        totalRemainingBalance,
        totalOutstandingBalance,
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
                .select("orderNumber items confirmedQuantities")
                .lean();
              if (refDoc)
                entry.referenceId = {
                  _id: refDoc._id,
                  orderNumber: refDoc.orderNumber,
                  items: refDoc.items,
                  confirmedQuantities: refDoc.confirmedQuantities,
                };
            } else if (entry.referenceModel === "Purchase") {
              // Legacy Purchase references - now use DispatchOrder (manual entries have supplierUser: null)
              refDoc = await DispatchOrder.findById(entry.referenceId)
                .select("orderNumber items confirmedQuantities")
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

    // Calculate total balance for all suppliers or specific supplier
    let totalBalance = 0;
    if (supplierId && supplierId !== "all") {
      totalBalance = await Ledger.getBalance("supplier", supplierId);
    } else {
      // Get balance for all suppliers - get the latest balance entry for each supplier
      const supplierIds = await Ledger.distinct("entityId", {
        type: "supplier",
      });
      const balances = await Promise.all(
        supplierIds.map((id) => Ledger.getBalance("supplier", id))
      );
      totalBalance = balances.reduce((sum, balance) => sum + (balance || 0), 0);
    }

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

    // Handle dispatch order payments
    if (
      entryData.referenceModel === "DispatchOrder" &&
      entryData.transactionType === "payment"
    ) {
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

      // Calculate remaining balance after this payment
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
        const entry = await Ledger.createEntry(entryData);

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
          transactionError
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
        const entry = await Ledger.createEntry(entryData);

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
          transactionError
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

      const entry = await Ledger.createEntry(entryData);

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
        transactionError
      );
      throw transactionError;
    } finally {
      session.endSession();
    }
  } catch (error) {
    console.error("Create ledger entry error:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Server error",
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
      .populate("entityId", "name") // Populate logistics company info
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

module.exports = router;
