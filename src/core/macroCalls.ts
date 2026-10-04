import { groupAt, significant, tokenize, type Token } from './lexer.ts';
import { diffText } from './patch.ts';
import type { MacroDef, Patch } from '../shared/types.ts';

/** All ranges are UTF-16 source offsets; argument ranges exclude their delimiters. */
export interface MacroArgument {
  index: number;                 // TeX parameter number, starting at 1
  from: number; to: number;
  shellFrom: number; shellTo: number;
  optional: boolean;
  braced: boolean;
  omitted: boolean;
  value: string;                 // exact source contents; empty for an omitted argument
  defaultValue?: string;
  childIds: string[];
}

export interface MacroCall {
  id: string;
  name: string;                 // without backslash
  kind: 'macro' | 'unknown';
  from: number; to: number;
  commandTo: number;
  text: string;
  args: MacroArgument[];
  parentId?: string;
  parentArgumentIndex?: number;
}

export interface ParsedMacroArguments { args: MacroArgument[]; end: number; next: number }

/** Parse TeX arguments, preserving an omitted optional argument as parameter #1. */
export function parseMacroArguments(
  sig: readonly Token[], source: string, i: number, macro: MacroDef, offset = 0, limit = sig.length,
): ParsedMacroArguments | undefined {
  const command = sig[i];
  if (!command || command.kind !== 'command' || !Number.isInteger(macro.arity) || macro.arity < 0 || macro.arity > 9) { return undefined; }
  const args: MacroArgument[] = [];
  let p = i + 1, end = command.to;
  let mandatory = macro.arity;
  if (macro.defaultArgument !== undefined && mandatory > 0) {
    mandatory--;
    const g = groupAt(sig as Token[], p, '[', ']');
    if (g && g.next <= limit) {
      args.push(argument(source, offset, 1, g.from, g.to, g.start, g.end, true, true));
      end = g.end; p = g.next;
    } else if (sig[p]?.value === '[') { return undefined; }
    else {
      args.push({ index: 1, from: end, to: end, shellFrom: end, shellTo: end,
        optional: true, braced: false, omitted: true, value: '', defaultValue: macro.defaultArgument, childIds: [] });
    }
    args[0].defaultValue = macro.defaultArgument;
  }
  for (let k = 0; k < mandatory; k++) {
    const t = sig[p];
    if (p >= limit || !t || t.value === '}' || t.value === '&' || t.value === '\\\\' || t.kind === 'verbatim') { return undefined; }
    const g = groupAt(sig as Token[], p);
    if (g && g.next <= limit) {
      args.push(argument(source, offset, args.length + 1, g.from, g.to, g.start, g.end, false, true));
      end = g.end; p = g.next;
    } else if (t.value === '{') { return undefined; }
    else {
      args.push(argument(source, offset, args.length + 1, t.from, t.to, t.from, t.to, false, false));
      end = t.to; p++;
    }
  }
  return { args, end, next: p };
}

function argument(source: string, offset: number, index: number, from: number, to: number,
  shellFrom: number, shellTo: number, optional: boolean, braced: boolean): MacroArgument {
  return { index, from, to, shellFrom, shellTo, optional, braced, omitted: false,
    value: source.slice(from - offset, to - offset), childIds: [] };
}

/** Unknown commands own only directly following balanced groups; no arity is guessed. */
export function parseUnknownArguments(sig: readonly Token[], source: string, i: number, offset = 0, limit = sig.length): ParsedMacroArguments {
  const args: MacroArgument[] = [];
  let p = i + 1, end = sig[i].to;
  while (p < limit) {
    const g = groupAt(sig as Token[], p) ?? groupAt(sig as Token[], p, '[', ']');
    if (!g || g.next > limit || source.slice(end - offset, g.start - offset).trim() !== '') { break; }
    args.push(argument(source, offset, args.length + 1, g.from, g.to, g.start, g.end, sig[p].value === '[', true));
    end = g.end; p = g.next;
  }
  return { args, end, next: p };
}

/**
 * Return calls in source order, including calls inside every explicitly supplied argument.
 * The tree uses ids rather than cyclic object references. Macro definitions are never expanded.
 */
export function parseMacroCalls(source: string, macros: ReadonlyMap<string, MacroDef>,
  unknown: ReadonlySet<string> = new Set(), offset = 0): MacroCall[] {
  const sig = significant(tokenize(source, offset));
  const calls: MacroCall[] = [];
  const byId = new Map<string, MacroCall>();
  const pending: { start: number; end: number; parentId?: string; parentArgumentIndex?: number }[] = [{ start: 0, end: sig.length }];
  // An explicit stack also handles deeply nested source without overflowing the JS call stack.
  while (pending.length) {
    const range = pending.pop()!;
    for (let i = range.start; i < range.end; i++) {
      const t = sig[i];
      if (t.kind !== 'command') { continue; }
      const name = t.value.slice(1), macro = macros.get(name);
      if ((!macro || macro.arity < 1) && !unknown.has(name)) { continue; }
      const parsed = macro
        ? parseMacroArguments(sig, source, i, macro, offset, range.end)
        : parseUnknownArguments(sig, source, i, offset, range.end);
      if (!parsed) { continue; }
      const call: MacroCall = { id: `${t.from}:${name}`, name, kind: macro ? 'macro' : 'unknown',
        from: t.from, to: parsed.end, commandTo: t.to, text: source.slice(t.from - offset, parsed.end - offset),
        args: parsed.args, ...(range.parentId ? { parentId: range.parentId, parentArgumentIndex: range.parentArgumentIndex } : {}) };
      calls.push(call); byId.set(call.id, call);
      if (range.parentId) {
        byId.get(range.parentId)?.args.find(a => a.index === range.parentArgumentIndex)?.childIds.push(call.id);
      }
      for (const arg of call.args) {
        if (!arg.omitted && arg.from < arg.to) {
          pending.push({ start: tokenAt(sig, arg.from), end: tokenAt(sig, arg.to), parentId: call.id, parentArgumentIndex: arg.index });
        }
      }
      i = parsed.next - 1;
    }
  }
  return calls.sort((a, b) => a.from - b.from);
}

function tokenAt(tokens: readonly Token[], at: number): number {
  let lo = 0, hi = tokens.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (tokens[mid].from < at) { lo = mid + 1; } else { hi = mid; }
  }
  return lo;
}

/**
 * Edit parameter #index. null removes an optional shell; '' retains an explicit empty [].
 * Braced parameters use a minimal content patch. Multi-token unbraced values acquire braces.
 * Invalid input and stale models throw; undefined means the source already has that value.
 */
export function editMacroArgument(source: string, call: MacroCall, index: number, value: string | null, offset = 0): Patch | undefined {
  assertCurrent(source, call, offset);
  const arg = call.args.find(a => a.index === index);
  if (!arg) { throw new Error('Macro argument does not exist'); }
  if (value === null) {
    if (!arg.optional) { throw new Error('A required macro argument cannot be omitted'); }
    return arg.omitted ? undefined : patch(source, arg.shellFrom, arg.shellTo, '', offset);
  }
  validateArgument(value, arg.optional);
  if (arg.omitted) { return patch(source, arg.shellFrom, arg.shellTo, `[${value}]`, offset); }
  if (arg.value === value) { return undefined; }
  if (arg.braced) {
    const diff = diffText(arg.value, value)!;
    return patch(source, arg.from + diff.from, arg.from + diff.to, diff.insert, offset);
  }
  // TeX consumes one token for an unbraced argument. A control word followed by a letter
  // outside the argument would merge into a different command even if it is one token.
  const tokens = significant(tokenize(value));
  const next = source.slice(arg.to - offset);
  const previousText = source.slice(0, arg.from - offset);
  const omittedOptional = call.args.some(a => a.optional && a.omitted && a.index < arg.index);
  const needsBraces = tokens.length !== 1 || tokens[0].kind === 'verbatim' ||
    /^\\[A-Za-z@]+$/.test(value) && /^[A-Za-z@]/.test(next) ||
    /\\[A-Za-z@]+$/.test(previousText) && /^[A-Za-z@]/.test(value) ||
    omittedOptional && value.startsWith('[') || /^\s|\s$/.test(value);
  if (needsBraces) {
    const previous = call.args.find(a => a.index === index - 1);
    const boundary = previous?.shellTo ?? call.commandTo;
    const separator = source.slice(boundary - offset, arg.from - offset);
    const from = /^\s+$/.test(separator) ? boundary : arg.from;
    return patch(source, from, arg.to, `{${value}}`, offset);
  }
  return patch(source, arg.from, arg.to, value, offset);
}

/** Delete exactly this source invocation, including its arguments and internal trivia. */
export function deleteMacroCall(source: string, call: MacroCall, offset = 0): Patch {
  assertCurrent(source, call, offset);
  return patch(source, call.from, call.to, '', offset);
}

function assertCurrent(source: string, call: MacroCall, offset: number): void {
  if (call.from < offset || call.to > source.length + offset || source.slice(call.from - offset, call.to - offset) !== call.text) {
    throw new Error('Macro call source has changed');
  }
}

function patch(source: string, from: number, to: number, insert: string, offset: number): Patch {
  return { from, to, expected: source.slice(from - offset, to - offset), insert };
}

function validateArgument(value: string, optional: boolean): void {
  const tokens = tokenize(value);
  let braces = 0, brackets = 0;
  for (const t of tokens) {
    if (t.kind === 'comment' || t.kind === 'verbatim') { throw new Error('Macro argument requires source editing'); }
    if (t.value === '\\') { throw new Error('Incomplete macro argument control sequence'); }
    if (t.kind === 'command' && (t.value === '\\placeholder' || /^\\OMT[a-z]+$/.test(t.value))) {
      throw new Error('Internal editing markers cannot be saved in macro arguments');
    }
    if (t.value === '{') { braces++; }
    else if (t.value === '}' && --braces < 0) { throw new Error('Unbalanced macro argument braces'); }
    if (optional && braces === 0) {
      if (t.value === '[') { brackets++; }
      if (t.value === ']' && --brackets < 0) { throw new Error('Unbalanced optional argument brackets'); }
    }
  }
  if (braces !== 0 || brackets !== 0) { throw new Error('Unbalanced macro argument delimiters'); }
}
