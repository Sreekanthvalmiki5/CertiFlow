// Client for the WhatsApp provider (here: our stand-in service). Every send
// carries an idempotency key (the certificate id). If a request times out we
// cannot know whether the message went out, so we simply retry with the same
// key: the provider returns the original message instead of sending again.
import { config } from '../config';

export class ProviderError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
  }
}

export interface SendResult {
  messageId: string;
  duplicate: boolean;
}

export async function sendCertificateMessage(input: {
  idempotencyKey: string;
  to: string;
  text: string;
  documentUrl: string;
  filename: string;
}): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`${config.whatsappUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': input.idempotencyKey },
      body: JSON.stringify({ to: input.to, type: 'document', text: input.text, document: { url: input.documentUrl, filename: input.filename } }),
      signal: AbortSignal.timeout(config.whatsappTimeoutMs),
    });
  } catch (err) {
    // Timeout or connection failure: outcome unknown -> safe to retry thanks to the key.
    throw new ProviderError(`provider unreachable: ${(err as Error).name}`, true);
  }
  if (res.ok) {
    const body = (await res.json()) as { id: string; duplicate?: boolean };
    return { messageId: body.id, duplicate: Boolean(body.duplicate) };
  }
  const text = await res.text().catch(() => '');
  // 4xx (except 408/429) means our request is wrong; retrying will not help.
  const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
  throw new ProviderError(`provider responded ${res.status}: ${text.slice(0, 200)}`, retryable);
}
