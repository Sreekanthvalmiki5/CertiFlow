// Thin API client. The session token lives in sessionStorage (per tab), so a
// reviewer can open two tabs as two different people side by side.

export interface ApiError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  requestId?: string;
}

const TOKEN_KEY = 'certiflow.token';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const res = await fetch(`/api${path}`, { ...init, headers });
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      code: body?.error?.code ?? 'ERROR',
      message: body?.error?.message ?? res.statusText,
      details: body?.error?.details,
      requestId: body?.requestId,
    };
    throw err;
  }
  return body as T;
}

export const post = <T = unknown>(path: string, data?: unknown) =>
  api<T>(path, { method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data ?? {}) });

/**
 * Live updates over Server-Sent Events, read with fetch() so the token goes in
 * a header. Reconnects with backoff; `onEvent` is called for every update.
 */
export function subscribe(onEvent: (e: { type: string; batchId: string; status?: string }) => void, onState: (live: boolean) => void) {
  let stopped = false;
  let controller: AbortController | null = null;
  (async () => {
    let delay = 1000;
    while (!stopped) {
      try {
        controller = new AbortController();
        const res = await fetch('/api/events', { headers: { authorization: `Bearer ${getToken()}` }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error('stream failed');
        onState(true);
        delay = 1000;
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = chunk.split('\n').find((l) => l.startsWith('data: '));
            if (chunk.startsWith('event: update') && data) onEvent(JSON.parse(data.slice(6)));
          }
        }
      } catch {
        /* fall through to reconnect */
      }
      onState(false);
      if (!stopped) await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
    }
  })();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
