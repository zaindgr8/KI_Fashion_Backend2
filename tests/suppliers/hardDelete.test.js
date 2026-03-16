const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

jest.mock('../../utils/imageUpload', () => ({
  generateSignedUrl: async (url) => url,
  generateSignedUrls: async (urls) => urls,
  generateSignedUploadUrl: async () => ({ url: 'http://upload' }),
  verifyFileExists: async () => true,
  deleteImage: async () => true,
  uploadImage: async () => ({ url: 'http://uploaded' }),
}));
jest.mock('../../utils/qrCode', () => ({
  generateDispatchOrderQR: async () => ({ dataUrl: 'data:' }),
  buildDispatchOrderQrPayload: () => ({}),
}));
jest.mock('../../utils/barcodeGenerator', () => ({
  generatePacketBarcode: async () => 'BARCODE',
  generateLooseItemBarcode: async () => 'LOOSE',
}));

let mongod;
let app;
let User;
let Supplier;
let ProductType;
let Product;
let DispatchOrder;
let Inventory;
let Return;
let PacketStock;
let PacketTemplate;
let SupplierPaymentReceipt;
let Ledger;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri();
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
  process.env.NODE_ENV = 'test';

  app = require('../../server');

  User = require('../../models/User');
  Supplier = require('../../models/Supplier');
  ProductType = require('../../models/ProductType');
  Product = require('../../models/Product');
  DispatchOrder = require('../../models/DispatchOrder');
  Inventory = require('../../models/Inventory');
  Return = require('../../models/Return');
  PacketStock = require('../../models/PacketStock');
  PacketTemplate = require('../../models/PacketTemplate');
  SupplierPaymentReceipt = require('../../models/SupplierPaymentReceipt');
  Ledger = require('../../models/Ledger');
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) {
    await mongod.stop();
  }
});

afterEach(async () => {
  const collections = Object.keys(mongoose.connection.collections);
  for (const collectionName of collections) {
    await mongoose.connection.collections[collectionName].deleteMany({});
  }
});

function generateTokenFor(user) {
  return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function createSupplierCascadeFixture() {
  const superAdmin = await User.create({
    name: 'Super Admin',
    email: 'superadmin@example.com',
    password: 'pass123',
    role: 'super-admin',
  });

  const targetSupplier = await Supplier.create({
    name: 'Supplier To Delete',
    phone: '111111',
    createdBy: superAdmin._id,
  });

  const alternateSupplier = await Supplier.create({
    name: 'Alternate Supplier',
    phone: '222222',
    createdBy: superAdmin._id,
  });

  const supplierUser = await User.create({
    name: 'Supplier User',
    email: 'supplier-user@example.com',
    password: 'pass123',
    role: 'supplier',
    supplier: targetSupplier._id,
  });

  const linkedAdmin = await User.create({
    name: 'Linked Admin',
    email: 'linked-admin@example.com',
    password: 'pass123',
    role: 'admin',
    supplier: targetSupplier._id,
  });

  const productType = await ProductType.create({
    name: 'Jackets',
    createdBy: superAdmin._id,
  });

  const primaryProduct = await Product.create({
    name: 'Supplier Jacket',
    sku: 'SUP-JKT-1',
    supplier: targetSupplier._id,
    category: 'Outerwear',
    pricing: {
      costPrice: 10,
      sellingPrice: 20,
    },
    createdBy: superAdmin._id,
  });

  const mappedProduct = await Product.create({
    name: 'Shared Product',
    sku: 'ALT-JKT-1',
    supplier: alternateSupplier._id,
    category: 'Outerwear',
    pricing: {
      costPrice: 12,
      sellingPrice: 24,
    },
    suppliers: [
      {
        supplier: targetSupplier._id,
        supplierPrice: 11,
      },
    ],
    createdBy: superAdmin._id,
  });

  const dispatchOrder = await DispatchOrder.create({
    supplier: targetSupplier._id,
    createdBy: superAdmin._id,
    items: [
      {
        product: primaryProduct._id,
        productName: 'Supplier Jacket',
        productCode: 'SUP-JKT-1',
        quantity: 5,
      },
    ],
  });

  await Inventory.create({
    product: primaryProduct._id,
    currentStock: 5,
    minStockLevel: 1,
    maxStockLevel: 20,
    reorderLevel: 2,
    averageCostPrice: 10,
    purchaseBatches: [
      {
        dispatchOrderId: dispatchOrder._id,
        supplierId: targetSupplier._id,
        quantity: 5,
        remainingQuantity: 5,
        costPrice: 10,
      },
    ],
  });

  await Inventory.create({
    product: mappedProduct._id,
    currentStock: 3,
    minStockLevel: 1,
    maxStockLevel: 15,
    reorderLevel: 2,
    averageCostPrice: 11,
    purchaseBatches: [
      {
        dispatchOrderId: dispatchOrder._id,
        supplierId: targetSupplier._id,
        quantity: 3,
        remainingQuantity: 3,
        costPrice: 11,
      },
    ],
  });

  await PacketTemplate.create({
    name: 'Supplier Packet Template',
    productType: productType._id,
    totalItemsPerPacket: 5,
    composition: [
      { size: 'M', color: 'Black', quantity: 5 },
    ],
    supplier: targetSupplier._id,
    createdBy: superAdmin._id,
  });

  await PacketStock.create({
    barcode: 'PKT-001',
    product: primaryProduct._id,
    supplier: targetSupplier._id,
    composition: [
      { size: 'M', color: 'Black', quantity: 5 },
    ],
    totalItemsPerPacket: 5,
    availablePackets: 1,
  });

  await Return.create({
    dispatchOrder: dispatchOrder._id,
    supplier: targetSupplier._id,
    items: [
      {
        product: primaryProduct._id,
        productName: 'Supplier Jacket',
        originalQuantity: 5,
        returnedQuantity: 1,
        costPrice: 10,
      },
    ],
    totalReturnValue: 10,
    returnedBy: superAdmin._id,
  });

  const supplierLedgerEntry = await Ledger.create({
    type: 'supplier',
    entityId: targetSupplier._id,
    entityModel: 'Supplier',
    transactionType: 'purchase',
    referenceId: dispatchOrder._id,
    referenceModel: 'DispatchOrder',
    debit: 50,
    credit: 0,
    date: new Date(),
    createdBy: superAdmin._id,
  });

  await SupplierPaymentReceipt.create({
    receiptNumber: 'SPR-000001',
    supplierId: targetSupplier._id,
    totalAmount: 50,
    cashAmount: 50,
    paymentMethodSummary: 'cash',
    paymentDate: new Date(),
    distributions: [
      {
        dispatchOrderId: dispatchOrder._id,
        orderNumber: dispatchOrder.orderNumber,
        amountApplied: 50,
        ledgerEntryId: supplierLedgerEntry._id,
      },
    ],
    balanceBefore: 50,
    balanceAfter: 0,
    createdBy: superAdmin._id,
  });

  return {
    superAdmin,
    linkedAdmin,
    supplierUser,
    targetSupplier,
    alternateSupplier,
    primaryProduct,
    mappedProduct,
    dispatchOrder,
  };
}

test('super-admin can get supplier delete summary and hard delete all related records', async () => {
  const fixture = await createSupplierCascadeFixture();
  const token = generateTokenFor(fixture.superAdmin);

  const summaryResponse = await request(app)
    .get(`/api/suppliers/${fixture.targetSupplier._id}/delete-summary`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(summaryResponse.body.success).toBe(true);
  expect(summaryResponse.body.data.counts.productsToDelete).toBe(1);
  expect(summaryResponse.body.data.counts.productMappingsToRemove).toBe(1);
  expect(summaryResponse.body.data.counts.dispatchOrdersToDelete).toBe(1);
  expect(summaryResponse.body.data.counts.supplierPaymentReceiptsToDelete).toBe(1);
  expect(summaryResponse.body.data.counts.supplierUsersToDelete).toBe(1);
  expect(summaryResponse.body.data.counts.linkedUsersToUnlink).toBe(1);

  const deleteResponse = await request(app)
    .delete(`/api/suppliers/${fixture.targetSupplier._id}/hard`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  expect(deleteResponse.body.success).toBe(true);
  expect(deleteResponse.body.data.supplier.name).toBe('Supplier To Delete');

  expect(await Supplier.findById(fixture.targetSupplier._id)).toBeNull();
  expect(await Product.findById(fixture.primaryProduct._id)).toBeNull();
  expect(await DispatchOrder.findById(fixture.dispatchOrder._id)).toBeNull();
  expect(await SupplierPaymentReceipt.countDocuments({ supplierId: fixture.targetSupplier._id })).toBe(0);
  expect(await Return.countDocuments({ supplier: fixture.targetSupplier._id })).toBe(0);
  expect(await PacketStock.countDocuments({ supplier: fixture.targetSupplier._id })).toBe(0);
  expect(await PacketTemplate.countDocuments({ supplier: fixture.targetSupplier._id })).toBe(0);
  expect(await Ledger.countDocuments({ type: 'supplier', entityId: fixture.targetSupplier._id })).toBe(0);
  expect(await User.findById(fixture.supplierUser._id)).toBeNull();

  const unlinkedAdmin = await User.findById(fixture.linkedAdmin._id).lean();
  expect(unlinkedAdmin).not.toBeNull();
  expect(unlinkedAdmin.supplier).toBeUndefined();

  const survivingProduct = await Product.findById(fixture.mappedProduct._id).lean();
  expect(survivingProduct).not.toBeNull();
  expect(survivingProduct.suppliers).toHaveLength(0);

  const survivingInventory = await Inventory.findOne({ product: fixture.mappedProduct._id }).lean();
  expect(survivingInventory).not.toBeNull();
  expect(survivingInventory.purchaseBatches).toHaveLength(0);
  expect(await Inventory.findOne({ product: fixture.primaryProduct._id })).toBeNull();
});

test('non-super-admin cannot hard delete a supplier', async () => {
  const fixture = await createSupplierCascadeFixture();
  const admin = await User.create({
    name: 'Regular Admin',
    email: 'admin@example.com',
    password: 'pass123',
    role: 'admin',
  });
  const token = generateTokenFor(admin);

  const response = await request(app)
    .delete(`/api/suppliers/${fixture.targetSupplier._id}/hard`)
    .set('Authorization', `Bearer ${token}`)
    .expect(403);

  expect(response.body.success).toBe(false);
  expect(await Supplier.findById(fixture.targetSupplier._id)).not.toBeNull();
});