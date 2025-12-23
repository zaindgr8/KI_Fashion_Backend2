const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Generate invoice PDF for a sale
 * @param {Object} sale - Sale document with populated buyer and items
 * @param {String} outputPath - Path to save the PDF file
 * @returns {Promise<String>} Path to the generated PDF file
 */
async function generateInvoicePDF(sale, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const stream = fs.createWriteStream(outputPath);
      doc.pipe(stream);

      // Company Header
      doc.fontSize(20).font('Helvetica-Bold').text('KL Fashion', 50, 50);
      doc.fontSize(10).font('Helvetica').text('Invoice', { align: 'right' });
      doc.moveDown(0.5);

      // Invoice Details
      doc.fontSize(10).font('Helvetica');
      doc.text(`Invoice Number: ${sale.invoiceNumber || sale.saleNumber}`, { align: 'right' });
      doc.text(`Sale Number: ${sale.saleNumber}`, { align: 'right' });
      doc.text(`Date: ${new Date(sale.saleDate).toLocaleDateString('en-GB')}`, { align: 'right' });
      doc.moveDown(1);

      // Bill To Section
      doc.fontSize(12).font('Helvetica-Bold').text('Bill To:', 50, doc.y);
      doc.fontSize(10).font('Helvetica');
      if (sale.buyer) {
        doc.text(sale.buyer.name || 'N/A');
        if (sale.buyer.company) doc.text(sale.buyer.company);
        if (sale.buyer.email) doc.text(sale.buyer.email);
        if (sale.buyer.phone) doc.text(sale.buyer.phone);
        if (sale.buyer.address) doc.text(sale.buyer.address);
      }
      doc.moveDown(1.5);

      // Items Table Header
      const tableTop = doc.y;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Item', 50, tableTop);
      doc.text('Quantity', 250, tableTop);
      doc.text('Unit Price', 320, tableTop);
      doc.text('Discount', 400, tableTop);
      doc.text('Tax', 460, tableTop);
      doc.text('Total', 500, tableTop);

      // Draw line under header
      doc.moveTo(50, tableTop + 15).lineTo(550, tableTop + 15).stroke();
      doc.moveDown(0.5);

      // Items
      let currentY = doc.y;
      doc.fontSize(9).font('Helvetica');
      
      sale.items.forEach((item, index) => {
        const productName = item.product?.name || item.productName || 'Product';
        const quantity = item.quantity || 0;
        const unitPrice = item.unitPrice || 0;
        const discount = item.discount || 0;
        const taxRate = item.taxRate || 0;
        const itemSubtotal = (quantity * unitPrice) - discount;
        const itemTax = itemSubtotal * (taxRate / 100);
        const itemTotal = itemSubtotal + itemTax;

        // Check if we need a new page
        if (currentY > 700) {
          doc.addPage();
          currentY = 50;
        }

        doc.text(productName.substring(0, 25), 50, currentY);
        doc.text(quantity.toString(), 250, currentY);
        doc.text(`€${unitPrice.toFixed(2)}`, 320, currentY);
        doc.text(`€${discount.toFixed(2)}`, 400, currentY);
        doc.text(`${taxRate.toFixed(1)}%`, 460, currentY);
        doc.text(`€${itemTotal.toFixed(2)}`, 500, currentY);
        
        currentY += 20;
      });

      doc.y = currentY + 10;

      // Draw line before totals
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.5);

      // Totals Section
      const totalsX = 400;
      doc.fontSize(10).font('Helvetica');
      doc.text('Subtotal:', totalsX, doc.y);
      doc.text(`€${(sale.subtotal || 0).toFixed(2)}`, 500, doc.y);
      doc.moveDown(0.3);

      if (sale.totalDiscount > 0) {
        doc.text('Discount:', totalsX, doc.y);
        doc.text(`-€${(sale.totalDiscount || 0).toFixed(2)}`, 500, doc.y);
        doc.moveDown(0.3);
      }

      if (sale.shippingCost > 0) {
        doc.text('Shipping:', totalsX, doc.y);
        doc.text(`€${(sale.shippingCost || 0).toFixed(2)}`, 500, doc.y);
        doc.moveDown(0.3);
      }

      if (sale.totalTax > 0) {
        doc.text('Tax:', totalsX, doc.y);
        doc.text(`€${(sale.totalTax || 0).toFixed(2)}`, 500, doc.y);
        doc.moveDown(0.3);
      }

      // Grand Total
      doc.fontSize(12).font('Helvetica-Bold');
      doc.moveDown(0.3);
      doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
      doc.moveDown(0.3);
      doc.text('Grand Total:', totalsX, doc.y);
      doc.text(`€${(sale.grandTotal || 0).toFixed(2)}`, 500, doc.y);

      // Payment Information
      doc.moveDown(1);
      doc.fontSize(10).font('Helvetica');
      if (sale.paymentMethod) {
        doc.text(`Payment Method: ${sale.paymentMethod.toUpperCase()}`);
      }
      if (sale.paymentStatus) {
        doc.text(`Payment Status: ${sale.paymentStatus.toUpperCase()}`);
      }
      if (sale.cashPayment > 0 || sale.bankPayment > 0) {
        const totalPaid = (sale.cashPayment || 0) + (sale.bankPayment || 0);
        const remaining = sale.grandTotal - totalPaid;
        doc.text(`Amount Paid: €${totalPaid.toFixed(2)}`);
        if (remaining > 0) {
          doc.text(`Remaining Balance: €${remaining.toFixed(2)}`);
        }
      }

      // Notes
      if (sale.notes) {
        doc.moveDown(1);
        doc.fontSize(10).font('Helvetica-Bold').text('Notes:');
        doc.fontSize(9).font('Helvetica').text(sale.notes);
      }

      // Footer
      doc.fontSize(8).font('Helvetica');
      const pageHeight = doc.page.height;
      const pageWidth = doc.page.width;
      doc.text('Thank you for your business!', 50, pageHeight - 50, { align: 'center' });
      doc.text('For inquiries, please contact KL Fashion', 50, pageHeight - 35, { align: 'center' });

      // QR Code (if available)
      if (sale.qrCode && sale.qrCode.dataUrl) {
        try {
          // Convert data URL to buffer
          const base64Data = sale.qrCode.dataUrl.replace(/^data:image\/png;base64,/, '');
          const imageBuffer = Buffer.from(base64Data, 'base64');
          
          // Add QR code to bottom right
          doc.image(imageBuffer, pageWidth - 100, pageHeight - 80, { width: 50, height: 50 });
          doc.fontSize(7).text('Scan for details', pageWidth - 100, pageHeight - 25, { width: 50, align: 'center' });
        } catch (qrError) {
          console.error('Error adding QR code to PDF:', qrError);
        }
      }

      doc.end();

      stream.on('finish', () => {
        resolve(outputPath);
      });

      stream.on('error', (error) => {
        reject(error);
      });

    } catch (error) {
      reject(error);
    }
  });
}

module.exports = {
  generateInvoicePDF
};

