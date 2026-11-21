import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, getToken, post, setToken, subscribe } from './api';
import { BatchDetail } from './components/BatchDetail';
import { StatePanel } from './components/StatePanel';
import { StatusPill, timeAgo } from './components/ui';

export interface DemoUser {
  id: string;
  name: string;
  role: 'CENTRE' | 'OFFICER' | 'QUALITY' | 'STATE';
  district: string | null;
  centre: string | null;
}

export interface BatchRow {
  id: string;
  title: string;
  course: string;
  status: string;
  revision: number;
  candidateCount: number;
  centre: string;
  district: string;
  stageEnteredAt: string;
  escalatedAt: string | null;
  approvals: number;
  myVote: string | null;
  awaitingMe: boolean;
}

const ROLE_LABEL: Record<DemoUser['role'], string> = {
  CENTRE: 'Training centre',
  OFFICER: 'District officer',
  QUALITY: 'Quality team',
  STATE: 'State office',
};

export function App() {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [me, setMe] = useState<DemoUser | null>(null);
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [scope, setScope] = useState<'queue' | 'all'>('queue');
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // bumps on every live event -> refetch
  const [live, setLive] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    api<DemoUser[]>('/auth/demo-users').then(setUsers).catch(() => setUsers([]));
    if (getToken()) api<DemoUser>('/me').then(setMe).catch(() => setToken(null));
  }, []);

  const switchTo = async (u: DemoUser) => {
    const { token } = await post<{ token: string }>('/auth/demo-login', { userId: u.id });
    setToken(token);
    setMe(u);
    setSelected(null);
    setScope('queue');
  };

  const loadBatches = useCallback(async () => {
    if (!me) return;
    setBatches(await api<BatchRow[]>(`/batches${scope === 'queue' ? '?scope=queue' : ''}`));
  }, [me, scope]);

  useEffect(() => {
    loadBatches().catch(() => undefined);
  }, [loadBatches, tick]);

  useEffect(() => {
    if (!me) return;
    return subscribe(
      (e) => {
        setTick((t) => t + 1);
        if (e.type === 'batch.escalated') setFlash('A batch has been escalated for sitting too long');
      },
      setLive,
    );
  }, [me]);

  if (!me) {
    return (
      <div className="login">
        <h1>CertiFlow</h1>
        <p className="muted">Pragati Skills Mission - certificate issuance. Pick a demo person to continue.</p>
        <div className="persona-grid">
          {users.map((u) => (
            <button key={u.id} className="persona" onClick={() => switchTo(u)}>
              <strong>{u.name}</strong>
              <span>{ROLE_LABEL[u.role]}</span>
              <small>{u.centre ?? u.district ?? 'Statewide'}</small>
            </button>
          ))}
        </div>
        <p>
          Public pages: <a href="/verify">Verify a certificate</a> · <a href="/phone">Candidate phone (demo)</a>
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <div className="brand">CertiFlow</div>
        <div className="personas">
          {users.map((u) => (
            <button key={u.id} className={u.id === me.id ? 'chip active' : 'chip'} onClick={() => switchTo(u)} title={ROLE_LABEL[u.role]}>
              {u.name}
            </button>
          ))}
        </div>
        <div className="header-right">
          <span className={live ? 'live on' : 'live'}>{live ? '● live' : '○ offline'}</span>
          <a href="/verify" target="_blank">Verify</a>
          <a href="/phone" target="_blank">Phone</a>
        </div>
      </header>
      {flash && (
        <div className="flash" onClick={() => setFlash(null)}>
          {flash} (click to dismiss)
        </div>
      )}
      <div className="whoami">
        Signed in as <strong>{me.name}</strong> · {ROLE_LABEL[me.role]} {me.centre ? `· ${me.centre}` : me.district ? `· ${me.district} district` : ''}
      </div>

      <main>
        <aside>
          {me.role === 'CENTRE' && <NewBatch onCreated={(id) => { setSelected(id); setScope('all'); setTick((t) => t + 1); }} />}
          <div className="tabs">
            <button className={scope === 'queue' ? 'active' : ''} onClick={() => setScope('queue')}>
              {me.role === 'CENTRE' ? 'Needs my action' : 'Waiting for me'}
            </button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>
              All visible
            </button>
          </div>
          {batches.length === 0 && <p className="muted pad">Nothing here right now.</p>}
          <ul className="batch-list">
            {batches.map((b) => (
              <li key={b.id} className={b.id === selected ? 'selected' : ''} onClick={() => setSelected(b.id)}>
                <div className="row-between">
                  <strong>{b.title}</strong>
                  <StatusPill status={b.status} />
                </div>
                <div className="muted small">
                  {b.centre} · {b.candidateCount} candidates · rev {b.revision}
                </div>
                <div className="muted small">
                  in stage {timeAgo(b.stageEnteredAt)}
                  {b.status === 'PENDING_DISTRICT' && ` · ${b.approvals} approval(s)`}
                  {b.escalatedAt && <span className="warn"> · escalated</span>}
                </div>
              </li>
            ))}
          </ul>
        </aside>
        <section className="content">
          {me.role === 'STATE' && !selected && <StatePanel tick={tick} onOpen={setSelected} />}
          {selected ? (
            <BatchDetail key={selected} id={selected} me={me} tick={tick} onChanged={() => setTick((t) => t + 1)} />
          ) : (
            me.role !== 'STATE' && <p className="muted pad">Select a batch on the left.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function NewBatch({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [course, setCourse] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button className="primary block" onClick={() => setOpen(true)}>+ New batch</button>;
  const submit = async () => {
    try {
      const b = await post<{ id: string }>('/batches', { title, course });
      setOpen(false);
      setTitle('');
      setCourse('');
      onCreated(b.id);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  return (
    <div className="card">
      <input placeholder="Batch title, e.g. Plumbing - April cohort" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input placeholder="Course, e.g. Plumber (NSQF L3)" value={course} onChange={(e) => setCourse(e.target.value)} />
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="primary" onClick={submit}>Create</button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
