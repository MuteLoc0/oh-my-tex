import { tokenize, type Token } from './lexer.ts';
import { diffText } from './patch.ts';

/** Normalise a formula body through the math engine; undefined when it cannot be parsed. */
export type Canonicalize = (body: string) => string | undefined;

export interface Reconciled {
  /** New body source (in island view space). */
  view: string;
  /** How the change was mapped: token-aligned region, an enclosing group, or the whole body. */
  strategy: 'none' | 'aligned' | 'group' | 'body';
}

/**
 * Map an edit made in the math field back onto the user's source.
 *
 * `before`/`after` are the engine's serialisations around the edit; `source` is the body as
 * written by the user, which may differ from `before` in whitespace, optional braces and
 * spelling (x' vs x^{\prime}). The changed region of before→after is mapped onto `source`
 * through a token alignment, and every candidate is verified by re-canonicalising it.
 * Candidates widen from the aligned tokens to enclosing groups to the whole body.
 */
export function reconcile(source: string, before: string, after: string, canon: Canonicalize,
  islands: readonly { token: string; swallow: boolean }[] = []): Reconciled {
  const change = diffText(before, after);
  if (!change) { return { view: source, strategy: 'none' }; }
  const target = canon(after);
  // Style declarations can gain groups each time MathLive parses them. The
  // candidate's first serialization is already authoritative when it matches
  // the live field; otherwise compare the next normalization of both values.
  const matches = (view: string): boolean => {
    const value = canon(view);
    return value !== undefined && (value === after || target !== undefined && canon(value) === target);
  };
  const delta = after.length - before.length;
  const bt = tokenize(before);
  const st = tokenize(source);
  const align = alignTokens(bt, st);
  const lead = source.length - source.trimStart().length;
  const trail = source.trimEnd().length;
  const separators = new Set(islands.filter(island => island.swallow).map(island => island.token));

  const attempt = (ra: number, rb: number, aa = ra, ab = rb + delta, mapping = align): string | undefined => {
    if (!mapping) { return undefined; }
    const insert = after.slice(aa, ab);
    // Prefer the smallest source range. Replacements skip surrounding whitespace (start late, end early);
    // pure insertions attach to the preceding token, as typed text does.
    const starts = ra === rb ? window(ra, mapping) : window(ra, mapping).reverse(), ends = window(rb, mapping);
    const braces = (text: string) => tokenize(text).filter(t => t.value === '{' || t.value === '}').length;
    // Removing source braces the insert does not bring back tends to strip required arguments.
    const pairs = starts.flatMap((sa, i) => ends.filter(sb => sb >= sa).map((sb, j) => ({
      sa, sb, rank: (sb - sa) * 64 + i + j + (braces(source.slice(sa, sb)) > braces(insert) ? 1 << 20 : 0),
    })));
    pairs.sort((x, y) => x.rank - y.rank);
    for (const { sa, sb } of pairs.slice(0, 48)) {
      let end = sb, replacement = insert;
      const islandDeletion = !insert ? deleteIslandTokens(source, sa, sb, separators) : undefined;
      if (islandDeletion) { end = islandDeletion.end; replacement = islandDeletion.trivia; }
      // Ordinary deletions coalesce spaces; atomic island deletion preserves every source byte
      // around the call, removing only a separator the projection introduced before a letter.
      else if (!insert && /\s$/.test(source.slice(0, sa)) && /^[ \t]/.test(source.slice(end))) { end += source.slice(end).match(/^[ \t]+/)![0].length; }
      const view = source.slice(0, sa) + replacement + source.slice(end);
      if (wellFormed(view) && matches(view)) { return view; }
    }
    return undefined;
  };
  /** Source positions that can correspond to canonical position p: token boundaries between its aligned neighbours. */
  const window = (p: number, mapping: NonNullable<typeof align>): number[] => {
    let lo = lead, hi = trail;
    for (let j = 0; j < bt.length; j++) {
      const k = mapping.src[j];
      if (k === undefined) { continue; }
      if (bt[j].to <= p) { lo = st[k].to; }
      if (bt[j].from >= p) { hi = st[k].from; break; }
    }
    if (hi < lo) { return [lo]; }
    const points = new Set<number>([lo, hi]);
    for (const t of st) {
      if (t.kind === 'space') { continue; }
      if (t.from > lo && t.from < hi) { points.add(t.from); }
      if (t.to > lo && t.to < hi) { points.add(t.to); }
    }
    return [...points].sort((x, y) => x - y);
  };

  // 1. A serializer can regroup unchanged terms on an edit. Diff meaningful
  // tokens before falling back, and use the same relaxed alignment with source.
  // Candidate validation still checks grouping semantics before accepting it.
  const meaningful = (t: Token) => skeleton(t) && t.value !== '{' && t.value !== '}';
  const old = bt.filter(meaningful), next = tokenize(after).filter(meaningful);
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix].value === next[prefix].value) { prefix++; }
  while (suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - suffix - 1].value === next[next.length - suffix - 1].value) { suffix++; }
  if (prefix < old.length || prefix < next.length) {
    const start = (tokens: Token[], end: number) => prefix < end ? tokens[prefix].from : tokens[prefix - 1]?.to ?? 0;
    const oldEnd = old.length - suffix, nextEnd = next.length - suffix;
    const a = start(old, oldEnd), b = oldEnd > prefix ? old[oldEnd - 1].to : a;
    const x = start(next, nextEnd), y = nextEnd > prefix ? next[nextEnd - 1].to : x;
    const view = attempt(a, b, x, y, alignTokens(bt, st, meaningful));
    if (view !== undefined) { return { view, strategy: 'aligned' }; }
  }
  // 2. The changed characters, widened to whole tokens.
  let [ra, rb] = snap(bt, change.from, change.to);
  const first = attempt(ra, rb);
  if (first !== undefined) { return { view: first, strategy: 'aligned' }; }
  // 3. Enclosing groups together with what owns them (\frac{..}{..}, x_{..}, \sqrt[..]{..}).
  for (let guard = 0; guard < 32; guard++) {
    const wider = enclosingGroup(bt, ra, rb);
    if (!wider) { break; }
    [ra, rb] = wider;
    const view = attempt(ra, rb);
    if (view !== undefined) { return { view, strategy: 'group' }; }
  }
  // 4. Replace the whole body, keeping its outer whitespace.
  return { view: source.slice(0, lead) + after + source.slice(trail), strategy: 'body' };
}

function deleteIslandTokens(source: string, from: number, to: number, separators: ReadonlySet<string>):
  { end: number; trivia: string } | undefined {
  const removed = tokenize(source.slice(from, to), from).filter(skeleton);
  if (!removed.length || removed.some(t => t.kind !== 'command' || !/^\\OMT[a-z]+$/.test(t.value))) { return undefined; }
  let cursor = from, end = to, trivia = '';
  for (const token of removed) {
    trivia += source.slice(cursor, token.from);
    cursor = token.to;
    if (separators.has(token.value) && /^ [a-zA-Z]/.test(source.slice(cursor))) { cursor++; end = Math.max(end, cursor); }
  }
  return { end, trivia: trivia + source.slice(cursor, end) };
}

/** Widen [from, to) so it starts and ends on token boundaries. */
function snap(tokens: Token[], from: number, to: number): [number, number] {
  let a = from, b = to;
  for (const t of tokens) {
    if (t.from < a && a < t.to) { a = t.from; }
    if (t.from < b && b < t.to) { b = t.to; }
    // An insertion inside a token replaces the token.
    if (from === to && t.from < from && from < t.to) { a = t.from; b = t.to; }
  }
  return [a, b];
}

const skeleton = (t: Token) => t.kind !== 'space' && t.kind !== 'comment';

/** Commands that always take an argument; MathLive accepts them bare, TeX does not. */
const NEEDS_ARGUMENT = new Set(['\\frac', '\\dfrac', '\\tfrac', '\\cfrac', '\\binom', '\\sqrt', '\\boldsymbol', '\\bm', '\\mathbf', '\\mathrm', '\\mathit',
  '\\mathsf', '\\mathtt', '\\mathbb', '\\mathcal', '\\mathfrak', '\\mathscr', '\\operatorname', '\\text', '\\textbf', '\\textit', '\\textrm',
  '\\hat', '\\widehat', '\\bar', '\\overline', '\\underline', '\\vec', '\\dot', '\\ddot', '\\tilde', '\\widetilde', '\\check', '\\breve',
  '\\acute', '\\grave', '\\overbrace', '\\underbrace', '\\overset', '\\underset', '\\stackrel', '\\pmod', '\\left', '\\right', '\\middle']);

/** Balanced braces, and no argument-taking command left without an argument. */
function wellFormed(text: string): boolean {
  const sig = tokenize(text).filter(t => t.kind !== 'space' && t.kind !== 'comment');
  let depth = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i].value;
    if (v === '{') { depth++; }
    if (v === '}' && --depth < 0) { return false; }
    if (NEEDS_ARGUMENT.has(v)) {
      const next = sig[i + 1]?.value;
      if (next === undefined || next === '}' || next === '&' || next === '\\\\' || next === '^' || next === '_') { return false; }
    }
  }
  return depth === 0;
}

/** LCS alignment of significant tokens (whitespace ignored). src[k] = index into source tokens. */
function alignTokens(a: Token[], b: Token[], keep = skeleton): { src: (number | undefined)[] } | undefined {
  const ai = a.map((t, i) => [t, i] as const).filter(([t]) => keep(t));
  const bi = b.map((t, i) => [t, i] as const).filter(([t]) => keep(t));
  const n = ai.length, m = bi.length;
  if (n * m > 4_000_000) { return undefined; }
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * (m + 1) + j] = ai[i][0].value === bi[j][0].value
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    }
  }
  const src: (number | undefined)[] = new Array(a.length).fill(undefined);
  for (let i = 0, j = 0; i < n && j < m;) {
    if (ai[i][0].value === bi[j][0].value) { src[ai[i][1]] = bi[j][1]; i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { i++; }
    else { j++; }
  }
  return { src };
}

/** The smallest brace group strictly enclosing [ra, rb), extended over sibling groups and its owner. */
function enclosingGroup(tokens: Token[], ra: number, rb: number): [number, number] | undefined {
  const sig = tokens.filter(t => t.kind !== 'space' && t.kind !== 'comment');
  const match = new Map<number, number>();
  const stack: number[] = [];
  const closer: Record<string, string> = { '}': '{', ']': '[' };
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i].value;
    if (v === '{' || v === '[') { stack.push(i); }
    else if (v === '}' || v === ']') {
      // `]` only closes a `[` it matches; a lone `]` is ordinary math.
      const top = stack[stack.length - 1];
      if (top !== undefined && sig[top].value === closer[v]) { stack.pop(); match.set(top, i); match.set(i, top); }
    }
  }
  let best: [number, number] | undefined;
  for (const [open, close] of match) {
    if (open > close || sig[open].value !== '{') { continue; }
    const from = sig[open].from, to = sig[close].to;
    // Strictly inside the braces: an insertion right after `}` is outside the group.
    const contains = sig[open].to <= ra && rb <= sig[close].from;
    if (contains && (!best || to - from < sig[best[1]].to - sig[best[0]].from)) { best = [open, close]; }
  }
  if (!best) { return undefined; }
  let [start, end] = best;
  // Walk back over sibling argument groups to the owner (command, _ or ^).
  for (;;) {
    const prev = sig[start - 1];
    if (prev && (prev.value === '}' || prev.value === ']') && match.has(start - 1)) { start = match.get(start - 1)!; continue; }
    break;
  }
  const owner = sig[start - 1];
  if (owner && (owner.kind === 'command' || owner.value === '_' || owner.value === '^')) { start--; }
  // And forward over following sibling groups (\frac{a}{b} edited in a).
  while (sig[end + 1] && sig[end + 1].value === '{' && match.has(end + 1)) { end = match.get(end + 1)!; }
  const from = sig[start].from, to = sig[end].to;
  return from === ra && to === rb ? undefined : [Math.min(from, ra), Math.max(to, rb)];
}
