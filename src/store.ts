import { createHash } from 'node:crypto';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: User;
  assignee: User | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string; repo: string };
  base: { ref: string; sha: string; repo: string };
  merged: boolean;
  mergeable: boolean;
  mergeCommitSha: string | null;
  user: User;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  defaultBranch: string;
  isPrivate: boolean;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextIssue: number;
  nextPull: number;
  nextLabelId: number;
  nextCommentId: number;
  createdAt: string;
  updatedAt: string;
}

/** Pemegang token: viewer skenario (FIXED). */
export const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

export const TEAMMATE: User = {
  id: 1001,
  login: 'quinnkeller',
  name: 'quinn keller',
  email: 'quinnkeller@example.invalid',
};

export const STRANGER: User = {
  id: 1002,
  login: 'olgabauer',
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
};

export const ORG_NAME = 'faint-meadow-org';

export const ZERO_OID = '0000000000000000000000000000000000000000';

const DEFAULT_BASE_ISO = '2026-11-14T06:30:00.000Z';

function parseBaseIso(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? DEFAULT_BASE_ISO;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.parse(DEFAULT_BASE_ISO);
}

/** SHA-1 id git untuk satu objek: sha1("<type> <len>\0<data>"). */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Ambil daftar oid parent dari byte mentah sebuah commit. */
function commitParents(data: Buffer): string[] {
  const parents: string[] = [];
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return parents;
}

/** Ambil oid tree dari byte mentah sebuah commit ('' bila tidak ada). */
function commitTree(data: Buffer): string {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
  }
  return '';
}

/** Ambil oid target dari byte mentah sebuah tag ('' bila tidak ada). */
function tagTarget(data: Buffer): string {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) return line.slice(7).trim();
  }
  return '';
}

/** Ambil oid anak dari byte mentah sebuah tree. */
function treeChildOids(data: Buffer): string[] {
  const out: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const nul = data.indexOf(0x00, offset);
    if (nul < 0 || nul + 21 > data.length) break;
    out.push(data.subarray(nul + 1, nul + 21).toString('hex'));
    offset = nul + 21;
  }
  return out;
}

export class Store {
  objects: Map<string, GitObject> = new Map();
  repos: Map<string, Repo> = new Map();
  nextRepoId = 1;

  #baseMs: number;
  #tick = 0;
  #reqCounter = 0;

  constructor() {
    this.#baseMs = parseBaseIso();
  }

  /** Jam deterministik: base + counter detik, format ISO UTC. Tiap panggilan maju 1 detik. */
  nowIso(): string {
    this.#tick += 1;
    return new Date(this.#baseMs + this.#tick * 1000).toISOString();
  }

  /** Id request deterministik, non-empty: "req-<counter>". */
  requestId(): string {
    this.#reqCounter += 1;
    return `req-${this.#reqCounter}`;
  }

  hashObject(type: ObjectType, data: Buffer): string {
    return hashObject(type, data);
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  createRepo(owner: string, name: string, description = ''): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description,
      defaultBranch: 'main',
      isPrivate: false,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextLabelId: 1,
      nextCommentId: 1,
      createdAt: this.nowIso(),
      updatedAt: this.nowIso(),
    };
    this.nextRepoId += 1;
    this.repos.set(repo.fullName, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(`${owner}/${name}`);
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(`${owner}/${name}`);
  }

  /** refname penuh ("refs/heads/main") atau pendek ("main" -> refs/heads/main). */
  getRef(repo: Repo, refname: string): string | undefined {
    const direct = repo.refs.get(refname);
    if (direct !== undefined) return direct;
    if (!refname.startsWith('refs/')) return repo.refs.get(`refs/heads/${refname}`);
    return undefined;
  }

  setRef(repo: Repo, refname: string, oid: string): void {
    const full = refname.startsWith('refs/') ? refname : `refs/heads/${refname}`;
    repo.refs.set(full, oid);
    repo.updatedAt = this.nowIso();
  }

  /** Hapus satu ref (nama penuh atau pendek "main"); true bila ref itu ada. */
  deleteRef(repo: Repo, refname: string): boolean {
    const full = refname.startsWith('refs/') ? refname : `refs/heads/${refname}`;
    if (repo.refs.delete(full)) {
      repo.updatedAt = this.nowIso();
      return true;
    }
    if (repo.refs.delete(refname)) {
      repo.updatedAt = this.nowIso();
      return true;
    }
    return false;
  }

  /** True bila ancestor == descendant atau ancestor dapat dicapai lewat rantai parent. */
  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const stack: string[] = [descendant];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of commitParents(obj.data)) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** Closure semua oid yang terjangkau dari oid (commit+tree+blob+tag), minus closure exclude. */
  reachable(oid: string, exclude?: Set<string>): Set<string> {
    const found = this.#closure(oid);
    if (exclude !== undefined) {
      for (const banned of exclude) {
        for (const gone of this.#closure(banned)) found.delete(gone);
      }
    }
    return found;
  }

  #closure(start: string): Set<string> {
    const found = new Set<string>();
    const stack: string[] = [start];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (found.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      found.add(oid);
      if (obj.type === 'commit') {
        const tree = commitTree(obj.data);
        if (tree !== '') stack.push(tree);
        for (const parent of commitParents(obj.data)) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const child of treeChildOids(obj.data)) stack.push(child);
      } else if (obj.type === 'tag') {
        const target = tagTarget(obj.data);
        if (target !== '') stack.push(target);
      }
    }
    return found;
  }
}
