export interface FilterableCompletion {
  label: string;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
}

function withoutSlash(value: string): string { return value.replace(/^\\/, ''); }

/** A control sequence after an unescaped backslash, including the initial slash. */
export function isLatexCommandPrefix(before: string): boolean {
  const command = /\\[A-Za-z@]*$/.exec(before);
  if (!command) { return false; }
  let preceding = 0;
  for (let at = command.index - 1; at >= 0 && before[at] === '\\'; at--) { preceding++; }
  return preceding % 2 === 0;
}

/** VS Code's Text kind is a document-word suggestion, not a LaTeX command. */
export function isWordCompletion(item: { source?: string; kind?: number }): boolean {
  return item.source === 'word' || item.kind === 0 && (!item.source || item.source === 'provider');
}

/** Higher scores favor exact matches, then prefixes, then compact subsequences. */
export function completionScore(query: string, candidate: string): number | null {
  const rawNeedle = withoutSlash(query), rawHaystack = withoutSlash(candidate);
  const needle = rawNeedle.toLowerCase(), haystack = rawHaystack.toLowerCase();
  if (!needle) { return 0; }
  // TeX commands are case-sensitive. Keep forgiving recall while putting the
  // spelling the user actually typed ahead of differently cased commands.
  const caseBonus = rawHaystack.startsWith(rawNeedle) ? 100 : 0;
  if (needle === haystack) { return 10000 + caseBonus; }
  if (haystack.startsWith(needle)) { return 8000 + Math.min(needle.length, 99) * 10 - Math.min(haystack.length - needle.length, 999) + caseBonus; }
  let at = 0, first = -1, previous = -1, score = 0;
  for (const char of needle) {
    const found = haystack.indexOf(char, at);
    if (found < 0) { return null; }
    if (first < 0) { first = found; }
    score += 10;
    if (found === previous + 1) { score += 20; }
    if (found === 0 || /[\s_\-:{/]/.test(haystack[found - 1])) { score += 15; }
    score -= Math.min(found - at, 100);
    previous = found; at = found + char.length;
  }
  return 1000 + Math.min(score, 5000) - Math.min(first * 4 + haystack.length, 500);
}

/** Filter without mutating provider items; stable order is the final tie-breaker. */
export function filterCompletions<T extends FilterableCompletion>(items: readonly T[], query: string, limit = 300): T[] {
  if (!Number.isFinite(limit) || limit <= 0) { return []; }
  const matches = items.flatMap((item, index) => {
    const score = completionScore(query, item.filterText ?? item.label);
    return score === null ? [] : [{ item, index, score }];
  });
  matches.sort((a, b) => b.score - a.score
    || Number(Boolean(b.item.preselect)) - Number(Boolean(a.item.preselect))
    || (a.item.sortText ?? a.item.label).localeCompare(b.item.sortText ?? b.item.label)
    || a.index - b.index);
  return matches.slice(0, Math.floor(limit)).map(match => match.item);
}
