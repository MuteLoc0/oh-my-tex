import { Annotation, EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from '@codemirror/view';
import { cursorLineDown, cursorLineUp } from '@codemirror/commands';
import { searchPanelOpen } from '@codemirror/search';
import { scanFormulas, type FormulaSpan } from '../../core/formulaScanner.ts';
import { diffText } from '../../core/patch.ts';
import { reconcile } from '../../core/writeback.ts';
import { restoreIslands } from '../../core/islands.ts';
import { Canonicalizer, createField, staticMarkup, unknownCommands, type LiveField } from '../formula/mathlive.ts';
import { parseMacroCalls, type MacroCall } from '../../core/macroCalls.ts';
import { completedMacroCall, isMacroCompletionSource } from '../../core/macroCompletion.ts';
import { MacroArgEditor } from '../macro/argEditor.ts';
import { macroContext, project, type MacroContext, type Projection } from '../formula/projection.ts';
import { editKind } from './annotations.ts';
import type { Change, Patch } from '../../shared/types.ts';
import type { MathCompletion, MathCompletionTarget } from '../completion/mathCompletion.ts';
import { sourceCursor } from '../formula/sourcePosition.ts';
import { hasMathModeCJK } from '../../core/mathText.ts';

/** Transactions produced by a math field; its own widget must not reload from them. */
const mathEdit = Annotation.define<boolean>();
const refresh = StateEffect.define<null>();
const toggleSource = StateEffect.define<null>();
const sourceFallback = StateEffect.define<{ from: number; reason: string }>();

let context: MacroContext = macroContext(-1, []);
let inlineShortcuts = true;
let shortcutOverrides: Record<string, string> | undefined;
let completion: MathCompletion | undefined;
let canonicalizer: Canonicalizer | undefined;
let active: FormulaSession | undefined;

export function setMacroContext(view: EditorView, next: MacroContext) {
  const signature = (value: MacroContext) => JSON.stringify({
    display: [...value.defs.values()].map(({ source: _source, ...def }) => def),
    completionNames: value.completionDefs.map(def => def.name).sort(),
  });
  // Prefix writes refresh the project index too. Stable definitions keep the field
  // and its selection alive even when contextVersion/source offsets have changed.
  if (signature(context) === signature(next)) { context = next; return; }
  completion?.cancel();
  active?.closeArgs(false);
  context = next;
  markupCache.clear();
  active?.reproject();
  view.dispatch({ effects: refresh.of(null) });
}
export function setMathCompletion(value: MathCompletion) { completion = value; }
export function setInlineShortcuts(value: boolean, overrides?: Record<string, string>) { inlineShortcuts = value; shortcutOverrides = overrides; active?.field.setShortcuts(value, overrides); active?.configureArgs(); }
export function toggleSourceMode(view: EditorView) { completion?.cancel(false); active?.deactivate(); view.dispatch({ effects: toggleSource.of(null) }); view.focus(); }
/** The formula being edited in a math field, as a document range. */
export function activeFormulaRange(): { from: number; to: number } | undefined { return active && { from: active.span.from, to: active.span.to }; }
export function activeFormulaCursor(): number | undefined { return active?.sourceCursor(); }
export function closeActiveFormula() { active?.deactivate(); }
export function flushFormulaInput() { active?.flushInput(); }

interface Visible { span: FormulaSpan; block: boolean }
interface FormulaState { spans: FormulaSpan[]; visible: Visible[]; decorations: DecorationSet; sourceMode: boolean; sourceFallbacks: Map<number, string>; completionEdit?: boolean }

function isBlock(state: EditorState, span: FormulaSpan): boolean {
  if (!span.display) { return false; }
  const start = state.doc.lineAt(span.from), end = state.doc.lineAt(span.to);
  return !state.doc.sliceString(start.from, span.from).trim() && !state.doc.sliceString(span.to, end.to).trim();
}

function build(state: EditorState, spans: FormulaSpan[], sourceMode: boolean): Pick<FormulaState, 'visible' | 'decorations'> {
  if (sourceMode) { return { visible: [], decorations: Decoration.none }; }
  const sel = state.selection.main;
  const ranges: Range<Decoration>[] = [];
  const visible: Visible[] = [];
  for (const span of spans) {
    if (span.sourceOnly || span.to <= span.from) { continue; }
    // The caret inside a formula shows its source, Obsidian-style.
    const inside = (p: number) => p > span.from && p < span.to;
    if (inside(sel.head) || inside(sel.anchor) || sel.from < span.from && sel.to > span.to) { continue; }
    const block = isBlock(state, span);
    const body = state.doc.sliceString(span.bodyFrom, span.bodyTo);
    ranges.push(Decoration.replace({ widget: new FormulaWidget(span, body, context.version), block }).range(span.from, span.to));
    visible.push({ span, block });
  }
  return { visible, decorations: Decoration.set(ranges, true) };
}

const formulaState = StateField.define<FormulaState>({
  create(state) {
    const spans = scanFormulas(state.doc.toString());
    return { spans, sourceMode: false, sourceFallbacks: new Map(), ...build(state, spans, false) };
  },
  update(value, tr) {
    let { spans, sourceMode, sourceFallbacks } = value;
    let rebuild = tr.selection !== undefined;
    if (tr.docChanged) {
      spans = scanFormulas(tr.newDoc.toString());
      const mapped = new Map<number, string>();
      for (const [from, reason] of sourceFallbacks) {
        const previous = value.spans.find(span => span.from === from);
        if (!previous) { continue; }
        const start = tr.changes.mapPos(previous.from, 1), end = tr.changes.mapPos(previous.to, -1);
        // A deleted/replaced formula must not hand its refusal to an adjacent
        // formula which moves into the same offset. Match both mapped boundaries.
        if (start < end && spans.some(span => span.from === start && span.to === end)) { mapped.set(start, reason); }
      }
      sourceFallbacks = mapped;
      rebuild = true;
    }
    for (const e of tr.effects) {
      if (e.is(toggleSource)) { sourceMode = !sourceMode; rebuild = true; }
      if (e.is(refresh)) { rebuild = true; }
      if (e.is(sourceFallback)) { sourceFallbacks = new Map(sourceFallbacks).set(e.value.from, e.value.reason); rebuild = true; }
    }
    if (!rebuild) { return value; }
    spans = spans.map(span => sourceFallbacks.has(span.from) ? { ...span, sourceOnly: sourceFallbacks.get(span.from) } : span);
    return { spans, sourceMode, sourceFallbacks, completionEdit: ['mathCompletionPrefix', 'mathCompletionCancel'].includes(tr.annotation(editKind) ?? ''), ...build(tr.state, spans, sourceMode) };
  },
  provide: field => [
    EditorView.decorations.from(field, v => v.decorations),
    // Search selects real source ranges, including text inside a collapsed widget.
    EditorView.atomicRanges.of(view => searchPanelOpen(view.state) ? Decoration.none : view.state.field(field).decorations),
  ],
});

const markupCache = new Map<string, string>();
function markupFor(span: FormulaSpan, body: string): string {
  const key = `${span.display ? 'D' : 'I'}${span.wrapper ?? ''}\u0000${body}`;
  let html = markupCache.get(key);
  if (html === undefined) {
    if (markupCache.size > 2000) { markupCache.clear(); }
    const p = project(span, body, context);
    html = staticMarkup(p.view, p.macros, span.display);
    markupCache.set(key, html);
  }
  return html;
}

class FormulaWidget extends WidgetType {
  readonly span: FormulaSpan;
  readonly body: string;
  readonly version: number;
  constructor(span: FormulaSpan, body: string, version: number) { super(); this.span = span; this.body = body; this.version = version; }

  eq(other: FormulaWidget) {
    return other.body === this.body && other.version === this.version && other.span.kind === this.span.kind && other.span.display === this.span.display;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom: HTMLElement = document.createElement(this.span.display ? 'div' : 'span');
    dom.className = `omt-formula ${this.span.display ? 'omt-display' : 'omt-inline'}`;
    dom.dataset.from = String(this.span.from);
    this.render(dom);
    dom.addEventListener('mousedown', event => {
      if (event.button !== 0) { return; }
      event.preventDefault();
      const span = currentSpan(view, dom);
      if (span) { activate(view, span, dom, { x: event.clientX, y: event.clientY }); }
    });
    return dom;
  }

  updateDOM(dom: HTMLElement): boolean {
    dom.dataset.from = String(this.span.from);
    if (active?.dom === dom) { active.update(this.span, this.body); return true; }
    if (dom.classList.contains('omt-display') !== this.span.display) { return false; }
    this.render(dom);
    return true;
  }

  private render(dom: HTMLElement) {
    const html = markupFor(this.span, this.body);
    dom.classList.toggle('omt-empty', !this.body.trim());
    dom.classList.toggle('omt-error', !html);
    if (html) { dom.innerHTML = html; } else { dom.textContent = this.body; }
  }

  destroy(dom: HTMLElement) { if (active?.dom === dom) { active.dispose(); } }
  ignoreEvent() { return true; }
}

/** Widgets keep their DOM across position shifts; find the span currently rendered by `dom`. */
function currentSpan(view: EditorView, dom: HTMLElement): FormulaSpan | undefined {
  const pos = view.posAtDOM(dom);
  return view.state.field(formulaState).visible.find(v => v.span.from === pos)?.span;
}

function activate(view: EditorView, span: FormulaSpan, dom: HTMLElement, where: 'start' | 'end' | { x: number; y: number }) {
  if (active?.dom === dom) { active.field.placeAt(where); active.field.focus(); return; }
  active?.deactivate();
  view.dom.querySelector('.omt-formula-notice')?.remove();
  canonicalizer ??= new Canonicalizer();
  // MathLive takes focus asynchronously; keys typed meanwhile must not land in the prose.
  view.contentDOM.blur();
  active = new FormulaSession(view, span, dom, canonicalizer);
  active.field.placeAt(where);
  active.field.focus();
}

/** One formula being edited in a live math field. */
class FormulaSession {
  readonly view: EditorView;
  span: FormulaSpan;
  readonly dom: HTMLElement;
  readonly field: LiveField;
  private canon: Canonicalizer;
  private body: string;
  private projection!: Projection;
  /** The body in island space as last written to the document. */
  private sourceView = '';
  /** The field's serialisation matching sourceView. */
  private serial = '';
  /** Unstable or invalid models may only write a verified source-aligned edit. */
  private minimalOnly = false;
  private bufferState?: { markedBody: string; marker: string; originalBody: string };
  private completionTarget: MathCompletionTarget;
  private completedCallFrom?: number;
  private restoringFocus = false;
  private argEditor?: MacroArgEditor;
  private tools = document.createElement('div');
  private abort = new AbortController();
  private scrollIntent = 0;
  private scrollAnchor?: { top: number; intent: number };

  constructor(view: EditorView, span: FormulaSpan, dom: HTMLElement, canon: Canonicalizer) {
    this.view = view; this.span = span; this.dom = dom; this.canon = canon;
    this.body = view.state.doc.sliceString(span.bodyFrom, span.bodyTo);
    this.projection = project(span, this.body, context);
    dom.classList.add('omt-live');
    this.field = createField(dom, span.display, this.projection.macros, inlineShortcuts, {
      input: () => this.onInput(),
      moveOut: direction => this.leave(direction),
      escape: () => this.toSource(),
      blur: () => setTimeout(() => { if (active === this && !this.restoringFocus && !this.argEditor?.isOpen && !completion?.ownsFocus() && !this.tools.contains(document.activeElement) && !this.dom.contains(document.activeElement) && document.activeElement !== this.field.element) { this.deactivate(); } }, 0),
      focus: () => { this.restoringFocus = false; },
      copy: (cut, event) => this.copy(cut, event),
      complete: prefix => { this.closeArgs(false); completion?.start(this.completionTarget, prefix); },
      editIsland: token => this.editIsland(token),
    }, shortcutOverrides);
    this.completionTarget = {
      element: this.field.element, macros: context.completionDefs,
      begin: () => this.beginCompletion(), buffer: prefix => this.buffer(prefix),
      anchor: () => this.field.anchor(), selectedLatex: () => restoreIslands(this.field.selectedLatex(), this.projection.islands),
      accept: (latex, firstPromptId, extras, sourceLatex) => this.acceptCompletion(latex, firstPromptId, extras, sourceLatex),
      acceptedTarget: () => {
        const from = this.completedCallFrom; this.completedCallFrom = undefined;
        if (active !== this || from === undefined) { return this.completionTarget; }
        const call = this.calls().find(call => call.from === from);
        const island = this.projection.islands.find(island => island.from === from);
        if (call && island) { this.openArgs(call, island.token); this.argEditor?.focusFirst(); }
        return this.argEditor?.completionTarget() ?? this.completionTarget;
      },
      end: () => {
        const original = this.bufferState?.originalBody;
        this.bufferState = undefined;
        // The inline command session already restored its saved live model.
        // Reproject only when the authoritative source changed meanwhile.
        if (active === this && this.body !== original) { this.reproject(); }
      },
      focus: () => {
        if (active === this) {
          if (this.argEditor?.isOpen) { this.argEditor.focus(); }
          else { this.restoringFocus = document.activeElement !== this.field.element; this.field.focus(); }
        }
      },
    };
    this.load();
    this.tools.className = 'omt-macro-tools'; document.body.append(this.tools); this.renderTools();
    window.addEventListener('resize', () => this.positionTools(), { signal: this.abort.signal });
    view.scrollDOM.addEventListener('scroll', () => this.positionTools(), { signal: this.abort.signal });
    for (const name of ['wheel', 'touchmove', 'pointerdown']) {
      // Parameter fields and completion menus live outside CodeMirror's DOM.
      // An interaction anywhere may transfer focus or scroll a floating editor.
      document.addEventListener(name, () => { this.scrollIntent++; this.scrollAnchor = undefined; }, { capture: true, passive: true, signal: this.abort.signal });
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'PageUp' || event.key === 'PageDown') { this.scrollIntent++; this.scrollAnchor = undefined; }
    }, { capture: true, signal: this.abort.signal });
  }

  private load() {
    this.canon.configure(this.projection.macros);
    this.sourceView = this.projection.view;
    this.field.set(this.sourceView);
    this.serial = this.field.value();
    this.minimalOnly = this.field.hasErrors() || this.canon.canon(this.serial) !== this.serial;
  }

  /** The macro context changed. */
  reproject() {
    this.projection = project(this.span, this.body, context);
    this.field.setMacros(this.projection.macros);
    this.load();
    this.renderTools();
  }

  /** The document changed under us: a math edit we made, undo/redo, or another editor. */
  update(span: FormulaSpan, body: string) {
    this.span = span;
    if (body === this.body) { return; }
    if (!this.view.state.field(formulaState).completionEdit) {
      // Let MathCompletion map its rollback through the remote change before
      // closing a parameter command buffer, just as the main field does.
      if (this.argEditor?.isOpen && completion?.active) { queueMicrotask(() => this.closeArgs(false)); }
      else { this.closeArgs(false); }
    }
    this.body = body;
    if (this.bufferState) { return; }
    this.projection = project(span, body, context);
    this.field.setMacros(this.projection.macros);
    this.load();
    this.renderTools();
  }

  private onInput() {
    if (this.bufferState) { return; }
    this.canon.configure(this.projection.macros);
    let after = this.field.value();
    if (hasMathModeCJK(after)) { this.rejectInput('中文输入未进入文本模式，已切换到源码模式。此次公式输入未写入。'); return; }
    let result = reconcile(this.sourceView, this.serial, after, this.canon.canon, this.projection.islands);
    let body = this.projection.restore(result.view);
    if (body === undefined) {
      const retried = this.field.retryAtEnd(this.serial, after);
      if (retried !== undefined) {
        after = retried;
        result = reconcile(this.sourceView, this.serial, after, this.canon.canon, this.projection.islands);
        body = this.projection.restore(result.view);
      }
    }
    if (body === undefined) { this.rejectInput('无法保留公式环境，已切换到源码模式。请在源码中继续编辑。'); return; }
    if (result.strategy === 'body' && (this.minimalOnly || this.field.hasErrors())) {
      this.rejectInput('此公式无法安全地保留原始格式，已切换到源码模式。此次公式输入未写入，请在源码中继续编辑。'); return;
    }
    this.sourceView = result.view;
    this.serial = after;
    const patch = diffText(this.body, body);
    this.body = body;
    if (!patch) { return; }
    const span = this.locate();
    if (!span) { return; }
    this.dispatchLocal({ from: span.bodyFrom + patch.from, to: span.bodyFrom + patch.to, insert: patch.insert }, 'math');
    this.renderTools();
  }

  /** Preserve the visual formula through every source write, including its parameters. */
  private dispatchLocal(changes: Change | Change[], kind: string) {
    const scroller = this.view.scrollDOM;
    const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
    const bounds = this.dom.getBoundingClientRect();
    // A tall formula may only be partly visible while its caret or parameter
    // editor is on screen. It needs the same protection as a short formula.
    if (!this.scrollAnchor && bounds.bottom > viewportTop && bounds.top < viewportTop + scroller.clientHeight) {
      this.scrollAnchor = { top: bounds.top - viewportTop, intent: this.scrollIntent };
    }
    const anchor = this.scrollAnchor;
    this.view.dispatch({ changes, annotations: [mathEdit.of(true), editKind.of(kind)] });
    if (!anchor) { return; }
    this.view.requestMeasure({
      key: this,
      // Rapid input can replace a queued measure request. Keep the earliest
      // pending baseline instead of capturing an intermediate scroll correction.
      read: () => anchor,
      // CodeMirror adjusts its scroll anchor after measure writes. Restore our
      // DOM position only once that cycle has completed.
      write: anchor => queueMicrotask(() => {
        if (this.scrollAnchor !== anchor) { return; }
        this.scrollAnchor = undefined;
        const focused = document.activeElement;
        if (active !== this || this.abort.signal.aborted || anchor.intent !== this.scrollIntent ||
            !(this.dom.contains(focused) || this.argEditor?.element.contains(focused) || this.tools.contains(focused) || completion?.ownsFocus() ||
              (this.restoringFocus && focused === document.body))) { return; }
        const offset = this.dom.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientTop - anchor.top;
        if (Math.abs(offset) > 0.5) { scroller.scrollTop += offset; }
        // The parameter field has its own floating scroller. Only reveal the
        // main caret when the main field currently owns keyboard focus.
        if (focused === this.field.element) { this.field.reveal(); }
        this.positionTools();
      }),
    });
  }

  private rejectInput(reason: string) {
    const span = this.locate() ?? this.span;
    // Do not deactivate/flush: that would attempt the rejected input again.
    this.dispose();
    this.view.dispatch({ effects: sourceFallback.of({ from: span.from, reason }), selection: EditorSelection.cursor(span.bodyFrom), scrollIntoView: true });
    const notice = document.createElement('div'); notice.className = 'omt-formula-notice'; notice.setAttribute('role', 'alert'); notice.textContent = reason;
    this.view.dom.querySelector('.omt-formula-notice')?.remove(); this.view.dom.append(notice);
    this.view.focus();
  }

  private calls() { return parseMacroCalls(this.body, context.defs, unknownCommands(this.body, context.dictionary)); }
  private renderTools() {
    this.tools.replaceChildren();
    for (const call of this.calls().filter(call => !call.parentId && call.args.length)) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'omt-macro-edit';
      button.textContent = `\\${call.name}`; button.title = `编辑 \\${call.name} 的参数`; button.dataset.from = String(call.from);
      button.addEventListener('click', () => this.openArgs(call)); this.tools.append(button);
    }
    this.tools.hidden = !this.tools.childElementCount || Boolean(this.argEditor?.isOpen); this.positionTools();
  }
  private positionTools() {
    const rect = this.dom.getBoundingClientRect();
    this.tools.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - this.tools.offsetWidth - 4))}px`;
    const top = rect.top - this.tools.offsetHeight - 4;
    this.tools.style.top = `${Math.max(4, top >= 4 ? top : Math.min(rect.bottom + 4, window.innerHeight - this.tools.offsetHeight - 4))}px`;
  }
  private islandCall(token: string) {
    const island = this.projection.islands.find(island => island.token === token);
    if (!island || island.kind === 'meta') { return; }
    const at = this.sourceView.indexOf(token);
    if (at < 0) { return; }
    const start = this.span.wrapper ? this.sourceView.indexOf(`\\begin{${this.span.wrapper}}`) + `\\begin{${this.span.wrapper}}`.length : 0;
    const from = restoreIslands(this.sourceView.slice(start, at), this.projection.islands).length;
    return this.calls().find(call => call.from === from);
  }
  private editIsland(token: string) {
    const call = this.islandCall(token);
    if (call?.args.length) { this.openArgs(call, token); }
  }
  private openArgs(call: MacroCall, token?: string) {
    completion?.cancel(false); this.closeArgs(false);
    this.argEditor = new MacroArgEditor({
      body: () => this.body, span: () => this.locate() ?? this.span, context: () => context,
      unknown: () => unknownCommands(this.body, context.dictionary),
      commit: (patch, extras, kind) => this.commitArgument(patch, extras, kind),
      anchor: () => token ? this.field.islandAnchor(token) : this.field.anchor(),
      focus: () => {
        if (active !== this) { return; }
        const current = this.projection.islands.find(island => island.from === call.from);
        if (current) { this.field.placeAfterIsland(current.token); }
        this.restoringFocus = document.activeElement !== this.field.element;
        if (completion) { completion.focusTarget(this.completionTarget); } else { this.field.focus(); }
      },
      closed: () => { if (active === this) { this.renderTools(); } },
      completion, shortcuts: () => ({ enabled: inlineShortcuts, overrides: shortcutOverrides }),
    }, call);
    this.tools.hidden = true;
  }
  closeArgs(focus = true) { this.argEditor?.close(focus); this.argEditor = undefined; }
  configureArgs() { this.argEditor?.configure(); }
  flushInput() { this.argEditor?.flushInput(); this.onInput(); }
  sourceCursor(): number {
    const span = this.locate() ?? this.span;
    const argument = this.argEditor?.sourceCursor();
    if (argument !== undefined) { return argument; }
    const offset = sourceCursor(this.field, this.projection, this.sourceView, this.serial, (projection, value) => {
      this.canon.configure(projection.macros); return this.canon.canon(value);
    });
    this.canon.configure(this.projection.macros);
    return span.bodyFrom + (offset ?? 0);
  }
  private commitArgument(patch: Patch | undefined, extras: Change[] = [], kind = 'macroArgument'): boolean {
    const span = this.locate();
    if (!span || patch && this.body.slice(patch.from, patch.to) !== patch.expected || !this.validExtras(span, extras)) { return false; }
    const changes = [...extras];
    if (patch) {
      this.body = this.body.slice(0, patch.from) + patch.insert + this.body.slice(patch.to);
      changes.push({ from: span.bodyFrom + patch.from, to: span.bodyFrom + patch.to, insert: patch.insert });
    }
    if (changes.length) { this.dispatchLocal(changes, kind); }
    // Rebuild the main field after each argument change. Repeated #n uses now
    // render the same new source argument, while definitions stay untouched.
    if (patch) { this.reproject(); }
    return true;
  }
  private validExtras(span: FormulaSpan, extras: Change[]) {
    if (extras.some(e => e.from < 0 || e.to < e.from || e.to > this.view.state.doc.length || e.from < span.to && e.to > span.from || e.from === e.to && e.from > span.from && e.from < span.to)) { return false; }
    const sorted = [...extras].sort((a, b) => a.from - b.from || a.to - b.to);
    return !sorted.some((e, i) => i > 0 && (e.from < sorted[i - 1]!.to || e.from === sorted[i - 1]!.from));
  }

  private beginCompletion(): boolean {
    const marker = '\\OMTCompletionCursor';
    if (this.body.includes(marker)) { return false; }
    this.canon.configure({ ...this.projection.macros, [marker.slice(1)]: { def: 'x', args: 0, expand: false, captureSelection: true } });
    const marked = this.field.markedValue(marker);
    const result = reconcile(this.sourceView, this.serial, marked, this.canon.canon, this.projection.islands);
    const markedBody = this.projection.restore(result.view);
    this.canon.configure(this.projection.macros);
    if (result.strategy === 'body' && this.minimalOnly) { this.rejectInput('此公式补全无法安全地保留原始格式，已切换到源码模式。'); return false; }
    if (markedBody === undefined || markedBody.split(marker).length !== 2) { return false; }
    this.bufferState = { markedBody, marker, originalBody: this.body }; this.completionTarget.macros = context.completionDefs;
    return true;
  }

  private buffer(prefix: string): { from: number; to: number } {
    const { markedBody, marker } = this.bufferState!;
    // A bare backslash immediately before `$` would escape the closing delimiter.
    // The separator also prevents a command prefix from swallowing the next atom.
    const body = markedBody.replace(marker, prefix + ' ');
    const span = this.locate() ?? this.span;
    const patch = diffText(this.body, body);
    this.body = body;
    if (patch) {
      this.dispatchLocal({ from: span.bodyFrom + patch.from, to: span.bodyFrom + patch.to, insert: patch.insert }, 'mathCompletionPrefix');
    }
    const from = (this.locate() ?? span).bodyFrom + markedBody.indexOf(marker);
    return { from, to: from + prefix.length };
  }

  private acceptCompletion(latex: string, firstPromptId: string | undefined, extras: Change[], sourceLatex?: string): boolean {
    const span = this.locate();
    if (!span || !this.validExtras(span, extras)) { return false; }
    this.completedCallFrom = undefined;
    // Insert source-owned macro calls before projection. In particular, MathLive's
    // MacroAtom argument parser cannot represent TeX's optional [argument] syntax.
    const call = sourceLatex === undefined ? undefined : completedMacroCall(sourceLatex, 0, context.defs);
    if (call && this.bufferState) {
      if (!isMacroCompletionSource(sourceLatex!)) { return false; }
      const { markedBody, marker } = this.bufferState;
      const from = markedBody.indexOf(marker);
      const body = markedBody.replace(marker, () => sourceLatex!);
      const completed = completedMacroCall(body, from, context.defs);
      if (!completed) { return false; }
      const patch = diffText(this.body, body);
      this.body = body; this.bufferState = undefined;
      const changes = [...extras];
      if (patch) { changes.push({ from: span.bodyFrom + patch.from, to: span.bodyFrom + patch.to, insert: patch.insert }); }
      if (changes.length) { this.dispatchLocal(changes, 'mathCompletion'); }
      this.reproject(); this.completedCallFrom = completed.from;
      return true;
    }
    this.canon.configure(this.projection.macros);
    if (!this.field.insertTemplate(latex, firstPromptId)) { return false; }
    const after = this.field.value();
    if (hasMathModeCJK(after)) { this.rejectInput('中文输入未进入文本模式，已切换到源码模式。此次公式输入未写入。'); return false; }
    const result = reconcile(this.sourceView, this.serial, after, this.canon.canon, this.projection.islands);
    const body = this.projection.restore(result.view);
    if (body === undefined) { return false; }
    if (result.strategy === 'body' && (this.minimalOnly || this.field.hasErrors())) {
      this.rejectInput('此公式补全无法安全地保留原始格式，已切换到源码模式。'); return false;
    }
    this.sourceView = result.view; this.serial = after; this.bufferState = undefined;
    const patch = diffText(this.body, body); this.body = body;
    const changes = [...extras];
    if (patch) { changes.push({ from: span.bodyFrom + patch.from, to: span.bodyFrom + patch.to, insert: patch.insert }); }
    if (changes.length) { this.dispatchLocal(changes, 'mathCompletion'); }
    const next = project(this.span, this.body, context);
    if (next.islands.length !== this.projection.islands.length) { this.reproject(); }
    else { this.renderTools(); }
    return true;
  }

  /** Our span in the current state (positions shift as the document changes). */
  private locate(): FormulaSpan | undefined {
    const pos = this.view.posAtDOM(this.dom);
    const span = this.view.state.field(formulaState).spans.find(s => s.from === pos);
    if (span) { this.span = span; }
    return span;
  }

  private leave(direction: 'forward' | 'backward' | 'upward' | 'downward') {
    const span = this.locate() ?? this.span;
    this.deactivate();
    const view = this.view;
    const pos = direction === 'backward' || direction === 'upward' ? span.from : span.to;
    view.dispatch({ selection: EditorSelection.cursor(pos), scrollIntoView: true });
    view.focus();
    if (direction === 'upward') { cursorLineUp(view); }
    if (direction === 'downward' && isBlock(view.state, span)) { cursorLineDown(view); }
  }

  private toSource() {
    const span = this.locate() ?? this.span;
    this.deactivate();
    this.view.dispatch({ selection: EditorSelection.cursor(span.bodyFrom), scrollIntoView: true });
    this.view.focus();
  }

  /** Clipboard gets the user's source for the selection, never island tokens. */
  private copy(cut: boolean, event: ClipboardEvent) {
    const latex = this.field.selectedLatex();
    if (!latex || !event.clipboardData) { return; }
    event.preventDefault();
    event.stopImmediatePropagation();
    event.clipboardData.setData('text/plain', restoreIslands(latex, this.projection.islands));
    if (cut) { this.field.deleteSelection(); }
  }

  deactivate() {
    if (active !== this) { return; }
    completion?.cancel(false);
    this.flushInput();
    if (active !== this) { return; }
    this.dispose();
    this.view.dispatch({ effects: refresh.of(null) });
  }

  dispose() {
    if (this.bufferState) { queueMicrotask(() => completion?.cancel(false)); }
    if (active === this) { active = undefined; }
    const args = this.argEditor; this.argEditor = undefined;
    if (args?.isOpen && completion?.active) { queueMicrotask(() => args.close(false)); }
    else { args?.close(false); }
    this.scrollAnchor = undefined;
    this.abort.abort(); this.tools.remove();
    this.field.dispose();
    this.dom.classList.remove('omt-live');
    const html = markupFor(this.span, this.body);
    if (html) { this.dom.innerHTML = html; } else { this.dom.textContent = this.body; }
  }
}

function visibleAt(state: EditorState, test: (v: Visible) => boolean): Visible | undefined {
  return state.field(formulaState).visible.find(test);
}

/** Enter a formula from the surrounding prose with the keyboard. */
function enter(view: EditorView, find: (head: number, state: EditorState) => { v: Visible; where: 'start' | 'end' } | undefined): boolean {
  const sel = view.state.selection.main;
  if (!sel.empty) { return false; }
  const hit = find(sel.head, view.state);
  if (!hit) { return false; }
  const element = findFormulaDom(view, hit.v.span.from);
  if (!element) { return false; }
  activate(view, hit.v.span, element, hit.where);
  return true;
}

function findFormulaDom(view: EditorView, from: number): HTMLElement | undefined {
  for (const el of view.contentDOM.querySelectorAll<HTMLElement>('.omt-formula')) {
    if (view.posAtDOM(el) === from) { return el; }
  }
  return undefined;
}

const formulaKeymap = Prec.high(keymap.of([
  { key: 'ArrowRight', run: view => enter(view, (h, s) => { const v = visibleAt(s, v => v.span.from === h); return v && { v, where: 'start' }; }) },
  { key: 'ArrowLeft', run: view => enter(view, (h, s) => { const v = visibleAt(s, v => v.span.to === h); return v && { v, where: 'end' }; }) },
  { key: 'Backspace', run: view => enter(view, (h, s) => { const v = visibleAt(s, v => v.span.to === h); return v && { v, where: 'end' }; }) },
  { key: 'Delete', run: view => enter(view, (h, s) => { const v = visibleAt(s, v => v.span.from === h); return v && { v, where: 'start' }; }) },
  {
    key: 'ArrowDown', run: view => enter(view, (h, s) => {
      const line = s.doc.lineAt(h);
      if (line.number >= s.doc.lines) { return undefined; }
      const next = s.doc.line(line.number + 1);
      const v = visibleAt(s, v => v.block && v.span.from === next.from);
      return v && { v, where: 'start' };
    }),
  },
  {
    key: 'ArrowUp', run: view => enter(view, (h, s) => {
      const line = s.doc.lineAt(h);
      if (line.number <= 1) { return undefined; }
      const prev = s.doc.line(line.number - 1);
      const v = visibleAt(s, v => v.block && v.span.to === prev.to);
      return v && { v, where: 'end' };
    }),
  },
]));

export function formulaExtensions(): Extension[] {
  return [formulaState, formulaKeymap, EditorView.theme({ '.omt-formula-notice': { padding: '6px 10px', borderTop: '1px solid var(--vscode-editorWarning-foreground, #cca700)', color: 'var(--vscode-editorWarning-foreground, #cca700)', fontSize: '12px' } })];
}

/** Test hook: formula spans currently rendered visually. */
export function visibleFormulas(state: EditorState): FormulaSpan[] { return state.field(formulaState).visible.map(v => v.span); }
