import { Compartment, Facet, Prec, StateEffect, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { StreamLanguage } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IOnigLib, type StateStack } from 'vscode-textmate';
import { createOnigScanner, createOnigString, loadWASM } from 'vscode-oniguruma';
import type { EditorSettings } from '../../shared/types.ts';
import { logToHost } from '../bridge.ts';

type BracketSettings = NonNullable<EditorSettings['tokens']['bracketPairs']>;
type Grammars = NonNullable<EditorSettings['tokens']['grammars']>;
interface Mark { from: number; to: number; className: string }
interface CommentRange { from: number; to: number }
interface LineResult<S> { end: S; marks: Mark[]; comments?: CommentRange[] }
interface CachedLine<S> extends LineResult<S> { text: string; start: S }

const syntaxCompartment = new Compartment();
const bracketCompartment = new Compartment();
const refreshed = StateEffect.define<null>();
const bracketSettings = Facet.define<BracketSettings, BracketSettings>({
  combine: values => values[0] ?? { enabled: false, independentColorPoolPerBracketType: false },
});
const fallbackLanguage = StreamLanguage.define(stex);
const SLICE_MS = 5;
// Regexes compile lazily on the first matching line. Give one line more room
// than a scheduling slice without allowing pathological input to run forever.
const LINE_LIMIT_MS = 50;

/** Both highlighters keep line states for the entire prefix, but mark only visible source. */
class IncrementalLines<S> {
  decorations: DecorationSet = Decoration.none;
  private cache: (CachedLine<S> | undefined)[] = [undefined];
  private next = 1;
  private cachedThrough = 0;
  private dirtyThrough = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  protected view: EditorView;
  private initial: S;
  private read: (text: string, previous: S, number: number) => LineResult<S> | undefined;
  private equal: (a: S, b: S) => boolean;
  private failed?: (error: unknown) => void;

  constructor(
    view: EditorView, initial: S,
    read: (text: string, previous: S, number: number) => LineResult<S> | undefined,
    equal: (a: S, b: S) => boolean, failed?: (error: unknown) => void,
  ) {
    this.view = view; this.initial = initial; this.read = read; this.equal = equal; this.failed = failed;
    this.schedule();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) {
      let first = Infinity, lastOld = 0, lastNew = 0;
      update.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
        first = Math.min(first, update.state.doc.lineAt(fromB).number);
        lastOld = Math.max(lastOld, update.startState.doc.lineAt(toA).number);
        lastNew = Math.max(lastNew, update.state.doc.lineAt(toB).number);
      });
      // Preserve suffix entries as candidates. Their input/end stacks determine
      // where propagation stops, including edits that insert or remove lines.
      const prefix = this.cache.slice(0, first);
      prefix.length = first;
      this.cache = prefix.concat(
        new Array<CachedLine<S> | undefined>(lastNew - first + 1), this.cache.slice(lastOld + 1),
      );
      this.cachedThrough = this.cachedThrough > lastOld
        ? this.cachedThrough + update.state.doc.lines - update.startState.doc.lines : Math.min(this.cachedThrough, first - 1);
      this.next = Math.min(this.next, first);
      this.dirtyThrough = Math.max(lastNew, this.dirtyThrough + update.state.doc.lines - update.startState.doc.lines);
    }
    // Short replacement widgets may leave visibleRanges unchanged. Selection
    // and mode/fallback effects still change which source is actually painted.
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.some(tr => tr.effects.length)) {
      // Keep mapped marks while changed lines are retokenized. Removing and
      // restoring an entire line's marks needlessly redraws its live widgets.
      this.draw(update.docChanged ? this.decorations.map(update.changes) : undefined);
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.destroyed || this.timer !== undefined || this.next > this.view.state.doc.lineAt(this.view.viewport.to).number) { return; }
    this.timer = setTimeout(() => { this.timer = undefined; this.work(); }, 0);
  }

  private work(): void {
    if (this.destroyed) { return; }
    const doc = this.view.state.doc;
    const target = doc.lineAt(this.view.viewport.to).number;
    const deadline = performance.now() + SLICE_MS;
    const startedAt = this.next;
    try {
      do {
        if (this.next > target) { break; }
        const number = this.next, line = doc.line(number);
        const previous = this.cache[number - 1]?.end ?? this.initial;
        const old = this.cache[number];
        // Equal incoming stacks make the unchanged suffix valid immediately.
        // No tokenizeLine call is needed after the state has converged.
        if (old && number > this.dirtyThrough && old.text === line.text && this.equal(old.start, previous)) {
          // Every later cached line is untouched by this edit. Once the first
          // suffix input stack agrees, skip it without visiting each line.
          this.next = Math.max(number + 1, Math.min(target + 1, this.cachedThrough + 1));
          continue;
        } else {
          const result = this.read(line.text, previous, number);
          // A dependent bracket worker waits for this line's TextMate state.
          if (!result) { break; }
          this.cache[number] = { text: line.text, start: previous, ...result };
          this.cachedThrough = Math.max(this.cachedThrough, number);
        }
        this.next++;
      } while (performance.now() < deadline);
    } catch (error) {
      this.destroyed = true;
      this.failed?.(error);
      return;
    }
    if (this.next !== startedAt) {
      this.draw();
      // An effect lets CodeMirror collect the newly computed plugin decorations.
      // It has no document changes and never enters the source synchronization path.
      this.view.dispatch({ effects: refreshed.of(null) });
    }
    this.schedule();
  }

  private draw(previous = this.decorations): void {
    const marks: Range<Decoration>[] = [];
    const doc = this.view.state.doc;
    const hidden: { from: number; to: number }[] = [];
    // Keep syntax marks outside replacement widgets. Moving a live MathLive
    // element between a token span and its line disconnects its custom element,
    // destroying the model and focus even when CodeMirror reuses the widget DOM.
    // Tokenization still reads the complete source, including hidden formulas.
    for (const decorations of this.view.state.facet(EditorView.decorations)) {
      if (typeof decorations === 'function') { continue; }
      decorations.between(this.view.viewport.from, this.view.viewport.to, (from, to, value) => {
        if (from < to && value.spec.widget) { hidden.push({ from, to }); }
      });
    }
    hidden.sort((a, b) => a.from - b.from || a.to - b.to);
    let hiddenAt = 0;
    const addMark = (from: number, to: number, decoration: Decoration) => {
      if (from >= to) { return; }
      while (hiddenAt < hidden.length && hidden[hiddenAt]!.to <= from) { hiddenAt++; }
      let start = from;
      for (let i = hiddenAt; i < hidden.length && hidden[i]!.from < to; i++) {
        const range = hidden[i]!;
        if (start < range.from) { marks.push(decoration.range(start, Math.min(to, range.from))); }
        start = Math.max(start, range.to);
        if (start >= to) { break; }
      }
      if (start < to) { marks.push(decoration.range(start, to)); }
    };
    for (const visible of this.view.visibleRanges) {
      const first = doc.lineAt(visible.from).number, last = doc.lineAt(visible.to).number;
      for (let number = first; number <= last; number++) {
        const line = doc.line(number), cached = number < this.next ? this.cache[number] : undefined;
        if (!cached) {
          // Other plugins can refresh during a tokenization slice too. Retain
          // mapped marks on every pending line until its new tokens are ready.
          const from = Math.max(visible.from, line.from), to = Math.min(visible.to, line.to);
          previous.between(from, to, (start, end, decoration) => addMark(Math.max(start, from), Math.min(end, to), decoration));
          continue;
        }
        for (const mark of cached.marks) {
          const from = Math.max(visible.from, line.from + mark.from), to = Math.min(visible.to, line.from + mark.to);
          addMark(from, to, Decoration.mark({ class: mark.className }));
        }
      }
    }
    this.decorations = Decoration.set(marks, true);
  }

  destroy(): void { this.destroyed = true; clearTimeout(this.timer); }

  line(number: number, text: string): CachedLine<S> | undefined {
    const value = number < this.next ? this.cache[number] : undefined;
    return value?.text === text ? value : undefined;
  }
}

interface Runtime { registry: Registry; grammar: IGrammar; key: string; themeKey?: string; highlighter?: IncrementalLines<StateStack> }
interface Controller {
  view: EditorView;
  settings?: EditorSettings;
  runtime?: Runtime;
  pending?: { key: string; promise: Promise<Runtime> };
  failedKey?: string;
  bracketKey?: string;
  destroyed: boolean;
}
const controllers = new WeakMap<EditorView, Controller>();
let oniguruma: Promise<IOnigLib> | undefined;

function controller(view: EditorView): Controller {
  let value = controllers.get(view);
  if (!value) { value = { view, destroyed: false }; controllers.set(view, value); }
  return value;
}

function onigLib(): Promise<IOnigLib> {
  return oniguruma ??= (async () => {
    const uri = document.body.dataset.onigWasm;
    if (!uri) { throw new Error('Oniguruma WASM resource is unavailable'); }
    const response = await fetch(uri);
    if (!response.ok) { throw new Error(`Oniguruma WASM request failed (${response.status})`); }
    // arrayBuffer also works when a webview resource has a generic content type.
    await loadWASM(await response.arrayBuffer());
    return { createOnigScanner, createOnigString };
  })();
}

async function loadRuntime(grammars: Grammars, key: string): Promise<Runtime> {
  const available = new Map(grammars.map(value => [value.scopeName, value]));
  const onig = await onigLib();
  const registry = new Registry({
    onigLib: Promise.resolve(onig),
    async loadGrammar(scope) {
      // The Workshop LaTeX/TeX pair is the only supported language set. Embedded
      // Python, C++, etc. deliberately do not load extensions into the webview.
      if (scope !== 'text.tex.latex' && scope !== 'text.tex') { return null; }
      const source = available.get(scope);
      if (!source) { return null; }
      return parseRawGrammar(source.content, source.format === 'json' ? 'grammar.json' : 'grammar.tmLanguage');
    },
  });
  try {
    const grammar = await registry.loadGrammar('text.tex.latex');
    if (!grammar) { throw new Error('Workshop LaTeX grammar is unavailable'); }
    return { registry, grammar, key };
  } catch (error) { registry.dispose(); throw error; }
}

function foreground(view: EditorView): string {
  const color = getComputedStyle(view.dom).color;
  const rgb = /^rgba?\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)/.exec(color);
  return rgb ? '#' + rgb.slice(1, 4).map(value => Number(value).toString(16).padStart(2, '0')).join('') : '#000000';
}

function textmateExtension(runtime: Runtime, failed: (error: unknown) => void): Extension {
  const plugin = ViewPlugin.fromClass(class extends IncrementalLines<StateStack> {
    constructor(view: EditorView) {
      super(view, INITIAL, (text, previous) => {
        const result = runtime.grammar.tokenizeLine2(text, previous, LINE_LIMIT_MS);
        if (result.stoppedEarly) { throw new Error('TextMate line exceeded its tokenization time budget'); }
        const marks: Mark[] = [];
        const comments: CommentRange[] = [];
        for (let i = 0; i < result.tokens.length; i += 2) {
          const from = result.tokens[i], to = Math.min(text.length, result.tokens[i + 2] ?? text.length);
          const metadata = result.tokens[i + 1];
          if (((metadata >>> 8) & 0x3) === 1) { comments.push({ from, to }); }
          const color = (metadata >>> 15) & 0x1ff, style = (metadata >>> 11) & 0xf;
          const className = `tm-c${color}${style & 1 ? ' tm-i' : ''}${style & 2 ? ' tm-b' : ''}${style & 4 ? ' tm-u' : ''}${style & 8 ? ' tm-s' : ''}`;
          if (from < to) { marks.push({ from, to, className }); }
        }
        return { end: result.ruleStack, marks, comments };
      }, (a, b) => a.equals(b), failed);
      runtime.highlighter = this;
    }
    destroy(): void { if (runtime.highlighter === this) { runtime.highlighter = undefined; } super.destroy(); }
  }, { decorations: value => value.decorations });
  const styles: Record<string, { color?: string; fontStyle?: string; fontWeight?: string; textDecoration?: string }> = {
    '[class*="tm-c"]': { fontStyle: 'normal', fontWeight: 'inherit', textDecoration: 'none' },
    '.tm-i': { fontStyle: 'italic' }, '.tm-b': { fontWeight: 'bold' },
    '.tm-u': { textDecoration: 'underline' }, '.tm-s': { textDecoration: 'line-through' },
    '.tm-u.tm-s': { textDecoration: 'underline line-through' },
  };
  runtime.registry.getColorMap().forEach((color, index) => {
    // Only colors produced by TextMate become CSS, never arbitrary grammar text.
    if (/^#[\da-f]{6}([\da-f]{2})?$/i.test(color)) { styles[`.tm-c${index}`] = { color }; }
  });
  return [plugin, EditorView.theme(styles)];
}

function fallback(value: Controller, error?: unknown): void {
  if (value.destroyed) { return; }
  value.view.dispatch({ effects: syntaxCompartment.reconfigure(fallbackLanguage) });
  value.view.dom.dataset.omtSyntax = 'fallback';
  value.runtime?.registry.dispose(); value.runtime = undefined;
  configureBrackets(value);
  if (error) { logToHost('warn', `TextMate highlighting fell back to stex: ${String(error)}`); }
}

function activate(value: Controller, runtime: Runtime): void {
  if (value.destroyed || !value.settings) { return; }
  const theme = value.settings.tokens.tokenColors ?? [];
  const defaultColor = foreground(value.view), themeKey = JSON.stringify([defaultColor, theme]);
  if (runtime.themeKey === themeKey && value.view.dom.dataset.omtSyntax === 'textmate') { return; }
  // Registry.setTheme invalidates all old rule stacks, so recreate the line
  // plugin after a theme change while retaining the compiled grammar registry.
  runtime.registry.setTheme({ settings: [{ settings: { foreground: defaultColor } }, ...theme.map(rule => ({ ...rule, settings: rule.settings ?? {} }))] });
  runtime.themeKey = themeKey;
  value.view.dispatch({ effects: syntaxCompartment.reconfigure(textmateExtension(runtime, error => {
    if (value.runtime !== runtime) { return; }
    value.failedKey = runtime.key; fallback(value, error);
  })) });
  configureBrackets(value, true);
  value.view.dom.dataset.omtSyntax = 'textmate';
}

/** Called after the settings compartment refresh, including the initial document. */
export function configureTextMate(view: EditorView, settings: EditorSettings): void {
  const value = controller(view);
  value.settings = settings;
  configureBrackets(value);
  const grammars = settings.tokens.grammars;
  if (!grammars?.some(grammar => grammar.scopeName === 'text.tex.latex')) {
    value.pending = undefined; fallback(value); return;
  }
  const key = JSON.stringify(grammars);
  if (value.runtime?.key === key) {
    try { activate(value, value.runtime); } catch (error) { value.failedKey = key; fallback(value, error); }
    return;
  }
  if (value.pending?.key === key) { return; }
  if (value.failedKey === key) { value.pending = undefined; fallback(value); return; }
  fallback(value);
  view.dom.dataset.omtSyntax = 'loading';
  const pending = { key, promise: loadRuntime(grammars, key) };
  value.pending = pending;
  void pending.promise.then(runtime => {
    if (value.destroyed || value.pending !== pending) { runtime.registry.dispose(); return; }
    value.pending = undefined; value.runtime = runtime;
    try { activate(value, runtime); } catch (error) { value.failedKey = key; fallback(value, error); }
  }).catch(error => {
    if (value.destroyed || value.pending !== pending) { return; }
    value.pending = undefined; value.failedKey = key; fallback(value, error);
  });
}

interface BracketState { opens: string; depths: [number, number, number]; grammarStack?: StateStack }
function bracketLine(text: string, previous: BracketState, independent: boolean, comments?: CommentRange[]): { end: BracketState; marks: Mark[] } {
  const opens = previous.opens.split(''), depths: [number, number, number] = [...previous.depths];
  const marks: Mark[] = [];
  let commentIndex = 0;
  for (let i = 0; i < text.length; i++) {
    while (comments && commentIndex < comments.length && comments[commentIndex].to <= i) { commentIndex++; }
    const comment = comments?.[commentIndex];
    if (comment && comment.from <= i) { i = comment.to - 1; continue; }
    const char = text[i];
    // A TeX control symbol consumes the next character. This correctly treats
    // both escaped brackets/comments and an even run of backslashes.
    if (char === '\\') { i++; continue; }
    if (!comments && char === '%') { break; }
    const openType = '{[('.indexOf(char), closeType = '}])'.indexOf(char);
    let depth: number;
    if (openType >= 0) {
      depth = independent ? depths[openType] : opens.length;
      opens.push(char); depths[openType]++;
    } else if (closeType >= 0) {
      if (opens[opens.length - 1] !== '{[('[closeType]) {
        marks.push({ from: i, to: i + 1, className: 'omt-bracket-unexpected' }); continue;
      }
      opens.pop(); depths[closeType]--;
      depth = independent ? depths[closeType] : opens.length;
    } else { continue; }
    marks.push({ from: i, to: i + 1, className: `omt-bracket-${depth % 6 + 1}` });
  }
  return { end: { opens: opens.join(''), depths }, marks };
}

function bracketPlugin(runtime?: Runtime): Extension {
  return Prec.high(ViewPlugin.fromClass(class extends IncrementalLines<BracketState> {
    constructor(view: EditorView) {
      const independent = view.state.facet(bracketSettings).independentColorPoolPerBracketType;
      super(view, { opens: '', depths: [0, 0, 0] }, (text, previous, number) => {
        const tokenLine = runtime?.highlighter?.line(number, text);
        if (runtime && !tokenLine) { return undefined; }
        const result = bracketLine(text, previous, independent, tokenLine?.comments);
        result.end.grammarStack = tokenLine?.end;
        return result;
      }, (a, b) => a.opens === b.opens && (a.grammarStack === b.grammarStack
        || !!a.grammarStack && !!b.grammarStack && a.grammarStack.equals(b.grammarStack)));
    }
  }, { decorations: value => value.decorations }));
}

function configureBrackets(value: Controller, force = false): void {
  if (value.destroyed || !value.settings) { return; }
  const brackets = value.settings.tokens.bracketPairs ?? { enabled: false, independentColorPoolPerBracketType: false };
  const key = JSON.stringify([brackets, value.runtime?.key]);
  if (!force && value.bracketKey === key) { return; }
  value.bracketKey = key;
  value.view.dispatch({ effects: bracketCompartment.reconfigure([
    bracketSettings.of(brackets), ...(brackets.enabled ? [bracketPlugin(value.runtime)] : []),
  ]) });
}

const bracketStyles = EditorView.baseTheme(Object.fromEntries([
  ...Array.from({ length: 6 }, (_, index) => [`.omt-bracket-${index + 1}`, { color: `var(--vscode-editorBracketHighlight-foreground${index + 1}, var(--vscode-editor-foreground)) !important` }]),
  ['.omt-bracket-unexpected', { color: 'var(--vscode-editorBracketHighlight-unexpectedBracket-foreground, var(--vscode-editor-foreground)) !important' }],
]));

export function textmateExtensions(): Extension[] {
  return [syntaxCompartment.of(fallbackLanguage), bracketCompartment.of([]), bracketStyles,
    ViewPlugin.define(view => {
      const value = controller(view);
      return { destroy() { value.destroyed = true; value.pending = undefined; value.runtime?.registry.dispose(); } };
    }),
  ];
}
