import { parseMacroCalls, type MacroCall } from './macroCalls.ts';
import { groupAt, significant, tokenize } from './lexer.ts';
import type { MacroDef } from '../shared/types.ts';
import type { CompletionItemDTO } from '../shared/protocol.ts';
import { parseSnippet } from './snippet.ts';

/** Build the source-owned invocation, without a provider resolution round trip. */
export function projectMacroSnippet(macro: MacroDef, beforeSlash: boolean): string {
  let body = `${beforeSlash ? '' : '\\'}${macro.name}`, tab = 1;
  if (macro.defaultArgument !== undefined) {
    const value = macro.defaultArgument.replace(/[\\$}]/g, '\\$&');
    body += `[\${${tab++}:${value}}]`;
  }
  for (let a = macro.defaultArgument !== undefined ? 1 : 0; a < macro.arity; a++) { body += `{$${tab++}}`; }
  return body;
}

/** Indexed macros own their plain invocation. Keep provider variants with
 * different placeholders, variables, edits or commands as separate choices. */
export function sameMacroCompletion(provider: Omit<CompletionItemDTO, 'i'>, macro: Omit<CompletionItemDTO, 'i'>): boolean {
  if (provider.source !== 'provider' || provider.command || provider.extraEdits?.length) { return false; }
  const command = (value: string) => /^\\{0,2}([A-Za-z@]+)/.exec(value)?.[1];
  if (command(provider.insert.value) !== command(macro.insert.value)) { return false; }
  if (provider.insert.snippet && /\$(?:\{)?[A-Za-z_]|\$\{\d+\//.test(provider.insert.value)) { return false; }
  const signature = (item: Omit<CompletionItemDTO, 'i'>) => {
    const parsed = item.insert.snippet ? parseSnippet(item.insert.value) : { text: item.insert.value, tabstops: [] };
    const slash = Number(parsed.text.startsWith('\\'));
    const stops = parsed.tabstops.filter(stop => !(stop.index === 0 && stop.from === parsed.text.length && stop.to === stop.from))
      .map(stop => [stop.index, stop.from - slash, stop.to - slash, stop.choices ?? [], stop.parents ?? []]);
    const range = item.range;
    return JSON.stringify([parsed.text.slice(slash), stops, range.insFrom + slash, range.insTo, range.repFrom + slash, range.repTo]);
  };
  return signature(provider) === signature(macro);
}

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
