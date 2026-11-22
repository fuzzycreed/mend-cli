// mend: applies an edit a model wrote (unified diff, SEARCH/REPLACE blocks, V4A patch, JSON tool calls) to a tree
// of text files, all files or none. SPEC.md is the specification; section numbers below refer to it.
// Node 22, standard library only. No clock, no randomness, no network in the CLI itself.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Outcomes

/** Exit 2 with `error: parse <N>`. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit failed: `error: <code> <path>`. */
class EditFault extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

interface Outcome {
  code: number;
  out: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Section 3: files, lines, paths

interface Doc {
  lines: string[];
  eol: string;
  final: boolean;
}

function parseDoc(text: string): Doc {
  const lf = text.indexOf('\n');
  const eol = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], eol, final: false };
  const lines = text.split(eol);
  let final = false;
  if (lines[lines.length - 1] === '') {
    lines.pop();
    final = true;
  }
  return { lines, eol, final };
}

function renderDoc(doc: Doc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.eol) + (doc.final ? doc.eol : '');
}

function isSafe(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function splitPatch(text: string): string[] {
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

const isBlank = (line: string): boolean => line.trim() === '';

// ---------------------------------------------------------------------------------------------------------------
// The tree: the directory as the edits so far left it, held in memory until everything succeeded (section 10)

class Tree {
  /** Paths touched so far: their text, or null when deleted. */
  private now = new Map<string, string | null>();
  /** What was on disk for every path asked about. */
  private disk = new Map<string, string | null>();
  /** Move edits that succeeded, in order. */
  moves: Array<[string, string]> = [];

  private original(path: string): string | null {
    let v = this.disk.get(path);
    if (v === undefined) {
      v = null;
      try {
        if (statSync(path).isFile()) v = readFileSync(path, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(path, v);
    }
    return v;
  }

  read(path: string): string | null {
    const v = this.now.get(path);
    return v === undefined ? this.original(path) : v;
  }

  has(path: string): boolean {
    return this.read(path) !== null;
  }

  /**
   * What stands in the way of a new file at `path`, or null: a file at one of its parent paths (the nearest to the
   * root first), a file at the path itself, or a directory there (on disk, or made by a file this patch created
   * below it). The path returned is the one that exists, for the `exists` line.
   */
  blocker(path: string): string | null {
    const segs = path.split('/');
    for (let n = 1; n < segs.length; n += 1) {
      const parent = segs.slice(0, n).join('/');
      if (this.read(parent) !== null) return parent;
    }
    if (this.read(path) !== null) return path;
    try {
      if (statSync(path).isDirectory()) return path;
    } catch {
      // nothing there
    }
    for (const [other, text] of this.now) {
      if (text !== null && other.startsWith(`${path}/`)) return path;
    }
    return null;
  }

  put(path: string, text: string): void {
    this.original(path);
    this.now.set(path, text);
  }

  remove(path: string): void {
    this.original(path);
    this.now.set(path, null);
  }

  /** The output rows of section 2, and the writes they stand for. */
  summary(): { rows: string[]; writes: Array<[string, string]>; deletes: string[] } {
    const kinds = new Map<string, string>();
    const writes: Array<[string, string]> = [];
    const deletes: string[] = [];
    for (const [path, after] of this.now) {
      const before = this.disk.get(path) ?? null;
      if (before === null && after !== null) {
        kinds.set(path, 'A');
        writes.push([path, after]);
      } else if (before !== null && after === null) {
        kinds.set(path, 'D');
        deletes.push(path);
      } else if (before !== null && after !== null && before !== after) {
        kinds.set(path, 'M');
        writes.push([path, after]);
      }
    }
    const rows: Array<{ key: string; text: string }> = [];
    const seen = new Set<string>();
    const paired = new Set<string>();
    for (const [from, to] of this.moves) {
      const id = `${from}\n${to}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (kinds.get(from) === 'D' && kinds.get(to) === 'A') {
        rows.push({ key: to, text: `R ${from} -> ${to}` });
        paired.add(from);
        paired.add(to);
      }
    }
    for (const [path, kind] of kinds) {
      if (!paired.has(path)) rows.push({ key: path, text: `${kind} ${path}` });
    }
    rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
    return { rows: rows.map((r) => r.text), writes, deletes };
  }
}

function needSafe(path: string): void {
  if (!isSafe(path)) throw new EditFault('unsafe', path);
}

/** A file is about to be created at, or moved to, `path`: nothing may be in its way. */
function needFree(tree: Tree, path: string): void {
  const inTheWay = tree.blocker(path);
  if (inTheWay !== null) throw new EditFault('exists', inTheWay);
}

// ---------------------------------------------------------------------------------------------------------------
// Section 5: matching lines

const trimTail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const TIERS: Array<(s: string) => string> = [(s) => s, trimTail, trimBoth];
const leadOf = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Every position where `old` occurs in `lines` at a tier. */
function occurrences(lines: string[], old: string[], tier: number): number[] {
  const norm = TIERS[tier];
  const want = old.map(norm);
  const have = tier === 0 ? lines : lines.map(norm);
  const found: number[] = [];
  for (let i = 0; i + want.length <= have.length; i += 1) {
    let same = true;
    for (let j = 0; j < want.length; j += 1) {
      if (have[i + j] !== want[j]) {
        same = false;
        break;
      }
    }
    if (same) found.push(i);
  }
  return found;
}

/** The first tier with an occurrence that `allowed` accepts, and those occurrences. */
function locate(lines: string[], old: string[], strict: boolean, allowed?: (i: number) => boolean): { tier: number; at: number[] } | null {
  const last = strict ? 0 : 2;
  for (let tier = 0; tier <= last; tier += 1) {
    let at = occurrences(lines, old, tier);
    if (allowed !== undefined) at = at.filter(allowed);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A body line of a hunk or chunk: ' ' context, '-' old, '+' new. */
interface Row {
  kind: string;
  text: string;
  /** A `\` line follows it (unified only). */
  bare: boolean;
}

const oldOf = (rows: Row[]): string[] => rows.filter((r) => r.kind !== '+').map((r) => r.text);
const newCount = (rows: Row[]): number => rows.filter((r) => r.kind !== '-').length;

function reindent(line: string, patchLead: string, fileLead: string): string {
  if (line.trim() === '' || !line.startsWith(patchLead)) return line;
  return fileLead + line.slice(patchLead.length);
}

/** The lines that replace the match at `at`: context as the file has it, new lines re-indented at tier 2. */
function replacement(lines: string[], rows: Row[], at: number, tier: number): string[] {
  const old = oldOf(rows);
  const fileLead = old.length > 0 ? leadOf(lines[at]) : '';
  const patchLead = old.length > 0 ? leadOf(old[0]) : '';
  const out: string[] = [];
  let k = at;
  for (const row of rows) {
    if (row.kind === ' ') {
      out.push(lines[k]);
      k += 1;
    } else if (row.kind === '-') {
      k += 1;
    } else {
      out.push(tier === 2 ? reindent(row.text, patchLead, fileLead) : row.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// An edit is a function over the tree; it throws EditFault and must not touch the tree before it is sure.

interface Options {
  strict: boolean;
}

type Edit = (tree: Tree, opt: Options) => void;

// ---------------------------------------------------------------------------------------------------------------
// Section 6: unified diffs

interface Hunk {
  start: number;
  rows: Row[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pair: { oldPath: string | null; newPath: string | null } | null;
  renameFrom: string | null;
  renameTo: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function headerPath(line: string): string | null {
  let text = line.slice(4);
  const tab = text.indexOf('\t');
  if (tab >= 0) text = text.slice(0, tab);
  text = text.replace(/^ +/, '').replace(/ +$/, '');
  if (text === '/dev/null') return null;
  if (text.startsWith('a/') || text.startsWith('b/')) text = text.slice(2);
  return text;
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  let first: [string, string] | null = null;
  for (let i = rest.indexOf(' b/'); i >= 0; i = rest.indexOf(' b/', i + 1)) {
    const x = rest.slice(2, i);
    const y = rest.slice(i + 3);
    if (x === '' || y === '') continue;
    if (x === y) return [x, y];
    if (first === null) first = [x, y];
  }
  return first;
}

function newSection(): Section {
  return { gitOld: null, gitNew: null, pair: null, renameFrom: null, renameTo: null, creation: false, deletion: false, hunks: [] };
}

function readUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  const pairAt = (i: number): boolean => lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const paths = gitPaths(line);
      if (paths === null) throw new ParseFault(i + 1);
      cur = newSection();
      cur.gitOld = paths[0];
      cur.gitNew = paths[1];
      sections.push(cur);
      i += 1;
      continue;
    }
    const inHeader: boolean = cur !== null && cur.hunks.length === 0;
    if (line.startsWith('--- ')) {
      if (pairAt(i)) {
        // A header takes one pair; a second pair, or a pair after hunks, starts a new section.
        if (cur === null || !inHeader || cur.pair !== null) {
          cur = newSection();
          sections.push(cur);
        }
        cur.pair = { oldPath: headerPath(line), newPath: headerPath(lines[i + 1]) };
        i += 2;
        continue;
      }
      if (inHeader) throw new ParseFault(i + 2);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null || cur === null) throw new ParseFault(i + 1);
      const rows: Row[] = [];
      let j = i + 1;
      let pendingEmpty = 0;
      let end = j;
      while (j < lines.length) {
        const b = lines[j];
        if (b === '') {
          pendingEmpty += 1;
          j += 1;
          continue;
        }
        const c = b[0];
        if (c !== ' ' && c !== '-' && c !== '+' && c !== '\\') break;
        if (pairAt(j)) break;
        for (; pendingEmpty > 0; pendingEmpty -= 1) rows.push({ kind: ' ', text: '', bare: false });
        if (c === '\\') {
          if (rows.length > 0) rows[rows.length - 1].bare = true;
        } else {
          rows.push({ kind: c, text: b.slice(1), bare: false });
        }
        j += 1;
        end = j;
      }
      cur.hunks.push({ start: Number(m[1]), rows });
      // Empty lines at the end of the body are outside it: they are plain ignored lines.
      i = Math.max(end, i + 1);
      continue;
    }
    if (inHeader && cur !== null) {
      // The SPEC names no trimming and no prefix removal for these two: the path is the rest of the line.
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.creation = true;
      else if (line.startsWith('deleted file mode')) cur.deletion = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map(unifiedEdit);
}

function unifiedEdit(sec: Section): Edit {
  let oldPath: string | null;
  let newPath: string | null;
  if (sec.pair !== null) {
    oldPath = sec.pair.oldPath;
    newPath = sec.pair.newPath;
  } else {
    oldPath = sec.renameFrom ?? sec.gitOld;
    newPath = sec.renameTo ?? sec.gitNew;
  }
  const creation = sec.creation || oldPath === null;
  const deletion = !creation && (sec.deletion || newPath === null);

  return (tree, opt) => {
    if (creation) {
      const path = newPath ?? oldPath ?? sec.gitNew ?? '/dev/null';
      needSafe(path);
      needFree(tree, path);
      const added: Row[] = [];
      for (const h of sec.hunks) for (const r of h.rows) if (r.kind === '+') added.push(r);
      let text = added.map((r) => r.text).join('\n');
      if (added.length > 0 && !added[added.length - 1].bare) text += '\n';
      tree.put(path, text);
      return;
    }
    const from = oldPath as string;
    if (deletion) {
      needSafe(from);
      if (!tree.has(from)) throw new EditFault('missing', from);
      tree.remove(from);
      return;
    }
    const to = newPath as string;
    const moving = from !== to;
    needSafe(from);
    if (moving) needSafe(to);
    const text = tree.read(from);
    if (text === null) throw new EditFault('missing', from);
    if (moving) needFree(tree, to);
    const doc = parseDoc(text);
    let drift = 0;
    for (const h of sec.hunks) {
      const old = oldOf(h.rows);
      const kept = h.rows.filter((r) => r.kind !== '-');
      const noBreak = kept.length > 0 && kept[kept.length - 1].bare;
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        at = Math.min(Math.max(h.start + drift, 0), doc.lines.length);
      } else {
        const hit = locate(doc.lines, old, opt.strict);
        if (hit === null) throw new EditFault('no-match', from);
        const target = h.start - 1 + drift;
        at = hit.at[0];
        for (const p of hit.at) {
          if (Math.abs(p - target) < Math.abs(at - target)) at = p;
        }
        tier = hit.tier;
      }
      const toEnd = at + old.length === doc.lines.length;
      const fresh = replacement(doc.lines, h.rows, at, tier);
      doc.lines.splice(at, old.length, ...fresh);
      if (toEnd) doc.final = !noBreak;
      drift += fresh.length - old.length;
    }
    const result = renderDoc(doc);
    if (moving) {
      tree.remove(from);
      tree.put(to, result);
      tree.moves.push([from, to]);
    } else {
      tree.put(from, result);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks

function readSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  const marks = lines.map((l) => l.trimEnd());
  let floor = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (marks[i] !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let p = i - 1; p >= floor; p -= 1) {
      const t = lines[p].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = lastPath;
    if (path === null) throw new ParseFault(i + 1);
    let mid = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (marks[j] === '=======') {
        mid = j;
        break;
      }
    }
    let close = -1;
    if (mid >= 0) {
      for (let j = mid + 1; j < lines.length; j += 1) {
        if (marks[j] === '>>>>>>> REPLACE') {
          close = j;
          break;
        }
      }
    }
    if (close < 0) throw new ParseFault(i + 1);
    edits.push(blockEdit(path, lines.slice(i + 1, mid), lines.slice(mid + 1, close)));
    lastPath = path;
    floor = close + 1;
    i = close + 1;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function blockEdit(path: string, old: string[], fresh: string[]): Edit {
  return (tree, opt) => {
    needSafe(path);
    if (old.length === 0) {
      needFree(tree, path);
      tree.put(path, fresh.map((l) => `${l}\n`).join(''));
      return;
    }
    const text = tree.read(path);
    if (text === null) throw new EditFault('missing', path);
    const doc = parseDoc(text);
    const hit = locate(doc.lines, old, opt.strict);
    if (hit === null) throw new EditFault('no-match', path);
    if (hit.at.length > 1) throw new EditFault('ambiguous', path);
    const rows: Row[] = [];
    for (const l of old) rows.push({ kind: '-', text: l, bare: false });
    for (const l of fresh) rows.push({ kind: '+', text: l, bare: false });
    doc.lines.splice(hit.at[0], old.length, ...replacement(doc.lines, rows, hit.at[0], hit.tier));
    tree.put(path, renderDoc(doc));
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 8: V4A patches

interface Chunk {
  anchor: string | null;
  rows: Row[];
  atEnd: boolean;
}

const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const trimSpaces = (s: string): string => s.replace(/^ +/, '').replace(/ +$/, '');
const startsSection = (l: string): boolean => l.startsWith(ADD) || l.startsWith(DELETE) || l.startsWith(UPDATE);

function readV4a(lines: string[]): Edit[] {
  let begin = 0;
  while (begin < lines.length && isBlank(lines[begin])) begin += 1;
  if (begin === lines.length) throw new ParseFault(1);
  if (lines[begin].trim() !== '*** Begin Patch') throw new ParseFault(begin + 1);
  let stop = lines.length - 1;
  while (isBlank(lines[stop])) stop -= 1;
  if (stop === begin || lines[stop].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const edits: Edit[] = [];
  let i = begin + 1;
  while (i < stop) {
    const head = lines[i];
    if (!startsSection(head)) {
      if (isBlank(head)) {
        i += 1;
        continue;
      }
      throw new ParseFault(i + 1);
    }
    let next = i + 1;
    while (next < stop && !startsSection(lines[next])) next += 1;
    let last = next;
    while (last > i + 1 && isBlank(lines[last - 1])) last -= 1;
    // The section's own lines are lines[i + 1 .. last - 1].
    if (head.startsWith(ADD)) {
      const content: string[] = [];
      for (let k = i + 1; k < last; k += 1) {
        const l = lines[k];
        if (l === '') content.push('');
        else if (l.startsWith('+')) content.push(l.slice(1));
        else throw new ParseFault(k + 1);
      }
      edits.push(addEdit(trimSpaces(head.slice(ADD.length)), content));
    } else if (head.startsWith(DELETE)) {
      for (let k = i + 1; k < last; k += 1) {
        if (!isBlank(lines[k])) throw new ParseFault(k + 1);
      }
      edits.push(deleteEdit(trimSpaces(head.slice(DELETE.length))));
    } else {
      let k = i + 1;
      let moveTo: string | null = null;
      if (k < last && lines[k].startsWith(MOVE)) {
        moveTo = trimSpaces(lines[k].slice(MOVE.length));
        k += 1;
      }
      const chunks: Chunk[] = [];
      let open: Chunk | null = null;
      for (; k < last; k += 1) {
        const l = lines[k];
        if (l.startsWith('@@')) {
          const anchor = trimSpaces(l.slice(2));
          open = { anchor: anchor === '' ? null : anchor, rows: [], atEnd: false };
          chunks.push(open);
        } else if (l === '*** End of File') {
          if (open === null) throw new ParseFault(k + 1);
          open.atEnd = true;
          open = null;
        } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (open === null) {
            if (chunks.length > 0) throw new ParseFault(k + 1);
            open = { anchor: null, rows: [], atEnd: false };
            chunks.push(open);
          }
          open.rows.push(l === '' ? { kind: ' ', text: '', bare: false } : { kind: l[0], text: l.slice(1), bare: false });
        } else {
          throw new ParseFault(k + 1);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFault(i + 1);
      edits.push(updateEdit(trimSpaces(head.slice(UPDATE.length)), moveTo, chunks));
    }
    i = next;
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function addEdit(path: string, content: string[]): Edit {
  return (tree) => {
    needSafe(path);
    needFree(tree, path);
    tree.put(path, content.map((l) => `${l}\n`).join(''));
  };
}

function deleteEdit(path: string): Edit {
  return (tree) => {
    needSafe(path);
    if (!tree.has(path)) throw new EditFault('missing', path);
    tree.remove(path);
  };
}

function updateEdit(path: string, moveTo: string | null, chunks: Chunk[]): Edit {
  return (tree, opt) => {
    needSafe(path);
    if (moveTo !== null) needSafe(moveTo);
    const text = tree.read(path);
    if (text === null) throw new EditFault('missing', path);
    if (moveTo !== null) needFree(tree, moveTo);
    const doc = parseDoc(text);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const from = cursor;
        const hit = locate(doc.lines, [chunk.anchor], opt.strict, (p) => p >= from);
        if (hit === null) throw new EditFault('no-match', path);
        cursor = hit.at[0] + 1;
      }
      const old = oldOf(chunk.rows);
      let at: number;
      let tier = 0;
      if (old.length === 0) {
        at = chunk.atEnd ? doc.lines.length : cursor;
      } else {
        const from = cursor;
        const size = doc.lines.length;
        const hit = locate(doc.lines, old, opt.strict, (p) => p >= from && (!chunk.atEnd || p + old.length === size));
        if (hit === null) throw new EditFault('no-match', path);
        at = hit.at[0];
        tier = hit.tier;
      }
      const fresh = replacement(doc.lines, chunk.rows, at, tier);
      doc.lines.splice(at, old.length, ...fresh);
      cursor = at + fresh.length;
    }
    const result = renderDoc(doc);
    if (moveTo !== null) {
      tree.remove(path);
      tree.put(moveTo, result);
      tree.moves.push([path, moveTo]);
    } else {
      tree.put(path, result);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 9: JSON edits

function jsonEdit(value: unknown): Edit | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const path = o.path;
  if (typeof path !== 'string') return null;
  if (o.command === 'create') {
    const body = o.file_text;
    if (typeof body !== 'string') return null;
    return (tree) => {
      needSafe(path);
      needFree(tree, path);
      tree.put(path, body);
    };
  }
  if (o.command === 'str_replace') {
    const oldStr = o.old_str;
    const newStr = o.new_str === undefined ? '' : o.new_str;
    if (typeof oldStr !== 'string' || oldStr === '' || typeof newStr !== 'string') return null;
    return (tree) => {
      needSafe(path);
      let text = tree.read(path);
      if (text === null) throw new EditFault('missing', path);
      const crlf = parseDoc(text).eol === '\r\n';
      let needle = oldStr;
      let fresh = newStr;
      if (crlf) {
        text = text.replaceAll('\r\n', '\n');
        needle = needle.replaceAll('\r\n', '\n');
        fresh = fresh.replaceAll('\r\n', '\n');
      }
      const at = text.indexOf(needle);
      if (at < 0) throw new EditFault('no-match', path);
      if (text.indexOf(needle, at + 1) >= 0) throw new EditFault('ambiguous', path);
      let result = text.slice(0, at) + fresh + text.slice(at + needle.length);
      if (crlf) result = result.replaceAll('\n', '\r\n');
      tree.put(path, result);
    };
  }
  if (o.command === 'insert') {
    const after = o.insert_line;
    const newStr = o.new_str;
    if (typeof after !== 'number' || !Number.isInteger(after) || typeof newStr !== 'string') return null;
    return (tree) => {
      needSafe(path);
      const text = tree.read(path);
      if (text === null) throw new EditFault('missing', path);
      const doc = parseDoc(text);
      if (after < 0 || after > doc.lines.length) throw new EditFault('no-match', path);
      doc.lines.splice(after, 0, ...splitPatch(newStr));
      tree.put(path, renderDoc(doc));
    };
  }
  return null;
}

function readJson(text: string, lines: string[]): Edit[] {
  let first = 0;
  while (first < lines.length && isBlank(lines[first])) first += 1;
  if (first === lines.length) throw new ParseFault(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(value)) throw new ParseFault(first + 1);
    for (const item of value) {
      const e = jsonEdit(item);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
  } else {
    for (let i = first; i < lines.length; i += 1) {
      if (isBlank(lines[i])) continue;
      let e: Edit | null = null;
      try {
        e = jsonEdit(JSON.parse(lines[i]));
      } catch {
        e = null;
      }
      if (e === null) throw new ParseFault(i + 1);
      edits.push(e);
    }
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 4: detecting the format

function detect(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) {
    const t = first.trim();
    if (t === '*** Begin Patch') return 'v4a';
    if (t[0] === '[' || t[0] === '{') return 'json';
  }
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the output, all or nothing

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function run(argv: string[]): Outcome {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let usage = false;
  let optionsOver = false;
  const positional: string[] = [];
  for (const arg of argv) {
    if (optionsOver || arg === '-' || !arg.startsWith('-')) {
      positional.push(arg);
    } else if (arg === '--') {
      optionsOver = true;
    } else if (arg === '--check') {
      if (check) usage = true;
      check = true;
    } else if (arg === '--strict') {
      if (strict) usage = true;
      strict = true;
    } else if (arg.startsWith('--format=')) {
      const name = arg.slice('--format='.length);
      if (format !== null || !FORMATS.includes(name)) usage = true;
      format = name;
    } else {
      usage = true;
    }
  }
  if (usage || positional.length > 1) return { code: 2, out: ['error: usage'] };

  let text: string;
  try {
    text = positional.length === 0 || positional[0] === '-' ? readFileSync(0, 'utf8') : readFileSync(positional[0], 'utf8');
  } catch {
    return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);

  let kind: string | null = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'unified') edits = readUnified(lines);
    else if (kind === 'search-replace') edits = readSearchReplace(lines);
    else if (kind === 'v4a') edits = readV4a(lines);
    else edits = readJson(text, lines);
  } catch (err) {
    if (err instanceof ParseFault) return { code: 2, out: [`error: parse ${err.line}`] };
    throw err;
  }

  const tree = new Tree();
  const failures: string[] = [];
  for (const edit of edits) {
    try {
      edit(tree, { strict });
    } catch (err) {
      if (!(err instanceof EditFault)) throw err;
      failures.push(`error: ${err.code} ${err.path}`);
    }
  }
  if (failures.length > 0) {
    failures.push(`failed: ${failures.length} of ${edits.length} edits`);
    return { code: 1, out: failures };
  }

  const { rows, writes, deletes } = tree.summary();
  if (!check) {
    for (const path of deletes) rmSync(path, { force: true });
    for (const [path, body] of writes) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, body);
    }
  }
  rows.push(rows.length === 1 ? 'ok: 1 file' : `ok: ${rows.length} files`);
  return { code: 0, out: rows };
}

// ---------------------------------------------------------------------------------------------------------------

const trialUrl = process.env.MAKEFUN_ENV_URL;
if (trialUrl !== undefined && trialUrl !== '') {
  // A trial: the kit's runner fetches the checks and runs this file on each of them, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialUrl);
} else {
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}
