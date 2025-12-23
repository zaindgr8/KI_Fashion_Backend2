// kl-backend-v2/scripts/format-gcs-credentials.js

const fs = require('fs');
const path = require('path');

/**
 * Script to convert GCS service account JSON file to environment variable format
 * Properly escapes newlines in private_key field and minifies JSON
 */

function formatGCSCredentials() {
  console.log('=== GCS Credentials Formatter ===\n');

  // Get input file path from command line or use default
  const inputPath = process.argv[2] || path.join(__dirname, '../config/gcs-service-account.json');

  // Check if file exists
  if (!fs.existsSync(inputPath)) {
    console.error(`❌ Error: File not found at: ${inputPath}`);
    console.log('\nUsage:');
    console.log('  node scripts/format-gcs-credentials.js [path-to-json-file]');
    console.log('\nExample:');
    console.log('  node scripts/format-gcs-credentials.js ./config/gcs-service-account.json');
    process.exit(1);
  }

  console.log(`📂 Reading file: ${inputPath}\n`);

  try {
    // Read the JSON file
    const fileContent = fs.readFileSync(inputPath, 'utf8');
    
    // Parse to validate it's valid JSON
    let credentials;
    try {
      credentials = JSON.parse(fileContent);
    } catch (parseError) {
      console.error(`❌ Error: Invalid JSON file. ${parseError.message}`);
      process.exit(1);
    }

    // Validate required fields
    const requiredFields = ['type', 'project_id', 'private_key', 'client_email'];
    const missingFields = requiredFields.filter(field => !credentials[field]);
    
    if (missingFields.length > 0) {
      console.error(`❌ Error: Missing required fields: ${missingFields.join(', ')}`);
      process.exit(1);
    }

    console.log('✅ Valid service account JSON detected');
    console.log(`   Project ID: ${credentials.project_id}`);
    console.log(`   Client Email: ${credentials.client_email}\n`);

    // Convert to single-line JSON with properly escaped newlines
    // The private_key already contains \n as literal characters in the string
    // We need to keep them as \\n in the final string
    const singleLineJson = JSON.stringify(credentials);

    console.log('✅ Formatted for environment variable\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📋 Copy the following value for GOOGLE_APPLICATION_CREDENTIALS_JSON:');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(singleLineJson);
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Optionally save to a file
    const outputPath = path.join(__dirname, '../config/gcs-credentials-formatted.txt');
    fs.writeFileSync(outputPath, singleLineJson, 'utf8');
    console.log(`💾 Also saved to: ${outputPath}\n`);

    // Create .env example
    const envExample = `# Add this to your .env file or Railway environment variables:\nGOOGLE_APPLICATION_CREDENTIALS_JSON=${singleLineJson}\n`;
    const envOutputPath = path.join(__dirname, '../config/gcs-credentials.env.example');
    fs.writeFileSync(envOutputPath, envExample, 'utf8');
    console.log(`💾 .env example saved to: ${envOutputPath}\n`);

    console.log('📝 Instructions:');
    console.log('   1. Copy the formatted JSON above');
    console.log('   2. In Railway: Go to your project → Variables tab');
    console.log('   3. Add variable: GOOGLE_APPLICATION_CREDENTIALS_JSON');
    console.log('   4. Paste the formatted JSON as the value');
    console.log('   5. Deploy your changes\n');

    // Verify by parsing it again
    try {
      const verified = JSON.parse(singleLineJson);
      console.log('✅ Verification: Formatted JSON is valid and can be parsed correctly');
      
      // Check if private key has proper escaping
      if (verified.private_key && verified.private_key.includes('\n')) {
        console.log('✅ Verification: Private key newlines are properly preserved');
      }
    } catch (verifyError) {
      console.error('❌ Warning: Formatted JSON failed verification:', verifyError.message);
    }

  } catch (error) {
    console.error(`❌ Error: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the script
formatGCSCredentials();