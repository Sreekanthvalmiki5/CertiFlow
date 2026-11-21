import { createMockWhatsApp } from './app';

const num = (name: string, d: number) => (process.env[name] ? Number(process.env[name]) : d);

const { app } = createMockWhatsApp({
  failureRate: num('WA_FAILURE_RATE', 0.2),
  timeoutRate: num('WA_TIMEOUT_RATE', 0.1),
  rateLimitRate: num('WA_RATE_LIMIT_RATE', 0.05),
  hangMs: num('WA_HANG_MS', 8000),
  latencyMs: num('WA_LATENCY_MS', 300),
  persistFile: process.env.WA_PERSIST_FILE,
});

const port = num('PORT', 4100);
app.listen(port, () => console.log(JSON.stringify({ msg: 'mock whatsapp listening', port })));
