// Generates a NEW Excel batch whose enrollment numbers and phones have never
// been used, so it never clashes with "already in another batch".
// Each run uses a unique prefix based on the current time.
//
// Run from the repo root:   node backend/scripts/make-fresh-batch.ts [count]
// Output: frontend/public/samples/fresh_batch_<PREFIX>_<count>.xlsx
import path from 'node:path';
import ExcelJS from 'exceljs';

const count = Math.max(1, Math.min(1000, Number(process.argv[2] ?? 20)));
const FIRST = ['Aditi', 'Rahul', 'Meghna', 'Siddharth', 'Kavya', 'Omkar', 'Nisha', 'Yash', 'Priya', 'Harsh', 'Sana', 'Varun', 'Ira', 'Dhruv', 'Lata'];
const LAST = ['Bhosale', 'Chavan', 'Jadhav', 'Nair', 'Mehta', 'Rane', 'Sawant', 'Kale', 'Desai', 'Rao'];

// Unique per run: e.g. "FR-K9X2A". Phones derive from the same clock value.
const stamp = Date.now().toString(36).toUpperCase().slice(-5);
const prefix = `FR-${stamp}`;
const phoneBase = 6000000000 + (Date.now() % 3_000_000_000); // starts with 6-8: a valid Indian mobile

async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Candidates');
  ws.addRow(['Name', 'Enrollment No', 'Phone', 'Date of Birth', 'Grade']).font = { bold: true };
  for (let i = 0; i < count; i++) {
    ws.addRow([
      `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
      `${prefix}-${String(i + 1).padStart(4, '0')}`,
      String(phoneBase + i),
      new Date(Date.UTC(1997 + (i % 9), i % 12, (i % 27) + 1)),
      ['A', 'B', 'C', 'D'][i % 4],
    ]);
  }
  ws.columns = [{ width: 24 }, { width: 20 }, { width: 16 }, { width: 15, style: { numFmt: 'yyyy-mm-dd' } }, { width: 8 }];
  const file = path.resolve(process.cwd(), 'frontend/public/samples', `fresh_batch_${stamp}_${count}.xlsx`);
  await wb.xlsx.writeFile(file);
  console.log(`wrote ${file}`);
  console.log(`enrollments ${prefix}-0001..${String(count).padStart(4, '0')}, phones +91${phoneBase}..+91${phoneBase + count - 1}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
