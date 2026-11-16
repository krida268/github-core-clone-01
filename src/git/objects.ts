import type { Store } from '../store.ts';
import { VIEWER } from '../store.ts';

export interface TreeEntryInput {
  mode: string;
  name: string;
  oid: string;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Urutan git untuk entri tree: nama sebagai byte, direktori dibanding seolah berakhiran '/'. */
function compareTreeEntries(a: TreeEntryInput, b: TreeEntryInput): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

function isHexOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/**
 * Bangun objek tree dari entri (diurutkan ala git), simpan ke store, kembalikan oid-nya.
 * Mode yang dipakai: "100644" untuk blob, "40000" untuk subtree.
 */
export function buildTree(store: Store, entries: Array<{ mode: string; name: string; oid: string }>): string {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isHexOid(entry.oid)) throw new Error(`buildTree: oid tidak valid untuk ${entry.name}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return store.putObject('tree', Buffer.concat(parts));
}

/**
 * Bangun objek commit, simpan ke store, kembalikan oid-nya.
 * Author dan committer = viewer skenario; timestamp deterministik dari store.nowIso().
 */
export function buildCommit(store: Store, treeOid: string, parents: string[], message: string): string {
  if (!isHexOid(treeOid)) throw new Error('buildCommit: treeOid tidak valid');
  for (const parent of parents) {
    if (!isHexOid(parent)) throw new Error('buildCommit: parent oid tidak valid');
  }
  const unix = Math.floor(Date.parse(store.nowIso()) / 1000);
  const who = `${VIEWER.name} <${VIEWER.email}> ${unix} +0000`;
  const lines: string[] = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${who}`, '');
  const raw = Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
  return store.putObject('commit', raw);
}

/** Urai byte mentah sebuah tree menjadi entri-entri (dalam urutan tersimpan). */
export function parseTree(data: Buffer): Array<{ mode: string; name: string; oid: string }> {
  const entries: Array<{ mode: string; name: string; oid: string }> = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('parseTree: entri tanpa pemisah mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('parseTree: entri tanpa terminator nama');
    if (nul + 21 > data.length) throw new Error('parseTree: oid entri terpotong');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Urai byte mentah sebuah commit menjadi tree, parents, dan message. */
export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
  }
  if (!isHexOid(tree)) throw new Error('parseCommit: tidak ada header tree yang valid');
  return { tree, parents, message };
}

/**
 * Ratakan sebuah tree secara rekursif: path lengkap -> { mode, oid }.
 * Entri direktori (mode "40000") ditelusuri; blob dan entri lain dicatat apa adanya.
 */
export function flattenTree(store: Store, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const obj = store.getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') throw new Error('flattenTree: tree tidak ditemukan di store');
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      for (const [childPath, child] of flattenTree(store, entry.oid, path)) {
        out.set(childPath, child);
      }
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}
