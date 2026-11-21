// Moment 1: a spreadsheet with a few bad rows. The centre learns exactly
// what is wrong, and nothing half-saved ends up in the system.
import ExcelJS from 'exceljs';
import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/infra';
import { api, auth, createBatch, csvFor, resetAll, submittedBatch, uploadCsv } from './helpers';

const BAD_CSV = [
  'Name,Enrollment No,Phone,Date of Birth,Grade',
  'Asha Patil,PSC-0001,9876543210,2001-04-12,A',
  'Rohan Joshi,PSC-0002,12345,2002-05-01,B', // bad phone
  'Isha Shinde,PSC-0003,9876543212,31/02/2001,C', // impossible date
  'Kiran Pawar,PSC-0001,9876543213,2000-01-01,A', // duplicate enrollment
  ',PSC-0005,9876543214,2000-01-01,E', // missing name + bad grade
  'Manav Iyer,PSC-0006,9876543215,2000-01-01,B',
].join('\n');

describe('Moment 1 - spreadsheet with bad rows', () => {
  beforeEach(resetAll);

  it('lists every bad row and column, and saves nothing', async () => {
    const batchId = await createBatch();
    const res = await uploadCsv(batchId, BAD_CSV);

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/4 row\(s\) have problems. Nothing was saved/);
    const problems = res.body.error.details.map((d: { row: number; column: string }) => `${d.row}:${d.column}`);
    expect(problems).toEqual(['3:phone', '4:date_of_birth', '5:enrollment_no', '6:name', '6:grade']);

    expect(await prisma.candidate.count({ where: { batchId } })).toBe(0);
    const batch = await prisma.batch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.candidateCount).toBe(0);
  });

  it('a bad re-upload leaves the previous good list untouched', async () => {
    const batchId = await createBatch();
    expect((await uploadCsv(batchId, csvFor('GOOD', 5))).status).toBe(200);
    expect((await uploadCsv(batchId, BAD_CSV)).status).toBe(422);
    const stored = await prisma.candidate.findMany({ where: { batchId } });
    expect(stored).toHaveLength(5);
    expect(stored.every((c) => c.enrollmentNo.startsWith('GOOD-'))).toBe(true);
  });

  it('refuses candidates who are already in another live batch', async () => {
    await submittedBatch(3, 'DUP');
    const other = await createBatch('Second');
    const res = await uploadCsv(other, csvFor('DUP', 2));
    expect(res.status).toBe(422);
    expect(res.body.error.details[0]).toMatchObject({ row: 2, column: 'enrollment_no' });
    expect(await prisma.candidate.count({ where: { batchId: other } })).toBe(0);
  });

  it('accepts .xlsx files too', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Passed');
    ws.addRow(['Name', 'Enrollment No', 'Phone', 'Date of Birth', 'Grade']);
    ws.addRow(['Asha Patil', 'XL-0001', '9876543210', new Date(Date.UTC(2001, 3, 12)), 'A']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const batchId = await createBatch();
    const res = await api().post(`/api/batches/${batchId}/candidates`).set(auth('anika')).attach('file', buf, 'passed.xlsx');
    expect(res.status).toBe(200);
    const c = await prisma.candidate.findFirstOrThrow({ where: { batchId } });
    expect(c.phone).toBe('+919876543210');
  });

  it('rejects files that are not spreadsheets', async () => {
    const batchId = await createBatch();
    const res = await api().post(`/api/batches/${batchId}/candidates`).set(auth('anika')).attach('file', Buffer.from('MZ...'), 'virus.exe');
    expect(res.status).toBe(400);
  });
});
