import { parseMacroCalls, type MacroCall } from './macroCalls.ts';
import { groupAt, significant, tokenize } from './lexer.ts';
import type { MacroDef } from '../shared/types.ts';

/** Whether a parsed completion snippet can be inserted directly in a formula body. */
export function isMacroCompletionSource(source: string): boolean {
  let braces = 0;
  const tokens = tokenize(source);
  for (const token of tokens) {
    if (token.kind === 'comment' || token.kind === 'verbatim' || token.value === '\\' || token.value === '$' ||
        ['\\(', '\\)', '\\[', '\\]'].includes(token.value) ||
        token.kind === 'command' && (token.value === '\\placeholder' || /^\\OMT[a-zA-Z]+$/.test(token.value))) { return false; }
    if (token.value === '{') { braces++; }
    else if (token.value === '}' && --braces < 0) { return false; }
  }
  if (braces !== 0) { return false; }
  // Environments must be owned entirely by this snippet. A matching matrix or
  // cases pair is valid inside math; a stray end could terminate its outer formula.
  const sig = significant(tokens), environments: string[] = [];
  for (let i = 0; i < sig.length; i++) {
    const command = sig[i].value;
    if (command !== '\\begin' && command !== '\\end') { continue; }
    const group = groupAt(sig, i + 1);
    if (!group) { return false; }
    const name = source.slice(group.from, group.to);
    if (command === '\\begin') { environments.push(name); }
    else if (environments.pop() !== name) { return false; }
    i = group.next - 1;
  }
  return environments.length === 0;
}

/** Locate a completed, source-owned macro exactly where a completion was inserted. */
export function completedMacroCall(
  source: string, insertionFrom: number, macros: ReadonlyMap<string, MacroDef>, unknown: ReadonlySet<string> = new Set(),
): MacroCall | undefined {
  if (!Number.isInteger(insertionFrom) || insertionFrom < 0 || insertionFrom >= source.length ||
      /\\OMT[a-zA-Z]+|\\placeholder(?![a-zA-Z])/.test(source)) { return; }
  return parseMacroCalls(source, macros, unknown).find(call =>
    call.from === insertionFrom && (macros.get(call.name)?.arity ?? 0) > 0);
}
