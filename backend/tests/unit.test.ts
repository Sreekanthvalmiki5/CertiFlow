// Pure rules: spreadsheet validation and workflow vote resolution.
import { describe, expect, it } from 'vitest';
import { normalisePhone, parseDate, validateRows } from '../src/domain/spreadsheet';
import { resolveVotes, whyCannotDecide } from '../src/domain/workflow';
import { maskName, signDownloadToken, verifyDownloadToken } from '../src/lib/tokens';

const H = ['name', 'enrollment_no', 'phone', 'date_of_birth', 'grade'];
const now = new Date('2026-11-21T00:00:00Z');

describe('spreadsheet validation', () => {
  it('normalises Indian mobile numbers and rejects bad ones', () => {
    expect(normalisePhone('98765 43210')).toBe('+919876543210');
    expect(normalisePhone('+91-98765-43210')).toBe('+919876543210');
    expect(normalisePhone('09876543210')).toBe('+919876543210');
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('5876543210')).toBeNull(); // must start 6-9
  });

  it('parses both date formats and rejects impossible dates', () => {
    expect(parseDate('2001-02-28')?.toISOString()).toContain('2001-02-28');
    expect(parseDate('28/02/2001')?.toISOString()).toContain('2001-02-28');
    expect(parseDate('2001-02-30')).toBeNull();
    expect(parseDate('yesterday')).toBeNull();
  });

  it('reports every problem with its row and column', () => {
    const rows = [
      { name: 'Asha Patil', enrollment_no: 'E-0001', phone: '9876543210', date_of_birth: '2001-01-01', grade: 'A' },
      { name: '', enrollment_no: 'E-0002', phone: '123', date_of_birth: '2001-13-01', grade: 'Z' },
      { name: 'Ravi', enrollment_no: 'E-0001', phone: '9876543211', date_of_birth: '2001-01-01', grade: 'B' },
    ];
    const { candidates, errors } = validateRows(H, rows, now);
    expect(candidates).toHaveLength(1);
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 3, column: 'name' }),
        expect.objectContaining({ row: 3, column: 'phone' }),
        expect.objectContaining({ row: 3, column: 'date_of_birth' }),
        expect.objectContaining({ row: 3, column: 'grade' }),
        expect.objectContaining({ row: 4, column: 'enrollment_no', message: 'Duplicate of row 2' }),
      ]),
    );
  });

  it('rejects a file with missing columns', () => {
    const { errors } = validateRows(['name', 'phone'], [], now);
    expect(errors.map((e) => e.column)).toEqual(['enrollment_no', 'date_of_birth', 'grade']);
  });
});

describe('workflow rules', () => {
  const officer = { id: 'dev', name: 'Dev', role: 'OFFICER' as const, districtId: 'pune', centreId: null };

  it('district approval needs two officers', () => {
    expect(resolveVotes('DISTRICT', [{ decision: 'APPROVE' }], 10)).toBeNull();
    expect(resolveVotes('DISTRICT', [{ decision: 'APPROVE' }, { decision: 'APPROVE' }], 10)).toBe('PENDING_STATE');
  });

  it('large batches go to the quality team', () => {
    expect(resolveVotes('DISTRICT', [{ decision: 'APPROVE' }, { decision: 'APPROVE' }], 60)).toBe('PENDING_QUALITY');
    expect(resolveVotes('QUALITY', [{ decision: 'APPROVE' }], 60)).toBe('PENDING_STATE');
    expect(resolveVotes('STATE', [{ decision: 'APPROVE' }], 60)).toBe('APPROVED');
  });

  it('one officer can send back, but rejection needs agreement', () => {
    expect(resolveVotes('DISTRICT', [{ decision: 'SEND_BACK' }], 10)).toBe('RETURNED');
    expect(resolveVotes('DISTRICT', [{ decision: 'REJECT' }], 10)).toBeNull();
    expect(resolveVotes('DISTRICT', [{ decision: 'REJECT' }, { decision: 'REJECT' }], 10)).toBe('REJECTED');
  });

  it('only the right role in the right district may act', () => {
    expect(whyCannotDecide(officer, 'PENDING_DISTRICT', 'pune')).toBeNull();
    expect(whyCannotDecide(officer, 'PENDING_DISTRICT', 'nashik')).toMatch(/different district/);
    expect(whyCannotDecide(officer, 'PENDING_STATE', 'pune')).toMatch(/state stage/);
    expect(whyCannotDecide({ ...officer, role: 'STATE' }, 'PENDING_DISTRICT', 'pune')).toMatch(/district stage/);
  });
});

describe('tokens', () => {
  it('download tokens are bound to one certificate and expire', () => {
    const t = signDownloadToken('cert-a');
    expect(verifyDownloadToken('cert-a', t)).toBe(true);
    expect(verifyDownloadToken('cert-b', t)).toBe(false);
    expect(verifyDownloadToken('cert-a', t.replace(/.$/, 'x'))).toBe(false);
    expect(verifyDownloadToken('cert-a', t, Date.now() + 400 * 86400_000)).toBe(false);
  });

  it('masks names for public verification', () => {
    expect(maskName('Ravi Kumar')).toBe('R*** K****');
  });
});
