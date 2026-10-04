import { parseSnippet, type SnippetTabstop } from './snippet.ts';

export interface MathSnippetTemplate {
  /** MathLive insertion syntax; never write this string directly to the document. */
  latex: string;
  /** Select this prompt after insert(), when the first slot has a default value. */
  firstPromptId?: string;
}

interface Slot { stop: SnippetTabstop; children: Slot[] }

/** Escape literal hashes, which MathLive otherwise interprets as template arguments. */
function literalHashes(value: string): string {
  let result = '', slashes = 0;
  for (const char of value) {
    if (char === '#' && slashes % 2 === 0) { result += '\\'; }
    result += char;
    slashes = char === '\\' ? slashes + 1 : 0;
  }
  return result;
}

/**
 * Convert VS Code snippets into MathLive templates without importing MathLive.
 * Empty slots use #?; defaults/first choices use editable named prompts because
 * #? has no per-slot default syntax. latex-without-placeholders serializes these
 * prompts as their contents. TM_SELECTED_TEXT uses MathLive's #@ selection.
 *
 * MathLive navigates in expression order, not VS Code's numeric tabstop order.
 * Mirrors start with the same default but become independent editable slots;
 * choices use their first value and transforms keep their untransformed value.
 * $0 adds no extra placeholder. Unknown variables follow parseSnippet's fallback.
 * Supply a unique idPrefix for each insertion into a field containing prompts.
 */
export function snippetToMathTemplate(
  body: string,
  variables: Record<string, string> = {},
  idPrefix = 'omt-snippet',
): MathSnippetTemplate {
  // A sentinel lets parseSnippet resolve all defaults and mirrors while keeping
  // selected text distinct from literal text, including an explicitly empty selection.
  let selection = '\uE000omt-selected\uE001';
  while (body.includes(selection) || Object.values(variables).some(value => value.includes(selection))) {
    selection += '\uE001';
  }
  const parsed = parseSnippet(body, { ...variables, TM_SELECTED_TEXT: selection });
  const plain = (value: string) => value.split(selection).map(literalHashes).join('#@');
  const slots = parsed.tabstops.map(stop => ({ stop, children: [] } as Slot));
  const roots: Slot[] = [];
  const lineage = (slot: Slot) => slot.stop.parents ?? [];
  const order = (a: Slot, b: Slot) => a.stop.from - b.stop.from || b.stop.to - a.stop.to;

  // parseSnippet supplies ancestry even for nested defaults inside mirrors.
  // Build the tree by depth; at coincident zero-width occurrences, spread each
  // identical child across matching parents so every occurrence is rendered once.
  for (const slot of [...slots].sort((a, b) => lineage(a).length - lineage(b).length || order(a, b))) {
    const parents = lineage(slot);
    const candidates = parents.length ? slots.filter(candidate => {
      const ancestors = lineage(candidate);
      return candidate.stop.index === parents[parents.length - 1]
        && ancestors.length === parents.length - 1
        && ancestors.every((index, at) => index === parents[at])
        && candidate.stop.from <= slot.stop.from && candidate.stop.to >= slot.stop.to;
    }) : [];
    const sameChildCount = (candidate: Slot) => candidate.children.filter(child =>
      child.stop.index === slot.stop.index && child.stop.from === slot.stop.from && child.stop.to === slot.stop.to).length;
    candidates.sort((a, b) => sameChildCount(a) - sameChildCount(b) || order(a, b));
    if (candidates[0]) { candidates[0].children.push(slot); }
    else { roots.push(slot); }
  }

  const prefix = idPrefix.replace(/[^A-Za-z0-9_-]/g, '_') || 'omt-snippet';
  let serial = 0, firstSlot = false;
  let firstPromptId: string | undefined;
  const render = (children: Slot[], from: number, to: number): string => {
    let result = '', cursor = from;
    for (const slot of [...children].sort(order)) {
      result += plain(parsed.text.slice(cursor, slot.stop.from));
      const isFirst = slot.stop.index !== 0 && !firstSlot;
      if (slot.stop.index !== 0) { firstSlot = true; }
      const id = `${prefix}-${++serial}`;
      const value = render(slot.children, slot.stop.from, slot.stop.to);
      if (slot.stop.index === 0) { result += value; }
      else if (slot.stop.from === slot.stop.to && !slot.children.length) { result += '#?'; }
      else {
        result += `\\placeholder[${id}]{${value}}`;
        if (isFirst) { firstPromptId = id; }
      }
      cursor = slot.stop.to;
    }
    return result + plain(parsed.text.slice(cursor, to));
  };
  const latex = render(roots, 0, parsed.text.length);
  return firstPromptId ? { latex, firstPromptId } : { latex };
}
