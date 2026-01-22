const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const app = express();

// Security middleware - Configure Helmet to work with CORS
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());

// Rate limiting - More lenient for development
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === "production" ? 200 : 1000, // Higher limit in dev, reasonable in prod
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/", limiter);

// CORS configuration - Allow multiple frontend origins
// Production origins (with and without www for safety)
const productionOrigins = [
  "https://crm-dashboard-redesign.vercel.app",
  "https://www.crm-dashboard-redesign.vercel.app",
  "https://supplier-portal.vercel.app",
  "https://www.supplier-portal.vercel.app",
  "https://distributor-portal.vercel.app",
  "https://www.distributor-portal.vercel.app",
  "https://kl-distributer-portal.vercel.app",
  "https://www.kl-distributer-portal.vercel.app",
  "https://kl-supplier-portal.vercel.app",
  "https://www.kl-supplier-portal.vercel.app",
  "https://ki-fashion-supplier-portal.vercel.app",
  "https://www.ki-fashion-supplier-portal.vercel.app",
  "https://ki-fashion-admin-panel.vercel.app",
  "https://www.ki-fashion-admin-panel.vercel.app",
];

// Development/localhost origins (always allowed for local testing)
const localhostOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:3002",
];

// Combine all allowed origins
const defaultOrigins = [...productionOrigins, ...localhostOrigins];

// Always include localhost origins for development, even if ALLOWED_ORIGINS is set
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? [
      ...process.env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()),
      ...localhostOrigins,
    ]
  : defaultOrigins;

// Remove duplicates
const uniqueOrigins = [...new Set(allowedOrigins)];

app.use(
  cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (like mobile apps, Postman, etc.)
      // This is useful for mobile apps and API testing tools
      if (!origin) {
        return callback(null, true);
      }

      // Check if origin is in allowed list
      if (uniqueOrigins.indexOf(origin) !== -1) {
        console.log("CORS allowed origin:", origin);
        return callback(null, true);
      } else {
        console.error("CORS blocked origin:", origin);
        console.error("Allowed origins:", uniqueOrigins);
        // Reject the request
        return callback(new Error("Not allowed by CORS"), false);
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    exposedHeaders: ["Content-Length", "Content-Type"],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 86400, // 24 hours
  })
);

// Explicitly handle OPTIONS requests for all routes
app.options("*", cors());

// Body parsing middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Serve invoice PDFs
const path = require("path");
const invoicesDir = path.join(__dirname, "invoices");
app.use("/invoices", express.static(invoicesDir));

// Database connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected successfully"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/users", require("./routes/users"));
app.use(
  "/api/password-reset-requests",
  require("./routes/passwordResetRequests")
);
app.use("/api/suppliers", require("./routes/suppliers"));
app.use("/api/buyers", require("./routes/buyers"));
app.use("/api/products", require("./routes/products"));
app.use("/api/product-types", require("./routes/productTypes"));
app.use("/api/purchases", require("./routes/purchases"));
app.use("/api/sales", require("./routes/sales"));
app.use("/api/inventory", require("./routes/inventory"));
app.use("/api/delivery-personnel", require("./routes/deliveryPersonnel"));
app.use("/api/cost-types", require("./routes/costTypes"));
app.use("/api/expenses", require("./routes/expenses"));
app.use("/api/reports", require("./routes/reports"));

// New routes for supplier portal
app.use("/api/logistics-companies", require("./routes/logisticsCompanies"));
app.use("/api/dispatch-orders", require("./routes/dispatchOrders"));
app.use("/api/returns", require("./routes/returns"));
app.use("/api/packet-templates", require("./routes/packetTemplates"));
app.use("/api/packet-stock", require("./routes/packetStock"));

app.use("/api/ledger", require("./routes/ledger"));
app.use("/api/balances", require("./routes/balances"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/sale-returns", require("./routes/saleReturns"));
app.use("/api/images", require("./routes/images"));
app.use("/api/logistics-payables", require("./routes/logisticsPayables"));
app.use("/api/cash-tracking", require("./routes/cashTracking"));
app.use("/api/stock-sync", require("./routes/stockSync"));

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: "Something went wrong!",
    error: process.env.NODE_ENV === "development" ? err.message : {},
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`CORS enabled for ${uniqueOrigins.length} origins`);
  console.log("Allowed origins:", uniqueOrigins);
});

module.exports = app;
