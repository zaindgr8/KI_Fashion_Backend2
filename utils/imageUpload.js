const { getBucket } = require('../config/gcs');
const path = require('path');

// Default configuration
const MAX_IMAGE_SIZE_MB = parseInt(process.env.MAX_IMAGE_SIZE_MB || '5', 10);
const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

/**
 * Validate image file
 * @param {Object} file - Multer file object
 * @returns {Object} { valid: boolean, error?: string }
 */
function validateImageFile(file) {
  if (!file) {
    return { valid: false, error: 'No file provided' };
  }

  // Check file size
  if (file.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      valid: false,
      error: `File size exceeds maximum allowed size of ${MAX_IMAGE_SIZE_MB}MB`
    };
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    return {
      valid: false,
      error: `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
    };
  }

  // Check file extension
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return {
      valid: false,
      error: `Invalid file extension. Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Upload image to Google Cloud Storage
 * @param {Object} file - Multer file object
 * @param {String} productId - Product ID
 * @returns {Promise<Object>} { url: string, fileName: string }
 */
async function uploadImage(file, productId) {
  try {
    // Verify file buffer exists
    if (!file || !file.buffer) {
      throw new Error('File buffer is missing. Cannot upload empty file.');
    }

    console.log('Starting GCS upload:', {
      productId,
      fileName: file.originalname,
      fileSize: file.size,
      mimeType: file.mimetype,
      bufferSize: file.buffer.length
    });

    // Get bucket - this will initialize GCS if not already done
    let bucket;
    try {
      bucket = getBucket();
      if (!bucket) {
        throw new Error('GCS bucket is not initialized');
      }
      console.log('GCS bucket retrieved:', bucket.name);
    } catch (bucketError) {
      console.error('GCS bucket initialization error:', {
        message: bucketError.message,
        stack: bucketError.stack
      });
      throw new Error(`GCS bucket initialization failed: ${bucketError.message}. Please check GCS configuration.`);
    }

    // Generate unique filename
    const timestamp = Date.now();
    const sanitizedOriginalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `products/${productId}/${timestamp}-${sanitizedOriginalName}`;

    console.log('Uploading to GCS path:', fileName);

    // Create file reference in bucket
    const bucketFile = bucket.file(fileName);

    // Verify bucket is accessible
    try {
      const [exists] = await bucket.exists();
      if (!exists) {
        throw new Error(`GCS bucket "${bucket.name}" does not exist or is not accessible`);
      }
    } catch (existsError) {
      console.error('GCS bucket access check failed:', {
        message: existsError.message,
        stack: existsError.stack,
        bucketName: bucket.name
      });
      throw new Error(`Cannot access GCS bucket: ${existsError.message}. Please check bucket permissions.`);
    }

    // Upload file and make it public (bucket has allUsers access)
    try {
      await bucketFile.save(file.buffer, {
        metadata: {
          contentType: file.mimetype,
          cacheControl: 'public, max-age=3600', // Cache for 1 hour (public)
        },
      });

      // Make file publicly accessible (bucket has allUsers access, but objects need to be made public)
      try {
        await bucketFile.makePublic();
        console.log('File made public successfully:', fileName);
      } catch (makePublicError) {
        console.warn('Could not make file public (may already be public or bucket-level permissions apply):', makePublicError.message);
        // Continue anyway - bucket-level permissions might be sufficient
      }

      console.log('File saved to GCS successfully:', fileName);
    } catch (saveError) {
      console.error('GCS file save error:', {
        message: saveError.message,
        stack: saveError.stack,
        fileName,
        bucketName: bucket.name,
        fileSize: file.buffer.length
      });
      throw new Error(`Failed to save file to GCS: ${saveError.message}. Check GCS permissions and quota.`);
    }

    // Files are stored as public - can use public URLs directly
    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;

    console.log('Image upload completed successfully:', {
      url: publicUrl,
      fileName,
      bucketName: bucket.name
    });

    return {
      url: publicUrl,
      fileName: fileName
    };
  } catch (error) {
    console.error('Error uploading image to GCS:', {
      message: error.message,
      stack: error.stack,
      name: error.name,
      productId,
      fileName: file?.originalname,
      fileSize: file?.size
    });

    // Provide more descriptive error messages
    if (error.message.includes('GCS') || error.message.includes('bucket') || error.message.includes('storage')) {
      throw error; // Re-throw GCS-specific errors as-is
    }
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

/**
 * Delete image from Google Cloud Storage
 * @param {String} imageUrl - Full GCS URL or file path
 * @returns {Promise<boolean>}
 */
async function deleteImage(imageUrl) {
  try {
    const bucket = getBucket();

    // Extract file path from URL
    let fileName;
    if (imageUrl.startsWith('https://storage.googleapis.com/')) {
      // Full URL format: https://storage.googleapis.com/bucket-name/path/to/file
      const urlParts = imageUrl.replace('https://storage.googleapis.com/', '').split('/');
      fileName = urlParts.slice(1).join('/'); // Remove bucket name, keep path
    } else if (imageUrl.startsWith('gs://')) {
      // gs:// format: gs://bucket-name/path/to/file
      const urlParts = imageUrl.replace('gs://', '').split('/');
      fileName = urlParts.slice(1).join('/');
    } else {
      // Assume it's already a file path
      fileName = imageUrl;
    }

    const bucketFile = bucket.file(fileName);

    // Check if file exists
    const [exists] = await bucketFile.exists();
    if (!exists) {
      console.warn(`Image file not found in GCS: ${fileName}`);
      return false;
    }

    // Delete file
    await bucketFile.delete();
    console.log(`Successfully deleted image from GCS: ${fileName}`);
    return true;
  } catch (error) {
    console.error('Error deleting image from GCS:', error);
    throw new Error(`Failed to delete image: ${error.message}`);
  }
}

/**
 * Extract file path from GCS URL
 * @param {String} imageUrl - Full GCS URL or file path
 * @returns {String} File path in bucket
 */
function extractFilePath(imageUrl) {
  if (!imageUrl) {
    return null;
  }

  if (imageUrl.startsWith('https://storage.googleapis.com/')) {
    // Full URL format: https://storage.googleapis.com/bucket-name/path/to/file
    const urlParts = imageUrl.replace('https://storage.googleapis.com/', '').split('/');
    return urlParts.slice(1).join('/'); // Remove bucket name, keep path
  } else if (imageUrl.startsWith('gs://')) {
    // gs:// format: gs://bucket-name/path/to/file
    const urlParts = imageUrl.replace('gs://', '').split('/');
    return urlParts.slice(1).join('/');
  } else {
    // Assume it's already a file path
    return imageUrl;
  }
}

/**
 * Generate signed URL for a single image
 * @param {String} imageUrl - Full GCS URL or file path
 * @param {Number} expiresInMinutes - Expiration time in minutes (default: 60)
 * @returns {Promise<String>} Signed URL or public URL as fallback
 */
async function generateSignedUrl(imageUrl, expiresInMinutes = null) {
  try {
    if (!imageUrl) {
      console.warn('generateSignedUrl called with empty imageUrl');
      return null;
    }

    const defaultExpiry = parseInt(process.env.IMAGE_SIGNED_URL_EXPIRY_MINUTES || '1440', 10); // Default: 24 hours (1440 minutes)
    const expiryMinutes = expiresInMinutes || defaultExpiry;

    // Get bucket - verify GCS is initialized
    let bucket;
    try {
      bucket = getBucket();
      if (!bucket) {
        console.error('GCS bucket is not initialized - falling back to public URL');
        return imageUrl; // Return original URL as fallback
      }
    } catch (bucketError) {
      console.error('GCS bucket initialization error in generateSignedUrl:', {
        message: bucketError.message,
        stack: bucketError.stack
      });
      return imageUrl; // Return original URL as fallback
    }

    const fileName = extractFilePath(imageUrl);

    if (!fileName) {
      console.warn('Could not extract file path from URL, using original URL:', imageUrl);
      // Return original URL as fallback
      return imageUrl;
    }

    const file = bucket.file(fileName);

    // Check if file exists
    let exists;
    try {
      [exists] = await file.exists();
      if (!exists) {
        console.warn(`Image file not found in GCS: ${fileName}, using original URL`);
        // Return original URL as fallback
        return imageUrl;
      }
    } catch (existsError) {
      console.error('Error checking file existence in GCS:', {
        message: existsError.message,
        stack: existsError.stack,
        fileName
      });
      return imageUrl; // Return original URL as fallback
    }

    // Generate signed URL
    // expires should be a Date object or number (milliseconds since epoch)
    const expires = new Date(Date.now() + (expiryMinutes * 60 * 1000));
    let signedUrl;
    try {
      [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: expires
      });
    } catch (signedUrlError) {
      console.error('Error generating signed URL:', {
        message: signedUrlError.message,
        stack: signedUrlError.stack,
        fileName,
        imageUrl
      });
      return imageUrl; // Return original URL as fallback
    }

    if (!signedUrl) {
      console.error('getSignedUrl returned null/undefined for:', imageUrl, '- using original URL');
      // Return original URL as fallback
      return imageUrl;
    }

    return signedUrl;
  } catch (error) {
    console.error('Error generating signed URL for:', {
      imageUrl,
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    // Return original URL as fallback - allow public access
    return imageUrl;
  }
}

/**
 * Generate signed URLs for multiple images
 * @param {Array<String>} imageUrls - Array of image URLs
 * @param {Number} expiresInMinutes - Expiration time in minutes (default: 60)
 * @returns {Promise<Array<String>>} Array of signed URLs (or public URLs as fallback)
 */
async function generateSignedUrls(imageUrls, expiresInMinutes = null) {
  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return [];
  }

  try {
    // Generate signed URLs in parallel
    const signedUrls = await Promise.all(
      imageUrls.map(url => generateSignedUrl(url, expiresInMinutes))
    );
    // Filter out null values (empty/invalid URLs) but keep fallback URLs
    return signedUrls.filter(url => url !== null && url !== undefined && url !== '');
  } catch (error) {
    console.error('Error generating signed URLs:', error);
    // Return original URLs as fallback
    return imageUrls.filter(url => url !== null && url !== undefined && url !== '');
  }
}

/**
 * Generate signed URLs for multiple images in a batch (optimized)
 * @param {Array<String>} imageKeys - Array of image keys/paths
 * @param {Number} expiresInMinutes - Expiration time in minutes (default: 60)
 * @returns {Promise<Object>} Map of { key: signedUrl }
 */
async function generateSignedUrlsBatch(imageKeys, expiresInMinutes = null) {
  if (!imageKeys || !Array.isArray(imageKeys) || imageKeys.length === 0) {
    return {};
  }

  // De-duplicate keys
  const uniqueKeys = [...new Set(imageKeys.filter(Boolean))];

  try {
    // Generate signed URLs in parallel for unique keys
    const entries = await Promise.all(
      uniqueKeys.map(async key => {
        const url = await generateSignedUrl(key, expiresInMinutes);
        // url will be either signed URL or original URL (fallback), never null
        return [key, url || key]; // Extra safety: return original key if somehow null
      })
    );

    return Object.fromEntries(entries);
  } catch (error) {
    console.error('Error generating batch signed URLs:', error);
    // Return map with original keys as fallback
    return Object.fromEntries(uniqueKeys.map(key => [key, key]));
  }
}

/**
 * Generate signed URL for direct upload (write access)
 * @param {String} filePath - File path in bucket (e.g., products/dispatch-123/image.jpg)
 * @param {String} mimeType - MIME type of the file
 * @param {Number} expiresInMinutes - Expiration time in minutes (default: 15)
 * @returns {Promise<String>} Signed upload URL
 */
async function generateSignedUploadUrl(filePath, mimeType, expiresInMinutes = 15) {
  try {
    if (!filePath) {
      throw new Error('File path is required');
    }

    if (!mimeType) {
      throw new Error('MIME type is required');
    }

    // Validate MIME type
    if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
      throw new Error(`Invalid MIME type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`);
    }

    // Get bucket
    let bucket;
    try {
      bucket = getBucket();
      if (!bucket) {
        throw new Error('GCS bucket is not initialized');
      }
    } catch (bucketError) {
      console.error('GCS bucket initialization error in generateSignedUploadUrl:', {
        message: bucketError.message,
        stack: bucketError.stack
      });
      throw new Error(`GCS bucket initialization failed: ${bucketError.message}`);
    }

    const file = bucket.file(filePath);

    // Generate signed URL for upload (write action)
    const expires = Date.now() + (expiresInMinutes * 60 * 1000);

    console.log('Generating signed upload URL:', {
      filePath,
      mimeType,
      expiresInMinutes,
      bucketName: bucket.name
    });

    const [signedUrl] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: expires,
      contentType: mimeType,
    });

    if (!signedUrl) {
      throw new Error('Failed to generate signed upload URL');
    }

    console.log('Signed upload URL generated successfully');

    return signedUrl;
  } catch (error) {
    console.error('Error generating signed upload URL:', {
      filePath,
      mimeType,
      message: error.message,
      stack: error.stack
    });
    throw new Error(`Failed to generate signed upload URL: ${error.message}`);
  }
}

/**
 * Verify that a file exists in GCS
 * @param {String} filePath - File path in bucket
 * @returns {Promise<boolean>}
 */
async function verifyFileExists(filePath) {
  try {
    if (!filePath) {
      return false;
    }

    const bucket = getBucket();
    const file = bucket.file(filePath);
    const [exists] = await file.exists();

    return exists;
  } catch (error) {
    console.error('Error verifying file existence:', {
      filePath,
      message: error.message
    });
    return false;
  }
}

/**
 * Get image URL helper (with fallback)
 * @param {Array} images - Array of image URLs
 * @param {String} fallbackUrl - Fallback URL if no images
 * @returns {String}
 */
function getImageUrl(images, fallbackUrl = null) {
  if (images && images.length > 0 && images[0]) {
    return images[0];
  }
  return fallbackUrl;
}

module.exports = {
  validateImageFile,
  uploadImage,
  deleteImage,
  getImageUrl,
  generateSignedUrl,
  generateSignedUrls,
  generateSignedUrlsBatch,
  generateSignedUploadUrl,
  verifyFileExists,
  extractFilePath,
  MAX_IMAGE_SIZE_MB,
  ALLOWED_MIME_TYPES
};

