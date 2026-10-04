import { parseMacroCalls, editMacroArgument, deleteMacroCall, type MacroCall, type MacroArgument } from '../../core/macroCalls.ts';
import { reconcile } from '../../core/writeback.ts';
import type { Change, Patch } from '../../shared/types.ts';
import type { FormulaSpan } from '../../core/formulaScanner.ts';
import { Canonicalizer, createField, type LiveField } from '../formula/mathlive.ts';
import { project, type MacroContext, type Projection } from '../formula/projection.ts';
import type { MathCompletion, MathCompletionTarget } from '../completion/mathCompletion.ts';
import { sourceCursor } from '../formula/sourcePosition.ts';
import { completedMacroCall, isMacroCompletionSource } from '../../core/macroCompletion.ts';
import { hasMathModeCJK } from '../../core/mathText.ts';

export interface ArgEditorHost {
  body(): string;
  span(): FormulaSpan;
  context(): MacroContext;
  unknown(): ReadonlySet<string>;
  commit(patch: Patch | undefined, extras?: Change[], kind?: string): boolean;
  anchor(): { left: number; top: number; bottom: number };
  focus(): void;
  closed(): void;
  completion?: MathCompletion;
  shortcuts(): { enabled: boolean; overrides?: Record<string, string> };
}

/** Source-owned argument fields. Expanded macro children are never the write-back model. */
export class MacroArgEditor {
  readonly element = document.createElement('div');
  private from: number;
  private parents: { from: number; index?: number; childFrom: number }[] = [];
  private fields: ArgumentSession[] = [];
  private lastFocused?: ArgumentSession;
  private abort = new AbortController();
  private canon = new Canonicalizer();
  private closed = false;
  private host: ArgEditorHost;
  constructor(host: ArgEditorHost, call: MacroCall) {
    this.host = host;
    this.from = call.from;
    this.element.className = 'omt-macro-args';
    this.element.setAttribute('role', 'dialog');
    this.element.setAttribute('aria-label', 'Macro arguments');
    document.body.append(this.element);
    this.render();
    window.addEventListener('resize', () => this.position(), { signal: this.abort.signal });
    document.addEventListener('scroll', () => this.position(), { capture: true, signal: this.abort.signal });
    document.addEventListener('pointerdown', event => {
      const target = event.target as Node;
      if (!this.element.contains(target) && !(target instanceof Element && target.closest('.omt-completion, .omt-math-buffer, .omt-macro-tools'))) { this.close(false); }
    }, { signal: this.abort.signal });
    this.element.addEventListener('keydown', event => {
      if (event.key === 'Tab' && !event.isComposing && !this.host.completion?.active && !event.altKey && !event.ctrlKey && !event.metaKey) {
        const field = this.focusedField();
        // MathLive's group navigation first visits the start/end of ordinary
        // expressions. Argument navigation moves directly unless a template is
        // still being edited inside this field.
        if (field && !field.hasTemplatePrompts()) {
          event.preventDefault(); event.stopImmediatePropagation(); this.move(field, event.shiftKey ? 'backward' : 'forward');
          return;
        }
      }
      if ((event.key === 'Escape' || event.key === 'Enter') && !event.isComposing && !this.host.completion?.active && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); this.finish();
      }
    }, { capture: true, signal: this.abort.signal });
  }
  get isOpen() { return !this.closed; }
  rejectMathCJK() {
    this.element.querySelector('.omt-argument-notice')?.remove();
    const notice = document.createElement('div'); notice.className = 'omt-argument-notice'; notice.setAttribute('role', 'alert');
    notice.textContent = '中文输入必须保留文本模式；本次参数输入未写回。';
    this.element.append(notice);
  }
  flushInput() { for (const field of this.fields) { field.flushInput(); } }
  rememberFocus(field: ArgumentSession) { this.lastFocused = field; }
  private focusedField() { return this.fields.find(field => field.field.element === document.activeElement) ?? this.lastFocused ?? this.fields[0]; }
  focusFirst(selectDefault = true) {
    const field = this.fields[0];
    if (!field || this.closed) { return; }
    if (selectDefault && field.field.value()) { field.field.selectAll(); }
    field.field.focus();
  }
  focus() { if (!this.closed) { this.focusedField()?.field.focus(); } }
  completionTarget(): MathCompletionTarget | undefined { return this.closed ? undefined : this.focusedField()?.completionTarget(); }
  sourceCursor(): number | undefined {
    const field = this.fields.find(field => field.field.element === document.activeElement) ?? this.lastFocused;
    return field?.sourceCursor();
  }
  calls() { return parseMacroCalls(this.host.body(), this.host.context().defs, this.host.unknown()); }
  call() { return this.calls().find(call => call.from === this.from); }
  argument(index: number) { return this.call()?.args.find(arg => arg.index === index); }
  projection(value: string) { return project({ ...this.host.span(), wrapper: undefined }, value, this.host.context()); }
  canonicalize(projection: Projection, value: string) { this.canon.configure(projection.macros); return this.canon.canon(value); }
  write(index: number, value: string | null, extras?: Change[], kind = 'macroArgument'): boolean {
    const call = this.call();
    if (!call || this.closed) { return false; }
    try {
      return this.host.commit(editMacroArgument(this.host.body(), call, index, value), extras, kind);
    } catch { return false; }
  }
  open(from: number) {
    this.host.completion?.cancel(false);
    const index = this.call()?.args.find(arg => from >= arg.from && from < arg.to)?.index;
    this.parents.push({ from: this.from, index, childFrom: from }); this.from = from; this.render();
    this.focusFirst();
  }
  move(field: ArgumentSession, direction: 'forward' | 'backward' | 'upward' | 'downward') {
    const backward = direction === 'backward' || direction === 'upward';
    const index = this.fields.indexOf(field), next = this.fields[index + (backward ? -1 : 1)];
    field.flushInput();
    if (next) { next.field.placeAt(backward ? 'end' : 'start'); this.focusField(next); }
    else if (backward) { const first = this.fields[0]; if (first) { first.field.placeAt('start'); this.focusField(first); } }
    else { this.finish(); }
  }
  finish() {
    this.flushInput();
    if (this.parents.length) { this.back(); }
    else { this.close(); }
  }
  private back() {
    this.host.completion?.cancel(false);
    const parent = this.parents.pop();
    if (!parent) { return; }
    this.from = parent.from; this.render();
    const field = this.fields.find(field => field.index === parent.index) ?? this.fields[0];
    if (field) { field.placeAfter(parent.childFrom); this.focusField(field); }
  }
  private focusField(field: ArgumentSession) {
    if (this.host.completion) { this.host.completion.focusTarget(field.completionTarget()); }
    else { field.field.focus(); }
  }
  nestedButtons(parent: HTMLElement, index: number) {
    parent.replaceChildren();
    const arg = this.argument(index);
    if (!arg) { return; }
    for (const [ordinal, child] of this.calls().filter(call => arg.childIds.includes(call.id)).entries()) {
      parent.append(button(`\\${child.name}`, 'omt-macro-edit', () => {
        // Editing an earlier parameter can shift this row without recreating
        // its field. Resolve the child against the current source on click.
        const argument = this.argument(index), calls = this.calls();
        const current = calls.filter(call => argument?.childIds.includes(call.id))[ordinal];
        if (current) { this.open(current.from); }
      }));
    }
  }
  configure() {
    const shortcuts = this.host.shortcuts();
    for (const field of this.fields) { field.field.setShortcuts(shortcuts.enabled, shortcuts.overrides); }
  }
  close(focus = true) {
    if (this.closed) { return; }
    this.host.completion?.cancel(false);
    this.closed = true;
    this.abort.abort(); this.fields.forEach(field => field.dispose()); this.fields = [];
    this.canon.dispose(); this.element.remove();
    this.host.closed();
    if (focus) { this.host.focus(); }
  }
  private render() {
    this.lastFocused = undefined;
    this.fields.forEach(field => field.dispose()); this.fields = [];
    this.element.replaceChildren();
    const call = this.call();
    if (!call) { this.close(); return; }
    const header = document.createElement('div'); header.className = 'omt-macro-header';
    if (this.parents.length) {
      header.append(button('返回', 'omt-macro-back', () => { this.flushInput(); this.back(); }));
    }
    const title = document.createElement('strong'); title.textContent = `\\${call.name}`; header.append(title);
    header.append(button('删除宏', 'omt-macro-delete', () => {
      const current = this.call();
      this.host.completion?.cancel(false);
      if (current) { this.host.commit(deleteMacroCall(this.host.body(), current)); }
      this.close();
    }), button('关闭', 'omt-macro-close', () => this.close()));
    this.element.append(header);
    for (const arg of call.args) {
      const row = document.createElement('div'); row.className = 'omt-macro-arg'; row.dataset.index = String(arg.index);
      const label = document.createElement('label'); label.textContent = `${arg.optional ? '可选参数' : '参数'} ${arg.index}`;
      row.append(label); this.element.append(row);
      if (arg.omitted) {
        row.append(button('添加可选参数', 'omt-optional-add', () => {
          this.host.completion?.cancel(false);
          if (this.write(arg.index, this.argument(arg.index)?.defaultValue ?? '')) { this.render(); }
        }));
      } else {
        const container = document.createElement('span'); container.className = 'omt-arg-field'; row.append(container);
        const nested = document.createElement('span'); nested.className = 'omt-nested-macros';
        const field = new ArgumentSession(this, this.host, arg, container, nested); this.fields.push(field);
        field.field.element.setAttribute('aria-label', label.textContent);
        if (arg.optional) {
          row.append(button('删除可选参数', 'omt-optional-remove', () => {
            this.host.completion?.cancel(false);
            if (this.write(arg.index, null)) { this.render(); }
          }));
        }
        row.append(nested); this.nestedButtons(nested, arg.index);
      }
    }
    this.position();
    this.fields[0]?.field.focus();
  }
  private position() {
    if (this.closed) { return; }
    const anchor = this.host.anchor();
    this.element.style.left = `${Math.max(4, Math.min(anchor.left, window.innerWidth - this.element.offsetWidth - 4))}px`;
    const top = anchor.bottom + 5;
    this.element.style.top = `${Math.max(4, top + this.element.offsetHeight < window.innerHeight ? top : anchor.top - this.element.offsetHeight - 5)}px`;
  }
}

function button(text: string, className: string, run: () => void) {
  const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = text;
  element.addEventListener('click', run); return element;
}

class ArgumentSession {
  readonly field: LiveField;
  private projection: Projection;
  private sourceView: string;
  private serial: string;
  private bufferState?: { marked: string; marker: string; original: string };
  private target: MathCompletionTarget;
  private editor: MacroArgEditor;
  private host: ArgEditorHost;
  private arg: MacroArgument;
  private nested: HTMLElement;
  private acceptedCallFrom?: number;
  private disposed = false;
  constructor(editor: MacroArgEditor, host: ArgEditorHost, arg: MacroArgument, parent: HTMLElement, nested: HTMLElement) {
    this.editor = editor; this.host = host; this.arg = arg; this.nested = nested;
    this.projection = editor.projection(arg.value); this.sourceView = this.projection.view;
    const shortcuts = host.shortcuts();
    this.field = createField(parent, false, this.projection.macros, shortcuts.enabled, {
      focus: () => { if (!this.disposed) { editor.rememberFocus(this); } },
      input: () => this.input(), moveOut: direction => {
        // MathLive resumes its model navigation after dispatching move-out.
        // Let it finish before a nested return destroys the originating field.
        queueMicrotask(() => { if (!this.disposed && editor.isOpen) { editor.move(this, direction); } });
      },
      escape: () => editor.finish(), blur: () => {},
      copy: (cut, event) => {
        const source = this.projection.restore(this.field.selectedLatex());
        if (source && event.clipboardData) { event.preventDefault(); event.stopImmediatePropagation(); event.clipboardData.setData('text/plain', source); if (cut) { this.field.deleteSelection(); } }
      },
      complete: prefix => host.completion?.start(this.target, prefix),
      editIsland: token => {
        const island = this.projection.islands.find(island => island.token === token);
        const argument = editor.argument(arg.index);
        const at = this.sourceView.indexOf(token);
        const prefix = at < 0 ? undefined : this.projection.restore(this.sourceView.slice(0, at));
        if (island && argument && island.kind !== 'meta' && prefix !== undefined) { editor.open(argument.from + prefix.length); }
      },
    }, shortcuts.overrides);
    this.field.set(this.sourceView); this.serial = this.field.value();
    this.target = {
      element: this.field.element, macros: host.context().completionDefs,
      begin: () => this.begin(), buffer: prefix => this.buffer(prefix),
      anchor: () => this.field.anchor(), selectedLatex: () => this.projection.restore(this.field.selectedLatex()) ?? '',
      accept: (latex, prompt, extras, sourceLatex) => this.accept(latex, prompt, extras, sourceLatex),
      acceptedTarget: () => {
        const from = this.acceptedCallFrom; this.acceptedCallFrom = undefined;
        if (from !== undefined && editor.isOpen) { editor.open(from); }
        return editor.completionTarget();
      },
      end: () => { this.bufferState = undefined; },
      focus: () => { if (editor.isOpen && !this.disposed) { this.field.focus(); } },
    };
  }
  get index() { return this.arg.index; }
  completionTarget() { return this.target; }
  hasTemplatePrompts() { return this.field.hasTemplatePrompts(); }
  placeAfter(from: number) {
    const arg = this.editor.argument(this.arg.index);
    const island = arg && this.projection.islands.find(island => island.from === from - arg.from);
    if (island) { this.field.placeAfterIsland(island.token); }
    else { this.field.placeAt('end'); }
  }
  private reconcile(after: string) { return reconcile(this.sourceView, this.serial, after, value => this.editor.canonicalize(this.projection, value), this.projection.islands); }
  flushInput() { this.input(); }
  sourceCursor(): number | undefined {
    const arg = this.editor.argument(this.arg.index);
    if (!arg) { return; }
    const at = sourceCursor(this.field, this.projection, this.sourceView, this.serial, (projection, value) => this.editor.canonicalize(projection, value));
    return this.host.span().bodyFrom + arg.from + (at ?? 0);
  }
  private input() {
    if (this.disposed || this.bufferState || !this.editor.isOpen) { return; }
    const after = this.field.value();
    if (hasMathModeCJK(after)) { this.field.set(this.sourceView); this.editor.rejectMathCJK(); return; }
    const result = this.reconcile(after), value = this.projection.restore(result.view);
    if (value === undefined || !this.editor.write(this.arg.index, value)) { this.field.set(this.sourceView); return; }
    this.sourceView = result.view; this.serial = after;
    this.editor.nestedButtons(this.nested, this.arg.index);
  }
  private begin(): boolean {
    const marker = '\\OMTArgumentCursor';
    if (this.sourceView.includes(marker)) { return false; }
    const macros = { ...this.projection.macros, [marker.slice(1)]: { def: 'x', args: 0, expand: false, captureSelection: true } };
    const result = reconcile(this.sourceView, this.serial, this.field.markedValue(marker), value => this.editor.canonicalize({ ...this.projection, macros }, value), this.projection.islands);
    const marked = this.projection.restore(result.view);
    const arg = this.editor.argument(this.arg.index);
    if (!arg || marked === undefined || marked.split(marker).length !== 2) { return false; }
    this.bufferState = { marked, marker, original: arg.value };
    return true;
  }
  private buffer(prefix: string): { from: number; to: number } {
    const buffer = this.bufferState!;
    const value = buffer.marked.replace(buffer.marker, prefix + ' ');
    if (!this.editor.write(this.arg.index, value, [], 'mathCompletionPrefix')) { queueMicrotask(() => this.host.completion?.cancel()); }
    const arg = this.editor.argument(this.arg.index)!;
    const from = this.host.span().bodyFrom + arg.from + buffer.marked.indexOf(buffer.marker);
    return { from, to: from + prefix.length };
  }
  private accept(latex: string, prompt: string | undefined, extras: Change[], sourceLatex?: string): boolean {
    const buffer = this.bufferState;
    if (sourceLatex !== undefined && buffer && completedMacroCall(sourceLatex, 0, this.host.context().defs)) {
      if (!isMacroCompletionSource(sourceLatex)) { return false; }
      // Optional macro arguments are source syntax. MathLive's MacroAtom has
      // only mandatory arguments, so install this completion directly in source.
      const insertionFrom = buffer.marked.indexOf(buffer.marker);
      const value = buffer.marked.replace(buffer.marker, () => sourceLatex);
      const completed = completedMacroCall(value, insertionFrom, this.host.context().defs);
      if (!completed) { return false; }
      if (!this.editor.write(this.arg.index, value, extras, 'mathCompletion')) { return false; }
      const arg = this.editor.argument(this.arg.index);
      if (arg) { this.acceptedCallFrom = arg.from + completed.from; }
      this.bufferState = undefined;
      this.projection = this.editor.projection(value); this.sourceView = this.projection.view;
      this.field.setMacros(this.projection.macros); this.field.set(this.sourceView); this.serial = this.field.value();
      this.editor.nestedButtons(this.nested, this.arg.index);
      return true;
    }
    const restore = this.field.checkpoint();
    if (!this.field.insertTemplate(latex, prompt)) { return false; }
    const after = this.field.value();
    if (hasMathModeCJK(after)) { restore(); this.editor.rejectMathCJK(); return false; }
    const result = this.reconcile(after), value = this.projection.restore(result.view);
    if (value === undefined || !this.editor.write(this.arg.index, value, extras, 'mathCompletion')) { restore(); return false; }
    this.sourceView = result.view; this.serial = after; this.bufferState = undefined;
    this.editor.nestedButtons(this.nested, this.arg.index);
    // A newly inserted project macro becomes an atomic source-owned island too.
    const projection = this.editor.projection(value);
    if (projection.islands.length !== this.projection.islands.length) {
      this.projection = projection; this.sourceView = projection.view;
      this.field.setMacros(projection.macros); this.field.set(projection.view); this.serial = this.field.value();
    }
    return true;
  }
  dispose() { this.disposed = true; this.field.dispose(); }
}
