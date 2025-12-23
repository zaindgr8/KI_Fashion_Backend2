const nodemailer = require('nodemailer');
const fs = require('fs');

let transporter = null;

/**
 * Initialize email transporter
 */
function initializeEmailService() {
  if (transporter) {
    return transporter;
  }

  // Create transporter based on environment variables
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD
    }
  });

  return transporter;
}

/**
 * Send email with PDF attachment
 * @param {Object} options - Email options
 * @param {String|Array} options.to - Recipient email(s)
 * @param {String} options.subject - Email subject
 * @param {String} options.html - HTML email body
 * @param {String} options.text - Plain text email body (optional)
 * @param {String} options.pdfPath - Path to PDF file to attach
 * @param {String} options.attachmentName - Name for the PDF attachment
 * @returns {Promise<Object>} Email send result
 */
async function sendEmailWithPDF({ to, subject, html, text, pdfPath, attachmentName }) {
  try {
    const emailTransporter = initializeEmailService();

    if (!emailTransporter) {
      throw new Error('Email service not configured. Please set SMTP environment variables.');
    }

    // Verify transporter configuration
    await emailTransporter.verify();

    const mailOptions = {
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: subject,
      html: html,
      text: text || html.replace(/<[^>]*>/g, ''), // Strip HTML for text version
      attachments: []
    };

    // Add PDF attachment if provided
    if (pdfPath && fs.existsSync(pdfPath)) {
      mailOptions.attachments.push({
        filename: attachmentName || 'invoice.pdf',
        path: pdfPath,
        contentType: 'application/pdf'
      });
    }

    const info = await emailTransporter.sendMail(mailOptions);
    return {
      success: true,
      messageId: info.messageId,
      response: info.response
    };

  } catch (error) {
    console.error('Email send error:', error);
    throw new Error(`Failed to send email: ${error.message}`);
  }
}

/**
 * Send invoice email to distributor and admin
 * @param {Object} sale - Sale document
 * @param {String} pdfPath - Path to invoice PDF
 * @param {String} distributorEmail - Distributor email address
 * @param {String} adminEmail - Admin email address
 * @returns {Promise<Object>} Email send results
 */
async function sendInvoiceEmails(sale, pdfPath, distributorEmail, adminEmail) {
  const invoiceNumber = sale.invoiceNumber || sale.saleNumber;
  const saleDate = new Date(sale.saleDate).toLocaleDateString('en-GB');
  const grandTotal = sale.grandTotal.toFixed(2);

  const htmlBody = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #2b6cb0; color: white; padding: 20px; text-align: center; }
        .content { padding: 20px; background-color: #f8f9fa; }
        .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        .invoice-details { background-color: white; padding: 15px; margin: 20px 0; border-left: 4px solid #2b6cb0; }
        .button { display: inline-block; padding: 10px 20px; background-color: #2b6cb0; color: white; text-decoration: none; border-radius: 4px; margin-top: 10px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h2>Invoice from KL Fashion</h2>
        </div>
        <div class="content">
          <p>Dear ${sale.buyer?.name || 'Customer'},</p>
          <p>Thank you for your purchase. Please find your invoice attached.</p>
          
          <div class="invoice-details">
            <h3>Invoice Details</h3>
            <p><strong>Invoice Number:</strong> ${invoiceNumber}</p>
            <p><strong>Sale Number:</strong> ${sale.saleNumber}</p>
            <p><strong>Date:</strong> ${saleDate}</p>
            <p><strong>Total Amount:</strong> €${grandTotal}</p>
            <p><strong>Payment Status:</strong> ${sale.paymentStatus?.toUpperCase() || 'PENDING'}</p>
          </div>

          <p>The invoice PDF is attached to this email for your records.</p>
          
          <p>If you have any questions about this invoice, please contact us.</p>
          
          <p>Best regards,<br>KL Fashion</p>
        </div>
        <div class="footer">
          <p>This is an automated email. Please do not reply to this message.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const textBody = `
    Invoice from KL Fashion
    
    Dear ${sale.buyer?.name || 'Customer'},
    
    Thank you for your purchase. Please find your invoice attached.
    
    Invoice Details:
    - Invoice Number: ${invoiceNumber}
    - Sale Number: ${sale.saleNumber}
    - Date: ${saleDate}
    - Total Amount: €${grandTotal}
    - Payment Status: ${sale.paymentStatus?.toUpperCase() || 'PENDING'}
    
    The invoice PDF is attached to this email for your records.
    
    If you have any questions about this invoice, please contact us.
    
    Best regards,
    KL Fashion
  `;

  const results = {
    distributor: null,
    admin: null
  };

  // Send to distributor
  if (distributorEmail) {
    try {
      results.distributor = await sendEmailWithPDF({
        to: distributorEmail,
        subject: `Invoice ${invoiceNumber} - KL Fashion`,
        html: htmlBody,
        text: textBody,
        pdfPath: pdfPath,
        attachmentName: `Invoice-${invoiceNumber}.pdf`
      });
    } catch (error) {
      console.error('Error sending email to distributor:', error);
      results.distributor = { success: false, error: error.message };
    }
  }

  // Send to admin
  if (adminEmail) {
    try {
      const adminHtmlBody = htmlBody.replace(
        `Dear ${sale.buyer?.name || 'Customer'},`,
        'Dear Admin,<br><br>A new sale has been completed. Please find the invoice attached.'
      );
      
      results.admin = await sendEmailWithPDF({
        to: adminEmail,
        subject: `New Sale Invoice ${invoiceNumber} - ${sale.buyer?.name || 'Customer'}`,
        html: adminHtmlBody,
        text: textBody.replace(
          `Dear ${sale.buyer?.name || 'Customer'},`,
          'Dear Admin,\n\nA new sale has been completed. Please find the invoice attached.'
        ),
        pdfPath: pdfPath,
        attachmentName: `Invoice-${invoiceNumber}.pdf`
      });
    } catch (error) {
      console.error('Error sending email to admin:', error);
      results.admin = { success: false, error: error.message };
    }
  }

  return results;
}

module.exports = {
  initializeEmailService,
  sendEmailWithPDF,
  sendInvoiceEmails
};

