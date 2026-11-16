import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Comment, Issue, Label, Pull, Repo, Store } from './store.ts';
import { buildCommit, buildTree, flattenTree, parseCommit, parseTree } from './git/objects.ts';
import { checkAuth, jsonError, readBody, requestId, sendJson, VIEWER } from './util.ts';

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Small helpers

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((part) => part.length > 0)
    .map(decodeSegment);
}

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function nodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

function userJson(user: typeof VIEWER): JsonObject {
  return {
    login: user.login,
    id: user.id,
    type: 'User',
    name: user.name,
    email: user.email,
    html_url: `https://github.com/${user.login}`,
  };
}

function labelJson(label: Label): JsonObject {
  return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function repoJson(repo: Repo): JsonObject {
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: nodeId('Repo', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson({ ...VIEWER, login: repo.owner } as typeof VIEWER),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    homepage: null,
    language: null,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    fork: false,
    archived: false,
    disabled: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    license: null,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues + openPulls,
    size: 0,
  };
}

function issueJson(repo: Repo, issue: Issue): JsonObject {
  const comments = repo.comments.get(issue.number) ?? [];
  const labels = issue.labels.map((name) => {
    const found = repo.labels.get(name);
    if (found !== undefined) return labelJson(found);
    return { id: 0, name, color: 'ededed', description: '' };
  });
  return {
    id: issue.id,
    node_id: nodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: userJson(issue.user),
    assignee: issue.assignee === null ? null : userJson(issue.assignee),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: comments.length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullRefJson(repo: Repo, ref: { ref: string; sha: string }): JsonObject {
  return {
    label: `${repo.owner}:${ref.ref}`,
    ref: ref.ref,
    sha: ref.sha,
    repo: {
      id: repo.id,
      name: repo.name,
      full_name: repo.fullName,
      owner: { login: repo.owner, id: VIEWER.id },
    },
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): JsonObject {
  return {
    id: pull.id,
    node_id: nodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: pullRefJson(repo, pull.head),
    base: pullRefJson(repo, pull.base),
    merged: pull.merged,
    mergeable: mergeableOf(store, repo, pull),
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

/** Build an absolute same-origin URL for pagination, keeping other query params. */
function absoluteUrl(req: IncomingMessage, pathname: string, params: URLSearchParams): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}${pathname}?${params.toString()}`;
}

interface Page<T> {
  items: T[];
  link: string | null;
}

function paginate<T>(req: IncomingMessage, url: URL, items: readonly T[]): Page<T> {
  const perPage = clamp(parseIntParam(url.searchParams.get('per_page'), 30), 1, 100);
  const page = Math.max(1, parseIntParam(url.searchParams.get('page'), 1));
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const links: string[] = [];
  const makeParams = (targetPage: number): URLSearchParams => {
    const params = new URLSearchParams(url.searchParams);
    params.set('per_page', String(perPage));
    params.set('page', String(targetPage));
    return params;
  };
  if (page < lastPage) links.push(`<${absoluteUrl(req, url.pathname, makeParams(page + 1))}>; rel="next"`);
  if (lastPage > 1) links.push(`<${absoluteUrl(req, url.pathname, makeParams(lastPage))}>; rel="last"`);
  return { items: slice, link: links.length > 0 ? links.join(', ') : null };
}

// ---------------------------------------------------------------------------------------------
// Git helpers (tree/commit walking over the store)

function commitOf(store: Store, oid: string): { tree: string; parents: string[]; message: string } | null {
  const object = store.getObject(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data);
}

function treeOf(store: Store, commitOid: string): string | null {
  const commit = commitOf(store, commitOid);
  return commit === null ? null : commit.tree;
}

function flatOf(store: Store, commitOid: string): Map<string, { mode: string; oid: string }> {
  const tree = treeOf(store, commitOid);
  if (tree === null) return new Map();
  return flattenTree(store, tree);
}

/** Rebuild nested trees from a flat path map; returns the root tree oid. */
function buildTreeFromFlat(store: Store, flat: Map<string, { mode: string; oid: string }>): string {
  const buildAt = (prefix: string): string => {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const seenDirs = new Set<string>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
      } else {
        const dir = rest.slice(0, slash);
        if (seenDirs.has(dir)) continue;
        seenDirs.add(dir);
        entries.push({ mode: '40000', name: dir, oid: buildAt(`${prefix}${dir}/`) });
      }
    }
    return buildTree(store, entries);
  };
  return buildAt('');
}

function treeOidAt(store: Store, rootTreeOid: string, segments: readonly string[]): string | null {
  let current = rootTreeOid;
  for (const segment of segments) {
    const object = store.getObject(current);
    if (object === undefined) return null;
    const found = parseTree(object.data).find((entry) => entry.name === segment && entry.mode === '40000');
    if (found === undefined) return null;
    current = found.oid;
  }
  return current;
}

interface ContentEntry {
  type: 'file' | 'dir';
  name: string;
  path: string;
  sha: string;
  size?: number;
}

type ResolvedContent =
  | { kind: 'file'; oid: string; size: number }
  | { kind: 'dir'; entries: ContentEntry[] }
  | null;

function resolveContent(store: Store, commitOid: string, path: string): ResolvedContent {
  const tree = treeOf(store, commitOid);
  if (tree === null) return null;
  const flat = flattenTree(store, tree);
  if (path !== '') {
    const hit = flat.get(path);
    if (hit !== undefined) {
      const object = store.getObject(hit.oid);
      return { kind: 'file', oid: hit.oid, size: object === undefined ? 0 : object.data.length };
    }
  }
  const prefix = path === '' ? '' : `${path}/`;
  const children = new Map<string, ContentEntry>();
  for (const [entryPath, entry] of flat) {
    if (!entryPath.startsWith(prefix)) continue;
    const rest = entryPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      children.set(rest, { type: 'file', name: rest, path: entryPath, sha: entry.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!children.has(dir)) {
        const segments = path === '' ? [dir] : [...path.split('/'), dir];
        const treeOid = treeOidAt(store, tree, segments);
        children.set(dir, { type: 'dir', name: dir, path: `${prefix}${dir}`, sha: treeOid ?? '' });
      }
    }
  }
  if (children.size === 0) return null;
  const entries = [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { kind: 'dir', entries };
}

/** All commit oids reachable from `oid` through parent links. */
function ancestorsOf(store: Store, oid: string): Set<string> {
  const seen = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = commitOf(store, current);
    if (commit !== null) queue.push(...commit.parents);
  }
  return seen;
}

/** First common ancestor of two tips (breadth-first from `b` into `a`'s history). */
function mergeBaseOf(store: Store, a: string, b: string): string | null {
  const ancestorsA = ancestorsOf(store, a);
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (ancestorsA.has(current)) return current;
    const commit = commitOf(store, current);
    if (commit !== null) queue.push(...commit.parents);
  }
  return null;
}

function changedPaths(
  base: Map<string, { mode: string; oid: string }>,
  other: Map<string, { mode: string; oid: string }>,
): Set<string> {
  const out = new Set<string>();
  for (const [path, entry] of base) {
    const next = other.get(path);
    if (next === undefined || next.oid !== entry.oid) out.add(path);
  }
  for (const path of other.keys()) {
    if (!base.has(path)) out.add(path);
  }
  return out;
}

/** True when a squash of `headTip` onto `baseTip` would conflict. */
function mergeConflicts(store: Store, headTip: string, baseTip: string): boolean {
  const base = mergeBaseOf(store, headTip, baseTip);
  if (base === null) return true;
  const baseFlat = flatOf(store, base);
  const headFlat = flatOf(store, headTip);
  const baseTipFlat = flatOf(store, baseTip);
  const headChanged = changedPaths(baseFlat, headFlat);
  const baseChanged = changedPaths(baseFlat, baseTipFlat);
  for (const path of headChanged) {
    if (!baseChanged.has(path)) continue;
    const headOid = headFlat.get(path)?.oid ?? null;
    const baseOid = baseTipFlat.get(path)?.oid ?? null;
    if (headOid !== baseOid) return true;
  }
  return false;
}

function mergeableOf(store: Store, repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const headTip = store.getRef(repo, `refs/heads/${pull.head.ref}`);
  const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`);
  if (headTip === undefined || baseTip === undefined) return false;
  return !mergeConflicts(store, headTip, baseTip);
}

function countLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const remaining = new Map<string, number>();
  for (const line of countLines(oldText)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of countLines(newText)) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of remaining.values()) deletions += count;
  return { additions, deletions };
}

function blobText(store: Store, oid: string): string {
  const object = store.getObject(oid);
  return object === undefined ? '' : object.data.toString('utf8');
}

// ---------------------------------------------------------------------------------------------
// The REST handler

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://127.0.0.1');
  const pathname = url.pathname;
  if (pathname !== '/api/v3' && !pathname.startsWith('/api/v3/')) return false;

  const rid = requestId(store);
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': rid };
  const reply = (status: number, body: unknown, extra: Record<string, string> = {}): void => {
    sendJson(res, status, body, { ...headers, ...extra });
  };
  const fail = (status: number, message: string): void => {
    jsonError(res, status, message, headers);
  };

  try {
    if (!checkAuth(req)) {
      fail(401, 'Requires authentication');
      return true;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const segments = parseSegments(pathname).slice(2); // drop the leading "api" and "v3"

    // Parse a JSON body for the methods that carry one; a broken body is a 400.
    let body: JsonObject = {};
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          fail(400, 'Invalid JSON body');
          return true;
        }
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as JsonObject;
      }
    }

    const bodyString = (value: unknown): string => (typeof value === 'string' ? value : '');
    const bodyBoolean = (value: unknown): boolean => value === true;

    // GET /api/v3/ — the API root.
    if (segments.length === 0) {
      if (method !== 'GET') {
        fail(404, 'Not Found');
        return true;
      }
      reply(200, { message: 'GitHub REST API v3', current_user_url: '/api/v3/user' }, { 'X-OAuth-Scopes': 'repo, read:org' });
      return true;
    }

    // GET /api/v3/meta
    if (segments.length === 1 && segments[0] === 'meta') {
      if (method !== 'GET') {
        fail(404, 'Not Found');
        return true;
      }
      reply(200, { installed_version: '1.0.0' });
      return true;
    }

    // /api/v3/user/repos
    if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = [...store.repos.values()]
          .filter((repo) => repo.owner === VIEWER.login)
          .sort((a, b) => a.id - b.id)
          .map((repo) => repoJson(repo));
        const page = paginate(req, url, repos);
        reply(200, page.items, page.link === null ? {} : { Link: page.link });
        return true;
      }
      if (method === 'POST') {
        const name = bodyString(body.name);
        if (name === '') {
          fail(422, 'Repository name is required');
          return true;
        }
        if (store.getRepo(VIEWER.login, name) !== undefined) {
          fail(422, 'Repository already exists');
          return true;
        }
        const repo = store.createRepo(VIEWER.login, name, bodyString(body.description));
        repo.isPrivate = bodyBoolean(body.private);
        reply(201, repoJson(repo));
        return true;
      }
      fail(404, 'Not Found');
      return true;
    }

    // Everything below is /api/v3/repos/{owner}/{repo}/...
    if (segments.length >= 3 && segments[0] === 'repos') {
      const owner = segments[1] as string;
      const repoName = segments[2] as string;
      const repo = store.getRepo(owner, repoName);
      if (repo === undefined) {
        fail(404, 'Not Found');
        return true;
      }
      const rest = segments.slice(3);

      // /repos/{o}/{r} itself.
      if (rest.length === 0) {
        if (method === 'GET') {
          reply(200, repoJson(repo));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.isPrivate = body.private;
          if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
            const oldKey = repo.fullName;
            repo.name = body.name;
            repo.fullName = `${repo.owner}/${repo.name}`;
            store.repos.delete(oldKey);
            store.repos.set(repo.fullName, repo);
          }
          reply(200, repoJson(repo));
          return true;
        }
        if (method === 'DELETE') {
          store.deleteRepo(owner, repoName);
          sendJson(res, 204, null, headers);
          return true;
        }
        fail(404, 'Not Found');
        return true;
      }

      // POST /repos/{o}/{r}/git/refs — create a branch.
      if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs') {
        if (method !== 'POST') {
          fail(404, 'Not Found');
          return true;
        }
        const ref = bodyString(body.ref);
        const sha = bodyString(body.sha);
        if (!ref.startsWith('refs/') || !isHex40(sha) || store.getObject(sha) === undefined) {
          fail(422, 'Invalid ref or sha');
          return true;
        }
        if (store.getRef(repo, ref) !== undefined) {
          fail(422, 'Reference already exists');
          return true;
        }
        store.setRef(repo, ref, sha);
        const object = store.getObject(sha);
        reply(201, { ref, object: { sha, type: object?.type ?? 'commit' } });
        return true;
      }

      // GET /repos/{o}/{r}/branches
      if (rest.length === 1 && rest[0] === 'branches') {
        if (method !== 'GET') {
          fail(404, 'Not Found');
          return true;
        }
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        reply(200, branches);
        return true;
      }

      // GET /repos/{o}/{r}/commits[?sha=<ref>]
      if (rest.length === 1 && rest[0] === 'commits') {
        if (method !== 'GET') {
          fail(404, 'Not Found');
          return true;
        }
        const shaParam = url.searchParams.get('sha');
        let tip: string | undefined;
        if (shaParam === null || shaParam === '') {
          tip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
        } else if (isHex40(shaParam) && store.getObject(shaParam) !== undefined) {
          tip = shaParam;
        } else {
          tip = store.getRef(repo, shaParam);
        }
        const out: JsonObject[] = [];
        if (tip !== undefined) {
          const seen = new Set<string>();
          const stack = [tip];
          while (stack.length > 0) {
            const oid = stack.pop() as string;
            if (seen.has(oid)) continue;
            seen.add(oid);
            const commit = commitOf(store, oid);
            if (commit === null) continue;
            out.push({
              sha: oid,
              commit: {
                message: commit.message,
                author: { name: VIEWER.name, email: VIEWER.email },
                committer: { name: VIEWER.name, email: VIEWER.email },
              },
              author: userJson(VIEWER),
              committer: userJson(VIEWER),
              parents: commit.parents.map((parent) => ({ sha: parent })),
            });
            for (const parent of commit.parents) stack.push(parent);
          }
        }
        reply(200, out);
        return true;
      }

      // /repos/{o}/{r}/contents/{path...}
      if (rest.length >= 1 && rest[0] === 'contents') {
        const filePath = rest.slice(1).join('/');
        if (method === 'PUT') return putContents(req, res, store, repo, filePath, body, headers, reply, fail);
        if (method === 'GET') return getContents(store, repo, filePath, url, reply, fail);
        if (method === 'DELETE') return deleteContents(store, repo, filePath, body, reply, fail);
        fail(404, 'Not Found');
        return true;
      }

      // POST /repos/{o}/{r}/labels
      if (rest.length === 1 && rest[0] === 'labels') {
        if (method !== 'POST') {
          fail(404, 'Not Found');
          return true;
        }
        const name = bodyString(body.name);
        if (name === '') {
          fail(422, 'Label name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          fail(422, 'Label already exists');
          return true;
        }
        const label: Label = {
          id: repo.nextLabelId,
          name,
          color: bodyString(body.color) || 'ededed',
          description: bodyString(body.description),
        };
        repo.nextLabelId += 1;
        repo.labels.set(name, label);
        reply(201, labelJson(label));
        return true;
      }

      // /repos/{o}/{r}/issues...
      if (rest.length >= 1 && rest[0] === 'issues') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            const sort = url.searchParams.get('sort') ?? 'created';
            const direction = url.searchParams.get('direction') ?? 'desc';
            let issues = [...repo.issues.values()];
            if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
            issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
            void sort;
            const page = paginate(req, url, issues.map((issue) => issueJson(repo, issue)));
            reply(200, page.items, page.link === null ? {} : { Link: page.link });
            return true;
          }
          if (method === 'POST') {
            const title = bodyString(body.title);
            if (title === '') {
              fail(422, 'Issue title is required');
              return true;
            }
            const labelNames: string[] = [];
            if (Array.isArray(body.labels)) {
              for (const entry of body.labels) {
                if (typeof entry === 'string') labelNames.push(entry);
                else if (typeof entry === 'object' && entry !== null && typeof (entry as JsonObject).name === 'string') {
                  labelNames.push((entry as JsonObject).name as string);
                }
              }
            }
            for (const name of labelNames) {
              if (!repo.labels.has(name)) {
                fail(422, `Label '${name}' does not exist`);
                return true;
              }
            }
            const now = store.nowIso();
            const issue: Issue = {
              id: repo.id * 1000000 + repo.nextIssue,
              number: repo.nextIssue,
              title,
              body: bodyString(body.body),
              state: 'open',
              labels: labelNames,
              user: VIEWER,
              assignee: null,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
            };
            repo.nextIssue += 1;
            repo.issues.set(issue.number, issue);
            reply(201, issueJson(repo, issue));
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }
        const issueNumber = Number.parseInt(rest[1] as string, 10);
        if (!Number.isInteger(issueNumber)) {
          fail(404, 'Not Found');
          return true;
        }
        const issue = repo.issues.get(issueNumber);
        if (rest.length === 2) {
          if (issue === undefined) {
            fail(404, 'Not Found');
            return true;
          }
          if (method === 'GET') {
            reply(200, issueJson(repo, issue));
            return true;
          }
          if (method === 'PATCH') {
            if (typeof body.title === 'string') issue.title = body.title;
            if (typeof body.body === 'string') issue.body = body.body;
            if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
              if (body.state === 'closed' && issue.state !== 'closed') issue.closedAt = store.nowIso();
              if (body.state === 'open') issue.closedAt = null;
              issue.state = body.state;
            }
            if (Array.isArray(body.labels)) {
              const names: string[] = [];
              for (const entry of body.labels) {
                if (typeof entry === 'string') names.push(entry);
                else if (typeof entry === 'object' && entry !== null && typeof (entry as JsonObject).name === 'string') {
                  names.push((entry as JsonObject).name as string);
                }
              }
              for (const name of names) {
                if (!repo.labels.has(name)) {
                  fail(422, `Label '${name}' does not exist`);
                  return true;
                }
              }
              issue.labels = names;
            }
            issue.updatedAt = store.nowIso();
            reply(200, issueJson(repo, issue));
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }
        if (rest.length === 3 && rest[2] === 'comments') {
          if (issue === undefined) {
            fail(404, 'Not Found');
            return true;
          }
          if (method === 'POST') {
            const text = bodyString(body.body);
            if (text === '') {
              fail(422, 'Comment body is required');
              return true;
            }
            const now = store.nowIso();
            const comment: Comment = { id: repo.nextCommentId, body: text, user: VIEWER, createdAt: now, updatedAt: now };
            repo.nextCommentId += 1;
            const list = repo.comments.get(issueNumber) ?? [];
            list.push(comment);
            repo.comments.set(issueNumber, list);
            reply(201, {
              id: comment.id,
              body: comment.body,
              user: userJson(comment.user),
              created_at: comment.createdAt,
              updated_at: comment.updatedAt,
              html_url: `https://github.com/${repo.fullName}/issues/${issueNumber}#issuecomment-${comment.id}`,
            });
            return true;
          }
          if (method === 'GET') {
            const list = repo.comments.get(issueNumber) ?? [];
            reply(
              200,
              list.map((comment) => ({
                id: comment.id,
                body: comment.body,
                user: userJson(comment.user),
                created_at: comment.createdAt,
                updated_at: comment.updatedAt,
              })),
            );
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }
        fail(404, 'Not Found');
        return true;
      }

      // /repos/{o}/{r}/pulls...
      if (rest.length >= 1 && rest[0] === 'pulls') {
        if (rest.length === 1) {
          if (method === 'GET') {
            const state = url.searchParams.get('state') ?? 'open';
            let pulls = [...repo.pulls.values()];
            if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
            pulls.sort((a, b) => b.number - a.number);
            const page = paginate(req, url, pulls.map((pull) => pullJson(store, repo, pull)));
            reply(200, page.items, page.link === null ? {} : { Link: page.link });
            return true;
          }
          if (method === 'POST') {
            const title = bodyString(body.title);
            const headName = stripOwnerPrefix(bodyString(body.head));
            const baseName = stripOwnerPrefix(bodyString(body.base));
            if (title === '' || headName === '' || baseName === '') {
              fail(422, 'Pull request title, head and base are required');
              return true;
            }
            const headSha = store.getRef(repo, `refs/heads/${headName}`);
            const baseSha = store.getRef(repo, `refs/heads/${baseName}`);
            if (headSha === undefined || baseSha === undefined) {
              fail(422, 'Head or base branch does not exist');
              return true;
            }
            const now = store.nowIso();
            const pull: Pull = {
              id: repo.id * 1000000 + 500000 + repo.nextPull,
              number: repo.nextPull,
              title,
              body: bodyString(body.body),
              state: 'open',
              head: { ref: headName, sha: headSha, repo: repo.fullName },
              base: { ref: baseName, sha: baseSha, repo: repo.fullName },
              merged: false,
              mergeable: true,
              mergeCommitSha: null,
              user: VIEWER,
              createdAt: now,
              updatedAt: now,
              closedAt: null,
              mergedAt: null,
            };
            repo.nextPull += 1;
            repo.pulls.set(pull.number, pull);
            reply(201, pullJson(store, repo, pull));
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }
        const pullNumber = Number.parseInt(rest[1] as string, 10);
        if (!Number.isInteger(pullNumber)) {
          fail(404, 'Not Found');
          return true;
        }
        const pull = repo.pulls.get(pullNumber);
        if (rest.length === 2) {
          if (pull === undefined) {
            fail(404, 'Not Found');
            return true;
          }
          if (method === 'GET') {
            reply(200, pullJson(store, repo, pull));
            return true;
          }
          fail(404, 'Not Found');
          return true;
        }
        if (rest.length === 3 && rest[2] === 'files') {
          if (pull === undefined) {
            fail(404, 'Not Found');
            return true;
          }
          if (method !== 'GET') {
            fail(404, 'Not Found');
            return true;
          }
          reply(200, pullFilesOf(store, pull));
          return true;
        }
        if (rest.length === 3 && rest[2] === 'merge') {
          if (pull === undefined) {
            fail(404, 'Not Found');
            return true;
          }
          if (method !== 'PUT') {
            fail(404, 'Not Found');
            return true;
          }
          return mergePullRequest(store, repo, pull, reply, fail);
        }
        fail(404, 'Not Found');
        return true;
      }

      fail(404, 'Not Found');
      return true;
    }

    fail(404, 'Not Found');
    return true;
  } catch (err) {
    if (!res.headersSent) {
      const message = err instanceof Error ? err.message : 'Internal error';
      jsonError(res, 500, message, headers);
    }
    return true;
  }
}

function stripOwnerPrefix(ref: string): string {
  const colon = ref.indexOf(':');
  return colon === -1 ? ref : ref.slice(colon + 1);
}

/** The changed files of a pull request: base tree vs head tree. */
function pullFilesOf(store: Store, pull: Pull): JsonObject[] {
  const baseTree = treeOf(store, pull.base.sha);
  const headTree = treeOf(store, pull.head.sha);
  const baseFlat = baseTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, baseTree);
  const headFlat = headTree === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(store, headTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: JsonObject[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before !== undefined && after === undefined) {
      const deletions = countLines(blobText(store, before.oid)).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (before === undefined && after !== undefined) {
      const additions = countLines(blobText(store, after.oid)).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (before !== undefined && after !== undefined && before.oid !== after.oid) {
      const diff = lineDiff(blobText(store, before.oid), blobText(store, after.oid));
      out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
    }
  }
  return out;
}

/** Squash-merge a pull request onto its base branch. Returns true (always handled). */
function mergePullRequest(
  store: Store,
  repo: Repo,
  pull: Pull,
  reply: (status: number, body: unknown, extra?: Record<string, string>) => void,
  fail: (status: number, message: string) => void,
): boolean {
  if (pull.state !== 'open') {
    fail(405, 'Pull request is already closed');
    return true;
  }
  const baseTip = store.getRef(repo, `refs/heads/${pull.base.ref}`);
  const headTip = store.getRef(repo, `refs/heads/${pull.head.ref}`);
  if (baseTip === undefined || headTip === undefined) {
    fail(422, 'Head or base branch does not exist');
    return true;
  }
  if (mergeConflicts(store, headTip, baseTip)) {
    fail(405, 'Merge conflict');
    return true;
  }
  const headTree = treeOf(store, headTip);
  if (headTree === null) {
    fail(422, 'Head commit does not exist');
    return true;
  }
  const mergeSha = buildCommit(store, headTree, [baseTip], pull.title);
  store.setRef(repo, `refs/heads/${pull.base.ref}`, mergeSha);
  const now = store.nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = now;
  pull.closedAt = now;
  pull.updatedAt = now;
  reply(200, { sha: mergeSha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head.ref}` });
  return true;
}

function resolveBranchTip(store: Store, repo: Repo, branch: string | undefined): string | undefined {
  const name = branch === undefined || branch === '' ? repo.defaultBranch : branch;
  return store.getRef(repo, `refs/heads/${name}`);
}

function putContents(
  _req: IncomingMessage,
  _res: ServerResponse,
  store: Store,
  repo: Repo,
  filePath: string,
  body: JsonObject,
  _headers: Record<string, string>,
  reply: (status: number, body: unknown, extra?: Record<string, string>) => void,
  fail: (status: number, message: string) => void,
): boolean {
  const contentB64 = typeof body.content === 'string' ? body.content : '';
  if (contentB64 === '') {
    fail(422, 'Content is required');
    return true;
  }
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = store.getRef(repo, refName);
  if (tip === undefined && typeof body.branch === 'string' && body.branch !== '') {
    fail(422, 'Branch does not exist');
    return true;
  }
  const flat = tip === undefined ? new Map<string, { mode: string; oid: string }>() : flatOf(store, tip);
  const existing = flat.get(filePath);
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (existing !== undefined) {
    if (givenSha === undefined || givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
      fail(409, 'File sha does not match the current blob');
      return true;
    }
  }
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = store.putObject('blob', content);
  flat.set(filePath, { mode: '100644', oid: blobOid });
  const treeOid = buildTreeFromFlat(store, flat);
  const parents = tip === undefined ? [] : [tip];
  const message = typeof body.message === 'string' ? body.message : '';
  const commitOid = buildCommit(store, treeOid, parents, message);
  store.setRef(repo, refName, commitOid);
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  reply(existing === undefined ? 201 : 200, {
    content: { name, path: filePath, sha: blobOid, size: content.length, type: 'file', encoding: 'base64', content: contentB64 },
    commit: { sha: commitOid, message },
  });
  return true;
}

function getContents(
  store: Store,
  repo: Repo,
  filePath: string,
  url: URL,
  reply: (status: number, body: unknown, extra?: Record<string, string>) => void,
  fail: (status: number, message: string) => void,
): boolean {
  const refParam = url.searchParams.get('ref');
  let tip: string | undefined;
  if (refParam === null || refParam === '') {
    tip = store.getRef(repo, `refs/heads/${repo.defaultBranch}`);
  } else if (isHex40(refParam) && store.getObject(refParam) !== undefined) {
    tip = refParam;
  } else {
    tip = store.getRef(repo, refParam);
  }
  if (tip === undefined) {
    fail(404, 'Not Found');
    return true;
  }
  const resolved = resolveContent(store, tip, filePath);
  if (resolved === null) {
    fail(404, 'Not Found');
    return true;
  }
  if (resolved.kind === 'file') {
    const object = store.getObject(resolved.oid);
    const data = object === undefined ? Buffer.alloc(0) : object.data;
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    reply(200, {
      type: 'file',
      encoding: 'base64',
      content: data.toString('base64'),
      sha: resolved.oid,
      size: resolved.size,
      name,
      path: filePath,
    });
    return true;
  }
  reply(
    200,
    resolved.entries.map((entry) => {
      const out: JsonObject = { type: entry.type, name: entry.name, path: entry.path, sha: entry.sha };
      if (entry.type === 'file') {
        const object = store.getObject(entry.sha);
        out.size = object === undefined ? 0 : object.data.length;
      }
      return out;
    }),
  );
  return true;
}

function deleteContents(
  store: Store,
  repo: Repo,
  filePath: string,
  body: JsonObject,
  reply: (status: number, body: unknown, extra?: Record<string, string>) => void,
  fail: (status: number, message: string) => void,
): boolean {
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = store.getRef(repo, refName);
  if (tip === undefined) {
    fail(404, 'Not Found');
    return true;
  }
  const flat = flatOf(store, tip);
  const existing = flat.get(filePath);
  if (existing === undefined) {
    fail(404, 'Not Found');
    return true;
  }
  const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
  if (givenSha !== undefined && givenSha.toLowerCase() !== existing.oid.toLowerCase()) {
    fail(409, 'File sha does not match the current blob');
    return true;
  }
  flat.delete(filePath);
  const treeOid = buildTreeFromFlat(store, flat);
  const message = typeof body.message === 'string' ? body.message : '';
  const commitOid = buildCommit(store, treeOid, [tip], message);
  store.setRef(repo, refName, commitOid);
  reply(200, { content: null, commit: { sha: commitOid, message } });
  return true;
}
