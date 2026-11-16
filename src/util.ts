import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store } from './store.ts';

/** The login the bearer token names (SPEC fixed scenario constants). */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Read the whole request body into one Buffer. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Send a JSON reply. Always sets application/json; extra headers (e.g. the
 * request-id or pagination Link) are merged in. A 204 has no body.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = status === 204 ? '' : JSON.stringify(body);
  const all: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    ...headers,
  };
  res.writeHead(status, all);
  res.end(payload);
}

/** Shortcut for the standard `{"message": ...}` error body. */
export function jsonError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { message }, headers);
}

/**
 * True only when the request carries `Authorization: Bearer <token>` where
 * <token> is exactly process.env.MAKEFUN_SHOP_TOKEN.
 */
export function checkAuth(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected === undefined || expected === '') return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === `Bearer ${expected}`;
}

/** Deterministic request id, delegated to the store's own counter. */
export function requestId(store: Store): string {
  return store.requestId();
}
