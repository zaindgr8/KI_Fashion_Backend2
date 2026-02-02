const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const jwt = require('jsonwebtoken');

// Mock external utilities before importing server/routes
jest.mock('../../utils/imageUpload', () => ({
  generateSignedUrl: async (url) => url,
  generateSignedUrls: async (urls) => urls,
  generateSignedUploadUrl: async () => ({ url: 'http://upload' }),
  verifyFileExists: async () => true,
  deleteImage: async () => true,
  uploadImage: async () => ({ url: 'http://uploaded' })
}));
jest.mock('../../utils/qrCode', () => ({
  generateDispatchOrderQR: async () => ({ dataUrl: 'data:' }),
  buildDispatchOrderQrPayload: () => ({})
}));
jest.mock('../../utils/barcodeGenerator', () => ({
  generatePacketBarcode: async () => 'BARCODE',
  generateLooseItemBarcode: async () => 'LOOSE'
}));

let mongod;
let app;
let User;
let Supplier;
let DispatchOrder;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  process.env.MONGODB_URI = uri;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecret';
  process.env.NODE_ENV = 'test';

  // Require app after env is set so server connects to the in-memory DB
  app = require('../../server');

  // Load models
  User = require('../models/User');
  Supplier = require('../models/Supplier');
  DispatchOrder = require('../models/DispatchOrder');
});

afterAll(async () => {
  // Close mongoose connection and stop in-memory server
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(async () => {
  // Clear database between tests
  const collections = Object.keys(mongoose.connection.collections);
  for (const coll of collections) {
    await mongoose.connection.collections[coll].deleteMany({});
  }
});

function generateTokenFor(user) {
  return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

test('admin can edit pending-approval dispatch order and totals are normalized', async () => {
  // Create admin user
  const admin = await User.create({ name: 'Admin', email: 'admin@example.com', password: 'pass123', role: 'admin' });

  // Create supplier
  const supplier = await Supplier.create({ name: 'Supplier A', phone: '123456', createdBy: admin._id });

  // Create dispatch order with status pending-approval
  const order = await DispatchOrder.create({
    supplier: supplier._id,
    createdBy: admin._id,
    status: 'pending-approval',
    items: [
      {
        productName: 'Item1',
        productCode: 'P1',
        season: ['all_season'],
        costPrice: 10,
        quantity: 5,
        useVariantTracking: true,
        packets: [
          {
            packetNumber: 1,
            totalItems: 5,
            composition: [{ size: 'M', color: 'Red', quantity: 5 }],
            isLoose: false
          }
        ]
      }
    ]
  });

  const token = generateTokenFor(admin);

  const payload = {
    exchangeRate: 2, // will be applied
    percentage: 10,
    items: [
      {
        productName: 'Item1',
        productCode: 'P1',
        season: ['all_season'],
        costPrice: 10,
        quantity: 4,
        useVariantTracking: true,
        packets: [
          {
            packetNumber: 1,
            totalItems: 4,
            composition: [{ size: 'M', color: 'Red', quantity: 4 }],
            isLoose: false
          }
        ]
      }
    ]
  };

  const res = await request(app)
    .put(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(200);

  expect(res.body.success).toBe(true);
  const updated = res.body.data;
  expect(updated.status).toBe('pending-approval');
  expect(updated.items[0].quantity).toBe(4);
  // Totals should be recalculated
  expect(typeof updated.supplierPaymentTotal).toBe('number');
  expect(typeof updated.grandTotal).toBe('number');
  // Packets preserved
  expect(updated.items[0].packets).toBeDefined();
  expect(updated.items[0].packets[0].composition[0].quantity).toBe(4);
});

test('supplier cannot edit pending-approval dispatch order', async () => {
  // Create admin and supplier users
  const admin = await User.create({ name: 'Admin', email: 'admin2@example.com', password: 'pass123', role: 'admin' });
  const supplier = await Supplier.create({ name: 'Supplier B', phone: '23456', createdBy: admin._id });
  const supplierUser = await User.create({ name: 'SupplierUser', email: 'sup@example.com', password: 'pass123', role: 'supplier', supplier: supplier._id });

  // Create dispatch order with status pending-approval
  const order = await DispatchOrder.create({
    supplier: supplier._id,
    createdBy: admin._id,
    status: 'pending-approval',
    items: [
      {
        productName: 'Item1',
        productCode: 'P1',
        season: ['all_season'],
        costPrice: 10,
        quantity: 5
      }
    ]
  });

  const token = generateTokenFor(supplierUser);

  const payload = { items: [{ productName: 'Item1', productCode: 'P1', quantity: 3 }] };

  const res = await request(app)
    .put(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(403);

  expect(res.body.success).toBe(false);
});

test('removing variants requires reconfiguration and blocks save', async () => {
  const admin = await User.create({ name: 'Admin3', email: 'admin3@example.com', password: 'pass123', role: 'admin' });
  const supplier = await Supplier.create({ name: 'Supplier C', phone: '34567', createdBy: admin._id });

  // Create order with sizes and colors and an initial packet
  const order = await DispatchOrder.create({
    supplier: supplier._id,
    createdBy: admin._id,
    status: 'pending-approval',
    items: [
      {
        productName: 'Item2',
        productCode: 'P2',
        season: ['all_season'],
        costPrice: 5,
        quantity: 10,
        primaryColor: ['Red','Blue'],
        size: ['S','M'],
        useVariantTracking: true,
        packets: [
          { packetNumber: 1, totalItems: 10, composition: [ { size: 'S', color: 'Red', quantity: 5 }, { size: 'M', color: 'Blue', quantity: 5 } ], isLoose: false }
        ]
      }
    ]
  });

  const token = generateTokenFor(admin);

  // Admin removes size 'M' without providing new packets
  const payload = {
    items: [ {
      productName: 'Item2', productCode: 'P2', quantity: 10, primaryColor: ['Red','Blue'], size: ['S']
    } ]
  };

  const res = await request(app)
    .put(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(400);

  expect(res.body.success).toBe(false);

  // Order should remain unchanged in DB (no save)
  const getRes = await request(app)
    .get(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  const dbOrder = getRes.body.data;
  expect(dbOrder.items[0].size.includes('M')).toBe(true);
});

test('providing new packets clears requiresReconfiguration and saves', async () => {
  const admin = await User.create({ name: 'Admin4', email: 'admin4@example.com', password: 'pass123', role: 'admin' });
  const supplier = await Supplier.create({ name: 'Supplier D', phone: '45678', createdBy: admin._id });

  const order = await DispatchOrder.create({
    supplier: supplier._id,
    createdBy: admin._id,
    status: 'pending-approval',
    items: [
      {
        productName: 'Item3',
        productCode: 'P3',
        season: ['all_season'],
        costPrice: 8,
        quantity: 6,
        primaryColor: ['Black'],
        size: ['L','XL'],
        useVariantTracking: true,
        packets: [ { packetNumber: 1, totalItems: 6, composition: [ { size: 'L', color: 'Black', quantity: 3 }, { size: 'XL', color: 'Black', quantity: 3 } ], isLoose: false } ]
      }
    ]
  });

  const token = generateTokenFor(admin);

  // Admin removes size 'XL' but provides new packets for remaining size
  const payload = {
    items: [ {
      productName: 'Item3', productCode: 'P3', quantity: 6, primaryColor: ['Black'], size: ['L'],
      packets: [ { packetNumber: 1, totalItems: 6, composition: [ { size: 'L', color: 'Black', quantity: 6 } ], isLoose: false } ]
    } ]
  };

  const res = await request(app)
    .put(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .send(payload)
    .expect(200);

  expect(res.body.success).toBe(true);

  const getRes = await request(app)
    .get(`/api/dispatch-orders/${order._id}`)
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  const dbOrder = getRes.body.data;
  expect(dbOrder.items[0].requiresReconfiguration).toBe(false);
  expect(dbOrder.items[0].packets.length).toBeGreaterThan(0);
});
