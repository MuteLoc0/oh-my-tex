import { ChangeSet, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, keymap, EditorView } from '@codemirror/view';
import { editKind, remoteEdit } from '../editor/annotations.ts';

export interface Tabstop { index: number; from: number; to: number; choices?: string[]; parents?: number[] }
interface SnippetSession { stops: Tabstop[]; active: number; end: number }
export const startSnippet = StateEffect.define<SnippetSession>();
const endSnippet = StateEffect.define<void>();

function editedStop(tr: Transaction, session: SnippetSession): Tabstop | undefined {
  const active = session.stops.filter(s => s.index === session.active);
  return active.find(s => {
    let inside = true;
    tr.changes.iterChangedRanges((from, to) => { if (from < s.from || to > s.to) { inside = false; } });
    return inside;
  });
}

const snippetState = StateField.define<SnippetSession | undefined>({
  create: () => undefined,
  update(value, tr) {
    if (tr.annotation(remoteEdit)) { value = undefined; }
    // The transaction filter supplies exact new ranges for placeholder edits.
    // Other document changes (including undo and edits outside the snippet) end the session.
    if (value && tr.docChanged) { value = undefined; }
    for (const effect of tr.effects) {
      if (effect.is(startSnippet)) { value = effect.value; }
      if (effect.is(endSnippet)) { value = undefined; }
    }
    if (value && tr.selection) {
      const range = tr.newSelection.main;
      if (!value.stops.some(s => s.index === value!.active && range.from >= s.from && range.to <= s.to)) { value = undefined; }
    }
    return value;
  },
  provide: field => EditorView.decorations.from(field, value => !value ? Decoration.none : Decoration.set(
    value.stops.filter(s => s.from < s.to).map(s => Decoration.mark({ class: s.index === value.active ? 'omt-snippet-active' : 'omt-snippet-stop' }).range(s.from, s.to)), true)),
});

function move(view: EditorView, backwards: boolean): boolean {
  const session = view.state.field(snippetState);
  if (!session) { return false; }
  const indexes = [...new Set(session.stops.map(s => s.index))].filter(i => i !== 0).sort((a, b) => a - b);
  const pos = indexes.indexOf(session.active) + (backwards ? -1 : 1);
  if (pos < 0) { return true; }
  const next = indexes[pos];
  const stop = session.stops.find(s => s.index === (next ?? 0));
  if (next === undefined) {
    view.dispatch({ selection: { anchor: stop?.from ?? session.end }, effects: endSnippet.of(undefined), scrollIntoView: true });
  } else {
    view.dispatch({ selection: { anchor: stop!.from, head: stop!.to }, effects: startSnippet.of({ ...session, active: next }), scrollIntoView: true });
  }
  return true;
}

function cycleChoice(view: EditorView, direction: number): boolean {
  const session = view.state.field(snippetState);
  const stop = session?.stops.find(s => s.index === session.active && s.choices?.length);
  if (!stop?.choices) { return false; }
  const old = view.state.doc.sliceString(stop.from, stop.to);
  const i = stop.choices.indexOf(old);
  const value = stop.choices[(i + direction + stop.choices.length) % stop.choices.length]!;
  view.dispatch({ changes: { from: stop.from, to: stop.to, insert: value }, selection: { anchor: stop.from, head: stop.from + value.length }, annotations: [editKind.of('snippet'), Transaction.userEvent.of('input.snippet')] });
  return true;
}

/** Mirror edits before sync sees them, so every occurrence is committed in one transaction. */
const mirrorEdits = EditorState.transactionFilter.of(tr => {
  const session = tr.startState.field(snippetState, false);
  if (!session || !tr.docChanged || tr.annotation(remoteEdit) || tr.effects.some(e => e.is(startSnippet))) { return tr; }
  const primary = editedStop(tr, session);
  if (!primary) { return tr; }
  const occurrences = session.stops.filter(s => s.index === session.active).sort((a, b) => a.from - b.from || a.to - b.to);
  // Recursive defaults can contain overlapping occurrences of the same index.
  // End that unusual session rather than apply overlapping replacements.
  if (occurrences.some((s, i) => i > 0 && s.from < occurrences[i - 1]!.to)) { return tr; }
  const primaryStart = tr.changes.mapPos(primary.from, -1);
  const text = tr.newDoc.sliceString(primaryStart, tr.changes.mapPos(primary.to, 1));
  const changes = ChangeSet.of(occurrences.map(s => ({ from: s.from, to: s.to, insert: text })), tr.startState.doc.length);
  // Position mapping alone cannot distinguish adjacent empty mirrors. Track each
  // replacement's contribution explicitly, including the final cursor after them.
  const ranges = new Map<Tabstop, Tabstop>();
  let delta = 0;
  for (const s of occurrences) {
    const from = s.from + delta;
    ranges.set(s, { ...s, from, to: from + text.length });
    delta += text.length - (s.to - s.from);
  }
  const stops = session.stops.filter(s => s.index === session.active || !s.parents?.includes(session.active))
    .map(s => {
      const replacement = ranges.get(s);
      if (replacement) { return replacement; }
      const adjacentStart = occurrences.some(o => o.from === s.from && o.from === o.to && !o.parents?.includes(s.index));
      const adjacentEnd = occurrences.some(o => o.from === s.to && !o.parents?.includes(s.index));
      return { ...s, from: changes.mapPos(s.from, s.from === s.to || adjacentStart ? 1 : -1),
        to: changes.mapPos(s.to, s.from === s.to || !adjacentEnd ? 1 : -1) };
    });
  const newPrimary = ranges.get(primary)!;
  const selection = EditorSelection.single(newPrimary.from + tr.newSelection.main.anchor - primaryStart, newPrimary.from + tr.newSelection.main.head - primaryStart);
  return {
    changes, selection, effects: [...tr.effects, startSnippet.of({ ...session, stops, end: changes.mapPos(session.end, 1) })],
    annotations: [editKind.of('snippet'), Transaction.userEvent.of(tr.annotation(Transaction.userEvent) ?? 'input.snippet')], scrollIntoView: tr.scrollIntoView,
  };
});

export function snippetExtensions(): Extension[] {
  return [snippetState, mirrorEdits, Prec.highest(keymap.of([
    { key: 'Tab', run: view => move(view, false) },
    { key: 'Shift-Tab', run: view => move(view, true) },
    { key: 'Escape', run: view => { if (!view.state.field(snippetState)) { return false; } view.dispatch({ effects: endSnippet.of(undefined) }); return true; } },
    { key: 'Alt-ArrowDown', run: view => cycleChoice(view, 1) },
    { key: 'Alt-ArrowUp', run: view => cycleChoice(view, -1) },
  ]))];
}

/** The completion's changes have already been mapped to their final document offsets. */
export function snippetSpec(stops: Tabstop[], end: number, preserveExisting = false) {
  const first = stops.find(s => s.index !== 0) ?? stops.find(s => s.index === 0);
  return {
    selection: EditorSelection.single(first?.from ?? end, first?.to ?? end),
    effects: first && first.index !== 0 ? startSnippet.of({ stops, active: first.index, end })
      : preserveExisting && !first ? [] : endSnippet.of(undefined),
  };
}
