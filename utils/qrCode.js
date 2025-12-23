const QRCode = require('qrcode');

const DISPATCH_ORDER_QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  type: 'image/png',
  scale: 6,
  margin: 1
};

function buildDispatchOrderQrPayload(dispatchOrder) {
  return {
    type: 'dispatch_order',
    dispatchOrderId: dispatchOrder._id.toString(),
    orderNumber: dispatchOrder.orderNumber || '',
    totalBoxes: dispatchOrder.totalBoxes || 0,
    totalQuantity: dispatchOrder.totalQuantity || 0,
    timestamp: new Date().toISOString()
  };
}

async function generateDispatchOrderQR(dispatchOrder, userId) {
  if (!dispatchOrder) {
    return null;
  }

  const payload = buildDispatchOrderQrPayload(dispatchOrder);
  const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), DISPATCH_ORDER_QR_OPTIONS);

  dispatchOrder.qrCode = {
    dataUrl,
    payload,
    generatedAt: new Date(),
    generatedBy: userId
  };

  await dispatchOrder.save();
  return dispatchOrder;
}

const SALE_QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  type: 'image/png',
  scale: 6,
  margin: 1
};

function buildSaleQrPayload(sale) {
  return {
    type: 'sale',
    saleId: sale._id.toString(),
    saleNumber: sale.saleNumber || '',
    invoiceNumber: sale.invoiceNumber || '',
    buyerId: sale.buyer?.toString() || '',
    grandTotal: sale.grandTotal || 0,
    timestamp: new Date().toISOString()
  };
}

async function generateSaleQR(sale, userId) {
  if (!sale) {
    return null;
  }

  const payload = buildSaleQrPayload(sale);
  const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), SALE_QR_OPTIONS);

  sale.qrCode = {
    dataUrl,
    payload,
    generatedAt: new Date(),
    generatedBy: userId
  };

  await sale.save();
  return sale;
}

const CATALOG_QR_OPTIONS = {
  errorCorrectionLevel: 'M',
  type: 'image/png',
  scale: 6,
  margin: 1
};

function buildCatalogQrPayload(buyerId, catalogUrl) {
  return {
    type: 'catalog',
    url: catalogUrl,
    distributorId: buyerId?.toString() || '',
    timestamp: new Date().toISOString()
  };
}

async function generateCatalogQR(buyerId, catalogUrl, userId) {
  const payload = buildCatalogQrPayload(buyerId, catalogUrl);
  const dataUrl = await QRCode.toDataURL(JSON.stringify(payload), CATALOG_QR_OPTIONS);

  return {
    dataUrl,
    payload,
    generatedAt: new Date(),
    generatedBy: userId
  };
}

module.exports = {
  generateDispatchOrderQR,
  buildDispatchOrderQrPayload,
  generateSaleQR,
  buildSaleQrPayload,
  generateCatalogQR,
  buildCatalogQrPayload
};

