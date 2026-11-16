# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/krida268/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/krida268/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in one Node 22 process — no UI, no git binary, no outside service. It serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4, and MCP over streamable HTTP from a single in-memory store, for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01).

## Run it

```sh
node --experimental-strip-types main.ts
```

The program binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, serves until the suite says done, then exits 0. Node 22 or later, standard library only — nothing to install.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, poll `/done`, exit 0).
- `app.ts` — the HTTP server and router to the four surfaces.
- `src/store.ts` — the in-memory store (repositories, refs, git objects, issues, pull requests, labels, comments) with a deterministic clock.
- `src/git/` — git objects, packfiles (parse/generate, delta apply), pkt-line framing, and the smart-HTTP handlers.
- `src/rest.ts` — the REST v3 API.
- `src/graphql.ts` — the GraphQL v4 mini-engine with introspection.
- `src/mcp.ts` — the MCP endpoint (JSON-RPC 2.0, six tools).

## Referral

Built for the make.fun bounty — join with my referral: https://make.fun/r/enzt809f
