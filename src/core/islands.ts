import { groupAt, tokenize } from './lexer.ts';
import { parseMacroArguments, parseUnknownArguments, type MacroArgument } from './macroCalls.ts';
import type { MacroDef } from '../shared/types.ts';

export { parseMacroArguments as parseCall } from './macroCalls.ts';

/**
 * An island is a piece of source shown atomically in the math field: a macro call with
 * arguments, or formula metadata such as \label. In the view it is a unique control word
 * \OMT<letters>; restore() puts the exact original text back.
 */
export interface Island {
  token: string;                 // e.g. \OMTa
  text: string;                  // exact source text of the call
  from: number; to: number;      // offsets in the body source
  kind: 'macro' | 'meta' | 'unknown';
  name: string;                  // macro name without backslash
  args: MacroArgument[];         // body-source ranges, including omitted optional parameters
  /** TeX the math field renders for this island (no #-parameters). */
  render: string;
  /** View emits a separator space the source did not have; restore swallows it. */
  swallow: boolean;
}

export interface IslandView { view: string; islands: Island[] }

const META = new Set(['\\label', '\\tag', '\\tag*', '\\notag', '\\nonumber', '\\eqref', '\\ref', '\\cite']);
const PREFIX = 'OMT';

function islandName(i: number): string {
  let s = '';
  do { s = String.fromCharCode(97 + i % 26) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
  return `\\${PREFIX}${s}`;
}

/** Substitute #1..#9 in a macro body. Arguments are wrapped in a group as TeX would treat them. */
export function expandBody(body: string, args: string[]): string {
  return body.replace(/#([1-9])/g, (_, d: string) => `{${args[Number(d) - 1] ?? ''}}`);
}

/**
 * Replace macro calls (arity > 0) and metadata commands by island tokens.
 * `unknown` lists command names (without backslash) the math engine cannot render.
 */
export function buildIslands(body: string, macros: ReadonlyMap<string, MacroDef>, unknown: ReadonlySet<string> = new Set()): IslandView {
  const tokens = tokenize(body);
  const sig = tokens.filter(t => t.kind !== 'space' && t.kind !== 'comment');
  const islands: Island[] = [];
  let view = '', cursor = 0;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    if (t.kind !== 'command') { continue; }
    const name = t.value.slice(1);
    const macro = macros.get(name);
    let island: Omit<Island, 'token' | 'swallow'> | undefined;
    let next = i + 1;
    if (macro && macro.arity > 0) {
      const parsed = parseMacroArguments(sig, body, i, macro);
      if (!parsed) { continue; }
      next = parsed.next;
      const argText = parsed.args.map(a => a.omitted ? macro.defaultArgument ?? '' : body.slice(a.from, a.to));
      island = { text: body.slice(t.from, parsed.end), from: t.from, to: parsed.end, kind: 'macro', name, args: parsed.args,
        render: unknown.has(name) ? unknownChip(name) : macro.operator ? `\\operatorname{${macro.body}}` : expandBody(macro.body, argText) };
    } else if (META.has(t.value) || META.has(t.value + (sig[i + 1]?.value === '*' ? '*' : ''))) {
      let p = i + 1, star = '';
      if (sig[p]?.value === '*') { p++; star = '*'; }
      const g = (t.value === '\\notag' || t.value === '\\nonumber') ? undefined : groupAt(sig, p);
      const end = g ? g.end : sig[p - 1].to;
      next = g ? g.next : p;
      const label = g ? body.slice(g.from, g.to) : '';
      const shown = t.value === '\\tag' ? `(${label})` : t.value === '\\eqref' ? `(${label})` : label ? `${t.value.slice(1)}${star}:${label}` : t.value.slice(1);
      island = { text: body.slice(t.from, end), from: t.from, to: end, kind: 'meta', name: name + star,
        args: g ? [{ index: 1, from: g.from, to: g.to, shellFrom: g.start, shellTo: g.end,
          optional: false, braced: true, omitted: false, value: label, childIds: [] }] : [],
        render: `{\\scriptstyle\\text{${escapeText(shown)}}}` };
    } else if (unknown.has(name)) {
      // Unknown to the math engine: keep it with any directly following groups, render as a chip.
      const parsed = macro ? parseMacroArguments(sig, body, i, macro) : parseUnknownArguments(sig, body, i);
      if (!parsed) { continue; }
      next = parsed.next;
      island = { text: body.slice(t.from, parsed.end), from: t.from, to: parsed.end,
        kind: macro ? 'macro' : 'unknown', name, args: parsed.args, render: unknownChip(name) };
    }
    if (!island) { continue; }
    const token = islandName(islands.length);
    view += body.slice(cursor, island.from) + token;
    cursor = island.to;
    // `\OMTa` followed by a letter would lex as a longer control word.
    const swallow = /^[a-zA-Z]/.test(body.slice(cursor));
    if (swallow) { view += ' '; }
    islands.push({ ...island, token, swallow });
    i = next - 1;
  }
  view += body.slice(cursor);
  return { view, islands };
}

function escapeText(s: string) { return s.replace(/[\\{}$&#^_%~]/g, c => `\\${c === '\\' ? 'textbackslash ' : c}`); }

function unknownChip(name: string) { return `\\text{\\textbackslash ${escapeText(name)}}`; }

/** Inverse of buildIslands for any view text: island tokens become their source text again. */
export function restoreIslands(view: string, islands: readonly Island[]): string {
  if (!islands.length) { return view; }
  const byToken = new Map(islands.map(i => [i.token, i]));
  return view.replace(new RegExp(`\\\\${PREFIX}([a-z]+)(?![a-zA-Z])( (?=[a-zA-Z]))?`, 'g'), (match, _id: string, space: string | undefined) => {
    const island = byToken.get(match.trimEnd());
    if (!island) { return match; }
    return island.text + (space && !island.swallow ? ' ' : '');
  });
}

/** MathLive macro table for the islands (atomic, never expanded on output). */
export function islandMacros(islands: readonly Island[]): Record<string, { def: string; args: number; captureSelection: boolean; expand: boolean }> {
  return Object.fromEntries(islands.map(i => [i.token.slice(1), { def: i.render, args: 0, captureSelection: true, expand: false }]));
}
