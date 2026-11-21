// Generates the demo Excel files a training centre can upload.
// Run: node scripts/make-sample-xlsx.ts  from backend/ (writes to ../frontend/public/samples)
import path from 'node:path';
import ExcelJS from 'exceljs';

const OUT = path.resolve(process.cwd(), '../frontend/public/samples');
const FIRST = ['Aarav', 'Diya', 'Rohan', 'Isha', 'Kiran', 'Pooja', 'Arjun', 'Sneha', 'Vikram', 'Neel', 'Tara', 'Manav', 'Riya', 'Kabir', 'Anaya'];
const LAST = ['Patil', 'Sharma', 'Deshmukh', 'Kulkarni', 'Joshi', 'Shinde', 'Pawar', 'Iyer', 'Gaikwad', 'More'];
const HEADERS = ['Name', 'Enrollment No', 'Phone', 'Date of Birth', 'Grade'];

type Row = [string, string, string, Date | string, string];

function goodRows(prefix: string, count: number, phoneStart: number): Row[] {
  return Array.from({ length: count }, (_, i) => [
    `${FIRST[i % FIRST.length]} ${LAST[(i * 3) % LAST.length]}`,
    `${prefix}-${String(i + 1).padStart(4, '0')}`,
    String(phoneStart + i),
    new Date(Date.UTC(1998 + (i % 8), i % 12, (i % 27) + 1)),
    ['A', 'B', 'C', 'D'][i % 4],
  ]);
}

async function write(file: string, rows: Row[], note?: string) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'CertiFlow demo';
  // The upload reads the FIRST sheet, so candidates go first.
  const ws = wb.addWorksheet('Candidates');
  ws.addRow(HEADERS).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  ws.columns = [{ width: 24 }, { width: 18 }, { width: 16 }, { width: 15, style: { numFmt: 'yyyy-mm-dd' } }, { width: 8 }];
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  if (note) {
    const info = wb.addWorksheet('Read me');
    note.split('\n').forEach((l) => info.addRow([l]));
    info.getColumn(1).width = 100;
  }
  await wb.xlsx.writeFile(path.join(OUT, file));
  console.log(`wrote ${file} (${rows.length} rows)`);
}

async function main() {
  await write('demo_batch_10.xlsx', goodRows('XL-PL26', 10, 9810000000),
    'Small batch (10 candidates): District (2 officers) -> State office -> certificates.');
  await write('demo_batch_60.xlsx', goodRows('XL-DE26', 60, 9820000000),
    'Large batch (60 candidates, >= 50): District (2 officers) -> Quality team (Neha) -> State office.');

  const bad: Row[] = [
    ['Asha Patil', 'XL-BAD-0001', '9830000001', new Date(Date.UTC(2001, 3, 12)), 'A'], // ok
    ['Rohan Joshi', 'XL-BAD-0002', '12345', new Date(Date.UTC(2002, 4, 1)), 'B'], // bad phone
    ['Isha Shinde', 'XL-BAD-0003', '9830000003', '31/02/2001', 'C'], // impossible date
    ['Kiran Pawar', 'XL-BAD-0001', '9830000004', new Date(Date.UTC(2000, 0, 1)), 'A'], // duplicate enrollment
    ['', 'XL-BAD-0005', '9830000005', new Date(Date.UTC(2000, 0, 1)), 'E'], // missing name + bad grade
    ['Manav Iyer', 'XL-BAD-0006', '9830000006', new Date(Date.UTC(2020, 0, 1)), 'B'], // age 6: too young
    ['Tara More', 'XL-BAD-0007', '9830000007', new Date(Date.UTC(1999, 6, 9)), 'D'], // ok
  ];
  await write('demo_batch_with_errors.xlsx', bad,
    'Contains 5 bad rows on purpose (rows 3-7). Uploading it shows every problem by row and column, and saves nothing.\n' +
      'Row 3: bad phone | Row 4: 31 Feb | Row 5: duplicate enrollment of row 2 | Row 6: no name, grade E | Row 7: age 6');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
