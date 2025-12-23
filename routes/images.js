const express = require('express');
const auth = require('../middleware/auth');
const { generateSignedUrl, generateSignedUrls } = require('../utils/imageUpload');
const { sendResponse } = require('../utils/helpers');

const router = express.Router();

/**
 * GET /api/images/signed
 * Generate a signed URL for an image
 * Query params:
 *   - url: The original image URL (required)
 *   - expires: Expiration time in minutes (optional, default: 1440 = 24 hours)
 */
router.get('/signed', auth, async (req, res) => {
  try {
    const { url, expires } = req.query;

    if (!url) {
      return sendResponse.error(res, 'Image URL is required', 400);
    }

    const expiresInMinutes = expires ? parseInt(expires, 10) : null;
    
    if (expiresInMinutes !== null && (isNaN(expiresInMinutes) || expiresInMinutes <= 0)) {
      return sendResponse.error(res, 'Expires must be a positive number', 400);
    }

    const signedUrl = await generateSignedUrl(url, expiresInMinutes);

    if (!signedUrl) {
      return sendResponse.error(res, 'Failed to generate signed URL', 500);
    }

    // Calculate expiration timestamp
    const defaultExpiry = parseInt(process.env.IMAGE_SIGNED_URL_EXPIRY_MINUTES || '1440', 10);
    const expiryMinutes = expiresInMinutes || defaultExpiry;
    const expiresAt = new Date(Date.now() + (expiryMinutes * 60 * 1000));

    return sendResponse.success(res, {
      signedUrl: signedUrl,
      expiresAt: expiresAt.toISOString()
    });

  } catch (error) {
    console.error('Generate signed URL error:', error);
    return sendResponse.error(res, error.message || 'Failed to generate signed URL', 500);
  }
});

/**
 * POST /api/images/signed/bulk
 * Generate signed URLs for multiple images
 * Body:
 *   - urls: Array of image URLs (required)
 *   - expires: Expiration time in minutes (optional, default: 1440 = 24 hours)
 */
router.post('/signed/bulk', auth, async (req, res) => {
  try {
    const { urls, expires } = req.body;

    if (!urls || !Array.isArray(urls) || urls.length === 0) {
      return sendResponse.error(res, 'URLs array is required and must not be empty', 400);
    }

    if (urls.length > 100) {
      return sendResponse.error(res, 'Maximum 100 URLs allowed per request', 400);
    }

    const expiresInMinutes = expires ? parseInt(expires, 10) : null;
    
    if (expiresInMinutes !== null && (isNaN(expiresInMinutes) || expiresInMinutes <= 0)) {
      return sendResponse.error(res, 'Expires must be a positive number', 400);
    }

    const signedUrls = await generateSignedUrls(urls, expiresInMinutes);

    // Calculate expiration timestamp
    const defaultExpiry = parseInt(process.env.IMAGE_SIGNED_URL_EXPIRY_MINUTES || '1440', 10);
    const expiryMinutes = expiresInMinutes || defaultExpiry;
    const expiresAt = new Date(Date.now() + (expiryMinutes * 60 * 1000));

    return sendResponse.success(res, {
      signedUrls: signedUrls,
      expiresAt: expiresAt.toISOString(),
      count: signedUrls.length,
      requested: urls.length
    });

  } catch (error) {
    console.error('Generate bulk signed URLs error:', error);
    return sendResponse.error(res, error.message || 'Failed to generate signed URLs', 500);
  }
});

module.exports = router;

