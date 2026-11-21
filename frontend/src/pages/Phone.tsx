import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Message {
  id: string;
  to: string;
  text: string;
  document?: { url: string; filename: string };
  receivedAt: string;
}

/**
 * DEMO ONLY: shows what reached a candidate's phone via the WhatsApp stand-in.
 * In production this page does not exist; the message lands in WhatsApp.
 */
export function PhonePage() {
  const [phone, setPhone] = useState('+919300000000');
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    setErr(null);
    try {
      setMsgs(await api<Message[]>(`/demo/phone/${encodeURIComponent(phone)}`));
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  useEffect(() => {
    const t = setInterval(() => msgs && load(), 3000);
    return () => clearInterval(t);
  });

  return (
    <div className="public">
      <h1>Candidate phone (demo)</h1>
      <p className="muted">Simulates a candidate's WhatsApp inbox, fed by the WhatsApp stand-in. Seeded approved batch phones: +919300000000 to +919300000004.</p>
      <div className="card row">
        <input value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="primary" onClick={load}>Open inbox</button>
      </div>
      {err && <div className="error">{err}</div>}
      {msgs && (
        <div className="phone">
          {msgs.length === 0 && <p className="muted">No messages yet.</p>}
          {msgs.map((m) => (
            <div key={m.id} className="bubble">
              <p>{m.text}</p>
              {m.document && (
                <a className="doc" href={m.document.url.replace(/^https?:\/\/[^/]+/, '')} target="_blank" rel="noreferrer">
                  📄 {m.document.filename}
                </a>
              )}
              <small>{new Date(m.receivedAt).toLocaleString()} · count on this phone: {msgs.length}</small>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
