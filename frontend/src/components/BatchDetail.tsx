import { useEffect, useRef, useState } from 'react';
import { api, ApiError, post } from '../api';
import type { DemoUser } from '../App';
import { StatusPill, timeAgo } from './ui';

interface Detail {
  id: string;
  title: string;
  course: string;
  status: string;
  revision: number;
  centre: string;
  district: string;
  candidateCount: number;
  stageEnteredAt: string;
  escalatedAt: string | null;
  returnReason: string | null;
  returnedBy: string | null;
  isLarge: boolean;
  districtQuorum: number;
  canDecide: boolean;
  canEdit: boolean;
  candidates: { id: string; rowNumber: number; name: string; enrollmentNo: string; phone: string; dateOfBirth: string; grade: string }[];
  decisions: { id: string; revision: number; stage: string; actorName: string; decision: string; reason: string | null; createdAt: string; current: boolean }[];
  certificateSummary: { total: number; sent: number; failed: number; pending: number; revoked: number };
  certificates: { id: string; number: string; holderName: string; phone: string; status: string; deliveryStatus: string; deliveryAttempts: number; lastDeliveryError: string | null }[];
}

interface RowError {
  row: number;
  column: string;
  message: string;
}

interface AuditRow {
  id: string;
  action: string;
  actorName: string;
  fromStatus: string | null;
  toStatus: string | null;
  details: Record<string, unknown> | null;
  requestId: string | null;
  createdAt: string;
  entityType: string;
}

export function BatchDetail({ id, me, tick, onChanged }: { id: string; me: DemoUser; tick: number; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<RowError[]>([]);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timeline, setTimeline] = useState<AuditRow[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<Detail>(`/batches/${id}`).then(setD).catch((e: ApiError) => setError(e.message));
    if (showTimeline) api<AuditRow[]>(`/batches/${id}/timeline`).then(setTimeline).catch(() => undefined);
  }, [id, tick, showTimeline]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setReason('');
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      setError(`${err.message}${err.requestId ? ` (ref ${err.requestId.slice(0, 8)})` : ''}`);
      if (Array.isArray(err.details)) setRowErrors(err.details as RowError[]);
    } finally {
      setBusy(false);
    }
  };

  const upload = () =>
    run(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) throw { message: 'Choose a .csv or .xlsx file first' };
      setRowErrors([]);
      const fd = new FormData();
      fd.append('file', file);
      await post(`/batches/${id}/candidates`, fd);
      if (fileRef.current) fileRef.current.value = '';
    });

  const decide = (decision: 'APPROVE' | 'REJECT' | 'SEND_BACK') =>
    run(() => post(`/batches/${id}/decisions`, { decision, revision: d!.revision, ...(reason ? { reason } : {}) }));

  if (!d) return <p className="pad">{error ?? 'Loading…'}</p>;
  const currentDistrictApprovals = d.decisions.filter((x) => x.current && x.stage === 'DISTRICT' && x.decision === 'APPROVE').length;

  return (
    <div className="detail">
      <div className="row-between">
        <div>
          <h2>{d.title}</h2>
          <div className="muted">
            {d.course} · {d.centre} · {d.district} district · revision {d.revision}
          </div>
        </div>
        <StatusPill status={d.status} />
      </div>

      <Stepper d={d} approvals={currentDistrictApprovals} />

      {d.escalatedAt && d.status.startsWith('PENDING') && (
        <div className="banner warn">Escalated: waiting in this stage for {timeAgo(d.stageEnteredAt)} (past the SLA).</div>
      )}
      {d.status === 'RETURNED' && (
        <div className="banner">
          Sent back by <strong>{d.returnedBy}</strong>: “{d.returnReason}”. Fix the list and resubmit. Earlier approvals will not carry over; the batch is
          reviewed again from the district stage.
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {rowErrors.length > 0 && (
        <div className="card">
          <strong>Nothing was saved. Fix these rows and upload again:</strong>
          <table>
            <thead>
              <tr><th>Row</th><th>Column</th><th>Problem</th></tr>
            </thead>
            <tbody>
              {rowErrors.map((e, i) => (
                <tr key={i}><td>{e.row}</td><td>{e.column}</td><td>{e.message}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.canEdit && (
        <div className="card">
          <strong>Candidates spreadsheet</strong>
          <p className="muted small">
            Columns: name, enrollment_no, phone, date_of_birth, grade. CSV or Excel. Samples:{' '}
            <a href="/samples/good_batch_8.csv" download>8 rows</a> · <a href="/samples/good_batch_60.csv" download>60 rows</a> ·{' '}
            <a href="/samples/bad_batch.csv" download>with errors</a>
          </p>
          <div className="row">
            <input type="file" accept=".csv,.xlsx" ref={fileRef} />
            <button onClick={upload} disabled={busy}>Upload</button>
            <button className="primary" disabled={busy || d.candidateCount === 0} onClick={() => run(() => post(`/batches/${id}/submit`))}>
              {d.status === 'RETURNED' ? 'Resubmit for approval' : 'Submit for approval'}
            </button>
          </div>
        </div>
      )}

      {d.canDecide && (
        <div className="card">
          <strong>Your decision ({me.name})</strong>
          <textarea placeholder="Reason (required to send back or reject)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <div className="row">
            <button className="primary" disabled={busy} onClick={() => decide('APPROVE')}>Approve</button>
            <button disabled={busy} onClick={() => decide('SEND_BACK')}>Send back</button>
            <button className="danger" disabled={busy} onClick={() => decide('REJECT')}>Reject</button>
          </div>
          {d.status === 'PENDING_DISTRICT' && (
            <p className="muted small">District decisions need {d.districtQuorum} officers to agree. A single officer can send back.</p>
          )}
        </div>
      )}

      {d.certificateSummary.total > 0 && (
        <div className="card">
          <strong>Certificates</strong>
          <div className="stats">
            <span>{d.certificateSummary.total} issued</span>
            <span className="ok">{d.certificateSummary.sent} delivered</span>
            <span>{d.certificateSummary.pending} sending…</span>
            {d.certificateSummary.failed > 0 && <span className="warn">{d.certificateSummary.failed} failed</span>}
            {d.certificateSummary.revoked > 0 && <span className="warn">{d.certificateSummary.revoked} cancelled</span>}
          </div>
          {d.certificates.length > 0 && (
            <table>
              <thead>
                <tr><th>Number</th><th>Holder</th><th>Phone</th><th>Status</th><th>WhatsApp</th><th></th></tr>
              </thead>
              <tbody>
                {d.certificates.map((c) => (
                  <tr key={c.id}>
                    <td className="mono">{c.number}</td>
                    <td>{c.holderName}</td>
                    <td className="mono">{c.phone}</td>
                    <td><StatusPill status={c.status} /></td>
                    <td title={c.lastDeliveryError ?? ''}>
                      <StatusPill status={c.deliveryStatus} /> <span className="muted small">{c.deliveryAttempts} attempt(s)</span>
                    </td>
                    <td>
                      {me.role === 'STATE' && c.status === 'VALID' && (
                        <button
                          className="danger small"
                          onClick={() => {
                            const r = prompt(`Cancel ${c.number}? Give a reason:`);
                            if (r) run(() => post(`/certificates/${c.id}/revoke`, { reason: r }));
                          }}
                        >
                          Cancel
                        </button>
                      )}
                      {me.role === 'STATE' && c.deliveryStatus === 'FAILED' && c.status === 'VALID' && (
                        <button className="small" onClick={() => run(() => post(`/certificates/${c.id}/retry-delivery`))}>Retry</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {d.decisions.length > 0 && (
        <div className="card">
          <strong>Decisions</strong>
          <ul className="plain">
            {d.decisions.map((x) => (
              <li key={x.id} className={x.current ? '' : 'superseded'}>
                rev {x.revision} · {x.stage.toLowerCase()} · <strong>{x.actorName}</strong> {x.decision.replace('_', ' ').toLowerCase()}
                {x.reason && <> - “{x.reason}”</>} <span className="muted small">{new Date(x.createdAt).toLocaleString()}</span>
                {!x.current && <span className="muted small"> (earlier revision, no longer counts)</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <strong>Candidates ({d.candidateCount})</strong>
        {d.isLarge && <span className="muted small"> · large batch: reviewed by the quality team</span>}
        {d.candidates.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr><th>Row</th><th>Name</th><th>Enrollment</th><th>Phone</th><th>DOB</th><th>Grade</th></tr>
              </thead>
              <tbody>
                {d.candidates.map((c) => (
                  <tr key={c.id}>
                    <td>{c.rowNumber}</td><td>{c.name}</td><td className="mono">{c.enrollmentNo}</td><td className="mono">{c.phone}</td><td>{c.dateOfBirth}</td><td>{c.grade}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <button className="link" onClick={() => setShowTimeline((s) => !s)}>{showTimeline ? 'Hide' : 'Show'} full audit trail</button>
        {showTimeline && (
          <table>
            <thead>
              <tr><th>When</th><th>Who</th><th>What</th><th>Change</th><th>Request</th></tr>
            </thead>
            <tbody>
              {timeline.map((e) => (
                <tr key={e.id}>
                  <td className="small">{new Date(e.createdAt).toLocaleTimeString()}</td>
                  <td>{e.actorName}</td>
                  <td>{e.action}{e.entityType === 'certificate' ? ' (cert)' : ''}</td>
                  <td className="small">{e.fromStatus || e.toStatus ? `${e.fromStatus ?? ''} → ${e.toStatus ?? ''}` : ''}</td>
                  <td className="mono small">{e.requestId?.slice(0, 8) ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Stepper({ d, approvals }: { d: Detail; approvals: number }) {
  const steps: { key: string; label: string }[] = [
    { key: 'DRAFT', label: 'Centre' },
    { key: 'PENDING_DISTRICT', label: `District (${approvals}/${d.districtQuorum})` },
    ...(d.isLarge ? [{ key: 'PENDING_QUALITY', label: 'Quality team' }] : []),
    { key: 'PENDING_STATE', label: 'State office' },
    { key: 'APPROVED', label: 'Issued' },
  ];
  const status = d.status === 'RETURNED' ? 'DRAFT' : d.status;
  const idx = steps.findIndex((s) => s.key === status);
  return (
    <ol className="stepper">
      {steps.map((s, i) => (
        <li key={s.key} className={d.status === 'REJECTED' ? 'rejected' : i < idx ? 'done' : i === idx ? 'current' : ''}>{s.label}</li>
      ))}
    </ol>
  );
}
