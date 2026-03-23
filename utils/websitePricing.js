function toMoney(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Number(numberValue.toFixed(2));
}

function toFiniteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) return null;
  return toMoney(numberValue);
}

function getProductMinSellingPrice(product) {
  const minSellingPrice = toFiniteNonNegative(product?.pricing?.minSellingPrice);
  if (minSellingPrice !== null) {
    return minSellingPrice;
  }

  const sellingPrice = toFiniteNonNegative(product?.pricing?.sellingPrice);
  if (sellingPrice !== null) {
    return sellingPrice;
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
