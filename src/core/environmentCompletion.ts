import type { ParsedSnippet } from './snippet.ts';

/** Accept both complete snippets and providers that reuse the typed backslash. */
export function environmentBody(text: string): { from: number; to: number } | undefined {
  const begin = /^\s*\\?begin\{([^}]+)\}/.exec(text);
  if (!begin) { return undefined; }
  const end = /\\end\{([^}]+)\}\s*$/.exec(text);
  return end && begin[1] === end[1] && end.index >= begin[0].length
    ? { from: begin[0].length, to: end.index } : undefined;
}

/** Fill the environment's content slot without altering its other fields. */
export function withEnvironmentSelection(parsed: ParsedSnippet, selected: string): ParsedSnippet {
  const body = environmentBody(parsed.text);
  if (!body || !selected) { return parsed; }
  const slot = parsed.tabstops.find(stop => {
    if (stop.from < body.from || stop.to > body.to) { return false; }
    const lineFrom = Math.max(body.from, parsed.text.lastIndexOf('\n', stop.from - 1) + 1);
    const nextLine = parsed.text.indexOf('\n', stop.to);
    const lineTo = Math.min(body.to, nextLine < 0 ? body.to : nextLine);
    return /^[\t ]*$/.test(parsed.text.slice(lineFrom, stop.from)) && /^[\t ]*$/.test(parsed.text.slice(stop.to, lineTo));
  });
  const whitespace = /^[\t ]*(?:\n[\t ]*)?/.exec(parsed.text.slice(body.from, body.to))![0];
  const from = slot?.from ?? body.from + whitespace.length, to = slot?.to ?? from;
  const insert = selected + (!slot && from === body.to && parsed.text.slice(body.from, from).includes('\n') && !selected.endsWith('\n') ? '\n' : '');
  const delta = insert.length - (to - from);
  const map = (at: number, end: boolean) => at < from ? at : at > to ? at + delta
    : at === to ? from + insert.length : end ? from + insert.length : from;
  const tabstops = parsed.tabstops.flatMap(stop => {
    if (stop === slot) { return [{ ...stop, from, to: from + selected.length }]; }
    if (slot && stop.parents?.includes(slot.index)) { return []; }
    if (stop.from >= from && stop.to <= to && stop.from !== stop.to) { return []; }
    return [{ ...stop, from: map(stop.from, false), to: map(stop.to, true) }];
  });
  if (!slot) {
    // Add an editable body field after any existing argument/label fields.
    const index = Math.max(0, ...tabstops.map(stop => stop.index)) + 1;
    tabstops.push({ index, from, to: from + selected.length });
    tabstops.sort((a, b) => (a.index === 0 ? Infinity : a.index) - (b.index === 0 ? Infinity : b.index) || a.from - b.from);
  }
  return { text: parsed.text.slice(0, from) + insert + parsed.text.slice(to), tabstops };
}
