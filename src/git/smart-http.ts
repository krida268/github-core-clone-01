/**
 * Git smart HTTP: git-upload-pack (protocol v2 dan v0) dan git-receive-pack (v0).
 *
 * Satu-satunya permukaan git di entry ini. Semua state tinggal di Store yang
 * diberikan pemanggil; modul ini tidak menyimpan apa pun sendiri dan tidak
 * memakai jam dinding maupun angka acak, jadi responsnya deterministik.
 *
 * Route yang dilayani (di bawah `/{owner}/{repo}.git`):
 *   GET  info/refs?service=git-upload-pack | git-receive-pack
 *   POST git-upload-pack
 *   POST git-receive-pack
 *
 * Auth: bila env MAKEFUN_SHOP_TOKEN terisi, header Authorization harus
 * `Bearer <token>` persis; bila env kosong, auth dilewati (mode latihan lokal).
 * Repo yang tidak ada dijawab 404 JSON dan server tetap hidup.
 *
 * Protokol yang diterapkan (sesuai yang diminta client conformance):
 *   - v2: iklan diawali "version 2" + capability ls-refs/fetch; perintah
 *     ls-refs (peel, symrefs, unborn, ref-prefix) dan fetch (want/have,
 *     deepen, shallow boundary). Jawaban fetch dibagi seksi
 *     acknowledgments / shallow-info / packfile (side-band-64k).
 *   - v0 upload-pack: iklan "# service=..." + baris ref + capability
 *     sesudah NUL; fetch dua seksi (want lalu have/done) dengan jawaban
 *     NAK + shallow-info + packfile side-band-64k.
 *   - v0 receive-pack: baca daftar perintah + packfile, simpan semua objek
 *     dari pack, lalu validasi fast-forward per ref dan jawab report-status
 *     ("unpack ok" + satu baris ok/ng per ref) di dalam side-band-64k.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from '../store.ts';
import { parseCommit, parseTree } from './objects.ts';
import { buildPack, parsePack } from './pack.ts';
import { decodePktLines, encodeDelim, encodeFlush, encodePktLine, sideBand } from './pktline.ts';
import type { PktLine } from './pktline.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'git-core-clone/1.0';
const OID_PATTERN = /^[0-9a-f]{40}$/;

export interface GitRouteParts {
  owner: string;
  repo: string;
  action: string;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
  /** True bila client mengirim `done` (negosiasi selesai dalam request ini). */
  done: boolean;
}

interface WalkResult {
  objects: Set<string>;
  commits: Set<string>;
  boundary: Set<string>;
}

/** True bila `value` berupa oid SHA-1 heksadesimal 40 karakter. */
function isOid(value: string): boolean {
  return OID_PATTERN.test(value);
}

function headerValue(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(body.length) });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err: Error) => reject(err));
  });
}

/**
 * Auth Bearer terhadap MAKEFUN_SHOP_TOKEN. Bila env tidak disetel, semua
 * request diizinkan (dipakai latihan lokal tanpa token).
 */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (!expected) return true;
  return headerValue(req, 'authorization') === `Bearer ${expected}`;
}

/** Ref di repo, diurutkan berdasarkan nama (HEAD tidak termasuk di sini). */
function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Ambil oid target dari baris pertama objek tag (`object <oid>`). */
function tagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const newline = text.indexOf('\n');
  const first = newline < 0 ? text : text.slice(0, newline);
  if (!first.startsWith('object ')) return null;
  const oid = first.slice(7).trim();
  return isOid(oid) ? oid : null;
}

/**
 * Kupas rantai tag sampai ke objek bukan-tag. Kembalikan null bila `oid`
 * bukan objek tag (tidak ada baris peeled untuk ref itu).
 */
function peelOid(store: Store, oid: string): string | null {
  let current = oid;
  const seen = new Set<string>();
  for (let step = 0; step < 16; step += 1) {
    if (seen.has(current)) return null;
    seen.add(current);
    const obj = store.getObject(current);
    if (!obj) return null;
    if (obj.type !== 'tag') return step === 0 ? null : current;
    const target = tagTarget(obj.data);
    if (!target) return null;
    current = target;
  }
  return null;
}

/**
 * Kumpulkan semua objek yang terjangkau dari `roots`.
 *
 * - Commit: telusuri tree + parent. `maxDepth` membatasi generasi commit
 *   (want di kedalaman 1); commit yang tercapai tepat di kedalaman batas
 *   dicatat sebagai boundary dan parent-nya tidak ditelusuri.
 * - `stopAt`: commit yang parent-nya tidak ditelusuri (batas shallow yang
 *   sudah dimiliki client saat menghitung closure "have").
 * - Tag: ikuti targetnya. Tree: ikuti entrinya (gitlink dilewati).
 * Objek yang tidak ada di store dilewati begitu saja.
 */
function walkObjects(store: Store, roots: string[], opts: { maxDepth?: number; stopAt?: Set<string> }): WalkResult {
  const objects = new Set<string>();
  const commits = new Set<string>();
  const depthOf = new Map<string, number>();
  const stack: Array<{ oid: string; depth: number }> = [];
  for (const root of roots) {
    if (root && root !== ZERO_OID) stack.push({ oid: root, depth: 1 });
  }
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const obj = store.getObject(item.oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const prev = depthOf.get(item.oid);
      if (prev !== undefined && prev <= item.depth) continue;
      depthOf.set(item.oid, item.depth);
      objects.add(item.oid);
      commits.add(item.oid);
      let parsed: { tree: string; parents: string[]; message: string };
      try {
        parsed = parseCommit(obj.data);
      } catch {
        continue;
      }
      stack.push({ oid: parsed.tree, depth: item.depth });
      const atLimit = opts.maxDepth !== undefined && item.depth >= opts.maxDepth;
      const stopped = opts.stopAt !== undefined && opts.stopAt.has(item.oid);
      if (!atLimit && !stopped) {
        for (const parent of parsed.parents) stack.push({ oid: parent, depth: item.depth + 1 });
      }
    } else {
      if (objects.has(item.oid)) continue;
      objects.add(item.oid);
      if (obj.type === 'tag') {
        const target = tagTarget(obj.data);
        if (target) stack.push({ oid: target, depth: item.depth });
      } else if (obj.type === 'tree') {
        let entries: Array<{ mode: string; name: string; oid: string }>;
        try {
          entries = parseTree(obj.data);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.mode === '160000') continue;
          stack.push({ oid: entry.oid, depth: item.depth });
        }
      }
    }
  }
  const boundary = new Set<string>();
  if (opts.maxDepth !== undefined) {
    for (const [oid, depth] of depthOf) {
      if (depth === opts.maxDepth) boundary.add(oid);
    }
  }
  return { objects, commits, boundary };
}

/**
 * Rencana satu fetch: objek yang dikirim = closure(want, dibatasi deepen)
 * dikurangi closure(have, berhenti di batas shallow client). Bila deepen
 * diminta, hitung juga shallow-info baru (boundary) dan unshallow (batas
 * lama yang kini sudah berada di dalam closure). `commonHaves` = have yang
 * juga terjangkau dari want (dipakai baris ACK).
 */
function planFetch(
  store: Store,
  args: FetchArgs,
): { sendOids: string[]; shallowOut: string[]; unshallowOut: string[]; commonHaves: string[] } {
  const wantWalk = walkObjects(store, args.wants, args.deepen !== undefined ? { maxDepth: args.deepen } : {});
  const haveWalk = walkObjects(store, args.haves, { stopAt: new Set(args.shallow) });
  const send = [...wantWalk.objects].filter((oid) => !haveWalk.objects.has(oid));
  send.sort();
  let shallowOut: string[] = [];
  let unshallowOut: string[] = [];
  if (args.deepen !== undefined) {
    shallowOut = [...wantWalk.boundary].sort();
    const boundarySet = new Set(shallowOut);
    unshallowOut = args.shallow.filter((oid) => wantWalk.commits.has(oid) && !boundarySet.has(oid));
    unshallowOut.sort();
  }
  const commonHaves = args.haves.filter((oid) => wantWalk.objects.has(oid));
  return { sendOids: send, shallowOut, unshallowOut, commonHaves };
}

// ---------------------------------------------------------------------------------------------
// advertisement
// ---------------------------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    encodePktLine('# service=git-upload-pack\n'),
    encodeFlush(),
    encodePktLine('version 2\n'),
    encodePktLine(`agent=${AGENT}\n`),
    encodePktLine('ls-refs=unborn\n'),
    encodePktLine('fetch=shallow wait-for-done\n'),
    encodePktLine('object-format=sha1\n'),
    encodeFlush(),
  ]);
}

function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const defaultRef = defaultBranchRef(repo);
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:${defaultRef} side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), encodeFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(defaultRef) ?? ZERO_OID;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(encodePktLine(`${oid} ${name}\n`));
      const peeled = peelOid(store, oid);
      if (peeled !== null) parts.push(encodePktLine(`${peeled} ${name}^{}\n`));
    }
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// v2: ls-refs dan fetch
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function v2LsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const defaultRef = defaultBranchRef(repo);
  const headOid = repo.refs.get(defaultRef);
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      parts.push(
        encodePktLine(`${headOid} HEAD${args.symrefs ? ` symref-target:${defaultRef}` : ''}\n`),
      );
    } else if (args.unborn) {
      parts.push(encodePktLine(`unborn HEAD${args.symrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peelOid(store, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(encodePktLine(`${line}\n`));
  }
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

function v2FetchResponse(store: Store, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const pack = buildPack(store, plan.sendOids);
  const parts: Buffer[] = [];
  // Seksi acknowledgments hanya bila client BELUM mengirim `done`: sesudah
  // `done`, git langsung mengharapkan seksi packfile (atau shallow-info).
  if (!args.done) {
    parts.push(encodePktLine('acknowledgments\n'));
    if (plan.commonHaves.length > 0) {
      for (const oid of plan.commonHaves) parts.push(encodePktLine(`ACK ${oid}\n`));
    } else {
      parts.push(encodePktLine('NAK\n'));
    }
    parts.push(encodePktLine('ready\n'));
    parts.push(encodeDelim());
  }
  if (plan.shallowOut.length > 0 || plan.unshallowOut.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(encodeDelim());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sideBand(1, pack));
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

/** Bagi request v2 menjadi perintah + argumen (dipisah paket delim). */
function parseV2Request(packets: PktLine[]): { command: string; args: string[] } {
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind === 'flush' || packet.kind === 'end') break;
    if (packet.kind !== 'data') continue;
    const line = packet.data.toString('utf8');
    if (!afterDelim) {
      if (line.startsWith('command=')) command = line.slice(8).replace(/\n$/, '');
    } else {
      args.push(line);
    }
  }
  return { command, args };
}

function parseV2FetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const raw of lines) {
    const text = raw.replace(/\n$/, '');
    if (text === 'done') {
      args.done = true;
    } else if (text.startsWith('want ')) {
      const oid = text.slice(5, 45);
      if (isOid(oid)) args.wants.push(oid);
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5, 45);
      if (isOid(oid)) args.haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8, 48);
      if (isOid(oid)) args.shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const depth = parseInt(text.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) args.deepen = depth;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// v0: fetch
// ---------------------------------------------------------------------------------------------

function parseV0Fetch(packets: PktLine[]): FetchArgs {
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind !== 'data') continue;
    sections[sections.length - 1].push(packet.data.toString('utf8'));
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const raw of sections[0] ?? []) {
    const text = raw.replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const oid = text.split(' ')[1] ?? '';
      if (isOid(oid)) args.wants.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8).trim();
      if (isOid(oid)) args.shallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const depth = parseInt(text.slice(7), 10);
      if (Number.isFinite(depth) && depth > 0) args.deepen = depth;
    }
  }
  for (const section of sections.slice(1)) {
    for (const raw of section) {
      const text = raw.replace(/\n$/, '');
      if (text.startsWith('have ')) {
        const oid = text.slice(5).trim();
        if (isOid(oid)) args.haves.push(oid);
      }
    }
  }
  return args;
}

function v0FetchResponse(store: Store, args: FetchArgs): Buffer {
  const plan = planFetch(store, args);
  const pack = buildPack(store, plan.sendOids);
  const parts: Buffer[] = [];
  // multi_ack_detailed: satu baris `ACK <oid> common` per have yang sama,
  // lalu satu baris `ACK <oid>` final sebagai tanda siap; bila tidak ada
  // yang sama, kirim NAK. Pack dikirim dalam respons yang sama.
  if (plan.commonHaves.length > 0) {
    for (const oid of plan.commonHaves) parts.push(encodePktLine(`ACK ${oid} common\n`));
    parts.push(encodePktLine(`ACK ${plan.commonHaves[plan.commonHaves.length - 1]}\n`));
  } else {
    parts.push(encodePktLine('NAK\n'));
  }
  for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sideBand(1, pack));
  parts.push(encodeFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

async function handleUploadPack(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let packets: PktLine[];
  try {
    packets = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line stream' });
    return;
  }
  const looksV2 =
    headerValue(req, 'git-protocol').includes('version=2') ||
    packets.some((packet) => packet.kind === 'data' && packet.data.toString('utf8').startsWith('command='));
  if (looksV2) {
    const { command, args } = parseV2Request(packets);
    if (command === 'ls-refs') {
      const lsArgs: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
      for (const raw of args) {
        const text = raw.replace(/\n$/, '');
        if (text === 'peel') lsArgs.peel = true;
        else if (text === 'symrefs') lsArgs.symrefs = true;
        else if (text === 'unborn') lsArgs.unborn = true;
        else if (text.startsWith('ref-prefix ')) lsArgs.prefixes.push(text.slice(11));
      }
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(v2LsRefsResponse(store, repo, lsArgs));
      return;
    }
    if (command === 'fetch') {
      res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
      res.end(v2FetchResponse(store, parseV2FetchArgs(args)));
      return;
    }
    sendJson(res, 400, { message: `unknown upload-pack command: ${command}` });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
  res.end(v0FetchResponse(store, parseV0Fetch(packets)));
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

/**
 * Pindai seksi perintah receive-pack (pkt-line sampai flush pertama).
 * Sisa byte sesudah flush adalah packfile mentah — sengaja tidak diurai
 * sebagai pkt-line.
 */
function scanCommandSection(body: Buffer): { lines: string[]; packStart: number } {
  const lines: string[] = [];
  let pos = 0;
  for (;;) {
    if (pos + 4 > body.length) throw new Error('receive-pack: command section truncated');
    const header = body.subarray(pos, pos + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error('receive-pack: bad pkt-line header');
    const length = parseInt(header, 16);
    if (length === 0) {
      pos += 4;
      break;
    }
    if (length < 4 || pos + length > body.length) throw new Error('receive-pack: bad pkt-line length');
    lines.push(body.subarray(pos + 4, pos + length).toString('utf8'));
    pos += length;
  }
  return { lines, packStart: pos };
}

function parsePushCommand(line: string): { oldOid: string; newOid: string; ref: string } | null {
  const text = line.replace(/\n$/, '');
  const nul = text.indexOf('\0');
  const head = nul >= 0 ? text.slice(0, nul) : text;
  const parts = head.split(' ');
  if (parts.length !== 3) return null;
  return { oldOid: parts[0], newOid: parts[1], ref: parts[2] };
}

async function handleReceivePack(req: IncomingMessage, res: ServerResponse, store: Store, repo: Repo): Promise<void> {
  const body = await readBody(req);
  let scanned: { lines: string[]; packStart: number };
  try {
    scanned = scanCommandSection(body);
  } catch {
    sendJson(res, 400, { message: 'malformed receive-pack command list' });
    return;
  }
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const line of scanned.lines) {
    const command = parsePushCommand(line);
    if (!command || !isOid(command.oldOid) || !isOid(command.newOid) || !command.ref.startsWith('refs/')) {
      sendJson(res, 400, { message: 'malformed receive-pack command' });
      return;
    }
    commands.push(command);
  }
  if (commands.length === 0) {
    sendJson(res, 400, { message: 'empty receive-pack command list' });
    return;
  }

  // Unpack dulu: semua objek dari pack disimpan apa pun hasil validasi ref.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(scanned.packStart);
  if (packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes);
      for (const obj of objects) store.putObject(obj.type, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message.replace(/[\r\n]+/g, ' ') : 'unpack failed';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Hapus ref.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else {
        store.deleteRef(repo, command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else if (command.oldOid === ZERO_OID) {
      // Buat ref baru.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!store.getObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    } else {
      // Perbarui ref: harus fast-forward dari nilai lama.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old value does not match' });
      } else if (command.newOid === command.oldOid) {
        results.push({ ref: command.ref, ok: true, reason: '' });
      } else if (!store.getObject(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else if (!store.isAncestor(command.oldOid, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        store.setRef(repo, command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
    }
  }

  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = Buffer.concat([...reportLines.map((line) => encodePktLine(line)), encodeFlush()]);
  const out = Buffer.concat([sideBand(1, report), encodeFlush()]);
  res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result' });
  res.end(out);
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

/**
 * Tangani satu request git. Kembalikan true bila path ini rute git dan sudah
 * dijawab (termasuk jawaban error 401/404/400/405), false bila bukan rute
 * git sehingga pemanggil (app.ts) bisa meneruskannya ke router lain.
 *
 * `parts` opsional: bila app.ts sudah mengurai path, teruskan
 * `{ owner, repo, action }` dengan action salah satu dari
 * `info/refs`, `git-upload-pack`, `git-receive-pack` (untuk info/refs,
 * parameter `service` tetap dibaca dari query URL).
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  parts?: GitRouteParts,
): Promise<boolean> {
  let owner: string;
  let repoName: string;
  let action: string;
  if (parts !== undefined) {
    owner = parts.owner;
    repoName = parts.repo;
    action = parts.action;
  } else {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return false;
    }
    const match = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (!match) return false;
    try {
      owner = decodeURIComponent(match[1]);
      repoName = decodeURIComponent(match[2]);
    } catch {
      return false;
    }
    action = match[3];
  }

  if (!authorized(req)) {
    sendJson(res, 401, { message: 'unauthorized' });
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    sendJson(res, 404, { message: 'repository not found' });
    return true;
  }

  try {
    if (action === 'info/refs') {
      if (req.method !== 'GET') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      let service = '';
      try {
        service = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('service') ?? '';
      } catch {
        service = '';
      }
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, { message: 'unknown service' });
        return true;
      }
      const v2 = service === 'git-upload-pack' && headerValue(req, 'git-protocol').includes('version=2');
      const body = v2 ? v2Advertisement() : v0Advertisement(store, repo, service);
      res.writeHead(200, { 'Content-Type': `application/x-${service}-advertisement` });
      res.end(body);
      return true;
    }
    if (action === 'git-upload-pack') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      await handleUploadPack(req, res, store, repo);
      return true;
    }
    if (action === 'git-receive-pack') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { message: 'method not allowed' });
        return true;
      }
      await handleReceivePack(req, res, store, repo);
      return true;
    }
    return false;
  } catch {
    if (!res.headersSent) sendJson(res, 500, { message: 'internal error' });
    else {
      try {
        res.end();
      } catch {
        // Respons sudah terkirim sebagian; tidak ada yang bisa dilakukan.
      }
    }
    return true;
  }
}
