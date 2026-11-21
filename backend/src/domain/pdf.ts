// Certificate PDF rendering. Deterministic for a given certificate, so
// re-running after a crash simply overwrites the same file.
import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { config } from '../config';

export interface PdfInput {
  id: string;
  number: string;
  verifyCode: string;
  holderName: string;
  course: string;
  centreName: string;
  issuedAt: Date;
}

export function verifyUrl(number: string, code: string) {
  return `${config.publicBaseUrl}/verify?n=${encodeURIComponent(number)}&c=${encodeURIComponent(code)}`;
}

export async function renderCertificatePdf(cert: PdfInput): Promise<Buffer> {
  const qr = await QRCode.toBuffer(verifyUrl(cert.number, cert.verifyCode), { margin: 1, width: 160 });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50, info: { Title: cert.number } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  const w = doc.page.width;
  doc.rect(25, 25, w - 50, doc.page.height - 50).lineWidth(3).stroke('#1f4e79');
  doc.fillColor('#1f4e79').fontSize(14).text('PRAGATI SKILLS MISSION', 0, 70, { align: 'center' });
  doc.fontSize(32).text('Certificate of Skill', 0, 100, { align: 'center' });
  doc.fillColor('#333').fontSize(14).text('This certifies that', 0, 170, { align: 'center' });
  doc.fillColor('#000').fontSize(28).text(cert.holderName, 0, 195, { align: 'center' });
  doc.fillColor('#333').fontSize(14).text('has successfully completed the course', 0, 245, { align: 'center' });
  doc.fillColor('#000').fontSize(20).text(cert.course, 0, 270, { align: 'center' });
  doc.fillColor('#333').fontSize(12).text(`at ${cert.centreName}`, 0, 305, { align: 'center' });

  doc.fontSize(11).fillColor('#000');
  doc.text(`Certificate No: ${cert.number}`, 70, 420);
  doc.text(`Verification code: ${cert.verifyCode}`, 70, 438);
  doc.text(`Issued: ${cert.issuedAt.toISOString().slice(0, 10)}`, 70, 456);
  doc.fontSize(9).fillColor('#555').text(`Verify at ${config.publicBaseUrl}/verify`, 70, 480);
  doc.image(qr, w - 230, 380, { width: 140 });
  doc.end();
  return done;
}

export async function writeCertificatePdf(cert: PdfInput): Promise<string> {
  const buf = await renderCertificatePdf(cert);
  await fs.mkdir(config.certificateDir, { recursive: true });
  const file = path.join(config.certificateDir, `${cert.id}.pdf`);
  // Write to a temp file then rename: readers never see a half-written PDF.
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, file);
  return file;
}
