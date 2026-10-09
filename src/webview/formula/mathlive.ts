/** The only module that talks to MathLive. Everything else sees plain strings and callbacks. */
import { MathfieldElement, convertLatexToMarkup, validateLatex } from 'mathlive';
import type { MacroDef } from '../../shared/types.ts';
import { serializeWithoutPlaceholders } from '../../core/mathSerialization.ts';
import { renderDefinitions } from '../../core/renderCompat.ts';
import { diffText } from '../../core/patch.ts';
import { attachMathIME } from './mathIME.ts';

export type MacroDictionary = Record<string, { def: string; args: number; captureSelection: boolean; expand: boolean }>;

let defaults: MacroDictionary | undefined;
let compatibility: MacroDef[] | undefined;

export function initMathLive(fontsDirectory: string) {
  MathfieldElement.fontsDirectory = fontsDirectory;
  MathfieldElement.soundsDirectory = null;
}

/** Project macros as MathLive sees them when the user types a new call: rendered, never expanded on output. */
export function projectMacros(macros: readonly MacroDef[]): MacroDictionary {
  const result: MacroDictionary = {};
  for (const m of macros) {
    if (!/^[a-zA-Z]+$/.test(m.name)) { continue; }
    result[m.name] = { def: m.operator ? `\\operatorname{${m.body}}` : m.body, args: m.arity, captureSelection: true, expand: false };
  }
  return result;
}

/** Display definitions share one capability check for static markup and live fields. */
export function displayMacros(macros: readonly MacroDef[], overrides: readonly MacroDef[] = []): MacroDef[] {
  return renderDefinitions(macros, overrides, knowsCommand);
}

const knownCommands = new Map<string, boolean>();
function knowsCommand(name: string): boolean {
  let known = knownCommands.get(name);
  if (known === undefined) {
    // Missing arguments are harmless here: only an unknown-command error means
    // the command needs compatibility support. Probe without compatibility aliases.
    known = !validateLatex(`\\${name}`, { macros: builtInMacros() } as never)
      .some(error => error.code === 'unknown-command' && error.arg === `\\${name}`);
    knownCommands.set(name, known);
  }
  return known;
}

/** Command names (without backslash) MathLive does not know, given the extra macros. */
export function unknownCommands(latex: string, macros: MacroDictionary): Set<string> {
  const names = new Set<string>();
  for (const e of validateLatex(latex, { macros: { ...defaultMacros(), ...macros } } as never)) {
    if (e.code === 'unknown-command' && e.arg && /^\\[a-zA-Z]+$/.test(e.arg)) { names.add(e.arg.slice(1)); }
  }
  return names;
}

export function staticMarkup(latex: string, macros: MacroDictionary, display: boolean): string {
  try {
    return convertLatexToMarkup(latex, { macros: { ...defaultMacros(), ...macros }, defaultMode: display ? 'math' : 'inline-math' } as never);
  } catch {
    return '';
  }
}

function defaultMacros(): MacroDictionary {
  compatibility ??= renderDefinitions([], [], knowsCommand);
  return { ...builtInMacros(), ...projectMacros(compatibility) };
}

function builtInMacros(): MacroDictionary {
  if (!defaults) {
    // A field's options are only readable once it is mounted.
    const probe = new MathfieldElement();
    probe.style.display = 'none';
    document.body.append(probe);
    defaults = { ...(probe.macros as unknown as MacroDictionary) };
    probe.remove();
  }
  return defaults;
}

/** A hidden field used to canonicalise candidate sources under the same macros as the live field. */
export class Canonicalizer {
  private field = new MathfieldElement();
  private key = '';
  constructor() {
    this.field.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden';
    document.body.append(this.field);
    this.field.mathVirtualKeyboardPolicy = 'manual';
  }
  configure(macros: MacroDictionary) {
    const key = JSON.stringify(macros);
    if (key === this.key) { return; }
    this.key = key;
    this.field.macros = { ...defaultMacros(), ...macros } as never;
  }
  canon = (latex: string): string | undefined => {
    try {
      this.field.setValue(latex, { silenceNotifications: true, mode: 'math' } as never);
      return this.field.errors.length ? undefined : serializeWithoutPlaceholders(this.field.getValue('latex-without-placeholders'));
    } catch { return undefined; }
  };
  dispose() { this.field.remove(); }
}

export interface FieldEvents {
  input(): void;
  moveOut(direction: 'forward' | 'backward' | 'upward' | 'downward'): void;
  escape(): void;
  blur(): void;
  copy(cut: boolean, event: ClipboardEvent): void;
  complete?(prefix: string): void;
  focus?(): void;
  editIsland?(token: string): void;
}

/** Input held while MathLive's asynchronous focus has not reached its keyboard sink. */
export type BufferedMathInput =
  | { kind: 'key'; key: KeyboardEventInit; input?: InputEventInit }
  | { kind: 'input'; input: InputEventInit };

/** Replay through MathLive's keyboard/input listeners, preserving shortcuts and source ownership. */
export function replayMathInput(element: HTMLElement, buffered: BufferedMathInput): void {
  let sink = element;
  while (sink.shadowRoot?.activeElement instanceof HTMLElement) { sink = sink.shadowRoot.activeElement; }
  const options = { bubbles: true, composed: true, cancelable: true };
  let input: InputEventInit | undefined;
  if (buffered.kind === 'key') {
    const key = new KeyboardEvent('keydown', { ...buffered.key, ...options });
    if (!sink.dispatchEvent(key)) { return; }
    input = buffered.input;
    if (!input && !key.ctrlKey && !key.metaKey && [...key.key].length === 1) {
      input = { data: key.key, inputType: 'insertText' };
    }
  } else { input = buffered.input; }
  if (!input) { return; }
  // Accessibility input may supply deletion without a preceding keydown.
  if (buffered.kind === 'input' && /^deleteContent(?:Backward|Forward)$/.test(input.inputType ?? '')) {
    sink.dispatchEvent(new KeyboardEvent('keydown', { ...options,
      key: input.inputType === 'deleteContentBackward' ? 'Backspace' : 'Delete' }));
    return;
  }
  if (sink.dispatchEvent(new InputEvent('beforeinput', { ...input, ...options }))) {
    sink.dispatchEvent(new InputEvent('input', { ...input, ...options, cancelable: false }));
  }
}

export interface InlineMathCommand {
  text(): string;
  selectionKey(): string;
  atEnd(): boolean;
  selectAll(): void;
  restore(): void;
  dispose(): void;
}

const inlineCommands = new WeakSet<MathfieldElement>();

/** A native LaTeX group keeps command editing and its caret inside the formula. */
export function startInlineMathCommand(element: HTMLElement, prefix: string, events: {
  input(): void;
  keydown(event: KeyboardEvent): void;
  composition(active: boolean): void;
  blur(): void;
  leave(): void;
}): InlineMathCommand | undefined {
  if (!(element instanceof MathfieldElement)) { return; }
  const field = element, controller = new AbortController(), { signal } = controller;
  const value = field.getValue('latex'), selection = field.selection, mode = field.mode;
  let suffix = 0;
  let initialising = true, composing = false, compositionRange: [number, number] | undefined, latest = prefix;
  let from = 0;
  const text = () => {
    if (field.mode === 'latex') { latest = field.getValue(from, Math.max(from, field.lastOffset - suffix - 1), 'latex'); }
    return latest;
  };
  inlineCommands.add(field);
  const owns = (event: Event) => event.composedPath().includes(field);
  const on = (name: string, listener: EventListener) => field.addEventListener(name, listener, { signal });
  field.addEventListener('keydown', event => { if (!composing) { events.keydown(event); } }, { capture: true, signal });
  on('input', () => { if (!initialising && !composing) { text(); events.input(); } });
  on('selection-change', () => {
    if (initialising || composing) { return; }
    // MathLive's input notification is deferred, but selection-change is
    // synchronous. Capture the final brace before native parsing removes this
    // group and changes all offsets.
    if (field.mode === 'latex') { text(); }
    else { events.leave(); }
  });
  on('blur', () => events.blur());
  // Handle composition before the normal math/text IME adapter. A command is
  // literal LaTeX, so intermediate input must stay in this native LaTeX group.
  document.addEventListener('compositionstart', event => {
    if (!owns(event)) { return; }
    composing = true; compositionRange = [...field.selection.ranges[0]!] as [number, number];
    events.composition(true); event.stopImmediatePropagation();
  }, { capture: true, signal });
  const compose = (text: string) => {
    if (!compositionRange) { return; }
    field.selection = { ranges: [compositionRange] };
    const start = Math.min(...compositionRange);
    field.insert(text, { mode: 'latex', format: 'latex', silenceNotifications: true, selectionMode: 'after' });
    compositionRange = [start, field.position];
    events.input();
  };
  document.addEventListener('compositionupdate', event => {
    if (!owns(event) || !composing) { return; }
    compose(event.data); event.stopImmediatePropagation();
  }, { capture: true, signal });
  document.addEventListener('compositionend', event => {
    if (!owns(event) || !composing) { return; }
    compose(event.data); composing = false; compositionRange = undefined;
    const sink = field.shadowRoot?.querySelector<HTMLElement>('[part="keyboard-sink"]');
    if (sink) { sink.textContent = ''; }
    events.composition(false); event.stopImmediatePropagation();
  }, { capture: true, signal });
  document.addEventListener('beforeinput', event => {
    if (!owns(event) || !composing) { return; }
    if (event.data !== null) { compose(event.data); }
    event.preventDefault(); event.stopImmediatePropagation();
  }, { capture: true, signal });
  document.addEventListener('input', event => {
    if (owns(event) && composing) { event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  document.addEventListener('keydown', event => {
    if (owns(event) && (composing || event.isComposing)) { event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  // Replace the saved selection only in the temporary visual model. The source
  // owner retains that original selection until acceptance or cancellation.
  if (!field.selectionIsCollapsed) {
    field.insert('', { mode: 'math', format: 'latex', silenceNotifications: true, selectionMode: 'after' });
  }
  // Deleting a structural selection can also remove its fraction/array group.
  // Count the surviving suffix after deletion rather than in the saved model.
  suffix = field.lastOffset - field.position;
  field.mode = 'latex';
  from = field.position;
  if (prefix) { field.insert(prefix, { mode: 'latex', format: 'latex', silenceNotifications: true, selectionMode: 'after' }); }
  field.classList.add('omt-math-command');
  initialising = false;
  let disposed = false;
  const dispose = () => {
    if (disposed) { return; }
    disposed = true; controller.abort(); inlineCommands.delete(field); field.classList.remove('omt-math-command');
    if (composing) {
      composing = false;
      field.dispatchEvent(new CustomEvent('omt-composition-cancel', { bubbles: true, composed: true }));
    }
  };
  return {
    text,
    selectionKey: () => JSON.stringify(field.selection),
    atEnd: () => field.selectionIsCollapsed && field.position === field.lastOffset - suffix - 1,
    selectAll: () => { field.selection = { ranges: [[from, Math.max(from, field.lastOffset - suffix - 1)]] }; },
    restore: () => {
      initialising = true;
      // Reject only the temporary native group before restoring the saved
      // model. Switching mode directly parses it and can leave an invalid
      // caret for unsupported commands, or accept known commands twice.
      if (field.mode === 'latex') { field.executeCommand(['complete', 'reject'] as never); }
      field.mode = mode;
      field.setValue(value, { silenceNotifications: true, mode: 'math' });
      field.selection = selection;
      initialising = false;
    },
    dispose,
  };
}

export interface LiveField {
  element: HTMLElement;
  value(): string;
  hasErrors(): boolean;
  selectedLatex(): string;
  /** Optional cursor is a LaTeX string offset, rather than a model atom offset. */
  set(latex: string, cursor?: number): void;
  setMacros(macros: MacroDictionary): void;
  focus(): void;
  reveal(): void;
  hasTemplatePrompts(): boolean;
  selectAll(): void;
  placeAfterIsland(token: string): void;
  placeAt(where: 'start' | 'end' | { x: number; y: number }): void;
  retryAtEnd(before: string, after: string): string | undefined;
  deleteSelection(): void;
  markedValue(marker: string, atCursor?: boolean): string;
  anchor(): { left: number; top: number; bottom: number };
  insertTemplate(latex: string, firstPromptId?: string): boolean;
  checkpoint(): () => void;
  setShortcuts(enabled: boolean, overrides?: Record<string, string>): void;
  islandAt(where?: { x: number; y: number }): string | undefined;
  islandAnchor(token: string): { left: number; top: number; bottom: number };
  dispose(): void;
}

/** Create a math field inside `parent`; most options can only be set once it is mounted. */
const SHORTCUTS = { '->': '\\to', '>=': '\\ge', '<=': '\\le', '!=': '\\ne', '+-': '\\pm', '...': '\\ldots' };
let cursorProbe: MathfieldElement | undefined;

/** Reveal the caret in our own scroller, without scrolling the Webview's ancestors. */
function containFieldScrolling(field: MathfieldElement, signal: AbortSignal): void {
  let frame = 0;
  const delta = (start: number, end: number, low: number, high: number) => {
    // An oversized atom already spanning the viewport cannot be fully revealed.
    if (start <= low && end >= high) { return 0; }
    return start < low ? start - low : end > high ? end - high : 0;
  };
  field.onScrollIntoView = () => {
    cancelAnimationFrame(frame);
    const scroller = field.closest<HTMLElement>('.cm-scroller, .omt-macro-args');
    if (!scroller) { return; }
    const scrollTop = scroller.scrollTop, scrollLeft = scroller.scrollLeft;
    // MathLive requests scrolling before rendering the newly inserted atom.
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (signal.aborted || !field.isConnected || !field.hasFocus()) { return; }
      // Respect scrolling that occurred after the input requested this reveal.
      if (scroller.scrollTop !== scrollTop || scroller.scrollLeft !== scrollLeft) { return; }
      const viewport = scroller.getBoundingClientRect();
      const top = viewport.top + scroller.clientTop, left = viewport.left + scroller.clientLeft;
      const fieldBounds = field.getBoundingClientRect();
      // A fully visible field needs no outer scrolling, even if atom bounds lag.
      if (fieldBounds.top >= top && fieldBounds.bottom <= top + scroller.clientHeight &&
          fieldBounds.left >= left && fieldBounds.right <= left + scroller.clientWidth) { return; }
      const bounds = field.getElementInfo(field.position)?.bounds;
      const caret = bounds ?? fieldBounds;
      // Missing atom bounds must not pull a partly visible, tall field into view.
      if (!bounds && caret.bottom > top && caret.top < top + scroller.clientHeight &&
          caret.right > left && caret.left < left + scroller.clientWidth) { return; }
      const dy = delta(caret.top, caret.bottom, top, top + scroller.clientHeight);
      const dx = delta(caret.left, caret.right, left, left + scroller.clientWidth);
      if (dy) { scroller.scrollTop += dy; }
      if (dx) { scroller.scrollLeft += dx; }
    });
  };
  signal.addEventListener('abort', () => cancelAnimationFrame(frame), { once: true });
}

export function createField(parent: HTMLElement, display: boolean, macros: MacroDictionary, inlineShortcuts: boolean, events: FieldEvents, overrides?: Record<string, string>): LiveField {
  const field = new MathfieldElement();
  const abort = new AbortController();
  parent.replaceChildren(field);
  field.defaultMode = display ? 'math' : 'inline-math';
  field.mathVirtualKeyboardPolicy = 'manual';
  field.popoverPolicy = 'off';
  field.smartFence = false;
  field.menuItems = [];
  containFieldScrolling(field, abort.signal);
  const shortcuts = (enabled: boolean, custom?: Record<string, string>) => { field.inlineShortcuts = enabled ? { ...SHORTCUTS, ...custom } : {}; };
  shortcuts(inlineShortcuts, overrides);
  field.macros = { ...defaultMacros(), ...macros } as never;
  const ime = attachMathIME(field, abort.signal, () => events.input());
  const on = (name: string, fn: (event: Event) => void) => field.addEventListener(name, fn, { signal: abort.signal });
  let pointerStartedHere = false;
  on('pointerdown', () => { pointerStartedHere = true; });
  on('pointercancel', () => { pointerStartedHere = false; });
  // Expanded MacroAtom children have no bounds, and point-to-offset can return
  // their previous atom. Only the atomic token's rendered bounds identify a hit.
  const islandInfo = (where?: { x: number; y: number }, token?: string) => {
    for (let offset = 0; offset <= field.lastOffset; offset++) {
      const info = field.getElementInfo(offset), b = info?.bounds;
      if (!info || !b || !/^\\OMT[a-z]+$/.test(info.latex ?? '')) { continue; }
      if (token ? info.latex === token : where ? where.x >= b.left && where.x <= b.right && where.y >= b.top && where.y <= b.bottom : offset === field.position) { return info; }
    }
    return undefined;
  };
  on('pointerup', event => {
    const e = event as PointerEvent;
    const startedHere = pointerStartedHere; pointerStartedHere = false;
    // The first click replaces static markup with this field during mousedown.
    // Its pointerup only finishes activation; a subsequent field click edits a macro.
    if (!startedHere || e.button !== 0 || !events.editIsland) { return; }
    const token = islandInfo({ x: e.clientX, y: e.clientY })?.latex;
    if (token) { events.editIsland(token); }
  });
  on('input', () => { if (!ime.composing) { events.input(); } });
  on('move-out', event => { event.preventDefault(); events.moveOut((event as CustomEvent).detail.direction); });
  on('focus-out', event => { event.preventDefault(); events.moveOut((event as CustomEvent).detail.direction === 'backward' ? 'backward' : 'forward'); });
  on('blur', () => events.blur());
  on('focus', () => events.focus?.());
  // CodeMirror cannot observe selection changes inside a math-field's shadow root.
  for (const name of ['selection-change', 'focus']) {
    on(name, () => field.dispatchEvent(new CustomEvent('omt-math-selection', { bubbles: true })));
  }
  on('keydown', event => {
    const e = event as KeyboardEvent, key = e.key;
    if (e.isComposing || ime.composing) { return; }
    if (key === 'Escape') { event.preventDefault(); event.stopPropagation(); events.escape(); }
  });
  field.addEventListener('keydown', event => {
    if (inlineCommands.has(field)) { return; }
    if (event.key === 'ArrowRight' && event.metaKey && !event.shiftKey && insideEnvironment()) {
      event.preventDefault(); event.stopImmediatePropagation(); placeAt('end'); return;
    }
    if (event.key === 'Enter' && event.altKey && events.editIsland) {
      const token = islandInfo()?.latex;
      if (token) { event.preventDefault(); event.stopImmediatePropagation(); events.editIsland(token); return; }
    }
    if (event.isComposing || event.altKey || !events.complete) { return; }
    if (event.key === '\\' && !event.ctrlKey && !event.metaKey || event.code === 'Space' && event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopImmediatePropagation(); events.complete(event.key === '\\' ? '\\' : '');
    }
  }, { capture: true, signal: abort.signal });
  // IME and accessibility input can insert text without a keydown.
  field.addEventListener('beforeinput', event => {
    const input = event as InputEvent;
    if (input.data === '\\' && events.complete && !inlineCommands.has(field)) { input.preventDefault(); input.stopImmediatePropagation(); events.complete('\\'); }
  }, { capture: true, signal: abort.signal });
  for (const name of ['copy', 'cut']) {
    field.addEventListener(name, event => { events.copy(name === 'cut', event as ClipboardEvent); }, { capture: true, signal: abort.signal });
  }
  const insideEnvironment = () => /^\\begin\{/.test(field.getValue('latex'));
  const endPosition = () => {
    let offset = insideEnvironment() ? Math.max(1, field.lastOffset - 1) : field.lastOffset;
    // MathLive wraps a cell-wide style declaration in a synthetic GroupAtom.
    // Its outer end would place new input outside the source's style scope.
    while (offset > 1) {
      const info = field.getElementInfo(offset), previous = field.getElementInfo(offset - 1);
      if (!/^\\(?:display|text|script|scriptscript)style\b/.test(info?.latex ?? '') || (previous?.depth ?? 0) <= (info?.depth ?? 0)) { break; }
      offset--;
    }
    return offset;
  };
  const placeAt = (where: 'start' | 'end' | { x: number; y: number }) => {
    const start = insideEnvironment() ? 1 : 0, end = endPosition();
    if (where === 'start') { field.position = start; }
    else if (where === 'end') { field.position = end; }
    else {
      const offset = field.getOffsetFromPoint(where.x, where.y, { bias: 0 });
      field.position = offset >= 0 ? Math.max(start, Math.min(end, offset)) : end;
    }
  };
  return {
    element: field,
    value: () => serializeWithoutPlaceholders(ime.value() ?? field.getValue('latex-without-placeholders')),
    hasErrors: () => field.errors.length > 0,
    selectedLatex: () => serializeWithoutPlaceholders(field.getValue(field.selection, 'latex-without-placeholders')),
    set: (latex, cursor) => {
      const position = field.position;
      if (cursor !== undefined) {
        // Reloading source changes atom offsets. A temporary atomic marker puts
        // the caret back in its actual fraction/array branch using public APIs.
        const marker = '\\OMTInputCursor', macros = field.macros;
        field.macros = { ...macros, OMTInputCursor: { def: 'x', args: 0, captureSelection: true, expand: false } };
        field.setValue(latex.slice(0, cursor) + marker + ' ' + latex.slice(cursor), { silenceNotifications: true, mode: 'math' });
        let found = false;
        for (let offset = 1; offset <= field.lastOffset; offset++) {
          const info = field.getElementInfo(offset);
          if (info?.latex !== marker) { continue; }
          // Macro expansion children occupy offsets too. Select the whole
          // marker from its preceding sibling, rather than just its last child.
          let before = offset - 1;
          while (before > 0 && (field.getElementInfo(before)?.depth ?? 0) > (info.depth ?? 0)) { before--; }
          field.selection = { ranges: [[before, offset]] };
          field.insert('', { silenceNotifications: true, mode: 'math', format: 'latex', selectionMode: 'after' });
          found = true; break;
        }
        field.macros = macros;
        if (found) { return; }
      }
      field.setValue(latex, { silenceNotifications: true, mode: 'math' } as never);
      field.position = Math.min(position, field.lastOffset);
    },
    setMacros: macros => { field.macros = { ...defaultMacros(), ...macros } as never; },
    focus: () => {
      field.dispatchEvent(new CustomEvent('omt-focus-request', { bubbles: true, composed: true }));
      field.focus();
    },
    reveal: () => { field.executeCommand('scrollIntoView'); },
    // Read the model synchronously: rendered prompt elements can lag behind
    // the keystroke which filled the preceding template slot.
    hasTemplatePrompts: () => field.getPrompts({ locked: false }).length > 0 || /\\placeholder(?![a-zA-Z])/.test(field.getValue('latex')),
    selectAll: () => { field.executeCommand('selectAll'); },
    placeAfterIsland: token => {
      for (let offset = 0; offset <= field.lastOffset; offset++) {
        const info = field.getElementInfo(offset);
        if (info?.latex === token) { field.position = offset; return; }
      }
    },
    placeAt,
    retryAtEnd: (before, after) => {
      const change = diffText(before, after);
      // Typing outside an array can leave text before/after its wrapper. Only
      // move new input; a structural deletion must stay in source for review.
      if (!/^\\begin\{/.test(before) || !change || change.from !== change.to || !change.insert) { return undefined; }
      field.setValue(before, { silenceNotifications: true, mode: 'math' } as never);
      placeAt('end');
      if (!field.insert(change.insert, { silenceNotifications: true, mode: 'math', format: 'latex', selectionMode: 'after' })) { return undefined; }
      return serializeWithoutPlaceholders(field.getValue('latex-without-placeholders'));
    },
    deleteSelection: () => { field.executeCommand('deleteBackward'); },
    markedValue: (marker, atCursor = false) => {
      cursorProbe ??= new MathfieldElement();
      if (!cursorProbe.isConnected) { cursorProbe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden'; document.body.append(cursorProbe); cursorProbe.mathVirtualKeyboardPolicy = 'manual'; }
      cursorProbe.macros = { ...field.macros, [marker.slice(1)]: { def: 'x', args: 0, expand: false, captureSelection: true } };
      cursorProbe.setValue(field.getValue('latex'), { silenceNotifications: true });
      if (atCursor) { cursorProbe.position = field.position; }
      else { cursorProbe.selection = field.selection; }
      cursorProbe.insert(marker, { silenceNotifications: true, mode: 'math', selectionMode: 'after' });
      return serializeWithoutPlaceholders(cursorProbe.getValue('latex-without-placeholders'));
    },
    anchor: () => {
      const b = field.getElementInfo(field.position)?.bounds ?? field.getBoundingClientRect();
      return { left: b.right, top: b.top, bottom: b.bottom };
    },
    insertTemplate: (latex, firstPromptId) => {
      const value = field.getValue('latex'), selection = field.selection;
      const ok = field.insert(latex, { silenceNotifications: true, mode: 'math', format: 'latex', selectionMode: 'placeholder' });
      if (!ok || field.errors.length) { field.setValue(value, { silenceNotifications: true }); field.selection = selection; return false; }
      if (firstPromptId) { const range = field.getPromptRange(firstPromptId); if (range) { field.selection = { ranges: [range] }; } }
      return true;
    },
    checkpoint: () => {
      const value = field.getValue('latex'), selection = field.selection;
      return () => { field.setValue(value, { silenceNotifications: true }); field.selection = selection; };
    },
    setShortcuts: shortcuts,
    islandAt: where => islandInfo(where)?.latex,
    islandAnchor: token => {
      const b = islandInfo(undefined, token)?.bounds ?? field.getBoundingClientRect();
      return { left: b.left, top: b.top, bottom: b.bottom };
    },
    dispose: () => { abort.abort(); field.remove(); },
  };
}
