// main.ts — mend, the CLI SPEC.md specifies (MIT).
// Node 22, standard library alone; run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file hands over to runner.ts.

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
const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => trimEndWs(s.replace(/^[ \t]+/, ''));
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's text as lines, per SPEC.md section 3. */
function fileParts(text: string): { br: string; hadBreak: boolean; ls: string[] } {
  if (text === '') return { br: '\n', hadBreak: false, ls: [] };
  const idx = text.indexOf('\n');
  const br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  const hadBreak = text.endsWith(br);
  const ls = hadBreak ? text.slice(0, text.length - br.length).split(br) : text.split(br);
  return { br, hadBreak, ls };
}

function joinLines(ls: string[], br: string, finalBreak: boolean): string {
  if (ls.length === 0) return '';
  return ls.join(br) + (finalBreak ? br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
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

type RowKind = 'ctx' | 'old' | 'new' | 'back';
interface Row {
  k: RowKind;
  t: string;
  blankLine?: boolean;
}
type Edit = (tree: Tree, strict: boolean) => void;

function eqTier(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

function occPositions(file: string[], O: string[], tier: number, from: number, endAtEnd: boolean): number[] {
  const res: number[] = [];
  if (O.length === 0) return res;
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!eqTier(file[i + j]!, O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok && (!endAtEnd || i + O.length === file.length)) res.push(i);
  }
  return res;
}

/** First occurrence of O at or after `from`, at the first tier with one. */
function findOcc(file: string[], O: string[], strict: boolean, from: number, endAtEnd: boolean): { tier: number; pos: number } | null {
  const top = strict ? 0 : 2;
  for (let tier = 0; tier <= top; tier++) {
    const ps = occPositions(file, O, tier, from, endAtEnd);
    if (ps.length > 0) return { tier, pos: ps[0]! };
  }
  return null;
}

function rowsO(rows: Row[]): string[] {
  return rows.filter((r) => r.k === 'ctx' || r.k === 'old').map((r) => r.t);
}
function rowsN(rows: Row[]): string[] {
  return rows.filter((r) => r.k === 'ctx' || r.k === 'new').map((r) => r.t);
}

/** Replace O at `pos` with N; context lines come from the file, tier-2 re-indent per section 5. */
function applyRows(file: string[], O: string[], rows: Row[], pos: number, tier: number): string[] {
  const out: string[] = file.slice(0, pos);
  const n = rowsN(rows);
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  const F = pos < file.length ? leadWs(file[pos]!) : '';
  let oi = 0;
  let ni = 0;
  for (const r of rows) {
    if (r.k === 'ctx') {
      out.push(pos + oi < file.length ? file[pos + oi]! : r.t);
      oi += 1;
      ni += 1;
    } else if (r.k === 'old') {
      oi += 1;
    } else if (r.k === 'new') {
      let t = r.t;
      if (tier === 2 && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
      ni += 1;
    }
  }
  void n;
  void ni;
  return out.concat(file.slice(pos + O.length));
}

function hunkNoEol(rows: Row[], lastKind: 'ctxnew' | 'new'): boolean {
  let last = -1;
  for (let i = 0; i < rows.length; i++) {
    const k = rows[i]!.k;
    if (lastKind === 'new' ? k === 'new' : k === 'ctx' || k === 'new') last = i;
  }
  for (let i = last + 1; i < rows.length; i++) if (rows[i]!.k === 'back') return true;
  return false;
}

// ---------------------------------------------------------------- unified diffs

interface Hunk {
  a: number;
  rows: Row[];
  noEol: boolean;
}
interface USection {
  line: number;
  minus: string | null;
  plus: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  dgOld: string | null;
  dgNew: string | null;
  hunks: Hunk[];
}

function applyHunks(lines0: string[], hunks: Hunk[], strict: boolean, path: string): { lines: string[]; endBreak: boolean | null; fail?: Fail } {
  let cur = lines0;
  let endBreak: boolean | null = null;
  let d = 0;
  for (const h of hunks) {
    const O = rowsO(h.rows);
    if (O.length > 0) {
      const top = strict ? 0 : 2;
      let found: { tier: number; pos: number } | null = null;
      for (let tier = 0; tier <= top && found === null; tier++) {
        const ps = occPositions(cur, O, tier, 0, false);
        if (ps.length > 0) {
          const target = h.a - 1 + d;
          let best = ps[0]!;
          for (const p of ps) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
          found = { tier, pos: best };
        }
      }
      if (found === null) return { lines: cur, endBreak, fail: new Fail('no-match', path) };
      const lenBefore = cur.length;
      const endRun = found.pos + O.length === lenBefore;
      cur = applyRows(cur, O, h.rows, found.pos, found.tier);
      if (endRun) endBreak = !h.noEol;
      d += rowsN(h.rows).length - O.length;
    } else {
      const lenBefore = cur.length;
      const pos = Math.min(h.a + d, lenBefore);
      const ins: string[] = [];
      for (const r of h.rows) if (r.k === 'ctx' || r.k === 'new') ins.push(r.t);
      cur = cur.slice(0, pos).concat(ins, cur.slice(pos));
      if (pos === lenBefore) endBreak = !h.noEol;
      d += ins.length;
    }
  }
  return { lines: cur, endBreak };
}

function parseUnified(lines: string[], mk: (e: Edit) => void): void {
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const headerPath = (raw: string): string => raw.split('\t')[0]!.trim();
  const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  let sec: USection | null = null;
  const sections: USection[] = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i]!;
    if (L.startsWith('diff --git ')) {
      const m = /^a\/(.*) b\/(.*)$/.exec(L.slice('diff --git '.length));
      if (m === null) err(i + 1);
      sec = { line: i + 1, minus: null, plus: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, dgOld: m![1]!, dgNew: m![2]!, hunks: [] };
      sections.push(sec);
      i += 1;
      continue;
    }
    if (L.startsWith('--- ') && i + 1 < lines.length && lines[i + 1]!.startsWith('+++ ')) {
      if (sec === null || sec.minus !== null || sec.hunks.length > 0) {
        sec = { line: i + 1, minus: null, plus: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, dgOld: null, dgNew: null, hunks: [] };
        sections.push(sec);
      }
      sec.minus = headerPath(L.slice(4));
      sec.plus = headerPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (L.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(L);
      if (m === null) err(i + 1);
      if (sec === null) err(i + 1);
      i += 1;
      const rows: Row[] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const B = lines[j]!;
        if (B.startsWith('diff --git ')) break;
        if (B.startsWith('--- ') && j + 1 < lines.length && lines[j + 1]!.startsWith('+++ ')) break;
        if (B === '') {
          rows.push({ k: 'ctx', t: '', blankLine: true });
        } else if (B.startsWith('\\')) {
          rows.push({ k: 'back', t: B.slice(1) });
        } else if (B.startsWith(' ')) {
          rows.push({ k: 'ctx', t: B.slice(1) });
        } else if (B.startsWith('-')) {
          rows.push({ k: 'old', t: B.slice(1) });
        } else if (B.startsWith('+')) {
          rows.push({ k: 'new', t: B.slice(1) });
        } else {
          break;
        }
      }
      while (rows.length > 0 && rows[rows.length - 1]!.blankLine === true) rows.pop();
      const hunk: Hunk = { a: parseInt(m![1]!, 10), rows, noEol: hunkNoEol(rows, 'ctxnew') };
      sec!.hunks.push(hunk);
      i = j;
      continue;
    }
    if (L.startsWith('--- ') && sec !== null && sec.hunks.length === 0) err(i + 2);
    if (sec !== null && sec.hunks.length === 0) {
      if (L.startsWith('rename from ')) {
        sec.renameFrom = L.slice(12).trim();
        i += 1;
        continue;
      }
      if (L.startsWith('rename to ')) {
        sec.renameTo = L.slice(10).trim();
        i += 1;
        continue;
      }
      if (L.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (L.startsWith('deleted file mode')) {
        sec.delFile = true;
        i += 1;
        continue;
      }
    }
    i += 1;
  }
  for (const s of sections) {
    const isCreate = s.minus === '/dev/null' || s.newFile;
    const isDelete = s.plus === '/dev/null' || s.delFile;
    const oldP = s.minus !== null && s.minus !== '/dev/null' ? stripAB(s.minus) : s.renameFrom ?? s.dgOld;
    const newP = s.plus !== null && s.plus !== '/dev/null' ? stripAB(s.plus) : s.renameTo ?? s.dgNew;
    if (isCreate) {
      if (newP === null) err(s.line);
      const np = newP!;
      mk((tree, _strict) => {
        if (!safe(np)) throw new Fail('unsafe', np);
        if (tree.get(np) !== null) throw new Fail('exists', np);
        const all = s.hunks.flatMap((h) => h.rows);
        const ls = all.filter((r) => r.k === 'new').map((r) => r.t);
        tree.now.set(np, ls.length === 0 ? '' : ls.join('\n') + (hunkNoEol(all, 'new') ? '' : '\n'));
      });
      continue;
    }
    if (isDelete) {
      if (oldP === null) err(s.line);
      const op = oldP!;
      mk((tree, _strict) => {
        if (!safe(op)) throw new Fail('unsafe', op);
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
      });
      continue;
    }
    if (oldP === null && newP === null) {
      if (s.hunks.length > 0) err(s.line);
      continue;
    }
    const op = oldP ?? newP!;
    const np = newP;
    mk((tree, strict) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (np !== null && np !== op && !safe(np)) throw new Fail('unsafe', np);
      const text = tree.get(op);
      if (text === null) throw new Fail('missing', op);
      if (np !== null && np !== op && tree.get(np) !== null) throw new Fail('exists', np);
      const { br, hadBreak, ls } = fileParts(text);
      const r = applyHunks(ls, s.hunks, strict, op);
      if (r.fail !== undefined) throw r.fail;
      const out = joinLines(r.lines, br, r.endBreak ?? hadBreak);
      if (np !== null && np !== op) {
        tree.now.set(np, out);
        tree.now.set(op, null);
        tree.moves.push([op, np]);
      } else {
        tree.now.set(op, out);
      }
    });
  }
}

// ---------------------------------------------------------- SEARCH/REPLACE blocks

interface SRBlock {
  line: number;
  path: string;
  old: string[];
  new: string[];
}

function parseSearchReplace(lines: string[], mk: (e: Edit) => void): void {
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let after = 0; // first index after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (trimEndWs(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]!) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) err(searchLine + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (trimEndWs(lines[j]!) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) err(searchLine + 1);
    let path: string | null = null;
    for (let j = searchLine - 1; j >= after; j--) {
      const t = lines[j]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) err(searchLine + 1);
    prevPath = path;
    after = rep + 1;
    blocks.push({ line: searchLine + 1, path, old: lines.slice(searchLine + 1, eq), new: lines.slice(eq + 1, rep) });
    i = rep + 1;
  }
  for (const b of blocks) {
    const p = b.path;
    const oldL = b.old;
    const newL = b.new;
    mk((tree, strict) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldL.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newL.length === 0 ? '' : newL.join('\n') + '\n');
        return;
      }
      const text = tree.get(p);
      if (text === null) throw new Fail('missing', p);
      const { br, hadBreak, ls } = fileParts(text);
      const top = strict ? 0 : 2;
      let tier = -1;
      let pos = -1;
      let count = 0;
      for (let t = 0; t <= top && tier < 0; t++) {
        const ps = occPositions(ls, oldL, t, 0, false);
        if (ps.length > 0) {
          tier = t;
          pos = ps[0]!;
          count = ps.length;
        }
      }
      if (tier < 0) throw new Fail('no-match', p);
      if (count !== 1) throw new Fail('ambiguous', p);
      const rows: Row[] = oldL.map((t) => ({ k: 'old' as const, t })).concat(newL.map((t) => ({ k: 'new' as const, t })));
      const out = joinLines(applyRows(ls, oldL, rows, pos, tier), br, hadBreak);
      tree.now.set(p, out);
    });
  }
}

// ------------------------------------------------------------------ V4A patches

interface VChunk {
  anchor: string | null;
  eof: boolean;
  rows: Row[];
  closedByEof: boolean;
}
interface VSection {
  line: number;
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: VChunk[];
}

function parseV4a(lines: string[], mk: (e: Edit) => void): void {
  const err = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) err(1);
  if (lines[first]!.trim() !== '*** Begin Patch') err(first + 1);
  const last = (() => {
    for (let j = lines.length - 1; j >= 0; j--) if (!blank(lines[j]!)) return j;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') err(lines.length + 1);
  const sections: VSection[] = [];
  let sec: VSection | null = null;
  let chunk: VChunk | null = null;
  for (let i = first + 1; i < last; i++) {
    const L = lines[i]!;
    const t = L.trim();
    if (t === '') {
      if (chunk !== null && sec !== null && sec.kind === 'update') chunk.rows.push({ k: 'ctx', t: '', blankLine: true });
      else if (sec !== null && sec.kind === 'update') {
        // a blank line before any chunk: the first chunk may start at a body line
        chunk = { anchor: null, eof: false, rows: [{ k: 'ctx', t: '', blankLine: true }], closedByEof: false };
        sec.chunks.push(chunk);
      } else if (sec !== null && sec.kind === 'add') sec.addLines.push('');
      continue;
    }
    if (t.startsWith('*** Add File: ') || t.startsWith('*** Delete File: ') || t.startsWith('*** Update File: ')) {
      const kind = t.startsWith('*** Add File: ') ? 'add' : t.startsWith('*** Delete File: ') ? 'delete' : 'update';
      const p = t.slice(t.indexOf(':') + 1).trim();
      sec = { line: i + 1, kind, path: p, moveTo: null, addLines: [], chunks: [] };
      chunk = null;
      sections.push(sec);
      continue;
    }
    if (sec === null) err(i + 1);
    if (sec.kind === 'add') {
      if (L.startsWith('+')) sec.addLines.push(L.slice(1));
      else err(i + 1);
    } else if (sec.kind === 'delete') {
      err(i + 1);
    } else {
      // update
      if (t.startsWith('*** Move to: ')) {
        if (sec.moveTo !== null || sec.chunks.length > 0 || chunk !== null) err(i + 1);
        sec.moveTo = t.slice('*** Move to: '.length).trim();
        continue;
      }
      if (t === '*** End of File') {
        if (chunk === null) err(i + 1);
        chunk!.eof = true;
        chunk!.closedByEof = true;
        chunk = null;
        continue;
      }
      if (L.startsWith('@@')) {
        chunk = { anchor: L.slice(2).trim() === '' ? null : L.slice(2).trim(), eof: false, rows: [], closedByEof: false };
        sec.chunks.push(chunk);
        continue;
      }
      if (L.startsWith(' ') || L.startsWith('-') || L.startsWith('+')) {
        if (chunk === null) {
          if (sec.chunks.length > 0) err(i + 1);
          chunk = { anchor: null, eof: false, rows: [], closedByEof: false };
          sec.chunks.push(chunk);
        }
        chunk!.rows.push(L.startsWith(' ') ? { k: 'ctx', t: L.slice(1) } : L.startsWith('-') ? { k: 'old', t: L.slice(1) } : { k: 'new', t: L.slice(1) });
        continue;
      }
      err(i + 1);
    }
  }
  for (const s of sections) {
    if (s.kind === 'add') {
      while (s.addLines.length > 0 && s.addLines[s.addLines.length - 1] === '') s.addLines.pop();
      const p = s.path;
      const ls = s.addLines;
      mk((tree, _strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
      });
    } else if (s.kind === 'delete') {
      const p = s.path;
      mk((tree, _strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else {
      for (const c of s.chunks) {
        if (!c.closedByEof) while (c.rows.length > 0 && c.rows[c.rows.length - 1]!.blankLine === true) c.rows.pop();
      }
      if (s.chunks.length === 0 && s.moveTo === null) err(s.line);
      const p = s.path;
      const mv = s.moveTo;
      const chunks = s.chunks;
      mk((tree, strict) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !safe(mv)) throw new Fail('unsafe', mv);
        const text = tree.get(p);
        if (text === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const { br, hadBreak, ls } = fileParts(text);
        let cur = ls;
        let cursor = 0;
        const top = strict ? 0 : 2;
        for (const c of chunks) {
          if (c.anchor !== null) {
            let idx = -1;
            for (let tier = 0; tier <= top && idx < 0; tier++) {
              for (let j = cursor; j < cur.length; j++) {
                if (eqTier(cur[j]!, c.anchor, tier)) {
                  idx = j;
                  break;
                }
              }
            }
            if (idx < 0) throw new Fail('no-match', p);
            cursor = idx + 1;
          }
          const O = rowsO(c.rows);
          if (O.length > 0) {
            const f = findOcc(cur, O, strict, cursor, c.eof);
            if (f === null) throw new Fail('no-match', p);
            cur = applyRows(cur, O, c.rows, f.pos, f.tier);
            cursor = f.pos + rowsN(c.rows).length;
          } else {
            const pos = c.eof ? cur.length : Math.min(cursor, cur.length);
            const ins: string[] = [];
            for (const r of c.rows) if (r.k === 'ctx' || r.k === 'new') ins.push(r.t);
            cur = cur.slice(0, pos).concat(ins, cur.slice(pos));
            cursor = pos + ins.length;
          }
        }
        const out = joinLines(cur, br, hadBreak);
        if (mv !== null) {
          if (tree.get(mv) !== null) throw new Fail('exists', mv);
          tree.now.set(mv, out);
          tree.now.set(p, null);
          tree.moves.push([p, mv]);
        } else {
          tree.now.set(p, out);
        }
      });
    }
  }
}

// ------------------------------------------------------------------ JSON edits

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
    return (tree, _strict) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree, _strict) => {
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
    return (tree, _strict) => {
      const before = exists(tree);
      const { br, hadBreak, ls } = fileParts(before);
      if (line < 0 || line > ls.length) throw new Fail('no-match', p);
      ls.splice(line, 0, ...add);
      tree.now.set(p, joinLines(ls, br, hadBreak));
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

// ---------------------------------------------------------------------- driver

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimEndWs(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

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
  const edits: Edit[] = [];
  try {
    if (kind === 'json') jsonEdits(text, lines).forEach((e) => edits.push(e));
    else if (kind === 'unified') parseUnified(lines, (e) => edits.push(e));
    else if (kind === 'search-replace') parseSearchReplace(lines, (e) => edits.push(e));
    else if (kind === 'v4a') parseV4a(lines, (e) => edits.push(e));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree, strict);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  type OutRow = { key: string; line: string };
  const rows: OutRow[] = [];
  const moved = new Set<string>();
  for (const [o, n] of tree.moves) {
    if (tree.now.get(o) === null && tree.original(o) !== null && tree.original(n) === null && tree.now.get(n) !== null && tree.now.get(n) !== tree.original(n)) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      moved.add(o);
      moved.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    if (moved.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const lines2 = rows.map((r) => r.line);
  if (!check) {
    for (const [p, now] of tree.now) {
      if (now === tree.original(p)) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...lines2, `ok: ${lines2.length} ${lines2.length === 1 ? 'file' : 'files'}`] };
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
