// main.ts is mend, the CLI SPEC.md specifies (MIT): it applies an edit a model wrote, in one of four formats (unified
// diff, SEARCH/REPLACE blocks, V4A, JSON tool calls), to the tree of files in the working directory, finding the lines
// an edit names at the first of three matching tiers, and writing every change or none.
// Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** The move edits that succeeded, as [old, new]. */
  moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------------
// Files as lines (SPEC.md section 3) and matching at three tiers (section 5).

interface Lines {
  lines: string[];
  br: string;
  final: boolean;
}

function toLines(text: string): Lines {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text !== '' && text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function fromLines(f: Lines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const trimEndST = (s: string): string => {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e -= 1;
  return s.slice(0, e);
};
const lead = (s: string): string => {
  let b = 0;
  while (b < s.length && (s[b] === ' ' || s[b] === '\t')) b += 1;
  return s.slice(0, b);
};
const trimST = (s: string): string => {
  const t = trimEndST(s);
  return t.slice(lead(t).length);
};
const trimSpaces = (s: string): string => {
  let b = 0;
  let e = s.length;
  while (b < e && s[b] === ' ') b += 1;
  while (e > b && s[e - 1] === ' ') e -= 1;
  return s.slice(b, e);
};
const NORM: Array<(s: string) => string> = [(s) => s, trimEndST, trimST];

/** The positions at or after `from` where O occurs in `file` at `tier`. */
function occurrences(file: string[], O: string[], tier: number, from: number): number[] {
  const norm = NORM[tier]!;
  const o = O.map(norm);
  const out: number[] = [];
  const first = o[0]!;
  for (let i = Math.max(0, from); i + o.length <= file.length; i += 1) {
    if (norm(file[i]!) !== first) continue;
    let k = 1;
    while (k < o.length && norm(file[i + k]!) === o[k]) k += 1;
    if (k === o.length) out.push(i);
  }
  return out;
}

/** The first tier at which `keep` leaves an occurrence of O at or after `from`, and those occurrences. */
function locate(file: string[], O: string[], strict: boolean, from = 0, keep?: (i: number) => boolean): { tier: number; at: number[] } | null {
  const tiers = strict ? 1 : 3;
  for (let tier = 0; tier < tiers; tier += 1) {
    let at = occurrences(file, O, tier, from);
    if (keep !== undefined) at = at.filter(keep);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** A line of N: a context line (the index in O of the line it shares) or a new line. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines N becomes where O matched at `pos` at `tier`. */
function written(file: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const F = lead(file[pos]!);
  const P = lead(O[0]!);
  return N.map((n) => {
    if (n.ctx !== null) return file[pos + n.ctx]!;
    if (tier === 2 && n.text.trim() !== '' && n.text.startsWith(P)) return F + n.text.slice(P.length);
    return n.text;
  });
}

/** O and N of a body of ` `, `-`, `+` and empty lines. */
function oldNew(body: string[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const l of body) {
    const text = l.slice(1);
    if (l === '' || l[0] === ' ') {
      N.push({ text, ctx: O.length });
      O.push(text);
    } else if (l[0] === '-') O.push(text);
    else N.push({ text, ctx: null });
  }
  return { O, N };
}

function need(p: string): void {
  if (!safe(p)) throw new Fail('unsafe', p);
}

// ---------------------------------------------------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6).

interface Hunk {
  a: number;
  O: string[];
  N: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** The `+` lines, and whether a `\` line follows the last of them. */
  plus: string[];
  plusNoEol: boolean;
}

interface Section {
  pair: [string | null, string | null] | null;
  renameFrom: string | null;
  renameTo: string | null;
  git: [string, string] | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function headerPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = trimSpaces(t);
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const cuts: number[] = [];
  for (let k = rest.indexOf(' b/'); k >= 0; k = rest.indexOf(' b/', k + 1)) cuts.push(k);
  const pairs = cuts.map((k): [string, string] => [rest.slice(2, k), rest.slice(k + 3)]).filter(([x, y]) => x !== '' && y !== '');
  if (pairs.length === 0) return null;
  return pairs.find(([x, y]) => x === y) ?? pairs[0]!;
}

function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let header = false;
  const open = (): Section => {
    cur = { pair: null, renameFrom: null, renameTo: null, git: null, creation: false, deletion: false, hunks: [] };
    sections.push(cur);
    header = true;
    return cur;
  };
  const pairAt = (k: number): boolean => lines[k]!.startsWith('--- ') && (lines[k + 1] ?? '').startsWith('+++ ');
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const g = gitPaths(l);
      if (g === null) throw new Exit2(`error: parse ${i + 1}`);
      open().git = g;
      i += 1;
    } else if (l.startsWith('--- ')) {
      const paired = pairAt(i);
      if (cur !== null && header && !paired) throw new Exit2(`error: parse ${i + 2}`);
      if (cur !== null && header && (cur as Section).pair === null) {
        // The pair of a header that has none yet; a second pair starts the next section.
        (cur as Section).pair = [headerPath(l), headerPath(lines[i + 1]!)];
        i += 2;
      } else if (paired) {
        open().pair = [headerPath(l), headerPath(lines[i + 1]!)];
        i += 2;
      } else i += 1;
    } else if (l.startsWith('@@')) {
      const m = HUNK.exec(l);
      if (m === null || cur === null) throw new Exit2(`error: parse ${i + 1}`);
      header = false;
      let j = i + 1;
      const body: string[] = [];
      while (j < lines.length) {
        const b = lines[j]!;
        if (b !== '' && b[0] !== ' ' && b[0] !== '-' && b[0] !== '+' && b[0] !== '\\') break;
        if (pairAt(j)) break;
        body.push(b);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const kept: string[] = [];
      const marked: boolean[] = [];
      for (const b of body) {
        if (b[0] === '\\') {
          if (kept.length > 0) marked[kept.length - 1] = true;
        } else {
          kept.push(b);
          marked.push(false);
        }
      }
      let lastN = -1;
      let lastPlus = -1;
      kept.forEach((b, k) => {
        if (b[0] !== '-') lastN = k;
        if (b[0] === '+') lastPlus = k;
      });
      (cur as Section).hunks.push({
        a: Number(m[1]),
        ...oldNew(kept),
        noEol: lastN >= 0 && marked[lastN]!,
        plus: kept.filter((b) => b[0] === '+').map((b) => b.slice(1)),
        plusNoEol: lastPlus >= 0 && marked[lastPlus]!,
      });
      i = j;
    } else {
      if (cur !== null && header) {
        const s: Section = cur;
        if (l.startsWith('rename from ')) s.renameFrom = trimSpaces(l.slice(12));
        else if (l.startsWith('rename to ')) s.renameTo = trimSpaces(l.slice(10));
        else if (l.startsWith('new file mode')) s.creation = true;
        else if (l.startsWith('deleted file mode')) s.deletion = true;
      }
      i += 1;
    }
  }
  return sections;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.pair !== null ? s.pair[0] : (s.renameFrom ?? (s.git !== null ? s.git[0] : null));
  const newPath = s.pair !== null ? s.pair[1] : (s.renameTo ?? (s.git !== null ? s.git[1] : null));
  if (oldPath === null || s.creation) {
    const p = newPath ?? oldPath ?? '/dev/null';
    return (tree) => {
      need(p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let noEol = false;
      for (const h of s.hunks) {
        if (h.plus.length === 0) continue;
        lines.push(...h.plus);
        noEol = h.plusNoEol;
      }
      tree.now.set(p, fromLines({ lines, br: '\n', final: !noEol }));
    };
  }
  if (newPath === null || s.deletion) {
    return (tree) => {
      need(oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
    };
  }
  const move = oldPath !== newPath;
  return (tree) => {
    need(oldPath);
    if (move) need(newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (move && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    const f = toLines(before);
    let d = 0;
    for (const h of s.hunks) {
      if (h.O.length === 0) {
        const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
        const end = at === f.lines.length;
        f.lines.splice(at, 0, ...h.N.map((n) => n.text));
        if (end) f.final = !h.noEol;
      } else {
        const found = locate(f.lines, h.O, strict);
        if (found === null) throw new Fail('no-match', oldPath);
        const want = h.a - 1 + d;
        let pos = found.at[0]!;
        for (const c of found.at) if (Math.abs(c - want) < Math.abs(pos - want)) pos = c;
        const end = pos + h.O.length === f.lines.length;
        f.lines.splice(pos, h.O.length, ...written(f.lines, pos, h.O, h.N, found.tier));
        if (end) f.final = !h.noEol;
      }
      d += h.N.length - h.O.length;
    }
    const after = fromLines(f);
    if (move) {
      tree.now.set(oldPath, null);
      tree.now.set(newPath, after);
      tree.moves.push([oldPath, newPath]);
    } else tree.now.set(oldPath, after);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7).

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const marks = lines.map(trimEndWs);
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (marks[i] !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let k = i - 1; k > prevEnd; k -= 1) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    path ??= prevPath;
    if (path === null) throw new Exit2(`error: parse ${i + 1}`);
    const mid = marks.indexOf('=======', i + 1);
    const end = mid < 0 ? -1 : marks.indexOf('>>>>>>> REPLACE', mid + 1);
    if (end < 0) throw new Exit2(`error: parse ${i + 1}`);
    const O = lines.slice(i + 1, mid);
    const N = lines.slice(mid + 1, end);
    const p = path;
    edits.push((tree) => {
      need(p);
      const before = tree.get(p);
      if (O.length === 0) {
        if (before !== null) throw new Fail('exists', p);
        tree.now.set(p, fromLines({ lines: N, br: '\n', final: true }));
        return;
      }
      if (before === null) throw new Fail('missing', p);
      const f = toLines(before);
      const found = locate(f.lines, O, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.at.length > 1) throw new Fail('ambiguous', p);
      const pos = found.at[0]!;
      f.lines.splice(pos, O.length, ...written(f.lines, pos, O, N.map((text) => ({ text, ctx: null })), found.tier));
      tree.now.set(p, fromLines(f));
    });
    prevPath = path;
    prevEnd = end;
    i = end + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------------------------------------------------
// V4A patches (SPEC.md section 8).

interface Chunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

function v4aUpdate(path: string, at: number, rest: string[], strict: boolean): Edit {
  let k = 0;
  let move: string | null = null;
  if (rest.length > 0 && rest[0]!.startsWith('*** Move to: ')) {
    move = trimSpaces(rest[0]!.slice('*** Move to: '.length));
    k = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (; k < rest.length; k += 1) {
    const l = rest[k]!;
    const bad = new Exit2(`error: parse ${at + 2 + k}`);
    if (l.startsWith('@@')) {
      const a = trimSpaces(l.slice(2));
      cur = { anchor: a === '' ? null : a, body: [], eof: false };
      chunks.push(cur);
    } else if (trimEndWs(l) === '*** End of File') {
      if (cur === null) throw bad;
      cur.eof = true;
      cur = null;
    } else if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw bad;
        cur = { anchor: null, body: [], eof: false };
        chunks.push(cur);
      }
      cur.body.push(l);
    } else throw bad;
  }
  if (chunks.length === 0 && move === null) throw new Exit2(`error: parse ${at + 1}`);
  const parts = chunks.map((c) => ({ anchor: c.anchor, eof: c.eof, ...oldNew(c.body) }));
  return (tree) => {
    need(path);
    if (move !== null) need(move);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (move !== null && tree.get(move) !== null) throw new Fail('exists', move);
    const f = toLines(before);
    let cursor = 0;
    for (const c of parts) {
      if (c.anchor !== null) {
        const a = locate(f.lines, [c.anchor], strict, cursor);
        if (a === null) throw new Fail('no-match', path);
        cursor = a.at[0]! + 1;
      }
      if (c.O.length === 0) {
        const pos = c.eof ? f.lines.length : cursor;
        f.lines.splice(pos, 0, ...c.N.map((n) => n.text));
        cursor = pos + c.N.length;
      } else {
        const last = f.lines.length - c.O.length;
        const found = locate(f.lines, c.O, strict, cursor, c.eof ? (i) => i === last : undefined);
        if (found === null) throw new Fail('no-match', path);
        const pos = found.at[0]!;
        f.lines.splice(pos, c.O.length, ...written(f.lines, pos, c.O, c.N, found.tier));
        cursor = pos + c.N.length;
      }
    }
    const after = fromLines(f);
    if (move !== null) {
      tree.now.set(path, null);
      tree.now.set(move, after);
      tree.moves.push([path, move]);
    } else tree.now.set(path, after);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (blank(lines[last]!)) last -= 1;
  if (last === first || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const KINDS = ['*** Add File: ', '*** Delete File: ', '*** Update File: '];
  const kindOf = (l: string): number => KINDS.findIndex((k) => l.startsWith(k));
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    const kind = kindOf(l);
    if (kind < 0) {
      if (!blank(l)) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    const path = trimSpaces(l.slice(KINDS[kind]!.length));
    let j = i + 1;
    while (j < last && kindOf(lines[j]!) < 0) j += 1;
    let e = j;
    while (e > i + 1 && blank(lines[e - 1]!)) e -= 1;
    const rest = lines.slice(i + 1, e);
    if (kind === 0) {
      const text: string[] = [];
      rest.forEach((r, k) => {
        if (r !== '' && r[0] !== '+') throw new Exit2(`error: parse ${i + 2 + k}`);
        text.push(r.slice(1));
      });
      edits.push((tree) => {
        need(path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fromLines({ lines: text, br: '\n', final: true }));
      });
    } else if (kind === 1) {
      const extra = rest.findIndex((r) => !blank(r));
      if (extra >= 0) throw new Exit2(`error: parse ${i + 2 + extra}`);
      edits.push((tree) => {
        need(path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else edits.push(v4aUpdate(path, i, rest, strict));
    i = j;
  }
  return edits;
}

const trimEndWs = (s: string): string => s.trimEnd();

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moved = tree.moves.slice();
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves = moved;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const cmp = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  // A move shows as one R row when its old path is gone and its new path is new.
  const renamedTo = new Map<string, string>();
  const renamedFrom = new Set<string>();
  for (const [from, to] of tree.moves) {
    if (renamedTo.has(to)) continue;
    if (tree.original(from) !== null && tree.get(from) === null && tree.original(to) === null && tree.get(to) !== null) {
      renamedTo.set(to, from);
      renamedFrom.add(from);
    }
  }
  const rows: string[] = [];
  for (const p of changed.sort(cmp)) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (renamedTo.has(p)) rows.push(`R ${renamedTo.get(p)!} -> ${p}`);
    else if (!renamedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  if (!check) {
    // Deletions first, so a path freed by one can hold a directory a new file needs.
    for (const p of changed) if (tree.now.get(p)! === null) rmSync(p, { force: true });
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
