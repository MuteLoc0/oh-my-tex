import { groupAt, significant, tokenize } from './lexer.ts';

/**
 * Finish MathLive's latex-without-placeholders serialization. MacroAtom preserves
 * its original argument string, including placeholder wrappers inside those
 * arguments, even when skipPlaceholders is enabled. Strip those wrappers while
 * retaining their contents and all surrounding TeX. This consumes serialized
 * MathLive output, not authoritative document source.
 */
export function serializeWithoutPlaceholders(latex: string): string {
  if (!latex.includes('\\placeholder')) { return latex; }
  const tokens = significant(tokenize(latex));
  const removals: { from: number; to: number }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.kind !== 'command' || token.value !== '\\placeholder') { continue; }
    let at = index + 1;
    // MathLive prompts can have an id, correctness/default, and locked option.
    for (let option = 0; option < 3; option++) {
      const group = groupAt(tokens, at, '[', ']');
      if (!group) { break; }
      at = group.next;
    }
    const body = groupAt(tokens, at);
    if (!body) { continue; } // Keep malformed input readable; never guess its extent.
    removals.push({ from: token.from, to: body.from }, { from: body.to, to: body.end });
    // Continue inside the body so nested wrappers are stripped too, without a
    // recursive call or a depth limit. Options are metadata and are skipped.
    index = at;
  }
  if (!removals.length) { return latex; }
  removals.sort((a, b) => a.from - b.from || a.to - b.to);
  let result = '', cursor = 0;
  for (const removal of removals) {
    result += latex.slice(cursor, removal.from);
    cursor = Math.max(cursor, removal.to);
  }
  return result + latex.slice(cursor);
}
