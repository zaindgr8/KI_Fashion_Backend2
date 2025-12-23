const express = require('express');
const Sale = require('../models/Sale');
const DispatchOrder = require('../models/DispatchOrder');
const Expense = require('../models/Expense');
const Inventory = require('../models/Inventory');
const Product = require('../models/Product');
const Supplier = require('../models/Supplier');
const Buyer = require('../models/Buyer');
const auth = require('../middleware/auth');

const router = express.Router();

// Sales Report
router.get('/sales', auth, async (req, res) => {
  try {
    const { startDate, endDate, groupBy = 'day', saleType, buyer } = req.query;

    const matchConditions = { deliveryStatus: 'delivered' };

    if (startDate || endDate) {
      matchConditions.saleDate = {};
      if (startDate) matchConditions.saleDate.$gte = new Date(startDate);
      if (endDate) matchConditions.saleDate.$lte = new Date(endDate);
    }

    if (saleType) matchConditions.saleType = saleType;
    if (buyer) matchConditions.buyer = buyer;

    // Group by date format
    let dateFormat = '%Y-%m-%d';
    if (groupBy === 'week') dateFormat = '%Y-%U';
    if (groupBy === 'month') dateFormat = '%Y-%m';
    if (groupBy === 'year') dateFormat = '%Y';

    const salesData = await Sale.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: { $dateToString: { format: dateFormat, date: '$saleDate' } },
          totalSales: { $sum: '$grandTotal' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$grandTotal' },
          totalProfit: { $sum: { $subtract: ['$grandTotal', { $multiply: ['$subtotal', 0.7] }] } }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Top selling products
    const topProducts = await Sale.aggregate([
      { $match: matchConditions },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalQuantity: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.totalPrice' }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $project: {
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          totalQuantity: 1,
          totalRevenue: 1
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 10 }
    ]);

    // Sales by customer type
    const salesByCustomerType = await Sale.aggregate([
      { $match: matchConditions },
      {
        $lookup: {
          from: 'buyers',
          localField: 'buyer',
          foreignField: '_id',
          as: 'buyerInfo'
        }
      },
      { $unwind: '$buyerInfo' },
      {
        $group: {
          _id: '$buyerInfo.customerType',
          totalSales: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    // Summary
    const summary = await Sale.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$grandTotal' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$grandTotal' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        summary: summary[0] || { totalRevenue: 0, totalOrders: 0, averageOrderValue: 0 },
        salesData,
        topProducts,
        salesByCustomerType
      }
    });

  } catch (error) {
    console.error('Sales report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Purchase Report
router.get('/purchases', auth, async (req, res) => {
  try {
    const { startDate, endDate, supplier, deliveryStatus } = req.query;

    const matchConditions = { supplierUser: null, status: 'confirmed' }; // Manual entries only

    if (startDate || endDate) {
      matchConditions.dispatchDate = {};
      if (startDate) matchConditions.dispatchDate.$gte = new Date(startDate);
      if (endDate) matchConditions.dispatchDate.$lte = new Date(endDate);
    }

    if (supplier) matchConditions.supplier = supplier;
    if (deliveryStatus) {
      matchConditions.status = deliveryStatus === 'delivered' ? 'confirmed' : deliveryStatus;
    }

    const purchasesData = await DispatchOrder.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$dispatchDate' } },
          totalPurchases: { $sum: '$grandTotal' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$grandTotal' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Top suppliers
    const topSuppliers = await DispatchOrder.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$supplier',
          totalAmount: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      },
      {
        $lookup: {
          from: 'suppliers',
          localField: '_id',
          foreignField: '_id',
          as: 'supplierInfo'
        }
      },
      { $unwind: '$supplierInfo' },
      {
        $project: {
          supplierName: '$supplierInfo.name',
          company: '$supplierInfo.company',
          totalAmount: 1,
          orderCount: 1
        }
      },
      { $sort: { totalAmount: -1 } },
      { $limit: 10 }
    ]);

    // Purchase by status
    const purchasesByStatus = await DispatchOrder.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: '$grandTotal' }
        }
      }
    ]);

    // Summary
    const summary = await DispatchOrder.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$grandTotal' },
          totalOrders: { $sum: 1 },
          averageOrderValue: { $avg: '$grandTotal' }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        summary: summary[0] || { totalAmount: 0, totalOrders: 0, averageOrderValue: 0 },
        purchasesData,
        topSuppliers,
        purchasesByStatus
      }
    });

  } catch (error) {
    console.error('Purchase report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Financial Report
router.get('/financial', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const dateCondition = {};
    if (startDate || endDate) {
      if (startDate) dateCondition.$gte = new Date(startDate);
      if (endDate) dateCondition.$lte = new Date(endDate);
    }

    // Revenue from sales
    const revenueData = await Sale.aggregate([
      {
        $match: {
          deliveryStatus: 'delivered',
          ...(Object.keys(dateCondition).length > 0 && { saleDate: dateCondition })
        }
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: '$grandTotal' },
          totalTax: { $sum: '$totalTax' },
          totalDiscount: { $sum: '$totalDiscount' }
        }
      }
    ]);

    // Expenses
    const expenseData = await Expense.aggregate([
      {
        $match: {
          status: 'approved',
          ...(Object.keys(dateCondition).length > 0 && { expenseDate: dateCondition })
        }
      },
      {
        $lookup: {
          from: 'costtypes',
          localField: 'costType',
          foreignField: '_id',
          as: 'costTypeInfo'
        }
      },
      { $unwind: '$costTypeInfo' },
      {
        $group: {
          _id: '$costTypeInfo.category',
          totalAmount: { $sum: { $add: ['$amount', '$taxAmount'] } },
          count: { $sum: 1 }
        }
      }
    ]);

    // Purchase costs (manual entries only)
    const purchaseCosts = await DispatchOrder.aggregate([
      {
        $match: {
          supplierUser: null,
          status: 'confirmed',
          ...(Object.keys(dateCondition).length > 0 && { dispatchDate: dateCondition })
        }
      },
      {
        $group: {
          _id: null,
          totalCost: { $sum: '$grandTotal' }
        }
      }
    ]);

    // Monthly financial trend
    const monthlyTrend = await Sale.aggregate([
      {
        $match: {
          deliveryStatus: 'delivered',
          ...(Object.keys(dateCondition).length > 0 && { saleDate: dateCondition })
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$saleDate' } },
          revenue: { $sum: '$grandTotal' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Add expense data to monthly trend
    const monthlyExpenses = await Expense.aggregate([
      {
        $match: {
          status: 'approved',
          ...(Object.keys(dateCondition).length > 0 && { expenseDate: dateCondition })
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$expenseDate' } },
          expenses: { $sum: { $add: ['$amount', '$taxAmount'] } }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Combine revenue and expenses
    const financialTrend = monthlyTrend.map(month => {
      const expenseMonth = monthlyExpenses.find(exp => exp._id === month._id);
      const expenses = expenseMonth ? expenseMonth.expenses : 0;
      return {
        month: month._id,
        revenue: month.revenue,
        expenses: expenses,
        profit: month.revenue - expenses
      };
    });

    const totalRevenue = revenueData[0]?.totalRevenue || 0;
    const totalExpenses = expenseData.reduce((sum, exp) => sum + exp.totalAmount, 0);
    const totalPurchaseCosts = purchaseCosts[0]?.totalCost || 0;
    const netProfit = totalRevenue - totalExpenses - totalPurchaseCosts;

    res.json({
      success: true,
      data: {
        summary: {
          totalRevenue,
          totalExpenses,
          totalPurchaseCosts,
          netProfit,
          profitMargin: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(2) : 0
        },
        revenue: revenueData[0] || { totalRevenue: 0, totalTax: 0, totalDiscount: 0 },
        expensesByCategory: expenseData,
        financialTrend
      }
    });

  } catch (error) {
    console.error('Financial report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Inventory Report
router.get('/inventory', auth, async (req, res) => {
  try {
    // Current stock levels
    const stockLevels = await Inventory.aggregate([
      { $match: { isActive: true } },
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
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          category: '$productInfo.category',
          currentStock: 1,
          reorderLevel: 1,
          totalValue: 1,
          needsReorder: { $lte: ['$currentStock', '$reorderLevel'] }
        }
      }
    ]);

    // Low stock items
    const lowStockItems = stockLevels.filter(item => item.needsReorder);

    // Stock by category
    const stockByCategory = await Inventory.aggregate([
      { $match: { isActive: true } },
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
        $group: {
          _id: '$productInfo.category',
          totalItems: { $sum: 1 },
          totalValue: { $sum: '$totalValue' },
          totalStock: { $sum: '$currentStock' }
        }
      },
      { $sort: { totalValue: -1 } }
    ]);

    // Inventory turnover (simplified calculation)
    const turnoverData = await Sale.aggregate([
      {
        $match: {
          deliveryStatus: 'delivered',
          saleDate: { $gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) } // Last year
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalSold: { $sum: '$items.quantity' },
          totalRevenue: { $sum: '$items.totalPrice' }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $lookup: {
          from: 'inventories',
          localField: '_id',
          foreignField: 'product',
          as: 'inventoryInfo'
        }
      },
      { $unwind: '$inventoryInfo' },
      {
        $project: {
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          totalSold: 1,
          currentStock: '$inventoryInfo.currentStock',
          turnoverRate: {
            $cond: {
              if: { $gt: ['$inventoryInfo.currentStock', 0] },
              then: { $divide: ['$totalSold', '$inventoryInfo.currentStock'] },
              else: 0
            }
          }
        }
      },
      { $sort: { turnoverRate: -1 } },
      { $limit: 20 }
    ]);

    // Summary
    const totalInventoryValue = stockLevels.reduce((sum, item) => sum + item.totalValue, 0);
    const totalItems = stockLevels.length;
    const lowStockCount = lowStockItems.length;

    res.json({
      success: true,
      data: {
        summary: {
          totalItems,
          totalInventoryValue,
          lowStockCount,
          lowStockPercentage: totalItems > 0 ? ((lowStockCount / totalItems) * 100).toFixed(2) : 0
        },
        stockLevels: stockLevels.slice(0, 50), // Limit to 50 items
        lowStockItems,
        stockByCategory,
        turnoverData
      }
    });

  } catch (error) {
    console.error('Inventory report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Supplier Performance Report
router.get('/suppliers', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchConditions = { supplierUser: null, status: 'confirmed' }; // Manual entries only
    if (startDate || endDate) {
      matchConditions.dispatchDate = {};
      if (startDate) matchConditions.dispatchDate.$gte = new Date(startDate);
      if (endDate) matchConditions.dispatchDate.$lte = new Date(endDate);
    }

    const supplierPerformance = await DispatchOrder.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$supplier',
          totalOrders: { $sum: 1 },
          totalAmount: { $sum: '$grandTotal' },
          averageOrderValue: { $avg: '$grandTotal' },
          onTimeDeliveries: {
            $sum: {
              $cond: [
                { $lte: ['$actualDeliveryDate', '$expectedDeliveryDate'] },
                1,
                0
              ]
            }
          },
          deliveredOrders: {
            $sum: {
              $cond: [{ $eq: ['$status', 'confirmed'] }, 1, 0]
            }
          }
        }
      },
      {
        $lookup: {
          from: 'suppliers',
          localField: '_id',
          foreignField: '_id',
          as: 'supplierInfo'
        }
      },
      { $unwind: '$supplierInfo' },
      {
        $project: {
          supplierName: '$supplierInfo.name',
          company: '$supplierInfo.company',
          rating: '$supplierInfo.rating',
          totalOrders: 1,
          totalAmount: 1,
          averageOrderValue: 1,
          onTimeDeliveryRate: {
            $cond: {
              if: { $gt: ['$deliveredOrders', 0] },
              then: { $multiply: [{ $divide: ['$onTimeDeliveries', '$deliveredOrders'] }, 100] },
              else: 0
            }
          },
          deliveryRate: {
            $cond: {
              if: { $gt: ['$totalOrders', 0] },
              then: { $multiply: [{ $divide: ['$deliveredOrders', '$totalOrders'] }, 100] },
              else: 0
            }
          }
        }
      },
      { $sort: { totalAmount: -1 } }
    ]);

    res.json({
      success: true,
      data: supplierPerformance
    });

  } catch (error) {
    console.error('Supplier performance report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Customer Analysis Report
router.get('/customers', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const matchConditions = { deliveryStatus: 'delivered' };
    if (startDate || endDate) {
      matchConditions.saleDate = {};
      if (startDate) matchConditions.saleDate.$gte = new Date(startDate);
      if (endDate) matchConditions.saleDate.$lte = new Date(endDate);
    }

    const customerAnalysis = await Sale.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$buyer',
          totalOrders: { $sum: 1 },
          totalSales: { $sum: '$grandTotal' },
          totalPaid: {
            $sum: {
              $cond: [
                { $eq: ['$paymentStatus', 'paid'] },
                '$grandTotal',
                0
              ]
            }
          },
          averageOrderValue: { $avg: '$grandTotal' },
          lastOrderDate: { $max: '$saleDate' }
        }
      },
      {
        $lookup: {
          from: 'buyers',
          localField: '_id',
          foreignField: '_id',
          as: 'buyerInfo'
        }
      },
      { $unwind: '$buyerInfo' },
      {
        $project: {
          id: '$_id',
          name: '$buyerInfo.name',
          company: '$buyerInfo.company',
          customerType: '$buyerInfo.customerType',
          totalSales: 1,
          totalOrders: 1,
          amountGiven: '$totalPaid',
          ledgerBalance: { $subtract: ['$totalSales', '$totalPaid'] },
          lastPurchaseDate: '$lastOrderDate',
          averageOrderValue: 1,
          status: {
            $cond: [
              { $lte: [{ $divide: [{ $subtract: [new Date(), '$lastOrderDate'] }, 1000 * 60 * 60 * 24] }, 30] },
              'active',
              'inactive'
            ]
          }
        }
      },
      { $sort: { totalSales: -1 } }
    ]);

    // Customer segmentation
    const segmentation = await Sale.aggregate([
      { $match: matchConditions },
      {
        $group: {
          _id: '$buyer',
          totalSpent: { $sum: '$grandTotal' }
        }
      },
      {
        $bucket: {
          groupBy: '$totalSpent',
          boundaries: [0, 1000, 5000, 10000, 50000, Infinity],
          default: 'Other',
          output: {
            count: { $sum: 1 },
            totalRevenue: { $sum: '$totalSpent' }
          }
        }
      }
    ]);

    const activeCustomers = customerAnalysis.filter(c => c.status === 'active');
    const totalActiveCustomers = activeCustomers.length;

    res.json({
      success: true,
      data: {
        activeCustomers,
        totalActiveCustomers,
        allCustomers: customerAnalysis,
        segmentation
      }
    });

  } catch (error) {
    console.error('Customer analysis report error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

// Dashboard Summary
router.get('/dashboard', auth, async (req, res) => {
  try {
    const today = new Date();
    const startOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const startOfYear = new Date(today.getFullYear(), 0, 1);

    const todaySales = await Sale.aggregate([
      {
        $match: {
          saleDate: {
            $gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
            $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
          }
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const weeklySales = await Sale.aggregate([
      {
        $match: {
          saleDate: { $gte: startOfWeek },
          deliveryStatus: 'delivered'
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const monthlySales = await Sale.aggregate([
      {
        $match: {
          saleDate: { $gte: startOfMonth },
          deliveryStatus: 'delivered'
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const yearlySales = await Sale.aggregate([
      {
        $match: {
          saleDate: { $gte: startOfYear },
          deliveryStatus: 'delivered'
        }
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const todayPurchases = await DispatchOrder.aggregate([
      {
        $match: {
          supplierUser: null,
          status: 'confirmed',
          dispatchDate: {
            $gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
            $lt: new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1)
          }
        }
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const weeklyPurchases = await DispatchOrder.aggregate([
      {
        $match: {
          supplierUser: null,
          status: 'confirmed',
          dispatchDate: { $gte: startOfWeek }
        }
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const monthlyPurchases = await DispatchOrder.aggregate([
      {
        $match: {
          supplierUser: null,
          status: 'confirmed',
          dispatchDate: { $gte: startOfMonth }
        }
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    const yearlyPurchases = await DispatchOrder.aggregate([
      {
        $match: {
          supplierUser: null,
          status: 'confirmed',
          dispatchDate: { $gte: startOfYear }
        }
      },
      {
        $group: {
          _id: null,
          totalPurchases: { $sum: '$grandTotal' },
          orderCount: { $sum: 1 }
        }
      }
    ]);

    // Low stock count
    const lowStockCount = await Inventory.countDocuments({
      isActive: true,
      needsReorder: true
    });

    // Pending orders
    const pendingOrders = await Sale.countDocuments({
      deliveryStatus: { $in: ['pending', 'processing'] }
    });

    // Top selling products this month
    const topProducts = await Sale.aggregate([
      {
        $match: {
          saleDate: { $gte: startOfMonth },
          deliveryStatus: 'delivered'
        }
      },
      { $unwind: '$items' },
      {
        $group: {
          _id: '$items.product',
          totalQuantity: { $sum: '$items.quantity' }
        }
      },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productInfo'
        }
      },
      { $unwind: '$productInfo' },
      {
        $project: {
          name: '$productInfo.name',
          sku: '$productInfo.sku',
          totalQuantity: 1
        }
      },
      { $sort: { totalQuantity: -1 } },
      { $limit: 5 }
    ]);

    // Recent activities (last 10 sales)
    const recentSales = await Sale.find()
      .populate('buyer', 'name')
      .select('saleNumber buyer grandTotal saleDate')
      .sort({ createdAt: -1 })
      .limit(10);

    res.json({
      success: true,
      data: {
        totalSales: {
          today: todaySales[0]?.totalSales || 0,
          thisWeek: weeklySales[0]?.totalSales || 0,
          thisMonth: monthlySales[0]?.totalSales || 0,
          thisYear: yearlySales[0]?.totalSales || 0
        },
        totalPurchases: {
          today: todayPurchases[0]?.totalPurchases || 0,
          thisWeek: weeklyPurchases[0]?.totalPurchases || 0,
          thisMonth: monthlyPurchases[0]?.totalPurchases || 0,
          thisYear: yearlyPurchases[0]?.totalPurchases || 0
        },
        netProfit: (yearlySales[0]?.totalSales || 0) - (yearlyPurchases[0]?.totalPurchases || 0),
        lowStockCount,
        pendingOrders,
        topProducts,
        recentSales
      }
    });

  } catch (error) {
    console.error('Dashboard summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

router.get('/stock-summary', auth, async (req, res) => {
  try {
    const stockData = await Inventory.aggregate([
      { $match: { isActive: true } },
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
          productCode: '$productInfo.productCode',
          productName: '$productInfo.name',
          sku: '$productInfo.sku',
          stockInHand: '$currentStock',
          value: { $multiply: ['$currentStock', '$averageCostPrice'] },
          averageCostPrice: 1,
          reorderLevel: 1,
          needsReorder: 1
        }
      },
      { $sort: { stockInHand: -1 } }
    ]);

    const summary = await Inventory.aggregate([
      { $match: { isActive: true } },
      {
        $group: {
          _id: null,
          totalStockValue: { $sum: '$totalValue' },
          totalItems: { $sum: 1 },
          lowStockItems: {
            $sum: {
              $cond: [{ $eq: ['$needsReorder', true] }, 1, 0]
            }
          }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        totalStockValue: summary[0]?.totalStockValue || 0,
        totalItems: summary[0]?.totalItems || 0,
        lowStockItems: summary[0]?.lowStockItems || 0,
        products: stockData
      }
    });
  } catch (error) {
    console.error('Stock summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Server error'
    });
  }
});

module.exports = router;