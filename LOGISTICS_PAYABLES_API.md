# Logistics Payables API - Backend Implementation

## Implementation Date
December 3, 2025

## Overview
Production-ready backend API for logistics company payables management. Tracks payments owed to logistics companies based on boxes delivered across dispatch orders.

---

## Database Changes

### 1. LogisticsCompany Model Update
**File**: `models/LogisticsCompany.js`

**Added Field**:
```javascript
rates: {
  // ... existing fields
  boxRate: { type: Number, default: 0 }, // Rate per box for payment calculation
  // ...
}
```

### 2. Ledger Model Update
**File**: `models/Ledger.js`

**Updated Enums**:
```javascript
type: {
  enum: ['supplier', 'buyer', 'logistics'] // Added 'logistics'
}

entityModel: {
  enum: ['Supplier', 'Buyer', 'LogisticsCompany'] // Added 'LogisticsCompany'
}
```

---

## API Endpoints

### Base URL
`/api/logistics-payables`

### Authentication
All endpoints require authentication (Bearer token).

---

### 1. GET `/api/logistics-payables`
**Fetch all logistics payables with optional filters**

**Query Parameters**:
- `companyId` (optional) - Filter by specific logistics company
- `paymentStatus` (optional) - Filter by status: pending, partial, paid
- `dateFrom` (optional) - Start date filter (ISO format)
- `dateTo` (optional) - End date filter (ISO format)
- `limit` (optional, default: 1000) - Pagination limit

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "company_id",
      "companyName": "Express Logistics",
      "name": "Express Logistics",
      "totalBoxes": 150,
      "boxRate": 5.50,
      "totalAmount": 825.00,
      "totalPaid": 300.00,
      "outstandingBalance": 525.00,
      "paymentStatus": "partial",
      "lastPaymentDate": "2025-11-25T00:00:00.000Z",
      "orderCount": 8
    }
  ]
}
```

**Logic**:
1. Fetches all confirmed dispatch orders
2. Groups by logistics company
3. Calculates total boxes per company
4. Retrieves payments from ledger
5. Computes outstanding balances
6. Determines payment status

---

### 2. GET `/api/logistics-payables/summary`
**Get summary statistics for all logistics payables**

**Response**:
```json
{
  "success": true,
  "data": {
    "totalCompanies": 5,
    "totalBoxes": 1250,
    "totalAmount": 6875.00,
    "totalPaid": 3200.00,
    "totalOutstanding": 3675.00
  }
}
```

**Logic**:
- Aggregates data from all logistics companies
- Counts unique companies
- Sums total boxes and amounts
- Calculates overall outstanding

---

### 3. GET `/api/logistics-payables/company/:companyId`
**Get detailed payable info for specific company**

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "company_id",
    "name": "Express Logistics",
    "code": "LOG0001",
    "contact": "+92-3001234567",
    "email": "contact@express.com",
    "boxRate": 5.50,
    "totalBoxes": 150,
    "totalAmount": 825.00,
    "totalPaid": 300.00,
    "outstandingBalance": 525.00,
    "orderCount": 8
  }
}
```

---

### 4. GET `/api/logistics-payables/company/:companyId/orders`
**Get orders breakdown for a company**

**Query Parameters**:
- `dateFrom` (optional) - Start date
- `dateTo` (optional) - End date
- `paymentStatus` (optional) - Filter by status
- `limit` (optional, default: 100) - Max orders to return

**Response**:
```json
{
  "success": true,
  "data": {
    "orders": [
      {
        "id": "order_id",
        "orderNumber": "DO-2025-001",
        "dispatchDate": "2025-11-15T00:00:00.000Z",
        "supplierName": "Supplier ABC",
        "totalBoxes": 25,
        "boxRate": 5.50,
        "amount": 137.50,
        "paidAmount": 0,
        "paymentStatus": "pending"
      }
    ]
  }
}
```

---

### 5. GET `/api/logistics-payables/company/:companyId/payments`
**Get payment history for a company**

**Query Parameters**:
- `limit` (optional, default: 100) - Max payments to return

**Response**:
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "id": "payment_id",
        "date": "2025-11-25T00:00:00.000Z",
        "amount": 300.00,
        "method": "cash",
        "description": "Payment for logistics services",
        "numberOfBoxes": 54.55,
        "balance": -525.00
      }
    ]
  }
}
```

---

### 6. POST `/api/logistics-payables/payment`
**Create a payment for a logistics company**

**Request Body**:
```json
{
  "logisticsCompanyId": "company_id",
  "amount": 275.00,
  "date": "2025-12-03",
  "method": "cash",
  "description": "Payment for November deliveries",
  "boxRate": 5.50,
  "numberOfBoxes": 50,
  "orderIds": ["order_id_1", "order_id_2"]
}
```

**Validation**:
- `logisticsCompanyId`: Required, valid ObjectId
- `amount`: Required, minimum 0.01
- `date`: Required, valid date
- `method`: Required, must be 'cash' or 'bank'
- `description`: Optional string
- `boxRate`: Required, minimum 0
- `numberOfBoxes`: Optional, calculated if not provided
- `orderIds`: Optional array

**Response**:
```json
{
  "success": true,
  "data": {
    "payment": {
      "id": "ledger_entry_id",
      "date": "2025-12-03T00:00:00.000Z",
      "amount": 275.00,
      "method": "cash",
      "description": "Payment for November deliveries",
      "numberOfBoxes": 50,
      "balance": -250.00
    }
  },
  "message": "Payment recorded successfully"
}
```

**Logic**:
1. Validates company exists
2. Validates payment amount
3. Creates ledger entry with type 'logistics'
4. Calculates and stores number of boxes
5. Returns new balance

---

### 7. PUT `/api/logistics-payables/company/:companyId/rate`
**Update box rate for a logistics company**

**Request Body**:
```json
{
  "boxRate": 6.00
}
```

**Validation**:
- `boxRate`: Required, minimum 0

**Response**:
```json
{
  "success": true,
  "data": {
    "id": "company_id",
    "name": "Express Logistics",
    "boxRate": 6.00
  },
  "message": "Box rate updated successfully"
}
```

---

## Ledger Integration

### New Ledger Endpoints

#### GET `/api/ledger/logistics/:companyId`
Get ledger entries for a specific logistics company

**Query Parameters**:
- `limit` (optional, default: 100)
- `offset` (optional, default: 0)

**Response**:
```json
{
  "success": true,
  "data": {
    "entries": [
      {
        "_id": "entry_id",
        "type": "logistics",
        "entityId": "company_id",
        "transactionType": "payment",
        "debit": 0,
        "credit": 300.00,
        "balance": -525.00,
        "date": "2025-11-25T00:00:00.000Z",
        "description": "Payment for logistics services",
        "paymentMethod": "cash",
        "createdBy": {...}
      }
    ],
    "balance": -525.00,
    "count": 1
  }
}
```

#### GET `/api/ledger/logistics`
Get all logistics companies with balances

**Response**:
```json
{
  "success": true,
  "data": [
    {
      "id": "company_id",
      "name": "Express Logistics",
      "code": "LOG0001",
      "contact": "3001234567",
      "balance": -525.00
    }
  ]
}
```

---

## Error Handling

All endpoints follow consistent error response format:

```json
{
  "success": false,
  "message": "Error description"
}
```

**Common HTTP Status Codes**:
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found (resource doesn't exist)
- `500` - Internal Server Error

---

## Data Flow

### Payment Creation Flow:
1. Frontend sends POST to `/api/logistics-payables/payment`
2. Backend validates all fields
3. Checks logistics company exists
4. Calculates numberOfBoxes if not provided
5. Creates ledger entry using `Ledger.createEntry()`
6. Ledger automatically calculates running balance
7. Returns payment details with new balance
8. Frontend React Query invalidates relevant caches
9. UI updates with new data

### Payables Calculation:
```
For each dispatch order:
  - Get totalBoxes from order
  - Get boxRate from LogisticsCompany
  - Calculate: amount = totalBoxes × boxRate

For each company:
  - Sum all order amounts
  - Get total paid from ledger entries
  - Calculate: outstanding = totalAmount - totalPaid
  - Determine status:
    - paid: if outstanding <= 0
    - partial: if outstanding > 0 AND totalPaid > 0
    - pending: if totalPaid = 0
```

---

## Testing

### Manual Testing Checklist:
- [ ] Create logistics company with boxRate
- [ ] Create dispatch order with totalBoxes and logistics company
- [ ] Confirm dispatch order
- [ ] Fetch payables list - verify company appears
- [ ] Fetch summary - verify totals
- [ ] Fetch company details - verify calculations
- [ ] Fetch company orders - verify order breakdown
- [ ] Create payment - verify ledger entry
- [ ] Fetch payment history - verify payment appears
- [ ] Update box rate - verify rate changes
- [ ] Test filters (status, date range, company)
- [ ] Test with multiple companies
- [ ] Test partial payments
- [ ] Test full payments

### Integration Testing:
- [ ] Frontend connects successfully
- [ ] Data displays in UI
- [ ] Filters work correctly
- [ ] Payment modal functions
- [ ] Calculations are accurate
- [ ] Real-time updates work

---

## Production Deployment

### Pre-Deployment:
1. ✅ All code committed and pushed
2. ✅ No breaking changes to existing APIs
3. ✅ Backward compatible schema changes
4. ✅ Proper error handling implemented
5. ✅ Validation in place

### Deployment Steps:
1. Pull latest code on server
2. Restart Node.js application
3. Verify `/health` endpoint
4. Test one payables API endpoint
5. Monitor logs for errors
6. Test frontend integration

### Post-Deployment:
- Monitor error logs
- Check API response times
- Verify ledger balance calculations
- Test payment creation
- Confirm frontend displays data

---

## Frontend Integration

The frontend at `crm-dashboard-redesign` is already configured:
- ✅ API client ready (`lib/api/endpoints/logisticsPayables.js`)
- ✅ React hooks configured (`lib/hooks/useLogisticsPayables.js`)
- ✅ Page component complete (`app/(dashboard)/logistics-payables/page.jsx`)
- ✅ Payment modal ready (`components/modals/LogisticsPaymentModal.jsx`)

**Once backend is deployed, frontend will automatically connect and display real-time data.**

---

## Security Considerations

1. **Authentication**: All endpoints protected by `auth` middleware
2. **Validation**: Joi schemas validate all input
3. **Authorization**: Can add admin-only checks if needed
4. **SQL Injection**: MongoDB prevents injection attacks
5. **XSS**: Frontend sanitizes inputs
6. **CSRF**: Token-based authentication prevents CSRF

---

## Performance Optimization

Current optimizations:
- Indexed ledger queries by entityId and date
- Limited default response sizes
- Efficient aggregation queries
- Reuses existing Ledger.createEntry() method

Future improvements:
- Add caching for frequently accessed data
- Implement pagination for large result sets
- Add database indexes on dispatch order queries
- Consider materialized views for summary data

---

## Maintenance

### Adding New Features:
1. Update validation schemas if adding fields
2. Update response formats in documentation
3. Test with existing data
4. Update frontend types if needed

### Troubleshooting:
- Check server logs for errors
- Verify database connection
- Test endpoints with Postman
- Confirm dispatch orders have totalBoxes
- Verify logistics companies have boxRate

---

## Support

For issues or questions:
- Check implementation documentation
- Review error logs
- Test endpoints individually
- Verify data in database

---

## Changelog

### v1.0.0 - December 3, 2025
- Initial implementation
- 7 payables endpoints created
- 2 ledger endpoints added
- Schema updates for logistics support
- Production-ready with validation and error handling

