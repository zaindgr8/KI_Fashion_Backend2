const DispatchOrderService = require('../../../services/DispatchOrderService');
const DispatchOrderRepository = require('../../../repositories/DispatchOrderRepository');
const Supplier = require('../../../models/Supplier');
const LogisticsCompany = require('../../../models/LogisticsCompany');
const Product = require('../../../models/Product');
const Ledger = require('../../../models/Ledger');
const Inventory = require('../../../models/Inventory');

// Mock dependencies
jest.mock('../../../repositories/DispatchOrderRepository');
jest.mock('../../../models/Supplier');
jest.mock('../../../models/LogisticsCompany');
jest.mock('../../../models/Product');
jest.mock('../../../models/Ledger');
jest.mock('../../../models/Inventory');
jest.mock('../../../utils/qrCode', () => ({
    generateDispatchOrderQR: jest.fn()
}));
jest.mock('../../../utils/imageUpload', () => ({
    generateSignedUrl: jest.fn(url => url ? 'signed_' + url : null),
    generateSignedUrls: jest.fn(urls => urls.map(u => 'signed_' + u)),
    deleteImage: jest.fn(url => Promise.resolve(true)),
    generateSignedUploadUrl: jest.fn().mockResolvedValue('http://upload.url'),
    uploadImage: jest.fn().mockResolvedValue({ url: 'http://gcs.url/img.jpg' }),
    validateImageFile: jest.fn().mockReturnValue({ valid: true })
}));

describe('DispatchOrderService', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('createDispatchOrder', () => {
        it('should throw error if logistics company is invalid', async () => {
            LogisticsCompany.findById.mockResolvedValue(null);
            await expect(DispatchOrderService.createDispatchOrder({ _id: 'user1' }, { logisticsCompany: 'bad_id' }))
                .rejects.toThrow('Invalid or inactive logistics company');
        });

        it('should create a dispatch order successfully', async () => {
            const mockUser = { _id: 'u1', name: 'User' };
            const mockData = {
                logisticsCompany: 'l1',
                items: [{ productCode: 'P1', quantity: 10, unitWeight: 1, primaryColor: 'Red', size: 'M' }]
            };
            LogisticsCompany.findById.mockResolvedValue({ _id: 'l1', isActive: true });
            Supplier.findOne.mockResolvedValue({ _id: 's1', userId: 'u1', address: {} });
            DispatchOrderRepository.create.mockResolvedValue({ _id: 'do1', items: [] });
            DispatchOrderRepository.findById.mockResolvedValue({ _id: 'do1', items: [] });
            const result = await DispatchOrderService.createDispatchOrder(mockUser, mockData);
            expect(DispatchOrderRepository.create).toHaveBeenCalled();
            expect(result).toBeDefined();
        });
    });

    describe('createManualEntry', () => {
        it('should calculate landed costs correctly', async () => {
            const mockUser = { _id: 'admin1', role: 'admin' };
            const mockData = {
                supplier: 's1',
                items: [{ productCode: 'P1', quantity: 10, costPrice: 100 }],
                exchangeRate: 2.0,
                percentage: 10,
                cashPayment: 0,
                bankPayment: 0
            };
            Supplier.findById.mockResolvedValue({ _id: 's1' });
            Product.findOne.mockResolvedValue({ _id: 'p1', season: ['summer'] });
            Ledger.getBalance.mockResolvedValue(0);
            DispatchOrderRepository.create.mockResolvedValue({ _id: 'do2', orderNumber: 'MAN-1', dispatchDate: new Date() });

            await DispatchOrderService.createManualEntry(mockUser, mockData);

            const calls = DispatchOrderRepository.create.mock.calls;
            expect(calls.length).toBeGreaterThan(0);
            const args = calls[0][0];
            expect(args.supplierPaymentTotal).toBe(1000); // 100 * 10
            expect(args.subtotal).toBeCloseTo(550, 1); // (100/2)*1.1*10 = 550
        });
    });

    describe('getDispatchOrders', () => {
        it('should get paginated orders', async () => {
            DispatchOrderRepository.findPaginated.mockResolvedValue({ docs: [{ _id: 'do1' }], total: 1, page: 1, limit: 10, pages: 1 });
            const result = await DispatchOrderService.getDispatchOrders({ role: 'admin' }, { page: 1 });
            expect(result.items).toHaveLength(1);
        });
    });

    describe('getUnpaidOrders', () => {
        it('should return only orders with remaining balance', async () => {
            const mockOrders = [
                { _id: 'o1', supplierPaymentTotal: 1000 },
                { _id: 'o2', supplierPaymentTotal: 500 }
            ];
            DispatchOrderRepository.findAll.mockResolvedValue(mockOrders);
            Ledger.find.mockImplementation(({ referenceId }) => {
                if (referenceId === 'o1') return Promise.resolve([{ paymentDetails: { cashPayment: 200 } }]);
                if (referenceId === 'o2') return Promise.resolve([{ paymentDetails: { cashPayment: 500 } }]);
                return Promise.resolve([]);
            });
            const result = await DispatchOrderService.getUnpaidOrders('s1');
            expect(result).toHaveLength(1);
            expect(result[0]._id).toBe('o1');
            expect(result[0].remainingBalance).toBe(800);
        });
    });

    describe('updateDispatchOrderStatus', () => {
        it('should update status successfully', async () => {
            const mockOrder = { _id: 'o1', save: jest.fn(), trackingInfo: {}, logisticsCompany: 'l1' };
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);
            LogisticsCompany.findById.mockResolvedValue({ name: 'DHL' });

            const result = await DispatchOrderService.updateDispatchOrderStatus('o1', { role: 'admin' }, { status: 'shipped', trackingNumber: '123' });
            expect(result.status).toBe('shipped');
            expect(result.trackingInfo.carrier).toBe('DHL');
        });
    });

    describe('submitForApproval', () => {
        it('should update for approval', async () => {
            const mockOrder = {
                _id: 'o1', status: 'pending', items: [{ costPrice: 100, quantity: 10 }],
                save: jest.fn(), populate: jest.fn(), toObject: jest.fn().mockReturnValue({})
            };
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);
            const result = await DispatchOrderService.submitForApproval('o1', { role: 'admin', _id: 'a1' }, { exchangeRate: 2, percentage: 10 });
            expect(result.status).toBe('pending-approval');
            expect(result.subtotal).toBeCloseTo(550, 1);
        });
    });

    describe('confirmDispatchOrder', () => {
        it('should confirm order, create inventory, and ledger entries', async () => {
            const mockOrder = {
                _id: 'o1', orderNumber: 'DO-1', status: 'pending',
                exchangeRate: 1, percentage: 0,
                supplier: { _id: 's1' },
                items: [{ productCode: 'P1', quantity: 10, costPrice: 100, season: ['sum'], landedPrice: 55, itemsWithPrices: [] }],
                save: jest.fn(), populate: jest.fn(),
                toObject: jest.fn().mockReturnValue({})
            };

            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);

            // Mock Product (Constructor and Static)
            const mockProductInstance = { save: jest.fn(), pricing: { costPrice: 55 }, _id: 'prod1' };
            Product.mockImplementation(() => mockProductInstance);
            Product.findOne.mockResolvedValue(null);

            // Mock Inventory (Constructor and Static)
            const mockInventoryInstance = {
                save: jest.fn(),
                addStockWithBatch: jest.fn(),
                addStockWithVariants: jest.fn(),
                purchaseBatches: []
            };
            Inventory.mockImplementation(() => mockInventoryInstance);
            Inventory.findOne.mockResolvedValue(null);

            Ledger.getBalance.mockResolvedValue(0);
            Ledger.createEntry.mockResolvedValue({});
            Supplier.findByIdAndUpdate.mockResolvedValue({});

            try {
                const result = await DispatchOrderService.confirmDispatchOrder('o1', { role: 'super-admin', _id: 'sa1' }, {
                    exchangeRate: 2, percentage: 10
                });

                expect(result.status).toBe('confirmed');
                expect(mockProductInstance.save).toHaveBeenCalled(); // Product creation
                expect(mockInventoryInstance.save).toHaveBeenCalled(); // Inventory creation
                expect(mockInventoryInstance.addStockWithBatch).toHaveBeenCalled(); // Stock add
                expect(Ledger.createEntry).toHaveBeenCalledTimes(1); // Purchase only (no pay/credit)
                expect(result.grandTotal).toBeCloseTo(550, 1);
            } catch (e) {
                // console.error('Test Error:', e);
                const fs = require('fs');
                fs.writeFileSync('error.log', e.stack || e.message);
                throw e;
            }
        });
    });

    describe('updateDispatchOrder', () => {
        it('should update dispatch order successfully', async () => {
            const mockOrder = {
                _id: 'order123',
                status: 'pending',
                supplier: { _id: 'supplier123', toString: () => 'supplier123' },
                items: [],
                save: jest.fn(),
                populate: jest.fn()
            };
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);

            const updateData = {
                trackingNumber: 'TRACK123',
                items: [
                    {
                        productName: 'Updated Item',
                        productCode: 'UP123',
                        quantity: 10,
                        costPrice: 50,

                        season: ['winter']
                    }
                ]
            };

            const result = await DispatchOrderService.updateDispatchOrder('order123', { role: 'admin' }, updateData);

            expect(result.trackingNumber).toBe('TRACK123');
            expect(result.items.length).toBe(1);
            expect(result.items[0].productCode).toBe('UP123');
            expect(mockOrder.save).toHaveBeenCalled();
        });

        it('should throw error if order not found', async () => {
            DispatchOrderRepository.findById.mockResolvedValue(null);
            await expect(DispatchOrderService.updateDispatchOrder('invalid', { role: 'admin' }, {}))
                .rejects.toThrow('Dispatch order not found');
        });

        it('should throw error if order is not pending', async () => {
            DispatchOrderRepository.findById.mockResolvedValue({ status: 'confirmed' });
            await expect(DispatchOrderService.updateDispatchOrder('id', { role: 'admin' }, {}))
                .rejects.toThrow('Only pending dispatch orders can be updated');
        });
    });

    describe('deleteDispatchOrder', () => {
        it('should delete dispatch order successfully', async () => {
            const mockOrder = {
                _id: 'order123',
                status: 'pending',
                items: [{ productImage: ['img1.jpg'] }]
            };
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);
            DispatchOrderRepository.delete.mockResolvedValue(true);

            const result = await DispatchOrderService.deleteDispatchOrder('order123', { role: 'admin' });

            expect(result.message).toBe('Dispatch order deleted successfully');
            expect(DispatchOrderRepository.delete).toHaveBeenCalledWith('order123');
        });

        it('should throw error if permission denied', async () => {
            const mockOrder = {
                _id: 'order123',
                status: 'pending',
                supplier: 'supplier123'
            };
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);

            await expect(DispatchOrderService.deleteDispatchOrder('order123', { role: 'supplier', supplier: 'other' }))
                .rejects.toThrow('You do not have permission to delete this dispatch order');
        });
    });

    describe('Upload Methods', () => {
        const mockOrder = {
            _id: 'order123',
            status: 'pending',
            items: [
                { productCode: 'P1', quantity: 1, productImage: [] }
            ],
            supplier: 'supplier123',
            save: jest.fn()
        };

        beforeEach(() => {
            DispatchOrderRepository.findById.mockResolvedValue(mockOrder);
            Product.findOne.mockResolvedValue({ _id: 'prod1', images: [], save: jest.fn().mockResolvedValue(true) });
        });

        it('should generate upload URL', async () => {
            const result = await DispatchOrderService.generateUploadUrl('order123', 0, 'test.jpg', 'image/jpeg', { role: 'admin' });
            expect(result.uploadUrl).toBe('http://upload.url');
            expect(result.filePath).toContain('dispatch-order123-item-0');
        });

        it('should upload item image directly', async () => {
            const fileData = {
                buffer: Buffer.from('test'),
                originalname: 'test.jpg',
                mimetype: 'image/jpeg',
                size: 4
            };
            const result = await DispatchOrderService.uploadDispatchOrderItemImage('order123', 0, fileData, { role: 'admin' });

            expect(result.imageUrl).toContain('http://gcs.url/img.jpg');
            expect(mockOrder.save).toHaveBeenCalled();
            // Check if product image logic triggered (Product.findOne called)
            expect(Product.findOne).toHaveBeenCalled();
        });

        it('should confirm upload', async () => {
            const result = await DispatchOrderService.confirmUpload('order123', 0, 'path/to/img.jpg', 'img.jpg', 'image/jpeg', { role: 'admin' });

            expect(result.imageUrl).toContain('signed_https://storage.googleapis.com/');
            expect(mockOrder.save).toHaveBeenCalled();
        });
    });
}); // End describe DispatchOrderService
