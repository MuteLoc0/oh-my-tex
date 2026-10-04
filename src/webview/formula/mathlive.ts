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

export interface LiveField {
  element: HTMLElement;
  value(): string;
  hasErrors(): boolean;
  selectedLatex(): string;
  set(latex: string): void;
  setMacros(macros: MacroDictionary): void;
  focus(): void;
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

export function createField(parent: HTMLElement, display: boolean, macros: MacroDictionary, inlineShortcuts: boolean, events: FieldEvents, overrides?: Record<string, string>): LiveField {
  const field = new MathfieldElement();
  const abort = new AbortController();
  parent.replaceChildren(field);
  field.defaultMode = display ? 'math' : 'inline-math';
  field.mathVirtualKeyboardPolicy = 'manual';
  field.popoverPolicy = 'off';
  field.smartFence = false;
  field.menuItems = [];
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
    if (input.data === '\\' && events.complete) { input.preventDefault(); input.stopImmediatePropagation(); events.complete('\\'); }
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
    set: latex => {
      const position = field.position;
      field.setValue(latex, { silenceNotifications: true, mode: 'math' } as never);
      field.position = Math.min(position, field.lastOffset);
    },
    setMacros: macros => { field.macros = { ...defaultMacros(), ...macros } as never; },
    focus: () => {
      field.dispatchEvent(new CustomEvent('omt-focus-request', { bubbles: true, composed: true }));
      field.focus();
    },
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
