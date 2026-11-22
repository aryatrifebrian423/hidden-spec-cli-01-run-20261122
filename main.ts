// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A, JSON edits) and applies it to the tree of text files rooted at the
// working directory. Every edit applies or none does: a failed edit changes
// nothing, the edits after it still run, and when any edit failed no file is
// written at all. SPEC.md is the contract; this file implements it.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.
// In a trial the grader runs this file with MAKEFUN_ENV_URL set, and it hands
// over to runner.ts (see the bottom of this file).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Errors

/** A parse fault: reported as `error: parse <line>`, exit 2. */
class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit failed: reported as `error: <code> <path>`, exit 1. */
class EditFailure extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

/** A usage error: reported as `error: usage`, exit 2. */
class UsageError extends Error {}

// ---------------------------------------------------------------------------
// Small helpers

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A line is blank when it is empty or only whitespace. */
function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  the empty piece after a final `\n` dropped. Line numbers count from 1. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function safePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The file model (SPEC.md section 3)

interface FileModel {
  /** The file's line break: `\r\n` when its first line feed follows a
   *  carriage return, `\n` otherwise. */
  br: string;
  /** The file's lines, split at its break. The last, empty piece after a
   *  final break is not a line; an empty file has no lines. */
  lines: string[];
  /** True when the file's text ends with its break. */
  tail: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], tail: false };
  const parts = text.split(br);
  const tail = text.endsWith(br);
  if (tail) parts.pop();
  return { br, lines: parts, tail };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.tail ? f.br : '');
}

// ---------------------------------------------------------------------------
// The working tree: the files as the edits leave them

type Edit = (tree: WorkTree) => void;

class WorkTree {
  /** Disk contents as first read (null: no such file). */
  private base = new Map<string, string | null>();
  /** Current contents (null: deleted); only paths an edit touched. */
  private current = new Map<string, string | null>();
  /** Successful moves, for the `R old -> new` output lines. */
  moves: Array<{ from: string; to: string }> = [];

  private disk(p: string): string | null {
    if (!this.base.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.base.set(p, v);
    }
    return this.base.get(p) as string | null;
  }

  /** The file's content before the patch (null: it did not exist). */
  baseOf(p: string): string | null {
    return this.disk(p);
  }

  /** The file's content as the edits left it (null: absent). */
  get(p: string): string | null {
    if (this.current.has(p)) return this.current.get(p) as string | null;
    return this.disk(p);
  }

  set(p: string, v: string | null): void {
    this.current.set(p, v);
  }

  touched(): string[] {
    return [...this.current.keys()];
  }

  /** A snapshot of the current state, to roll one edit back with. */
  checkpoint(): Map<string, string | null> {
    return new Map(this.current);
  }

  restore(cp: Map<string, string | null>): void {
    this.current = new Map(cp);
  }
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)

/** One line of N: its text, and the index of the line of O it is a context
 *  line of, or -1 when it is a new line of its own. */
interface NewLine {
  text: string;
  ctx: number;
}

/** A line's comparison key at a tier: tier 0 is the line itself, tier 1
 *  strips trailing spaces and tabs, tier 2 strips leading ones too. */
function keyOf(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** The leading spaces and tabs of a line. */
function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

/** Every 0-based position where `oldLines` occurs in `fileLines` at `tier`,
 *  searching from `from` on. Occurrences may overlap. */
function occurrencesIn(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const found: number[] = [];
  if (oldLines.length === 0) return found;
  for (let i = from; i + oldLines.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j++) {
      if (keyOf(fileLines[i + j], tier) !== keyOf(oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  return found;
}

/** The first tier (of `tiers`, in order) at which `oldLines` occurs at least
 *  once at or after `from`, with its positions; null when it occurs nowhere. */
function firstTierWith(
  fileLines: string[],
  oldLines: string[],
  tiers: number[],
  from: number,
): { tier: number; occ: number[] } | null {
  for (const t of tiers) {
    const occ = occurrencesIn(fileLines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N becomes when it replaces the k matched lines at `at`.
 *  A context line is written as the file's own matched line, never the
 *  patch's. At tier 2 every other line is re-indented: with F the leading
 *  spaces and tabs of the file's first matched line and P those of O's
 *  first line, a line that is not empty and not only whitespace and starts
 *  with P has that P replaced by F; any other line is written as it is.
 *  At tiers 0 and 1 the lines of N are written as they are. */
function renderNew(
  newLines: NewLine[],
  fileLines: string[],
  at: number,
  tier: number,
  oldFirst: string,
): string[] {
  const p = leadingWs(oldFirst);
  const f = leadingWs(fileLines[at]);
  return newLines.map((nl) => {
    if (nl.ctx >= 0) return fileLines[at + nl.ctx];
    if (tier !== 2) return nl.text;
    if (nl.text === '' || /^[ \t]+$/.test(nl.text)) return nl.text;
    if (nl.text.startsWith(p)) return f + nl.text.slice(p.length);
    return nl.text;
  });
}

// ---------------------------------------------------------------------------
// Detecting the format (SPEC.md section 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)

interface HunkBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
}

interface Hunk {
  /** A: the 1-based old start the header names. */
  a: number;
  body: HunkBodyLine[];
}

interface UniSection {
  gitOld: string | undefined;
  gitNew: string | undefined;
  /** From a `---`/`+++` pair; null means `/dev/null`. */
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 *  characters, up to the first tab, with surrounding spaces removed. */
function headerPath(rest: string): string {
  const cut = rest.split('\t')[0];
  return cut.trim();
}

/** A path with a leading `a/` or `b/` removed; `/dev/null` means no file. */
function toPath(p: string): string | null {
  const s = p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
  return s === '/dev/null' ? null : s;
}

/** True when a `\` line follows the last body line of `body` whose kind is
 *  one of `kinds` (the hunk's last context or `+` line, or its last `+`
 *  line). False when there is no such line, or no `\` after it. */
function backslashAfterLast(body: HunkBodyLine[], kinds: Array<'ctx' | 'new'>): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i].kind === 'ctx' || body[i].kind === 'new') {
      if (kinds.indexOf(body[i].kind as 'ctx' | 'new') >= 0) last = i;
    }
  }
  if (last < 0) return false;
  const next = body[last + 1];
  return next !== undefined && next.kind === 'bs';
}

/** Apply one section's hunks, in order, to a file's model. `d` is the sum
 *  over the hunks applied so far of (N's length minus O's length). */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  const tiers = strict ? [0] : [0, 1, 2];
  let d = 0;
  for (const hunk of hunks) {
    const oldLines: string[] = [];
    const newLines: NewLine[] = [];
    for (const bl of hunk.body) {
      if (bl.kind === 'ctx') {
        const idx = oldLines.length;
        oldLines.push(bl.text);
        newLines.push({ text: bl.text, ctx: idx });
      } else if (bl.kind === 'old') {
        oldLines.push(bl.text);
      } else if (bl.kind === 'new') {
        newLines.push({ text: bl.text, ctx: -1 });
      }
    }
    if (oldLines.length === 0) {
      // N is inserted after the first A + d lines (all of them when the
      // file has fewer).
      let at = hunk.a + d;
      if (at < 0) at = 0;
      if (at > model.lines.length) at = model.lines.length;
      const wasEnd = at === model.lines.length;
      const ins = newLines.map((nl) => nl.text);
      model.lines.splice(at, 0, ...ins);
      if (wasEnd && ins.length > 0) {
        // The insertion is at the end: the result ends with a line break
        // unless a `\` line follows the hunk's last `+` line.
        model.tail = !backslashAfterLast(hunk.body, ['new']);
      }
      d += newLines.length;
      continue;
    }
    const found = firstTierWith(model.lines, oldLines, tiers, 0);
    if (found === null) throw new EditFailure('no-match', path);
    // Of the occurrences at the tier where O is found, the hunk takes the
    // one whose 0-based position is nearest to A - 1 + d; of two equally
    // near, the earlier.
    const target = hunk.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const pos of found.occ) {
      const dist = Math.abs(pos - target);
      if (dist < bestDist) {
        best = pos;
        bestDist = dist;
      }
    }
    const runsToEnd = best + oldLines.length === model.lines.length;
    const replacement = renderNew(newLines, model.lines, best, found.tier, oldLines[0]);
    model.lines.splice(best, oldLines.length, ...replacement);
    if (runsToEnd) {
      // The matched lines run to the end of the file: the result ends with
      // a line break unless a `\` line follows the hunk's last context or
      // `+` line; otherwise the file's final break stays as it was.
      model.tail = !backslashAfterLast(hunk.body, ['ctx', 'new']);
    }
    d += newLines.length - oldLines.length;
  }
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldP: string | null =
    sec.pairOld !== undefined ? sec.pairOld : sec.renameFrom !== undefined ? sec.renameFrom : sec.gitOld !== undefined ? sec.gitOld : null;
  const newP: string | null =
    sec.pairNew !== undefined ? sec.pairNew : sec.renameTo !== undefined ? sec.renameTo : sec.gitNew !== undefined ? sec.gitNew : null;
  return (tree: WorkTree): void => {
    const isCreate = oldP === null || sec.isCreate;
    const isDelete = !isCreate && (newP === null || sec.isDelete);
    // Every path the edit names is checked for safety before anything else.
    if (oldP !== null && !safePath(oldP)) throw new EditFailure('unsafe', oldP);
    if (newP !== null && !safePath(newP)) throw new EditFailure('unsafe', newP);
    if (isCreate) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new EditFailure('exists', newP);
      const plus: string[] = [];
      let lastPlus: { h: number; b: number } | null = null;
      sec.hunks.forEach((h, hi) => {
        h.body.forEach((bl, bi) => {
          if (bl.kind === 'new') {
            plus.push(bl.text);
            lastPlus = { h: hi, b: bi };
          }
        });
      });
      let tail = true;
      if (lastPlus !== null) {
        const body = sec.hunks[lastPlus.h].body;
        const next = body[lastPlus.b + 1];
        if (next !== undefined && next.kind === 'bs') tail = false;
      }
      tree.set(newP, plus.length === 0 ? '' : plus.join('\n') + (tail ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldP === null) return;
      if (tree.get(oldP) === null) throw new EditFailure('missing', oldP);
      tree.set(oldP, null);
      return;
    }
    // A move (old and new path differ) or a change of the one path.
    const from = oldP as string;
    const to = newP as string;
    if (from !== to) {
      if (tree.get(from) === null) throw new EditFailure('missing', from);
      if (tree.get(to) !== null) throw new EditFailure('exists', to);
      const model = splitFile(tree.get(from) as string);
      applyHunks(model, sec.hunks, strict, from);
      tree.set(to, joinFile(model));
      tree.set(from, null);
      tree.moves.push({ from, to });
    } else {
      if (tree.get(from) === null) throw new EditFailure('missing', from);
      const model = splitFile(tree.get(from) as string);
      applyHunks(model, sec.hunks, strict, from);
      tree.set(from, joinFile(model));
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let sec: UniSection | null = null;
  let hunk: Hunk | null = null;
  const finishHunk = (): void => {
    if (hunk === null) return;
    // Empty lines at the end of a body are not part of it.
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1];
      if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
      else break;
    }
    hunk = null;
  };
  const beginSection = (s: UniSection): void => {
    finishHunk();
    if (sec !== null) sections.push(sec);
    sec = s;
  };
  const blankSection = (): UniSection => ({
    gitOld: undefined,
    gitNew: undefined,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (hunk !== null) {
      // The body ends at a `--- ` line followed by a `+++ ` line: that pair
      // starts a new section, it is not an old line of this hunk.
      if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        finishHunk();
        continue;
      }
      if (line === '') {
        hunk.body.push({ kind: 'ctx', text: '' });
        i++;
        continue;
      }
      const c = line[0];
      if (c === ' ') {
        hunk.body.push({ kind: 'ctx', text: line.slice(1) });
        i++;
        continue;
      }
      if (c === '-') {
        hunk.body.push({ kind: 'old', text: line.slice(1) });
        i++;
        continue;
      }
      if (c === '+') {
        hunk.body.push({ kind: 'new', text: line.slice(1) });
        i++;
        continue;
      }
      if (c === '\\') {
        hunk.body.push({ kind: 'bs', text: '' });
        i++;
        continue;
      }
      // The body ends at the first other line; reprocess that line.
      finishHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      const s = blankSection();
      s.gitOld = m[1];
      s.gitNew = m[2];
      beginSection(s);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = toPath(headerPath(line.slice(4)));
      const newP = toPath(headerPath(lines[i + 1].slice(4)));
      if (sec === null || sec.hunks.length > 0) {
        // A new section starts at the pair.
        const s = blankSection();
        s.pairOld = oldP;
        s.pairNew = newP;
        beginSection(s);
      } else {
        // The pair is part of this section's header.
        sec.pairOld = oldP;
        sec.pairNew = newP;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line not followed by a `+++ ` line, inside a section's
      // header, is a parse error at the line after it.
      if (sec !== null && sec.hunks.length === 0) throw new ParseError(i + 2);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseError(i + 1);
      hunk = { a: Number(m[1]), body: [] };
      sec.hunks.push(hunk);
      i++;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Lines of the section's header, before its first hunk.
      if (line.startsWith('+++ ')) {
        sec.pairNew = toPath(headerPath(line.slice(4)));
      } else if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
      } else if (line.startsWith('new file mode')) {
        sec.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        sec.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index` and `Index:` lines, and any other line, are
      // ignored.
      i++;
      continue;
    }
    // Outside a section, or between a section's hunks: prose is ignored.
    i++;
  }
  finishHunk();
  if (sec !== null) sections.push(sec);
  if (sections.length === 0) throw new ParseError(1);
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    // A SEARCH line with no `=======` and then `>>>>>>> REPLACE` after it.
    if (eq === -1 || rep === -1 || rep < eq) throw new ParseError(s + 1);
    // The path is the nearest line before the SEARCH line, and after the
    // previous block's REPLACE line (or the start of the patch), that is not
    // blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = s - 1; j > prevReplace; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(s + 1);
      path = prevPath;
    }
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevReplace = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks.map((b) => {
    return (tree: WorkTree): void => {
      if (!safePath(b.path)) throw new EditFailure('unsafe', b.path);
      if (b.oldLines.length === 0) {
        // The file is created with the new lines.
        if (tree.get(b.path) !== null) throw new EditFailure('exists', b.path);
        tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new EditFailure('missing', b.path);
      const model = splitFile(text);
      const tiers = strict ? [0] : [0, 1, 2];
      const found = firstTierWith(model.lines, b.oldLines, tiers, 0);
      if (found === null) throw new EditFailure('no-match', b.path);
      // The old lines must occur at their tier exactly once.
      if (found.occ.length > 1) throw new EditFailure('ambiguous', b.path);
      const at = found.occ[0];
      const newItems: NewLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
      const replacement = renderNew(newItems, model.lines, at, found.tier, b.oldLines[0]);
      model.lines.splice(at, b.oldLines.length, ...replacement);
      tree.set(b.path, joinFile(model));
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)

interface VBodyLine {
  kind: 'ctx' | 'old' | 'new';
  text: string;
}

interface VChunk {
  /** The anchor, or null when the chunk has none. */
  anchor: string | null;
  body: VBodyLine[];
  /** True when a `*** End of File` line ends this chunk. */
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  /** 1-based line of the section's header (for parse errors). */
  headerLine: number;
}

interface RawLine {
  text: string;
  num: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let idx = lines.length - 1; idx >= 0; idx--) {
    if (!isBlank(lines[idx])) {
      last = idx;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  // Split the body into sections, each with its raw lines.
  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    headerLine: number;
    raw: RawLine[];
  }
  const rawSections: RawSection[] = [];
  let cur: RawSection | null = null;
  for (let idx = first + 1; idx < last; idx++) {
    const line = lines[idx];
    if (isBlank(line)) {
      if (cur !== null) cur.raw.push({ text: line, num: idx + 1 });
      continue;
    }
    if (line.startsWith('*** Add File:')) {
      cur = { kind: 'add', path: line.slice('*** Add File:'.length).trim(), headerLine: idx + 1, raw: [] };
      rawSections.push(cur);
      continue;
    }
    if (line.startsWith('*** Delete File:')) {
      cur = { kind: 'delete', path: line.slice('*** Delete File:'.length).trim(), headerLine: idx + 1, raw: [] };
      rawSections.push(cur);
      continue;
    }
    if (line.startsWith('*** Update File:')) {
      cur = { kind: 'update', path: line.slice('*** Update File:'.length).trim(), headerLine: idx + 1, raw: [] };
      rawSections.push(cur);
      continue;
    }
    if (cur === null) throw new ParseError(idx + 1);
    cur.raw.push({ text: line, num: idx + 1 });
  }
  if (rawSections.length === 0) throw new ParseError(1);
  const sections: VSection[] = [];
  for (const rs of rawSections) {
    // Blank lines at the end of a section are not part of it.
    let raw = rs.raw;
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
    if (rs.kind === 'add') {
      const fileLines: string[] = [];
      for (const rl of raw) {
        if (rl.text === '') fileLines.push('');
        else if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
        else throw new ParseError(rl.num);
      }
      sections.push({ kind: 'add', path: rs.path, moveTo: null, chunks: [], headerLine: rs.headerLine });
      // Keep the file's lines on the section through a side table.
      addLines.set(sections[sections.length - 1], fileLines);
      continue;
    }
    if (rs.kind === 'delete') {
      if (raw.length > 0) throw new ParseError(raw[0].num);
      sections.push({ kind: 'delete', path: rs.path, moveTo: null, chunks: [], headerLine: rs.headerLine });
      continue;
    }
    // Update: an optional `*** Move to:` first, then chunks.
    let moveTo: string | null = null;
    if (raw.length > 0 && raw[0].text.startsWith('*** Move to:')) {
      moveTo = raw[0].text.slice('*** Move to:'.length).trim();
      raw = raw.slice(1);
    }
    const chunks: VChunk[] = [];
    let curChunk: VChunk | null = null;
    let seenAny = false;
    for (const rl of raw) {
      const t = rl.text;
      if (t.startsWith('@@')) {
        if (curChunk !== null) chunks.push(curChunk);
        const anchorText = t.slice(2).trim();
        curChunk = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
        seenAny = true;
      } else if (t.trimEnd() === '*** End of File') {
        if (curChunk === null) throw new ParseError(rl.num);
        curChunk.eof = true;
        chunks.push(curChunk);
        curChunk = null;
      } else if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
        if (curChunk === null) {
          if (seenAny) throw new ParseError(rl.num);
          curChunk = { anchor: null, body: [], eof: false };
          seenAny = true;
        }
        const kind = t === '' ? 'ctx' : t[0] === ' ' ? 'ctx' : t[0] === '-' ? 'old' : 'new';
        curChunk.body.push({ kind, text: t === '' ? '' : t.slice(1) });
      } else {
        throw new ParseError(rl.num);
      }
    }
    if (curChunk !== null) chunks.push(curChunk);
    if (chunks.length === 0 && moveTo === null) throw new ParseError(rs.headerLine);
    sections.push({ kind: 'update', path: rs.path, moveTo, chunks, headerLine: rs.headerLine });
  }
  return sections.map((s) => v4aEdit(s, strict));
}

/** The lines of an Add File section, kept beside the section. */
const addLines = new Map<VSection, string[]>();

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree: WorkTree): void => {
    if (!safePath(sec.path)) throw new EditFailure('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new EditFailure('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new EditFailure('exists', sec.path);
      const fileLines = addLines.get(sec) ?? [];
      tree.set(sec.path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new EditFailure('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    const text = tree.get(sec.path);
    if (text === null) throw new EditFailure('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new EditFailure('exists', sec.moveTo);
    const model = splitFile(text);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        // Find the first line at or after the cursor equal to the anchor
        // at the first tier where one is, else no-match; the cursor moves
        // past it.
        let found = -1;
        for (const t of tiers) {
          for (let i = cursor; i < model.lines.length; i++) {
            if (keyOf(model.lines[i], t) === keyOf(chunk.anchor, t)) {
              found = i;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFailure('no-match', sec.path);
        cursor = found + 1;
      }
      const oldLines: string[] = [];
      const newLines: NewLine[] = [];
      for (const bl of chunk.body) {
        if (bl.kind === 'ctx') {
          const idx = oldLines.length;
          oldLines.push(bl.text);
          newLines.push({ text: bl.text, ctx: idx });
        } else if (bl.kind === 'old') {
          oldLines.push(bl.text);
        } else {
          newLines.push({ text: bl.text, ctx: -1 });
        }
      }
      if (oldLines.length === 0) {
        // N is inserted at the cursor, or at the end of the file for an
        // end-of-file chunk.
        const at = chunk.eof ? model.lines.length : cursor;
        const ins = newLines.map((nl) => nl.text);
        model.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      let occ = -1;
      let tierUsed = 0;
      if (chunk.eof) {
        // An end-of-file chunk takes only an occurrence that ends at the
        // file's last line.
        const start = model.lines.length - oldLines.length;
        if (start >= cursor) {
          for (const t of tiers) {
            let ok = true;
            for (let j = 0; j < oldLines.length; j++) {
              if (keyOf(model.lines[start + j], t) !== keyOf(oldLines[j], t)) {
                ok = false;
                break;
              }
            }
            if (ok) {
              occ = start;
              tierUsed = t;
              break;
            }
          }
        }
      } else {
        const found = firstTierWith(model.lines, oldLines, tiers, cursor);
        if (found !== null) {
          occ = found.occ[0];
          tierUsed = found.tier;
        }
      }
      if (occ < 0) throw new EditFailure('no-match', sec.path);
      const replacement = renderNew(newLines, model.lines, occ, tierUsed, oldLines[0]);
      model.lines.splice(occ, oldLines.length, ...replacement);
      cursor = occ + replacement.length;
    }
    const content = joinFile(model);
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, content);
      tree.set(sec.path, null);
      tree.moves.push({ from: sec.path, to: sec.moveTo });
    } else {
      tree.set(sec.path, content);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree: WorkTree): void => {
      if (!safePath(p)) throw new EditFailure('unsafe', p);
      if (tree.get(p) !== null) throw new EditFailure('exists', p);
      // Written with `file_text`'s bytes.
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: WorkTree): void => {
      if (!safePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const crlf = splitFile(before).br === '\r\n';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      const nw = norm(newStr);
      // `old_str` occurs in the text exactly once (positions may overlap).
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', p);
      if (count > 1) throw new EditFailure('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + nw + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: WorkTree): void => {
      if (!safePath(p)) throw new EditFailure('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFailure('missing', p);
      const model = splitFile(before);
      if (lineNo < 0 || lineNo > model.lines.length) throw new EditFailure('no-match', p);
      model.lines.splice(lineNo, 0, ...add);
      // The file's final break stays as it was.
      tree.set(p, joinFile(model));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  const edits: Edit[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is a parse error at the
    // line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseError(first + 1);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored; a line that
  // does not hold one valid edit object is a parse error at that line.
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

// ---------------------------------------------------------------------------
// The command line (SPEC.md sections 1, 2 and 10)

interface Options {
  format: string | null;
  checkOnly: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Options {
  let format: string | null = null;
  let checkOnly = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) throw new UsageError();
        const v = a.slice('--format='.length);
        if (FORMATS.indexOf(v) < 0) throw new UsageError();
        format = v;
      } else if (a === '--check') {
        if (checkOnly) throw new UsageError();
        checkOnly = true;
      } else if (a === '--strict') {
        if (strict) throw new UsageError();
        strict = true;
      } else {
        throw new UsageError();
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new UsageError();
  return { format, checkOnly, strict, patch: pos.length === 0 ? null : pos[0] };
}

interface Outcome {
  code: number;
  out: string[];
}

function run(argv: string[]): Outcome {
  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) return { code: 2, out: ['error: usage'] };
    throw e;
  }
  const patchArg = opts.patch;
  let text = '';
  try {
    text = readFileSync(patchArg === null || patchArg === '-' ? 0 : patchArg, 'utf8');
  } catch {
    if (patchArg !== null && patchArg !== '-') return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = opts.format === null || opts.format === 'auto' ? detectFormat(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'unified') edits = parseUnified(lines, opts.strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, opts.strict);
    else if (kind === 'v4a') edits = parseV4a(lines, opts.strict);
    else edits = parseJson(text, lines);
    if (edits.length === 0) throw new ParseError(1);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  // Edits apply in the patch's order to the tree as earlier edits left it.
  // A failed edit changes nothing, and the edits after it still run.
  const tree = new WorkTree();
  const fails: EditFailure[] = [];
  for (const edit of edits) {
    const snap = tree.checkpoint();
    try {
      edit(tree);
    } catch (e) {
      if (e instanceof EditFailure) {
        tree.restore(snap);
        fails.push(e);
      } else {
        throw e;
      }
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }
  // One line for each path whose state changed, in byte order of the paths.
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of tree.touched()) {
    const was = tree.baseOf(p);
    const now = tree.get(p);
    if (was === now) continue;
    if (was === null) rows.push({ key: p, line: `A ${p}` });
    else if (now === null) rows.push({ key: p, line: `D ${p}` });
    else rows.push({ key: p, line: `M ${p}` });
  }
  // A move that succeeded replaces its pair's `D` and `A` lines with one
  // `R old -> new` line, which sorts by `<new>`.
  for (const m of tree.moves) {
    const wasFrom = tree.baseOf(m.from);
    const nowFrom = tree.get(m.from);
    const wasTo = tree.baseOf(m.to);
    const nowTo = tree.get(m.to);
    if (wasFrom !== null && nowFrom === null && wasTo === null && nowTo !== null) {
      const di = rows.findIndex((r) => r.line === `D ${m.from}`);
      const ai = rows.findIndex((r) => r.line === `A ${m.to}`);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: m.to, line: `R ${m.from} -> ${m.to}` });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const changed = rows.map((r) => r.line);
  if (!opts.checkOnly) {
    for (const p of tree.touched()) {
      const was = tree.baseOf(p);
      const now = tree.get(p);
      if (was === now) continue;
      if (now === null) {
        rmSync(p, { force: true });
      } else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...changed, `ok: ${changed.length} ${changed.length === 1 ? 'file' : 'files'}`] };
}

// ---------------------------------------------------------------------------
// Entry point, and the trial hand-over

async function start(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl !== undefined && envUrl !== '') {
    // A trial: the kit's runner reads the checks from the env and runs this
    // file on each one, without this variable.
    const runner = await import('./runner.ts');
    await runner.runTrial(envUrl);
    return;
  }
  const result = run(process.argv.slice(2));
  writeSync(1, result.out.map((l) => `${l}\n`).join(''));
  process.exitCode = result.code;
}

await start();
