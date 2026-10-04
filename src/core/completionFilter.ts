export interface FilterableCompletion {
  label: string;
  filterText?: string;
  sortText?: string;
  preselect?: boolean;
}

function normalized(value: string): string { return value.replace(/^\\/, '').toLowerCase(); }

/** Higher scores favor exact matches, then prefixes, then compact subsequences. */
export function completionScore(query: string, candidate: string): number | null {
  const needle = normalized(query), haystack = normalized(candidate);
  if (!needle) { return 0; }
  if (needle === haystack) { return 10000; }
  if (haystack.startsWith(needle)) { return 8000 + Math.min(needle.length, 99) * 10 - Math.min(haystack.length - needle.length, 999); }
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
