import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';

interface Result {
  result: 'VALID' | 'REVOKED' | 'NOT_FOUND';
  certificateNumber?: string;
  holderName?: string;
  course?: string;
  centre?: string;
  issuedAt?: string;
  revokedAt?: string | null;
}

/** Public page: no login. Pre-filled when opened from the certificate's QR code. */
export function VerifyPage() {
  const params = new URLSearchParams(window.location.search);
  const [n, setN] = useState(params.get('n') ?? '');
  const [c, setC] = useState(params.get('c') ?? '');
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const check = async () => {
    setErr(null);
    setRes(null);
    try {
      setRes(await api<Result>(`/public/verify?n=${encodeURIComponent(n)}&c=${encodeURIComponent(c)}`));
    } catch (e) {
      setErr((e as ApiError).message);
    }
  };

  useEffect(() => {
    if (n && c) check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="public">
      <h1>Verify a certificate</h1>
      <p className="muted">Pragati Skills Mission. Enter the certificate number and the verification code printed on it, or scan its QR code.</p>
      <div className="card">
        <input placeholder="Certificate number, e.g. PSM-2026-000123" value={n} onChange={(e) => setN(e.target.value)} />
        <input placeholder="Verification code (8 characters)" value={c} onChange={(e) => setC(e.target.value)} />
        <button className="primary" onClick={check} disabled={!n || !c}>Check</button>
      </div>
      {err && <div className="error">{err}</div>}
      {res?.result === 'VALID' && (
        <div className="verdict valid">
          <h2>✔ Genuine certificate</h2>
          <p><strong>{res.certificateNumber}</strong> issued to <strong>{res.holderName}</strong></p>
          <p>{res.course} · {res.centre}</p>
          <p className="muted">Issued {new Date(res.issuedAt!).toLocaleDateString()}</p>
        </div>
      )}
      {res?.result === 'REVOKED' && (
        <div className="verdict revoked">
          <h2>✖ No longer valid</h2>
          <p><strong>{res.certificateNumber}</strong> was cancelled by the state office on {new Date(res.revokedAt!).toLocaleString()}.</p>
          <p>Do not accept this certificate.</p>
        </div>
      )}
      {res?.result === 'NOT_FOUND' && (
        <div className="verdict revoked">
          <h2>✖ Not found</h2>
          <p>No certificate matches this number and code. Check for typos; otherwise this certificate is not genuine.</p>
        </div>
      )}
      <p className="small"><a href="/">← Staff app</a></p>
    </div>
  );
}
