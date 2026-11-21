// Parse and validate a centre's candidate spreadsheet (CSV or XLSX).
// Validation is all-or-nothing: we collect EVERY problem with its row and
// column so the centre can fix them in one go, and the caller saves nothing
// unless the error list is empty.
import { parse } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { config } from '../config';

export interface RowError {
  row: number; // 1-based spreadsheet row, header = row 1
  column: string;
  message: string;
}

export interface ValidCandidate {
  rowNumber: number;
  name: string;
  enrollmentNo: string;
  phone: string; // normalised +91XXXXXXXXXX
  dateOfBirth: Date;
  grade: string;
}

export const REQUIRED_COLUMNS = ['name', 'enrollment_no', 'phone', 'date_of_birth', 'grade'] as const;
const GRADES = ['A', 'B', 'C', 'D'];

/** Normalise header text: " Enrollment No " -> "enrollment_no". */
function normHeader(h: unknown): string {
  return String(h ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Accepts 9876543210, +91 98765 43210, 091-9876543210 ... -> +919876543210 */
export function normalisePhone(raw: string): string | null {
  let digits = raw.replace(/[\s\-()]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (!/^\d+$/.test(digits)) return null;
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[6-9]\d{9}$/.test(digits)) return null;
  return `+91${digits}`;
}

/** Accepts YYYY-MM-DD or DD/MM/YYYY (and DD-MM-YYYY). Rejects impossible dates. */
export function parseDate(raw: string): Date | null {
  let y: number, m: number, d: number;
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else {
    match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw);
    if (!match) return null;
    [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])];
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function ageOn(dob: Date, now: Date): number {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  return beforeBirthday ? age - 1 : age;
}

const nameSchema = z
  .string()
  .min(2, 'Name must have at least 2 characters')
  .max(100, 'Name is too long')
  .regex(/^[\p{L} .'-]+$/u, 'Name may only contain letters, spaces, . \' and -');
const enrollmentSchema = z
  .string()
  .regex(/^[A-Z0-9][A-Z0-9-]{3,29}$/, 'Enrollment number must be 4-30 characters of A-Z, 0-9 or -');

type RawRow = Record<string, string>;

/** Turn the uploaded file into header-keyed string rows. */
export async function readRows(buffer: Buffer, filename: string): Promise<{ headers: string[]; rows: RawRow[] }> {
  if (/\.xlsx$/i.test(filename)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return { headers: [], rows: [] };
    const headers: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => (headers[col - 1] = normHeader(cell.text)));
    const rows: RawRow[] = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row: RawRow = {};
      headers.forEach((h, i) => {
        const cell = ws.getRow(r).getCell(i + 1);
        // Excel stores dates as Date objects; render them as ISO dates.
        row[h] = cell.value instanceof Date ? cell.value.toISOString().slice(0, 10) : cell.text ?? '';
      });
      rows.push(row);
    }
    return { headers, rows };
  }
  if (/\.csv$/i.test(filename)) {
    const records: string[][] = parse(buffer, { bom: true, skip_empty_lines: false, relax_column_count: true, trim: true });
    const headers = (records[0] ?? []).map(normHeader);
    const rows = records.slice(1).map((rec) => Object.fromEntries(headers.map((h, i) => [h, rec[i] ?? ''])));
    return { headers, rows };
  }
  throw new Error('UNSUPPORTED_FILE');
}

/**
 * Validate every row. Rows that are completely blank are skipped (Excel often
 * leaves trailing empty rows) but keep their row numbers so errors line up
 * with what the centre sees in their spreadsheet.
 */
export function validateRows(
  headers: string[],
  rows: RawRow[],
  now = new Date(),
): { candidates: ValidCandidate[]; errors: RowError[] } {
  const errors: RowError[] = [];
  const missing = REQUIRED_COLUMNS.filter((c) => !headers.includes(c));
  if (missing.length) {
    return {
      candidates: [],
      errors: missing.map((c) => ({ row: 1, column: c, message: `Missing required column "${c}"` })),
    };
  }

  const candidates: ValidCandidate[] = [];
  const seenEnrollment = new Map<string, number>();

  rows.forEach((raw, i) => {
    const rowNumber = i + 2;
    if (REQUIRED_COLUMNS.every((c) => !raw[c]?.trim())) return; // blank row
    const rowErrors: RowError[] = [];
    const err = (column: string, message: string) => rowErrors.push({ row: rowNumber, column, message });

    const name = (raw.name ?? '').trim().replace(/\s+/g, ' ');
    const n = nameSchema.safeParse(name);
    if (!n.success) err('name', name ? n.error.issues[0].message : 'Name is required');

    const enrollmentNo = (raw.enrollment_no ?? '').trim().toUpperCase();
    const e = enrollmentSchema.safeParse(enrollmentNo);
    if (!enrollmentNo) err('enrollment_no', 'Enrollment number is required');
    else if (!e.success) err('enrollment_no', e.error.issues[0].message);
    else if (seenEnrollment.has(enrollmentNo)) {
      err('enrollment_no', `Duplicate of row ${seenEnrollment.get(enrollmentNo)}`);
    } else seenEnrollment.set(enrollmentNo, rowNumber);

    const phoneRaw = (raw.phone ?? '').trim();
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    if (!phoneRaw) err('phone', 'Phone is required');
    else if (!phone) err('phone', `"${phoneRaw}" is not a valid Indian mobile number`);

    const dobRaw = (raw.date_of_birth ?? '').trim();
    const dob = dobRaw ? parseDate(dobRaw) : null;
    if (!dobRaw) err('date_of_birth', 'Date of birth is required');
    else if (!dob) err('date_of_birth', `"${dobRaw}" is not a valid date (use YYYY-MM-DD or DD/MM/YYYY)`);
    else {
      const age = ageOn(dob, now);
      if (age < 14 || age > 70) err('date_of_birth', `Age ${age} is outside the allowed 14-70 range`);
    }

    const grade = (raw.grade ?? '').trim().toUpperCase();
    if (!GRADES.includes(grade)) err('grade', `Grade must be one of ${GRADES.join(', ')}`);

    if (rowErrors.length) errors.push(...rowErrors);
    else candidates.push({ rowNumber, name, enrollmentNo, phone: phone!, dateOfBirth: dob!, grade });
  });

  if (candidates.length + new Set(errors.map((e) => e.row)).size === 0) {
    errors.push({ row: 1, column: '-', message: 'The spreadsheet has no candidate rows' });
  }
  const totalRows = candidates.length + new Set(errors.map((e) => e.row)).size;
  if (totalRows > config.maxBatchSize) {
    errors.push({ row: 1, column: '-', message: `A batch may have at most ${config.maxBatchSize} candidates` });
  }
  return { candidates, errors };
}
