const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');

let storage = null;
let bucketName = null;

/**
 * Initialize Google Cloud Storage client with flexible credential loading
 * Supports both environment variable (production) and file path (local dev)
 */
function initializeGCS() {
  if (storage) {
    return { storage, bucketName };
  }

  // Get bucket name from environment or use hardcoded default
  bucketName = process.env.GCS_BUCKET_NAME || "kl-fashion-crm-storage";
  
  if (!bucketName) {
    throw new Error(
      'GCS_BUCKET_NAME environment variable is required. ' +
      'Please set it in your .env file or environment variables.'
    );
  }

  let credentials = null;

  // Primary method: Use JSON from environment variable (production)
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
    try {
      // Try parsing as JSON string
      credentials = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      console.log('GCS: Using credentials from GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable');
    } catch (error) {
      throw new Error(
        'Failed to parse GOOGLE_APPLICATION_CREDENTIALS_JSON. ' +
        'Ensure it contains valid JSON. Error: ' + error.message
      );
    }
  }
  // Secondary method: Use file path from environment variable (local development)
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH) {
    const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS_PATH);
    
    if (!fs.existsSync(credentialsPath)) {
      throw new Error(
        `GCS credentials file not found at: ${credentialsPath}. ` +
        'Please ensure GOOGLE_APPLICATION_CREDENTIALS_PATH points to a valid JSON file.'
      );
    }

    try {
      const credentialsContent = fs.readFileSync(credentialsPath, 'utf8');
      credentials = JSON.parse(credentialsContent);
      console.log(`GCS: Using credentials from file: ${credentialsPath}`);
    } catch (error) {
      throw new Error(
        `Failed to read or parse credentials file at ${credentialsPath}. ` +
        `Error: ${error.message}`
      );
    }
  }
  // Fallback method: Try to use local credentials file in config directory (development only)
  else {
    const defaultCredentialsPath = path.join(__dirname, 'gcs-service-account.json');
    
    // Only use local file in development, not in production
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Google Cloud Storage credentials not configured for production. ' +
        'Please set GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable with your service account JSON. ' +
        'In Railway: Go to Variables tab and add GOOGLE_APPLICATION_CREDENTIALS_JSON with the full JSON as a single-line string.'
      );
    }
    
    if (fs.existsSync(defaultCredentialsPath)) {
      try {
        const credentialsContent = fs.readFileSync(defaultCredentialsPath, 'utf8');
        credentials = JSON.parse(credentialsContent);
        console.log(`GCS: Using credentials from default file: ${defaultCredentialsPath}`);
      } catch (error) {
        throw new Error(
          `Failed to read or parse default credentials file at ${defaultCredentialsPath}. ` +
          `Error: ${error.message}`
        );
      }
    } else {
      throw new Error(
        'Google Cloud Storage credentials not configured. ' +
        'For production: Set GOOGLE_APPLICATION_CREDENTIALS_JSON environment variable. ' +
        'For development: Set GOOGLE_APPLICATION_CREDENTIALS_PATH or place credentials file at: ' +
        `${defaultCredentialsPath}`
      );
    }
  }

  // Validate credentials structure
  if (!credentials.project_id || !credentials.private_key || !credentials.client_email) {
    throw new Error(
      'Invalid GCS credentials format. ' +
      'Credentials must include project_id, private_key, and client_email.'
    );
  }

  // Initialize Storage client
  try {
    storage = new Storage({
      projectId: credentials.project_id,
      credentials: credentials
    });

    console.log(`GCS: Initialized successfully for project ${credentials.project_id}, bucket: ${bucketName}`);
    console.log(`GCS: Service account: ${credentials.client_email}`);
    
    // Verify bucket access and permissions
    const bucket = storage.bucket(bucketName);
    bucket.exists()
      .then(([exists]) => {
        if (exists) {
          console.log(`GCS: Bucket "${bucketName}" exists and is accessible`);
        } else {
          console.warn(`GCS: WARNING - Bucket "${bucketName}" does not exist or is not accessible`);
        }
      })
      .catch((error) => {
        console.error(`GCS: ERROR - Failed to verify bucket access: ${error.message}`);
        console.error(`GCS: Please ensure the service account has the following IAM permissions:`);
        console.error(`GCS:   - storage.objects.get`);
        console.error(`GCS:   - storage.objects.create`);
        console.error(`GCS:   - storage.objects.delete`);
        console.error(`GCS:   - storage.buckets.get`);
      });
    
    return { storage, bucketName };
  } catch (error) {
    throw new Error(
      'Failed to initialize Google Cloud Storage client. ' +
      `Error: ${error.message}`
    );
  }
}

/**
 * Get Storage instance (initializes if not already done)
 */
function getStorage() {
  if (!storage) {
    initializeGCS();
  }
  return storage;
}

/**
 * Get bucket name
 */
function getBucketName() {
  if (!bucketName) {
    initializeGCS();
  }
  return bucketName;
}

/**
 * Get bucket instance
 */
function getBucket() {
  const storage = getStorage();
  const bucketName = getBucketName();
  return storage.bucket(bucketName);
}

module.exports = {
  initializeGCS,
  getStorage,
  getBucketName,
  getBucket
};

