import { useEffect, useState } from 'react';
import { api, ApiError, post } from '../api';
import { StatusPill } from './ui';

interface Escalation {
  id: string;
  title: string;
  status: string;
  centre: string;
  district: string;
  waitingMinutes: number;
}

interface Cert {
  id: string;
  number: string;
  holderName: string;
  course: string;
  status: string;
  deliveryStatus: string;
  batchId: string;
}

/** State office home: what is stuck, and certificate search / cancellation. */
export function StatePanel({ tick, onOpen }: { tick: number; onOpen: (batchId: string) => void }) {
  const [stuck, setStuck] = useState<Escalation[]>([]);
  const [q, setQ] = useState('');
  const [certs, setCerts] = useState<Cert[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api<Escalation[]>('/escalations').then(setStuck).catch(() => undefined);
    api<Cert[]>(`/certificates?q=${encodeURIComponent(q)}`).then(setCerts).catch(() => undefined);
  }, [tick, q]);

  const revoke = async (c: Cert) => {
    const reason = prompt(`Cancel ${c.number}? Give a reason:`);
    if (!reason) return;
    try {
      await post(`/certificates/${c.id}/revoke`, { reason });
      setMsg(`${c.number} cancelled. Public verification now reports it as no longer valid.`);
      setCerts(await api<Cert[]>(`/certificates?q=${encodeURIComponent(q)}`));
    } catch (e) {
      setMsg((e as ApiError).message);
    }
  };

  return (
    <div className="detail">
      <h2>State office</h2>
      <div className="card">
        <strong>Stuck batches ({stuck.length})</strong>
        <p className="muted small">Escalated automatically when a batch waits in one stage longer than the SLA.</p>
        {stuck.length === 0 ? (
          <p className="muted">Nothing is stuck.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Batch</th><th>Where</th><th>Centre</th><th>Waiting</th></tr>
            </thead>
            <tbody>
              {stuck.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => onOpen(s.id)}>
                  <td>{s.title}</td>
                  <td><StatusPill status={s.status} /></td>
                  <td>{s.centre} ({s.district})</td>
                  <td className="warn">{Math.round(s.waitingMinutes / 60)} h</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <strong>Certificates</strong>
        <input placeholder="Search by certificate or enrollment number" value={q} onChange={(e) => setQ(e.target.value)} />
        {msg && <div className="banner">{msg}</div>}
        <table>
          <thead>
            <tr><th>Number</th><th>Holder</th><th>Course</th><th>Status</th><th>WhatsApp</th><th></th></tr>
          </thead>
          <tbody>
            {certs.map((c) => (
              <tr key={c.id}>
                <td className="mono clickable" onClick={() => onOpen(c.batchId)}>{c.number}</td>
                <td>{c.holderName}</td>
                <td>{c.course}</td>
                <td><StatusPill status={c.status} /></td>
                <td><StatusPill status={c.deliveryStatus} /></td>
                <td>{c.status === 'VALID' && <button className="danger small" onClick={() => revoke(c)}>Cancel</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
