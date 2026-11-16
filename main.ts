// Siklus hidup entry <-> env untuk github-core-clone-01.
//
//   1. MAKEFUN_ENV_URL wajib ada (asal env). Tanpa itu tidak ada yang bisa
//      dihubungi, jadi program berhenti 1.
//   2. Server diikat ke port ephemeral (listen(0)); kernel yang memilih.
//      Port 8080 tidak pernah dipakai — itu milik env.
//   3. POST {"port": N} ke $MAKEFUN_ENV_URL/register. Register pertama yang
//      menang; 409 berarti sudah ada yang mendaftar lebih dulu.
//   4. GET $MAKEFUN_ENV_URL/done di-poll sampai jawab {"done": true}.
//      Poll gagal/lambat diulang dengan backoff; program tidak pernah
//      berhenti sebelum env bilang selesai.
//   5. Tutup server, keluar 0.
//
// File ini hanya mengurus lifecycle; servernya sendiri ada di app.ts.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_URL === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

/** Batas waktu satu request register/done sebelum dibatalkan dan diulang. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Jeda awal antar percobaan ulang, dan batas atasnya. */
const RETRY_FIRST_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Jeda sesudah percobaan ke-`attempt` gagal: eksponensial, dibatasi. */
function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Daftarkan port yang terikat ke env sampai diterima. 200 dan 409 sama-sama
 * berarti selesai (409 = register pertama sudah dimenangkan proses lain).
 * 400/405 adalah kesalahan kontrak dan menghentikan program; status lain
 * atau error jaringan diulang karena env mungkin masih mulai.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done sampai badannya {"done": true}. Tidak pernah kembali sebelumnya. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Env belum menjawab atau poll kehabisan waktu: belum selesai, poll lagi.
    }
    await sleep(retryDelay(attempt));
  }
}

/** Ikat port, daftarkan, lalu tunggu env: seluruh hidup proses ini. */
async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
