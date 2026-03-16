function toMoney(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Number(numberValue.toFixed(2));
}

function getProductMinSellingPrice(product) {
  const minSellingPrice = Number(product?.pricing?.minSellingPrice);
  if (Number.isFinite(minSellingPrice) && minSellingPrice >= 0) {
    return toMoney(minSellingPrice);
  }

  const sellingPrice = Number(product?.pricing?.sellingPrice);
  if (Number.isFinite(sellingPrice) && sellingPrice >= 0) {
    return toMoney(sellingPrice);
  }

  return 0;
}

function getEffectivePacketSellingPrice(packetStock, product) {
  const totalItemsPerPacket = Number(packetStock?.totalItemsPerPacket || 1);
  const unitMinPrice = getProductMinSellingPrice(product);

  if (unitMinPrice > 0) {
    return toMoney(unitMinPrice * Math.max(1, totalItemsPerPacket));
  }

  const packetPrice = Number(packetStock?.suggestedSellingPrice);
  if (Number.isFinite(packetPrice) && packetPrice >= 0) {
    return toMoney(packetPrice);
  }

  return 0;
}

module.exports = {
  getProductMinSellingPrice,
  getEffectivePacketSellingPrice,
  toMoney,
};
