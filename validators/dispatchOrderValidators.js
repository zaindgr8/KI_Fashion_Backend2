const Joi = require('joi');

const boxSchema = Joi.object({
    boxNumber: Joi.number().required(),
    itemsPerBox: Joi.number().min(0).optional().allow(null),
    weight: Joi.number().min(0).default(0),
    dimensions: Joi.object({
        length: Joi.number().min(0).optional(),
        width: Joi.number().min(0).optional(),
        height: Joi.number().min(0).optional()
    }).optional()
});

const packetCompositionSchema = Joi.object({
    size: Joi.string().required().trim(),
    color: Joi.string().required().trim(),
    quantity: Joi.number().min(1).required()
});

const packetSchema = Joi.object({
    packetNumber: Joi.number().required(),
    totalItems: Joi.number().required(),
    templateId: Joi.string().optional(),
    composition: Joi.array().items(packetCompositionSchema).min(1).required(),
    isLoose: Joi.boolean().optional()
});

const dispatchItemSchema = Joi.object({
    productName: Joi.string().min(1).required(),
    productCode: Joi.string().min(1).required(),
    season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season')).min(1).required(),
    costPrice: Joi.number().min(0).required(),
    primaryColor: Joi.array().items(Joi.string()).optional(),
    size: Joi.array().items(Joi.string()).optional(),
    material: Joi.string().allow(null, '').optional(),
    description: Joi.string().allow(null, '').optional(),
    productImage: Joi.alternatives().try(
        Joi.string().uri(),
        Joi.array().items(Joi.string().uri())
    ).optional(),
    quantity: Joi.number().min(1).required(),
    boxes: Joi.array().items(boxSchema).optional(),
    unitWeight: Joi.number().min(0).default(0),
    notes: Joi.string().allow(null, '').optional(),
    useVariantTracking: Joi.boolean().optional(),
    packets: Joi.array().items(packetSchema).optional()
});

const dispatchOrderSchema = Joi.object({
    date: Joi.string().optional(),
    logisticsCompany: Joi.string().required(),
    items: Joi.array().items(dispatchItemSchema).min(1).required(),
    dispatchDate: Joi.date().optional(),
    expectedDeliveryDate: Joi.date().optional(),
    pickupAddress: Joi.object({
        street: Joi.string().optional(),
        city: Joi.string().optional(),
        state: Joi.string().optional(),
        zipCode: Joi.string().optional(),
        country: Joi.string().default('Pakistan'),
        contactPerson: Joi.string().optional(),
        contactPhone: Joi.string().optional(),
        contactPhoneAreaCode: Joi.string().max(5).optional()
    }).optional(),
    deliveryAddress: Joi.object({
        street: Joi.string().optional(),
        city: Joi.string().optional(),
        state: Joi.string().optional(),
        zipCode: Joi.string().optional(),
        country: Joi.string().default('Pakistan'),
        contactPerson: Joi.string().optional(),
        contactPhone: Joi.string().optional(),
        contactPhoneAreaCode: Joi.string().max(5).optional()
    }).optional(),
    specialInstructions: Joi.string().optional(),
    notes: Joi.string().optional(),
    totalDiscount: Joi.number().min(0).default(0).optional(),
    totalBoxes: Joi.number().min(0).optional()
});

const manualEntryItemSchema = Joi.object({
    product: Joi.string().optional(),
    productName: Joi.string().optional(),
    productCode: Joi.string().optional(),
    season: Joi.array().items(Joi.string().valid('winter', 'summer', 'spring', 'autumn', 'all_season')).min(1).optional(),
    costPrice: Joi.number().min(0).optional(),
    primaryColor: Joi.alternatives().try(
        Joi.string().allow(null, ''),
        Joi.array().items(Joi.string())
    ).optional(),
    size: Joi.alternatives().try(
        Joi.string().allow(null, ''),
        Joi.array().items(Joi.string().allow('')).min(0),
        Joi.any().allow(null)
    ).optional(),
    material: Joi.string().allow(null, '').optional(),
    description: Joi.string().allow(null, '').optional(),
    productImage: Joi.alternatives().try(
        Joi.string().allow(null, ''),
        Joi.array().items(Joi.string())
    ).optional(),
    quantity: Joi.number().min(1).required(),
    landedTotal: Joi.number().min(0).required(),
    useVariantTracking: Joi.boolean().optional(),
    packets: Joi.array().items(packetSchema).optional()
});

const manualEntrySchema = Joi.object({
    supplier: Joi.string().required(),
    purchaseDate: Joi.date().optional(),
    expectedDeliveryDate: Joi.date().optional(),
    exchangeRate: Joi.number().min(0.01).default(1.0),
    percentage: Joi.number().min(0).default(0),
    items: Joi.array().items(manualEntryItemSchema).min(1).required(),
    subtotal: Joi.number().min(0).optional(),
    totalDiscount: Joi.number().min(0).default(0),
    totalTax: Joi.number().min(0).default(0),
    shippingCost: Joi.number().min(0).default(0),
    grandTotal: Joi.number().min(0).optional(),
    cashPayment: Joi.number().min(0).default(0),
    bankPayment: Joi.number().min(0).default(0),
    remainingBalance: Joi.number().min(0).optional(),
    paymentStatus: Joi.string().valid('pending', 'partial', 'paid', 'overdue').optional(),
    paymentTerms: Joi.string().valid('cash', 'net15', 'net30', 'net45', 'net60').default('net30'),
    invoiceNumber: Joi.string().allow('', null).optional(),
    notes: Joi.string().allow('', null).optional(),
    attachments: Joi.array().items(Joi.string()).optional(),
    logisticsCompany: Joi.string().allow(null, '').optional()
});

module.exports = {
    dispatchOrderSchema,
    manualEntrySchema,
    dispatchItemSchema
};
