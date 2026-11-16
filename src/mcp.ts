import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, Pull, Repo, Store, User } from './store.ts';
import { buildCommit, parseCommit } from './git/objects.ts';

// MCP endpoint (JSON-RPC 2.0, Streamable HTTP, jawaban application/json).
// Mendukung revisi modern 2026-07-28 (server/discover, tanpa handshake) dan
// handshake lama (initialize + notifications/initialized) untuk revisi <=2025-11-25.

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '0.1.0';
const SESSION_ID = 'mcp-session-1';

const VIEWER: User = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
};

const SUPPORTED_VERSIONS: string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// Daftar tool dibuat sekali di level modul dan tidak pernah diubah, supaya dua
// panggilan tools/list menghasilkan array yang byte-identik.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body text of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        title: { type: 'string', description: 'Title of the pull request.' },
        body: { type: 'string', description: 'Body text of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash commit on the default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Login of the repository owner.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        full_name: { type: 'string', description: 'Full name of the repository, "owner/repo".' },
        pull_number: { type: 'integer', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- util kecil

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function rpcOk(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ---------------------------------------------------------------- argumen

function strArg(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function boolArg(args: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function numArg(args: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

function resolveOwnerRepo(args: Record<string, unknown>): { owner?: string; repo?: string } {
  const full = strArg(args, ['full_name', 'repo_full_name', 'repository_full_name', 'fullName']);
  if (full !== undefined && full.includes('/')) {
    const slash = full.indexOf('/');
    return { owner: full.slice(0, slash), repo: full.slice(slash + 1) };
  }
  return {
    owner: strArg(args, ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name']),
    repo: strArg(args, ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name']),
  };
}

// ---------------------------------------------------------------- bentuk JSON

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 0, type: 'User' },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
  };
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    assignee: issue.assignee === null ? null : { login: issue.assignee.login, id: issue.assignee.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
  };
}

function pullJson(pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head.ref, sha: pull.head.sha, repo: pull.head.repo, label: `${pull.head.repo.split('/')[0] ?? ''}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, repo: pull.base.repo, label: `${pull.base.repo.split('/')[0] ?? ''}:${pull.base.ref}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
  };
}

// ---------------------------------------------------------------- tools

function runTool(name: string, args: Record<string, unknown>, store: Store): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name']);
      if (repoName === undefined) return toolFailure('Missing required argument: name');
      const owner = strArg(args, ['owner', 'owner_login', 'org', 'login']) ?? VIEWER.login;
      const description = strArg(args, ['description', 'about', 'summary', 'body']) ?? '';
      const isPrivate = boolArg(args, ['private', 'is_private']) ?? false;
      const existing = store.getRepo(owner, repoName);
      if (existing !== undefined) return toolResult(repoJson(existing));
      const repo = store.createRepo(owner, repoName, description);
      repo.isPrivate = isPrivate;
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === undefined || repoName === undefined) {
        return toolFailure('Missing required argument: owner and repo (or full_name "owner/repo")');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`Repository not found: ${owner}/${repoName}`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = strArg(args, ['title', 'issue_title', 'subject']);
      if (owner === undefined || repoName === undefined || title === undefined) {
        return toolFailure('Missing required argument: owner, repo, and title');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`Repository not found: ${owner}/${repoName}`);
      const body = strArg(args, ['body', 'issue_body', 'description', 'content', 'text']) ?? '';
      const labels: string[] = Array.isArray(args.labels)
        ? args.labels.filter((entry): entry is string => typeof entry === 'string')
        : [];
      const number = repo.nextIssue;
      repo.nextIssue += 1;
      const now = store.nowIso();
      const issue: Issue = {
        id: repo.id * 1000000 + number,
        number,
        title,
        body,
        state: 'open',
        labels,
        user: VIEWER,
        assignee: null,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(issue));
    }
    case 'list_issues': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      if (owner === undefined || repoName === undefined) {
        return toolFailure('Missing required argument: owner and repo (or full_name "owner/repo")');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`Repository not found: ${owner}/${repoName}`);
      const state = strArg(args, ['state', 'status']) ?? 'all';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(issue));
      const text = JSON.stringify(list);
      return { content: [{ type: 'text', text }], structuredContent: { issues: list } };
    }
    case 'create_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const title = strArg(args, ['title', 'pr_title', 'pull_request_title', 'subject']);
      const head = strArg(args, ['head', 'head_ref', 'head_branch', 'source', 'source_ref', 'source_branch', 'from_branch', 'branch']);
      const base = strArg(args, ['base', 'base_ref', 'base_branch', 'target', 'target_ref', 'target_branch', 'into_branch']);
      if (owner === undefined || repoName === undefined || title === undefined || head === undefined || base === undefined) {
        return toolFailure('Missing required argument: owner, repo, title, head, and base');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`Repository not found: ${owner}/${repoName}`);
      const headSha = store.getRef(repo, head);
      if (headSha === undefined) return toolFailure(`Unknown head ref: ${head}`);
      const baseSha = store.getRef(repo, base);
      if (baseSha === undefined) return toolFailure(`Unknown base ref: ${base}`);
      const body = strArg(args, ['body', 'description', 'content', 'text']) ?? '';
      const number = repo.nextPull;
      repo.nextPull += 1;
      const now = store.nowIso();
      const pull: Pull = {
        id: repo.id * 1000000 + 500000 + number,
        number,
        title,
        body,
        state: 'open',
        head: { ref: head, sha: headSha, repo: repo.fullName },
        base: { ref: base, sha: baseSha, repo: repo.fullName },
        merged: false,
        mergeable: true,
        mergeCommitSha: null,
        user: VIEWER,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        mergedAt: null,
      };
      repo.pulls.set(number, pull);
      return toolResult(pullJson(pull));
    }
    case 'merge_pull_request': {
      const { owner, repo: repoName } = resolveOwnerRepo(args);
      const pullNumber = numArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number']);
      if (owner === undefined || repoName === undefined || pullNumber === undefined) {
        return toolFailure('Missing required argument: owner, repo, and pull_number');
      }
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) return toolFailure(`Repository not found: ${owner}/${repoName}`);
      const pull = repo.pulls.get(pullNumber);
      if (pull === undefined) return toolFailure(`Pull request not found: #${pullNumber}`);
      if (pull.merged) {
        return toolResult({ merged: true, sha: pull.mergeCommitSha, message: `Pull request #${pullNumber} is already merged`, number: pullNumber });
      }
      if (pull.mergeable === false) return toolFailure(`Pull request #${pullNumber} is not mergeable`);
      const headObject = store.getObject(pull.head.sha);
      if (headObject === undefined) return toolFailure(`Unknown head commit: ${pull.head.sha}`);
      const headCommit = parseCommit(headObject.data);
      const defaultHead = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
      const parents = defaultHead === undefined ? [] : [defaultHead];
      const squashSha = buildCommit(store, headCommit.tree, parents, pull.title);
      store.setRef(repo, `refs/heads/${repo.defaultBranch}`, squashSha);
      const now = store.nowIso();
      pull.state = 'closed';
      pull.merged = true;
      pull.mergeCommitSha = squashSha;
      pull.mergedAt = now;
      pull.updatedAt = now;
      pull.closedAt = now;
      return toolResult({ merged: true, sha: squashSha, message: `Pull request #${pullNumber} merged`, number: pullNumber });
    }
    default:
      return toolFailure(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC

function dispatch(message: unknown, store: Store): Record<string, unknown> | null {
  if (!isRecord(message) || typeof message.method !== 'string') {
    const id = isRecord(message) ? message.id : undefined;
    return rpcError(id, -32600, 'Invalid Request');
  }
  const id = message.id;
  const params = isRecord(message.params) ? message.params : {};
  const method = message.method;
  if (method === 'server/discover') {
    return rpcOk(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'GitHub-compatible forge: repositories, issues, and pull requests over MCP tools.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
    return rpcOk(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list') return rpcOk(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (toolName === '') return rpcError(id, -32602, 'Missing required argument: name');
    if (TOOLS.find((tool) => tool.name === toolName) === undefined) {
      return rpcError(id, -32601, `Unknown tool: ${toolName}`);
    }
    return rpcOk(id, runTool(toolName, args, store));
  }
  if (method.startsWith('notifications/')) return null;
  if (id === undefined) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------- handler

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const url = new URL(req.url ?? '/mcp', 'http://127.0.0.1');
  if (url.pathname !== '/mcp') return false;
  if (req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method not allowed' });
    return true;
  }
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const auth = req.headers.authorization ?? '';
  if (expected === '' || auth !== `Bearer ${expected}`) {
    sendJson(res, 401, { message: 'Unauthorized' });
    return true;
  }
  const raw = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (Array.isArray(body)) {
    const answers: Array<Record<string, unknown>> = [];
    for (const message of body) {
      const answer = dispatch(message, store);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) {
      res.writeHead(202);
      res.end();
      return true;
    }
    sendJson(res, 200, answers);
    return true;
  }
  if (isRecord(body) && body.method === 'initialize') {
    res.setHeader('Mcp-Session-Id', SESSION_ID);
  }
  const answer = dispatch(body, store);
  if (answer === null) {
    res.writeHead(202);
    res.end();
    return true;
  }
  sendJson(res, 200, answer);
  return true;
}
