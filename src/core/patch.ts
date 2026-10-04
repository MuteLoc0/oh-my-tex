import type { Patch } from '../shared/types.ts';

/** Returns a rejection reason, or undefined when every patch matches the text it expects to replace. */
export function validatePatches(text: string, patches: readonly Patch[]): string | undefined {
  if (!patches.length || patches.length > 10000) { return 'invalid patch count'; }
  let end = -1;
  for (const p of [...patches].sort((a, b) => a.from - b.from)) {
    if (!Number.isInteger(p.from) || !Number.isInteger(p.to) || p.from < 0 || p.to < p.from || p.to > text.length || p.from < end) { return 'invalid or overlapping range'; }
    if (typeof p.insert !== 'string' || typeof p.expected !== 'string') { return 'invalid patch'; }
    if (text.slice(p.from, p.to) !== p.expected) { return 'expectedMismatch'; }
    // Template placeholders are an editing aid and must never reach the .tex file.
    if (p.insert.includes('\\placeholder') && !p.expected.includes('\\placeholder')) { return 'placeholder leak'; }
    end = p.to;
  }
  return undefined;
}

export function applyPatches(text: string, patches: readonly { from: number; to: number; insert: string }[]): string {
  for (const p of [...patches].sort((a, b) => b.from - a.from)) { text = text.slice(0, p.from) + p.insert + text.slice(p.to); }
  return text;
}

/** One change covering the differing middle of two strings, snapped to code point boundaries. */
export function diffText(before: string, after: string): { from: number; to: number; insert: string } | undefined {
  if (before === after) { return undefined; }
  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) { prefix++; }
  if (prefix > 0 && isLowSurrogate(before.charCodeAt(prefix))) { prefix--; }
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) { suffix++; }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) { suffix--; }
  return { from: prefix, to: before.length - suffix, insert: after.slice(prefix, after.length - suffix) };
}
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;
