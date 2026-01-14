const crypto = require('crypto');

/**
 * Generate a deterministic barcode from packet configuration.
 * Same inputs will always produce the same barcode.
 * 
 * @param {string} supplierId - Supplier ObjectId as string
 * @param {string} productId - Product ObjectId as string
 * @param {Array} composition - Array of {size, color, quantity}
 * @param {boolean} isLoose - Whether this is a loose item
 * @returns {string} Barcode string like "PKT-A1B2C3D4" or "LSE-A1B2C3D4"
 */
function generatePacketBarcode(supplierId, productId, composition, isLoose = false) {
  // Sort composition for consistency (same items in different order = same barcode)
  const sortedComposition = [...composition]
    .sort((a, b) => {
      const keyA = `${a.color}-${a.size}`;
      const keyB = `${b.color}-${b.size}`;
      return keyA.localeCompare(keyB);
    })
    .map(c => `${c.color}:${c.size}:${c.quantity}`)
    .join('|');
  
  // Create hash from supplier + product + composition
  const dataString = `${supplierId}-${productId}-${sortedComposition}-${isLoose}`;
  const hash = crypto.createHash('md5')
    .update(dataString)
    .digest('hex')
    .substring(0, 8)
    .toUpperCase();
  
  // Prefix: PKT for packets, LSE for loose items
  const prefix = isLoose ? 'LSE' : 'PKT';
  
  return `${prefix}-${hash}`;
}

/**
 * Generate barcode for a loose item (single product variant)
 * 
 * @param {string} supplierId - Supplier ObjectId as string
 * @param {string} productId - Product ObjectId as string
 * @param {string} size - Size of the item
 * @param {string} color - Color of the item
 * @returns {string} Barcode string like "LSE-A1B2C3D4"
 */
function generateLooseItemBarcode(supplierId, productId, size, color) {
  const composition = [{ size, color, quantity: 1 }];
  return generatePacketBarcode(supplierId, productId, composition, true);
}

/**
 * Parse a barcode to determine its type
 * 
 * @param {string} barcode - Barcode string
 * @returns {object} { isValid, isLoose, isPacket }
 */
function parseBarcodeType(barcode) {
  if (!barcode || typeof barcode !== 'string') {
    return { isValid: false, isLoose: false, isPacket: false };
  }
  
  const upperBarcode = barcode.toUpperCase().trim();
  
  return {
    isValid: upperBarcode.startsWith('PKT-') || upperBarcode.startsWith('LSE-'),
    isLoose: upperBarcode.startsWith('LSE-'),
    isPacket: upperBarcode.startsWith('PKT-')
  };
}

/**
 * Normalize barcode for lookup (uppercase, trimmed)
 * 
 * @param {string} barcode - Barcode string
 * @returns {string} Normalized barcode
 */
function normalizeBarcode(barcode) {
  if (!barcode || typeof barcode !== 'string') {
    return '';
  }
  return barcode.toUpperCase().trim();
}

module.exports = {
  generatePacketBarcode,
  generateLooseItemBarcode,
  parseBarcodeType,
  normalizeBarcode
};
