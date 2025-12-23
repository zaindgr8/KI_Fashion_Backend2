# ERP Backend System

A comprehensive Enterprise Resource Planning (ERP) backend system built with Node.js, Express, and MongoDB.

## Features

### Core Modules
- **User Management & Authentication** - User roles, permissions, JWT authentication
- **Supplier Management** - Supplier profiles, payment terms, ratings
- **Buyer/Customer Management** - Customer types (retail/wholesale/distributor)
- **Product Management** - Product catalog, SKUs, pricing, categories
- **Product Types** - Dynamic product categorization with attributes
- **Delivery Personnel** - Delivery staff management with performance tracking
- **Expense Management** - Cost tracking with customizable cost type IDs (A1-meals, etc.)
- **Purchase Management** - Purchase orders, supplier relationships
- **Sales Management** - Sales orders, bulk sales, customer relationships
- **Inventory Management** - Stock tracking, movements, reorder levels
- **Comprehensive Reports** - Sales, financial, inventory, supplier performance

### Key Features
- **Cost Type System** - Configurable expense categories (A1=meals, B1=marketing, etc.)
- **Bulk Sales** - Handle multiple sales transactions efficiently
- **Inventory Tracking** - Real-time stock levels, low stock alerts
- **Multi-level Authentication** - Role-based access control
- **Comprehensive Reporting** - Dashboard, financial reports, performance analytics
- **Stock Operations** - Add, reduce, adjust, transfer stock with full audit trail
- **Payment Tracking** - Multiple payment methods and status tracking

## Technology Stack

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB with Mongoose ODM
- **Authentication:** JWT (JSON Web Tokens)
- **Validation:** Joi
- **Security:** Helmet, CORS, Rate Limiting
- **Password Hashing:** bcryptjs

## Installation

1. Clone the repository:
```bash
unzip zip
cd backendupdated
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Update the `.env` file with your configuration:
```env
PORT=5000
MONGODB_URI=mongodb://localhost:27017/erp_database
JWT_SECRET=your_jwt_secret_key_here
NODE_ENV=development
```

4. Start the server:
```bash
# Development
npm run dev

# Production
npm start
```

## API Endpoints

### Authentication
- `POST /api/auth/register` - Register new user
- `POST /api/auth/login` - User login
- `GET /api/auth/me` - Get current user
- `POST /api/auth/refresh` - Refresh token

### User Management
- `GET /api/users` - Get all users
- `GET /api/users/:id` - Get user by ID
- `PUT /api/users/:id` - Update user
- `PATCH /api/users/:id/deactivate` - Deactivate user

### Suppliers
- `POST /api/suppliers` - Create supplier
- `GET /api/suppliers` - Get all suppliers
- `GET /api/suppliers/:id` - Get supplier by ID
- `PUT /api/suppliers/:id` - Update supplier
- `PATCH /api/suppliers/:id/balance` - Update supplier balance

### Buyers/Customers
- `POST /api/buyers` - Create buyer
- `GET /api/buyers` - Get all buyers
- `GET /api/buyers/:id` - Get buyer by ID
- `PUT /api/buyers/:id` - Update buyer
- `PATCH /api/buyers/:id/balance` - Update buyer balance

### Products
- `POST /api/products` - Create product
- `GET /api/products` - Get all products
- `GET /api/products/:id` - Get product by ID
- `PUT /api/products/:id` - Update product
- `GET /api/products/reports/low-stock` - Get low stock products

### Product Types
- `POST /api/product-types` - Create product type
- `GET /api/product-types` - Get all product types
- `GET /api/product-types/:id` - Get product type by ID
- `PUT /api/product-types/:id` - Update product type

### Delivery Personnel
- `POST /api/delivery-personnel` - Create delivery personnel
- `GET /api/delivery-personnel` - Get all delivery personnel
- `GET /api/delivery-personnel/:id` - Get delivery personnel by ID
- `PUT /api/delivery-personnel/:id` - Update delivery personnel
- `PATCH /api/delivery-personnel/:id/stats` - Update delivery statistics

### Cost Types
- `POST /api/cost-types` - Create cost type (e.g., A1=meals)
- `GET /api/cost-types` - Get all cost types
- `GET /api/cost-types/:id` - Get cost type by ID
- `PUT /api/cost-types/:id` - Update cost type

### Expenses
- `POST /api/expenses` - Create expense
- `GET /api/expenses` - Get all expenses
- `GET /api/expenses/:id` - Get expense by ID
- `PUT /api/expenses/:id` - Update expense
- `PATCH /api/expenses/:id/approve` - Approve expense
- `PATCH /api/expenses/:id/reject` - Reject expense
- `GET /api/expenses/reports/summary` - Get expense summary

### Purchases
- `POST /api/purchases` - Create purchase order
- `GET /api/purchases` - Get all purchases
- `GET /api/purchases/:id` - Get purchase by ID
- `PUT /api/purchases/:id` - Update purchase
- `PATCH /api/purchases/:id/delivered` - Mark as delivered (updates inventory)
- `PATCH /api/purchases/:id/payment` - Update payment status

### Sales
- `POST /api/sales` - Create sale
- `POST /api/sales/bulk` - Create bulk sales
- `GET /api/sales` - Get all sales
- `GET /api/sales/:id` - Get sale by ID
- `PUT /api/sales/:id` - Update sale
- `PATCH /api/sales/:id/delivered` - Mark as delivered (updates inventory)
- `PATCH /api/sales/:id/payment` - Update payment status

### Inventory
- `GET /api/inventory` - Get all inventory
- `GET /api/inventory/product/:productId` - Get inventory by product
- `POST /api/inventory/add-stock` - Add stock
- `POST /api/inventory/reduce-stock` - Reduce stock
- `POST /api/inventory/adjust-stock` - Adjust stock levels
- `POST /api/inventory/transfer-stock` - Transfer between products
- `GET /api/inventory/movements/:productId` - Get stock movements
- `GET /api/inventory/reports/low-stock` - Low stock report
- `GET /api/inventory/reports/valuation` - Inventory valuation

### Reports
- `GET /api/reports/sales` - Sales reports
- `GET /api/reports/purchases` - Purchase reports
- `GET /api/reports/financial` - Financial reports
- `GET /api/reports/inventory` - Inventory reports
- `GET /api/reports/suppliers` - Supplier performance
- `GET /api/reports/customers` - Customer analysis
- `GET /api/reports/dashboard` - Dashboard summary

## Data Models

### User Roles
- `admin` - Full system access
- `manager` - Management level access
- `employee` - Limited access based on permissions
- `accountant` - Financial data access

### Cost Type System
Pre-configured cost types for expense management:
- `A1` - Meals & Food
- `A2` - Office Supplies
- `A3` - Utilities - Electricity
- `B1` - Marketing & Advertising
- `C1` - Rent
- `D1` - Packaging Materials
- `E1` - Staff Training
- And more...

### Customer Types
- `retail` - Individual customers
- `wholesale` - Bulk buyers
- `distributor` - Distribution partners

### Sale Types
- `retail` - Regular retail sales
- `wholesale` - Wholesale transactions
- `bulk` - Bulk/batch sales

## Usage Examples

### Creating a Cost Type
```bash
POST /api/cost-types
{
  "id": "A1",
  "name": "Meals & Food",
  "description": "Employee meals and food expenses",
  "category": "operational"
}
```

### Adding Stock
```bash
POST /api/inventory/add-stock
{
  "product": "product_id",
  "quantity": 100,
  "reference": "Purchase Order PO001",
  "notes": "Initial stock from supplier"
}
```

### Creating Bulk Sales
```bash
POST /api/sales/bulk
{
  "sales": [
    {
      "buyer": "buyer_id_1",
      "items": [...],
      "paymentMethod": "cash"
    },
    {
      "buyer": "buyer_id_2",
      "items": [...],
      "paymentMethod": "card"
    }
  ]
}
```

## Security Features

- JWT-based authentication
- Password hashing with bcrypt
- Rate limiting on API endpoints
- Input validation and sanitization
- CORS protection
- Helmet security headers
- Role-based access control

## Error Handling

The API uses standardized error responses:

```json
{
  "success": false,
  "message": "Error description",
  "errors": ["Detailed error information"],
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Response Format

All successful responses follow this format:

```json
{
  "success": true,
  "message": "Operation successful",
  "data": {...},
  "pagination": {...}, // For paginated responses
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

## Development

### Running in Development Mode
```bash
npm run dev
```

### Running Tests
```bash
npm test
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 5000 |
| MONGODB_URI | MongoDB connection string | mongodb://localhost:27017/erp_database |
| JWT_SECRET | JWT signing secret | - |
| NODE_ENV | Environment mode | development |

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the MIT License.