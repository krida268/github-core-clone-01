// Server HTTP + router untuk github-core-clone-01.
//
// Satu Store dipakai bersama keempat permukaan (git smart HTTP, REST v3,
// GraphQL v4, MCP) supaya data yang ditulis lewat satu permukaan terbaca
// lewat permukaan lain sebagai objek yang sama.
//
// Routing:
//   GET  /healthz                  -> 200 {"ok": true} (boot probe env)
//   /{owner}/{repo}.git/...        -> git smart HTTP (upload-pack v2/v0, receive-pack v0)
//   /api/v3...                     -> REST v3
//   POST /api/graphql              -> GraphQL v4
//   POST /mcp                      -> MCP (JSON-RPC 2.0 Streamable HTTP)
//   lainnya                        -> 404 {"message": "Not Found"}
//
// Server tidak pernah mati karena satu request: error di handler ditangkap
// dan dijawab 500 JSON (bukan HTML, bukan crash).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { sendJson } from './src/util.ts';
import { handleGit } from './src/git/smart-http.ts';
import { handleRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

/** Path URL sebuah request (tanpa query), atau '/' bila tidak bisa diparse. */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Pola rute git: /{owner}/{repo}.git/{action}. */
const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/;

/** Bangun server. Store dibuat di sini dan dipakai semua handler. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (await handleRest(req, res, store)) return;
        }

        if (path === '/api/graphql') {
          if (await handleGraphQL(req, res, store)) return;
        }

        if (path === '/mcp') {
          if (await handleMcp(req, res, store)) return;
        }

        const git = GIT_ROUTE.exec(path);
        if (git !== null) {
          const parts = {
            owner: decodeURIComponent(git[1] ?? ''),
            repo: decodeURIComponent(git[2] ?? ''),
            action: git[3] ?? '',
          };
          if (await handleGit(req, res, store, parts)) return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } else {
          try {
            res.end();
          } catch {
            // Respons sudah setengah terkirim; tidak ada lagi yang bisa dilakukan.
          }
        }
      }
    })();
  });
}
