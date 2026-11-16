// GraphQL v4 mini-engine untuk github-core-clone-01.
//
// Melayani POST /api/graphql di atas Store yang sama dengan REST/MCP/git.
// Parser GraphQL kecil ditulis sendiri (tokenizer + parser rekursif untuk
// dokumen yang dipakai gh / github-mcp-server), lalu executor di atas Store.
//
// Aturan wire yang dipenuhi:
//   - auth Bearer harus sama persis dengan process.env.MAKEFUN_SHOP_TOKEN,
//     tanpa/salah -> 401 {"message": ...}
//   - field tidak dikenal -> HTTP 200 + errors[] yang menyebut nama field itu
//   - repo tidak dikenal -> data.repository = null tanpa errors
//   - satu body JSON array -> satu hasil per operasi, urutan sama
//   - id global (Relay) opaque dan stabil: base64("<Kind>:<kunci>"), bukan
//     angka database mentah
//   - tidak ada Date.now()/Math.random(): semua timestamp dari store.nowIso()

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Comment, Issue, Pull, Repo, Store, User } from './store.ts';
import { buildCommit, flattenTree, parseCommit } from './git/objects.ts';

// -------------------------------------------------------------------------------------------
// Konstanta skenario (FIX dari SPEC) dan id global
// -------------------------------------------------------------------------------------------

const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

function viewerUser(): User {
  return VIEWER;
}

function userForLogin(login: string): User {
  if (login === VIEWER.login) return VIEWER;
  return { id: 0, login, name: login, email: '' };
}

/** Id global opaque: base64("Kind:kunci"). Stabil karena kuncinya deterministik. */
function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

function ungid(id: string): { kind: string; rest: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const cut = text.indexOf(':');
    if (cut <= 0) return null;
    return { kind: text.slice(0, cut), rest: text.slice(cut + 1) };
  } catch {
    return null;
  }
}

function repoGid(repo: Repo): string {
  return gid('Repository', String(repo.id));
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('Issue', `${repo.fullName}:${issue.number}`);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('PullRequest', `${repo.fullName}:${pull.number}`);
}

function findRepoByGid(store: Store, id: string): Repo | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  const wanted = Number(decoded.rest);
  if (!Number.isInteger(wanted)) return null;
  for (const repo of store.repos.values()) {
    if (repo.id === wanted) return repo;
  }
  return null;
}

/** "owner/name:number" -> [repo, number]. */
function findIssueByGid(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'Issue') return null;
  const cut = decoded.rest.lastIndexOf(':');
  if (cut < 0) return null;
  const fullName = decoded.rest.slice(0, cut);
  const number = Number(decoded.rest.slice(cut + 1));
  if (!Number.isInteger(number)) return null;
  const slash = fullName.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (!repo) return null;
  const issue = repo.issues.get(number);
  if (!issue) return null;
  return { repo, issue };
}

function findPullByGid(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = ungid(id);
  if (decoded === null || decoded.kind !== 'PullRequest') return null;
  const cut = decoded.rest.lastIndexOf(':');
  if (cut < 0) return null;
  const fullName = decoded.rest.slice(0, cut);
  const number = Number(decoded.rest.slice(cut + 1));
  if (!Number.isInteger(number)) return null;
  const slash = fullName.indexOf('/');
  if (slash < 0) return null;
  const repo = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1));
  if (!repo) return null;
  const pull = repo.pulls.get(number);
  if (!pull) return null;
  return { repo, pull };
}

// -------------------------------------------------------------------------------------------
// Komentar issue: disimpan di Store (repo.comments), wadah yang sama dengan
// REST — komentar dari GraphQL terbaca lewat REST dan sebaliknya.
// -------------------------------------------------------------------------------------------

export interface StoredComment {
  id: string;
  body: string;
  createdAt: string;
}

export function getIssueComments(store: Store, owner: string, name: string, number: number): StoredComment[] {
  const repo = store.getRepo(owner, name);
  if (!repo) return [];
  return (repo.comments.get(number) ?? []).map((c) => ({
    id: gid('IssueComment', `${repo.fullName}:${number}:${c.id}`),
    body: c.body,
    createdAt: c.createdAt,
  }));
}

function addStoredComment(repo: Repo, number: number, body: string, createdAt: string): StoredComment {
  const comment: Comment = {
    id: repo.nextCommentId,
    body,
    user: viewerUser(),
    createdAt,
    updatedAt: createdAt,
  };
  repo.nextCommentId += 1;
  const list = repo.comments.get(number) ?? [];
  list.push(comment);
  repo.comments.set(number, list);
  return {
    id: gid('IssueComment', `${repo.fullName}:${number}:${comment.id}`),
    body: comment.body,
    createdAt: comment.createdAt,
  };
}

// -------------------------------------------------------------------------------------------
// Tabel skema introspection (yang dicek gh: __type Issue/PullRequest/Repository
// dan enumValues SearchType). Hanya berisi field yang executor bisa jawab.
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'closedAt', 'author'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'body', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequests', 'pullRequest',
    'createdAt', 'updatedAt',
  ],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Ref: ['name'],
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// -------------------------------------------------------------------------------------------
// Tokenizer + parser GraphQL kecil. Hanya untuk dokumen yang dikirim gh /
// github-mcp-server: query/mutation bernama, definisi variabel, argumen
// (variabel, literal, enum, list, objek input), fragment inline + spread,
// alias, direktif (di-parse lalu diabaikan kecuali @skip/@include).
// Bukan parser GraphQL lengkap — tapi benar-benar mem-parse, bukan string-match.
// -------------------------------------------------------------------------------------------

type TokenKind = 'name' | 'string' | 'int' | 'float' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

class ParseError extends Error {}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < n) {
          const esc = src[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < n) {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      if (j >= n) throw new ParseError('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      if (src[j] === '.' && src[j + 1] >= '0' && src[j + 1] <= '9') {
        isFloat = true;
        j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && src[j] >= '0' && src[j] <= '9') j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z')) {
      let j = i;
      while (j < n && (src[j] === '_' || (src[j] >= 'a' && src[j] <= 'z') || (src[j] >= 'A' && src[j] <= 'Z') || (src[j] >= '0' && src[j] <= '9'))) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgNode {
  name: string;
  value: ValueNode;
}

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: ArgNode[];
  directives: Array<{ name: string; args: ArgNode[] }>;
  selections: Selection[] | null;
}

interface InlineFragment {
  kind: 'inline';
  typeCondition: string | null;
  directives: Array<{ name: string; args: ArgNode[] }>;
  selections: Selection[];
}

interface Spread {
  kind: 'spread';
  name: string;
  directives: Array<{ name: string; args: ArgNode[] }>;
}

type Selection = FieldSelection | InlineFragment | Spread;

interface VarDef {
  name: string;
  type: string;
  defaultValue?: ValueNode;
}

interface Operation {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefs: VarDef[];
  selections: Selection[];
}

interface FragmentDef {
  name: string;
  typeCondition: string;
  selections: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, FragmentDef>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const tok = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new ParseError(`expected "${value}", got ${tok.kind} ${JSON.stringify(tok.value)}`);
    }
  }

  private acceptPunct(value: string): boolean {
    const tok = this.peek();
    if (tok.kind === 'punct' && tok.value === value) {
      this.next();
      return true;
    }
    return false;
  }

  private expectName(what = 'name'): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new ParseError(`expected ${what}, got ${tok.kind} ${JSON.stringify(tok.value)}`);
    return tok.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, FragmentDef>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.kind === 'punct' && tok.value === '{') {
        operations.push({ opType: 'query', name: null, varDefs: [], selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const name = this.expectName('fragment name');
        const on = this.expectName('"on"');
        if (on !== 'on') throw new ParseError('expected "on" in fragment definition');
        const typeCondition = this.expectName('fragment type condition');
        this.parseDirectives();
        fragments.set(name, { name, typeCondition, selections: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.next();
        const opType = tok.value as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        const varDefs = this.parseVarDefs();
        this.parseDirectives();
        operations.push({ opType, name, varDefs, selections: this.parseSelectionSet() });
        continue;
      }
      throw new ParseError(`unexpected token ${tok.kind} ${JSON.stringify(tok.value)} at document level`);
    }
    if (operations.length === 0) throw new ParseError('document has no operation');
    return { operations, fragments };
  }

  private parseVarDefs(): VarDef[] {
    const defs: VarDef[] = [];
    if (!this.acceptPunct('(')) return defs;
    while (!this.acceptPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName('variable name');
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | undefined;
      if (this.acceptPunct('=')) defaultValue = this.parseValue(true);
      defs.push(defaultValue === undefined ? { name, type } : { name, type, defaultValue });
    }
    return defs;
  }

  private parseType(): string {
    if (this.acceptPunct('[')) {
      const inner = this.parseType();
      this.expectPunct(']');
      let out = `[${inner}]`;
      if (this.acceptPunct('!')) out += '!';
      return out;
    }
    const name = this.expectName('type name');
    return this.acceptPunct('!') ? `${name}!` : name;
  }

  private parseDirectives(): Array<{ name: string; args: ArgNode[] }> {
    const out: Array<{ name: string; args: ArgNode[] }> = [];
    while (this.acceptPunct('@')) {
      const name = this.expectName('directive name');
      out.push({ name, args: this.parseArguments() });
    }
    return out;
  }

  private parseArguments(): ArgNode[] {
    const args: ArgNode[] = [];
    if (!this.acceptPunct('(')) return args;
    while (!this.acceptPunct(')')) {
      const name = this.expectName('argument name');
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      if (isConst) throw new ParseError('variable in constant value');
      return { kind: 'variable', name: this.expectName('variable name') };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue(isConst));
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.acceptPunct('}')) {
        const name = this.expectName('object field name');
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new ParseError(`unexpected value token ${tok.kind} ${JSON.stringify(tok.value)}`);
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.acceptPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'punct' && this.peek().value === '...') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.expectName('inline fragment type');
        const directives = this.parseDirectives();
        return { kind: 'inline', typeCondition, directives, selections: this.parseSelectionSet() };
      }
      if (this.peek().kind === 'name') {
        const name = this.next().value;
        const directives = this.parseDirectives();
        return { kind: 'spread', name, directives };
      }
      const directives = this.parseDirectives();
      return { kind: 'inline', typeCondition: null, directives, selections: this.parseSelectionSet() };
    }
    const first = this.expectName('field name');
    let name = first;
    let alias: string | null = null;
    if (this.acceptPunct(':')) {
      alias = first;
      name = this.expectName('field name after alias');
    }
    const args = this.parseArguments();
    const directives = this.parseDirectives();
    let selections: Selection[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name, alias, args, directives, selections };
  }
}

function parseDocument(src: string): Document {
  return new Parser(tokenize(src)).parseDocument();
}

// -------------------------------------------------------------------------------------------
// Executor
// -------------------------------------------------------------------------------------------

class FieldError extends Error {}

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

/** Nilai runtime: objek bertanda __typename, atau record polos (payload dsb). */
type RuntimeValue = Record<string, unknown> & { __typename?: string };

function nodeOf(typename: string, extra: Record<string, unknown>): RuntimeValue {
  return { __typename: typename, ...extra };
}

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      const v = ctx.variables[node.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, ctx);
      return out;
    }
  }
}

function argMap(sel: FieldSelection, ctx: ExecCtx): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const arg of sel.args) out.set(arg.name, resolveValue(arg.value, ctx));
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) && n >= 0 ? n : -1;
  } catch {
    return -1;
  }
}

function pageInfoFor(start: number, end: number, total: number): RuntimeValue {
  return nodeOf('PageInfo', {
    hasNextPage: end < total,
    hasPreviousPage: start > 0,
    endCursor: end > start ? encodeCursor(end - 1) : null,
    startCursor: end > start ? encodeCursor(start) : null,
  });
}

function issueNode(repo: Repo, issue: Issue): RuntimeValue {
  return nodeOf('Issue', { repo, issue });
}

function pullNode(repo: Repo, pull: Pull): RuntimeValue {
  return nodeOf('PullRequest', { repo, pull });
}

function issueStateOut(state: string): string {
  return state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullStateOut(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function mergeableOut(repo: Repo, pull: Pull, store: Store): string {
  const headSha = pull.head.sha;
  const baseSha = pull.base.sha;
  if (!headSha || !baseSha) return 'UNKNOWN';
  if (!store.getObject(headSha) || !store.getObject(baseSha)) return 'UNKNOWN';
  return pull.mergeable ? 'MERGEABLE' : 'CONFLICTING';
}

/** Daftar path yang berubah antara tree base dan tree head (tambah/ubah/hapus). */
function changedPaths(store: Store, baseSha: string, headSha: string): string[] {
  const out: string[] = [];
  try {
    const headObj = headSha ? store.getObject(headSha) : undefined;
    if (!headObj) return out;
    const headTree = parseCommit(headObj.data).tree;
    const headFiles = flattenTree(store, headTree);
    const baseFiles = new Map<string, { mode: string; oid: string }>();
    const baseObj = baseSha ? store.getObject(baseSha) : undefined;
    if (baseObj) {
      const baseTree = parseCommit(baseObj.data).tree;
      for (const [path, entry] of flattenTree(store, baseTree)) baseFiles.set(path, entry);
    }
    for (const [path, entry] of headFiles) {
      const base = baseFiles.get(path);
      if (!base || base.oid !== entry.oid) out.push(path);
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) out.push(path);
    }
  } catch {
    return out;
  }
  out.sort();
  return out;
}

function issuesConnection(repo: Repo, args: Map<string, unknown>): RuntimeValue {
  let list = [...repo.issues.values()];
  const states = args.get('states');
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : String(s).toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.get('orderBy');
  const orderRec = isRecord(orderBy) ? orderBy : {};
  const direction = orderRec.direction === 'DESC' ? -1 : 1;
  const field = typeof orderRec.field === 'string' ? orderRec.field : 'CREATED_AT';
  list.sort((a, b) => {
    let cmp: number;
    if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else cmp = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (cmp === 0) cmp = a.number - b.number;
    return cmp * direction;
  });
  const total = list.length;
  const after = args.get('after');
  let start = 0;
  if (typeof after === 'string' && after !== '') {
    const idx = decodeCursor(after);
    if (idx >= 0) start = Math.min(idx + 1, total);
  }
  const first = args.get('first');
  const end = typeof first === 'number' && first >= 0 ? Math.min(total, start + Math.floor(first)) : total;
  const page = list.slice(start, end);
  return nodeOf('IssueConnection', {
    items: page.map((issue) => issueNode(repo, issue)),
    pageInfo: pageInfoFor(start, end, total),
    totalCount: total,
  });
}

function pullsConnection(repo: Repo, args: Map<string, unknown>): RuntimeValue {
  const list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  const total = list.length;
  const first = args.get('first');
  const end = typeof first === 'number' && first >= 0 ? Math.min(total, Math.floor(first)) : total;
  const page = list.slice(0, end);
  return nodeOf('PullRequestConnection', {
    items: page.map((pull) => pullNode(repo, pull)),
    pageInfo: pageInfoFor(0, end, total),
    totalCount: total,
  });
}

function filesConnection(store: Store, repo: Repo, pull: Pull, args: Map<string, unknown>): RuntimeValue {
  const paths = changedPaths(store, pull.base.sha, pull.head.sha);
  const first = args.get('first');
  const limited = typeof first === 'number' && first >= 0 ? paths.slice(0, Math.floor(first)) : paths;
  return nodeOf('PullRequestChangedFileConnection', {
    items: limited.map((path) => nodeOf('PullRequestChangedFile', { path })),
    pageInfo: pageInfoFor(0, limited.length, paths.length),
    totalCount: paths.length,
  });
}

// -------------------------------------------------------------------------------------------
// Mutasi
// -------------------------------------------------------------------------------------------

function nextNumericId(repo: Repo, number: number): number {
  return repo.id * 1000000 + number;
}

/** Id numerik PR: rentang terpisah dari issue agar id issue dan PR tidak pernah sama. */
function nextPullNumericId(repo: Repo, number: number): number {
  return repo.id * 1000000 + 500000 + number;
}

function doCreateIssue(store: Store, input: Record<string, unknown>): RuntimeValue {
  const repositoryId = input.repositoryId;
  if (typeof repositoryId !== 'string') throw new FieldError('createIssue needs input.repositoryId');
  const repo = findRepoByGid(store, repositoryId);
  if (!repo) throw new FieldError(`createIssue: unknown repository ${repositoryId}`);
  const title = input.title;
  if (typeof title !== 'string' || title === '') throw new FieldError('createIssue needs input.title');
  const body = typeof input.body === 'string' ? input.body : '';
  const now = store.nowIso();
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const issue: Issue = {
    id: nextNumericId(repo, number),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    user: viewerUser(),
    assignee: null,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
  };
  repo.issues.set(number, issue);
  return nodeOf('CreateIssuePayload', { issue: issueNode(repo, issue) });
}

function doCloseIssue(store: Store, input: Record<string, unknown>): RuntimeValue {
  const issueId = input.issueId;
  if (typeof issueId !== 'string') throw new FieldError('closeIssue needs input.issueId');
  const found = findIssueByGid(store, issueId);
  if (!found) throw new FieldError(`closeIssue: unknown issue ${issueId}`);
  const now = store.nowIso();
  found.issue.state = 'closed';
  found.issue.closedAt = now;
  found.issue.updatedAt = now;
  return nodeOf('CloseIssuePayload', { issue: issueNode(found.repo, found.issue) });
}

function doCreatePullRequest(store: Store, input: Record<string, unknown>): RuntimeValue {
  const repositoryId = input.repositoryId;
  if (typeof repositoryId !== 'string') throw new FieldError('createPullRequest needs input.repositoryId');
  const repo = findRepoByGid(store, repositoryId);
  if (!repo) throw new FieldError(`createPullRequest: unknown repository ${repositoryId}`);
  const headRefName = input.headRefName;
  const baseRefName = input.baseRefName;
  const title = input.title;
  if (typeof headRefName !== 'string' || typeof baseRefName !== 'string') {
    throw new FieldError('createPullRequest needs input.headRefName and input.baseRefName');
  }
  if (typeof title !== 'string' || title === '') throw new FieldError('createPullRequest needs input.title');
  const headSha = store.getRef(repo, headRefName);
  if (!headSha) throw new FieldError(`createPullRequest: head ref not found: ${headRefName}`);
  const baseSha = store.getRef(repo, baseRefName) ?? '';
  const body = typeof input.body === 'string' ? input.body : '';
  const now = store.nowIso();
  const number = repo.nextPull;
  repo.nextPull += 1;
  const mergeable = baseSha !== '' && store.getObject(baseSha) !== undefined ? store.isAncestor(baseSha, headSha) : false;
  const pull: Pull = {
    id: nextPullNumericId(repo, number),
    number,
    title,
    body,
    state: 'open',
    head: { ref: headRefName, sha: headSha, repo: repo.fullName },
    base: { ref: baseRefName, sha: baseSha, repo: repo.fullName },
    merged: false,
    mergeable,
    mergeCommitSha: null,
    user: viewerUser(),
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    mergedAt: null,
  };
  repo.pulls.set(number, pull);
  return nodeOf('CreatePullRequestPayload', { pullRequest: pullNode(repo, pull) });
}

function doMergePullRequest(store: Store, input: Record<string, unknown>): RuntimeValue {
  const pullRequestId = input.pullRequestId;
  if (typeof pullRequestId !== 'string') throw new FieldError('mergePullRequest needs input.pullRequestId');
  const found = findPullByGid(store, pullRequestId);
  if (!found) throw new FieldError(`mergePullRequest: unknown pull request ${pullRequestId}`);
  const { repo, pull } = found;
  if (!pull.merged) {
    // Squash merge: commit baru di default branch, parent = ujung branch itu,
    // tree = tree head PR, message = judul PR (sama seperti REST).
    const baseSha = store.getRef(repo, pull.base.ref);
    const headObj = pull.head.sha ? store.getObject(pull.head.sha) : undefined;
    if (!headObj) throw new FieldError(`mergePullRequest: head commit not found: ${pull.head.sha}`);
    const treeOid = parseCommit(headObj.data).tree;
    const parents = baseSha ? [baseSha] : [];
    const mergeSha = buildCommit(store, treeOid, parents, pull.title);
    store.setRef(repo, `refs/heads/${pull.base.ref}`, mergeSha);
    pull.mergeCommitSha = mergeSha;
    const now = store.nowIso();
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAt = now;
    pull.closedAt = now;
    pull.updatedAt = now;
  }
  return nodeOf('MergePullRequestPayload', { pullRequest: pullNode(repo, pull) });
}

function doAddComment(store: Store, input: Record<string, unknown>): RuntimeValue {
  const subjectId = input.subjectId;
  if (typeof subjectId !== 'string') throw new FieldError('addComment needs input.subjectId');
  const found = findIssueByGid(store, subjectId);
  if (!found) throw new FieldError(`addComment: unknown subject ${subjectId}`);
  const body = input.body;
  if (typeof body !== 'string') throw new FieldError('addComment needs input.body');
  const comment = addStoredComment(found.repo, found.issue.number, body, store.nowIso());
  const node = nodeOf('IssueComment', { id: comment.id, body: comment.body });
  return nodeOf('AddCommentPayload', { commentEdge: nodeOf('IssueCommentEdge', { node }) });
}

// -------------------------------------------------------------------------------------------
// Resolver field per tipe
// -------------------------------------------------------------------------------------------

interface Resolved {
  value: unknown;
  typeName: string | null;
}

function resolveField(typeName: string, value: RuntimeValue, sel: FieldSelection, ctx: ExecCtx): Resolved {
  const store = ctx.store;
  const name = sel.name;
  if (name === '__typename') return { value: typeName, typeName: null };

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return { value: nodeOf('User', { user: viewerUser() }), typeName: 'User' };
      if (name === 'repository') {
        const args = argMap(sel, ctx);
        const owner = args.get('owner');
        const repoName = args.get('name');
        if (typeof owner !== 'string' || typeof repoName !== 'string') {
          throw new FieldError('repository needs owner and name arguments');
        }
        const repo = store.getRepo(owner, repoName);
        if (!repo) return { value: null, typeName: 'Repository' };
        return { value: nodeOf('Repository', { repo }), typeName: 'Repository' };
      }
      if (name === 'node') {
        const args = argMap(sel, ctx);
        const id = args.get('id');
        if (typeof id !== 'string') throw new FieldError('node needs an id argument');
        const decoded = ungid(id);
        if (decoded === null) return { value: null, typeName: null };
        if (decoded.kind === 'Repository') {
          const repo = findRepoByGid(store, id);
          if (!repo) return { value: null, typeName: null };
          return { value: nodeOf('Repository', { repo }), typeName: 'Repository' };
        }
        if (decoded.kind === 'Issue') {
          const found = findIssueByGid(store, id);
          if (!found) return { value: null, typeName: null };
          return { value: issueNode(found.repo, found.issue), typeName: 'Issue' };
        }
        if (decoded.kind === 'PullRequest') {
          const found = findPullByGid(store, id);
          if (!found) return { value: null, typeName: null };
          return { value: pullNode(found.repo, found.pull), typeName: 'PullRequest' };
        }
        return { value: null, typeName: null };
      }
      if (name === '__type') {
        const args = argMap(sel, ctx);
        const typeArg = args.get('name');
        if (typeof typeArg !== 'string') throw new FieldError('__type needs a name argument');
        if (!(typeArg in TYPE_FIELDS) && !(typeArg in ENUM_VALUES)) return { value: null, typeName: '__Type' };
        return { value: nodeOf('__Type', { name: typeArg }), typeName: '__Type' };
      }
      break;
    }
    case 'Mutation': {
      const args = argMap(sel, ctx);
      const input = args.get('input');
      if (!isRecord(input)) throw new FieldError(`${name} needs an input object`);
      if (name === 'createIssue') return { value: doCreateIssue(store, input), typeName: 'CreateIssuePayload' };
      if (name === 'closeIssue') return { value: doCloseIssue(store, input), typeName: 'CloseIssuePayload' };
      if (name === 'createPullRequest') return { value: doCreatePullRequest(store, input), typeName: 'CreatePullRequestPayload' };
      if (name === 'mergePullRequest') return { value: doMergePullRequest(store, input), typeName: 'MergePullRequestPayload' };
      if (name === 'addComment') return { value: doAddComment(store, input), typeName: 'AddCommentPayload' };
      break;
    }
    case 'User': {
      const user = value.user as User;
      if (name === 'login') return { value: user.login, typeName: null };
      if (name === 'id') return { value: gid('User', String(user.id)), typeName: null };
      if (name === 'name') return { value: user.name, typeName: null };
      if (name === 'email') return { value: user.email, typeName: null };
      break;
    }
    case 'Repository': {
      const repo = value.repo as Repo;
      if (name === 'id') return { value: repoGid(repo), typeName: null };
      if (name === 'databaseId') return { value: repo.id, typeName: null };
      if (name === 'name') return { value: repo.name, typeName: null };
      if (name === 'nameWithOwner') return { value: repo.fullName, typeName: null };
      if (name === 'owner') return { value: nodeOf('User', { user: userForLogin(repo.owner) }), typeName: 'User' };
      if (name === 'defaultBranchRef') {
        const ref = store.getRef(repo, repo.defaultBranch);
        if (!ref) return { value: null, typeName: 'Ref' };
        return { value: nodeOf('Ref', { name: repo.defaultBranch }), typeName: 'Ref' };
      }
      if (name === 'viewerPermission') return { value: 'ADMIN', typeName: null };
      if (name === 'hasIssuesEnabled') return { value: true, typeName: null };
      if (name === 'description') return { value: repo.description, typeName: null };
      if (name === 'isPrivate') return { value: repo.isPrivate, typeName: null };
      if (name === 'createdAt') return { value: repo.createdAt, typeName: null };
      if (name === 'updatedAt') return { value: repo.updatedAt, typeName: null };
      if (name === 'issue') {
        const args = argMap(sel, ctx);
        const number = args.get('number');
        if (typeof number !== 'number') throw new FieldError('issue needs a number argument');
        const issue = repo.issues.get(number);
        if (!issue) return { value: null, typeName: 'Issue' };
        return { value: issueNode(repo, issue), typeName: 'Issue' };
      }
      if (name === 'issues') return { value: issuesConnection(repo, argMap(sel, ctx)), typeName: 'IssueConnection' };
      if (name === 'pullRequest') {
        const args = argMap(sel, ctx);
        const number = args.get('number');
        if (typeof number !== 'number') throw new FieldError('pullRequest needs a number argument');
        const pull = repo.pulls.get(number);
        if (!pull) return { value: null, typeName: 'PullRequest' };
        return { value: pullNode(repo, pull), typeName: 'PullRequest' };
      }
      if (name === 'pullRequests') return { value: pullsConnection(repo, argMap(sel, ctx)), typeName: 'PullRequestConnection' };
      break;
    }
    case 'Issue': {
      const issue = value.issue as Issue;
      const repo = value.repo as Repo;
      if (name === 'id') return { value: issueGid(repo, issue), typeName: null };
      if (name === 'number') return { value: issue.number, typeName: null };
      if (name === 'title') return { value: issue.title, typeName: null };
      if (name === 'state') return { value: issueStateOut(issue.state), typeName: null };
      if (name === 'body') return { value: issue.body, typeName: null };
      if (name === 'createdAt') return { value: issue.createdAt, typeName: null };
      if (name === 'updatedAt') return { value: issue.updatedAt, typeName: null };
      if (name === 'closedAt') return { value: issue.closedAt, typeName: null };
      if (name === 'author') return { value: nodeOf('User', { user: issue.user }), typeName: 'User' };
      break;
    }
    case 'IssueConnection': {
      if (name === 'nodes') return { value: (value.items as RuntimeValue[]), typeName: 'Issue' };
      if (name === 'pageInfo') return { value: value.pageInfo as RuntimeValue, typeName: 'PageInfo' };
      if (name === 'totalCount') return { value: value.totalCount as number, typeName: null };
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return { value: value.hasNextPage as boolean, typeName: null };
      if (name === 'hasPreviousPage') return { value: value.hasPreviousPage as boolean, typeName: null };
      if (name === 'endCursor') return { value: value.endCursor as string | null, typeName: null };
      if (name === 'startCursor') return { value: value.startCursor as string | null, typeName: null };
      break;
    }
    case 'PullRequest': {
      const pull = value.pull as Pull;
      const repo = value.repo as Repo;
      if (name === 'id') return { value: pullGid(repo, pull), typeName: null };
      if (name === 'number') return { value: pull.number, typeName: null };
      if (name === 'title') return { value: pull.title, typeName: null };
      if (name === 'state') return { value: pullStateOut(pull), typeName: null };
      if (name === 'merged') return { value: pull.merged, typeName: null };
      if (name === 'mergeable') return { value: mergeableOut(repo, pull, store), typeName: null };
      if (name === 'headRefName') return { value: pull.head.ref, typeName: null };
      if (name === 'baseRefName') return { value: pull.base.ref, typeName: null };
      if (name === 'headRef') return { value: nodeOf('Ref', { name: pull.head.ref }), typeName: 'Ref' };
      if (name === 'baseRef') return { value: nodeOf('Ref', { name: pull.base.ref }), typeName: 'Ref' };
      if (name === 'body') return { value: pull.body, typeName: null };
      if (name === 'createdAt') return { value: pull.createdAt, typeName: null };
      if (name === 'updatedAt') return { value: pull.updatedAt, typeName: null };
      if (name === 'closedAt') return { value: pull.closedAt, typeName: null };
      if (name === 'mergedAt') return { value: pull.mergedAt, typeName: null };
      if (name === 'author') return { value: nodeOf('User', { user: pull.user }), typeName: 'User' };
      if (name === 'files') return { value: filesConnection(store, repo, pull, argMap(sel, ctx)), typeName: 'PullRequestChangedFileConnection' };
      break;
    }
    case 'PullRequestConnection': {
      if (name === 'nodes') return { value: (value.items as RuntimeValue[]), typeName: 'PullRequest' };
      if (name === 'pageInfo') return { value: value.pageInfo as RuntimeValue, typeName: 'PageInfo' };
      if (name === 'totalCount') return { value: value.totalCount as number, typeName: null };
      break;
    }
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return { value: (value.items as RuntimeValue[]), typeName: 'PullRequestChangedFile' };
      if (name === 'pageInfo') return { value: value.pageInfo as RuntimeValue, typeName: 'PageInfo' };
      if (name === 'totalCount') return { value: value.totalCount as number, typeName: null };
      break;
    }
    case 'PullRequestChangedFile': {
      if (name === 'path') return { value: value.path as string, typeName: null };
      break;
    }
    case 'Ref': {
      if (name === 'name') return { value: value.name as string, typeName: null };
      break;
    }
    case '__Type': {
      const typeNameValue = value.name as string;
      if (name === 'name') return { value: typeNameValue, typeName: null };
      if (name === 'kind') {
        return { value: typeNameValue in ENUM_VALUES ? 'ENUM' : 'OBJECT', typeName: null };
      }
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeNameValue];
        if (!fields) return { value: null, typeName: '__Field' };
        return { value: fields.map((f) => nodeOf('__Field', { name: f })), typeName: '__Field' };
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[typeNameValue];
        if (!values) return { value: null, typeName: '__EnumValue' };
        return { value: values.map((v) => nodeOf('__EnumValue', { name: v })), typeName: '__EnumValue' };
      }
      if (name === 'description') return { value: null, typeName: null };
      break;
    }
    case '__Field':
    case '__EnumValue': {
      if (name === 'name') return { value: value.name as string, typeName: null };
      if (name === 'description') return { value: null, typeName: null };
      break;
    }
    default: {
      // Payload polos (CreateIssuePayload dsb) dan edge: baca properti langsung.
      if (name in value) {
        const inner = value[name];
        if (isRecord(inner) && typeof inner.__typename === 'string') {
          return { value: inner, typeName: inner.__typename as string };
        }
        return { value: inner ?? null, typeName: null };
      }
      break;
    }
  }
  throw new FieldError(`Cannot query field "${name}" on type "${typeName}".`);
}

function skipByDirectives(sel: FieldSelection | InlineFragment | Spread, ctx: ExecCtx): boolean {
  for (const dir of sel.directives) {
    if (dir.name !== 'skip' && dir.name !== 'include') continue;
    const arg = dir.args.find((a) => a.name === 'if');
    if (!arg) continue;
    const flag = resolveValue(arg.value, ctx);
    if (dir.name === 'skip' && flag === true) return true;
    if (dir.name === 'include' && flag !== true) return true;
  }
  return false;
}

function executeSelections(
  typeName: string,
  value: RuntimeValue,
  selections: Selection[],
  doc: Document,
  ctx: ExecCtx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (skipByDirectives(sel, ctx)) continue;
    if (sel.kind === 'spread') {
      const frag = doc.fragments.get(sel.name);
      if (!frag) {
        ctx.errors.push({ message: `Unknown fragment "${sel.name}".`, path: [...path] });
        continue;
      }
      Object.assign(out, executeSelections(typeName, value, frag.selections, doc, ctx, path));
      continue;
    }
    if (sel.kind === 'inline') {
      if (sel.typeCondition !== null && sel.typeCondition !== typeName) continue;
      Object.assign(out, executeSelections(typeName, value, sel.selections, doc, ctx, path));
      continue;
    }
    const key = sel.alias ?? sel.name;
    try {
      const resolved = resolveField(typeName, value, sel, ctx);
      if (sel.selections !== null && resolved.value !== null && resolved.value !== undefined) {
        const childType = resolved.typeName ?? typeName;
        if (Array.isArray(resolved.value)) {
          out[key] = resolved.value.map((item, i) => {
            if (item === null || item === undefined) return null;
            return executeSelections(childType, item as RuntimeValue, sel.selections as Selection[], doc, ctx, [...path, key, i]);
          });
        } else {
          out[key] = executeSelections(childType, resolved.value as RuntimeValue, sel.selections, doc, ctx, [...path, key]);
        }
      } else {
        out[key] = resolved.value ?? null;
      }
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [...path, key] });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Satu operasi -> satu envelope {data, errors?}
// -------------------------------------------------------------------------------------------

function runOperation(op: unknown, store: Store): Record<string, unknown> {
  if (!isRecord(op) || typeof op.query !== 'string') {
    return { data: null, errors: [{ message: 'GraphQL operation needs a string "query".' }] };
  }
  const variables = isRecord(op.variables) ? (op.variables as Record<string, unknown>) : {};
  let doc: Document;
  try {
    doc = parseDocument(op.query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: Operation | undefined;
  if (typeof op.operationName === 'string') {
    operation = doc.operations.find((o) => o.name === op.operationName);
    if (!operation) {
      return { data: null, errors: [{ message: `Unknown operation named "${op.operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  const ctx: ExecCtx = { store, variables, errors: [] };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  let data: Record<string, unknown>;
  try {
    data = executeSelections(rootType, nodeOf(rootType, {}), operation.selections, doc, ctx, []);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// -------------------------------------------------------------------------------------------
// Handler HTTP: POST /api/graphql. Dipanggil app.ts setelah routing.
// Mengembalikan true bila request ditangani (POST), false bila bukan POST.
// -------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, store: Store, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'X-GitHub-Request-Id': store.requestId(),
  });
  res.end(JSON.stringify(payload));
}

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  if (req.method !== 'POST') return false;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer));
  }
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  const auth = req.headers.authorization ?? '';
  if (token === undefined || token === '' || auth !== `Bearer ${token}`) {
    sendJson(res, 401, store, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendJson(res, 400, store, { message: 'Invalid JSON body' });
    return true;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, store, body.map((op) => runOperation(op, store)));
    return true;
  }
  sendJson(res, 200, store, runOperation(body, store));
  return true;
}
