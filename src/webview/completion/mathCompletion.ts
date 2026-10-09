import { ChangeSet, type Text } from '@codemirror/state';
import type { EditorView, ViewUpdate } from '@codemirror/view';
import type { CompletionItemDTO, HostMessage, WebMessage } from '../../shared/protocol.ts';
import type { Change, EditorSettings, MacroDef } from '../../shared/types.ts';
import { completionScore } from '../../core/completionFilter.ts';
import { isMathCompletion } from '../../core/mathCompletionFilter.ts';
import { snippetToMathTemplate } from '../../core/mathSnippet.ts';
import { parseSnippet } from '../../core/snippet.ts';
import { tokenize } from '../../core/lexer.ts';
import { editKind } from '../editor/annotations.ts';
import { replayMathInput, startInlineMathCommand, type InlineMathCommand, type BufferedMathInput } from '../formula/mathlive.ts';
import type { SyncClient } from '../sync.ts';
import { CompletionPopup } from './popup.ts';
import { CompletionResolver } from './resolve.ts';

type Trigger = Extract<WebMessage, { t: 'complete' }>['trigger'];
/** A formula keeps its original MathLive selection while source contains the temporary prefix. */
export interface MathCompletionTarget {
  element: HTMLElement;
  macros: MacroDef[];
  begin(): boolean;
  buffer(prefix: string): { from: number; to: number };
  anchor(): { left: number; top: number; bottom: number };
  selectedLatex(): string;
  accept(latex: string, firstPromptId: string | undefined, extraEdits: Change[], sourceLatex?: string): boolean;
  /** Typed LaTeX is authoritative even when the renderer does not support it. */
  acceptTyped(latex: string): boolean;
  /** Acceptance may open a source-owned argument field and transfer input there. */
  acceptedTarget?(): MathCompletionTarget | undefined;
  end(): void;
  focus(): void;
}
interface Request { req: string; version: number; at: number; doc: Text; changes: ChangeSet; retry: number; items?: CompletionItemDTO[]; incomplete?: boolean }
let counter = 0;

export class MathCompletion {
  private view!: EditorView;
  private popup!: CompletionPopup;
  private settings?: EditorSettings;
  private target?: MathCompletionTarget;
  private command?: InlineMathCommand;
  private prefix = '';
  private selectedLatex = '';
  private selectionExplicit = false;
  private range = { from: 0, to: 0 };
  private rollback?: ChangeSet;
  private requestState?: Request;
  private listed: CompletionItemDTO[] = [];
  private selected = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private editing = false;
  private composing = false;
  private stopHandoff?: () => void;
  private focusHandoff?: (target: MathCompletionTarget) => void;
  private replayingHandoff = false;
  private continuingHandoff = false;
  private focusSettled?: Promise<void>;
  private sync: SyncClient;
  private post: (message: WebMessage) => void;
  private readonly resolver: CompletionResolver;

  constructor(sync: SyncClient, post: (message: WebMessage) => void) {
    this.sync = sync; this.post = post; this.resolver = new CompletionResolver(sync, post);
    window.addEventListener('resize', () => this.render());
  }
  attach(view: EditorView) {
    this.view = view; this.popup = new CompletionPopup(view, index => { this.resolver.cancel(); this.selected = index; this.accept(); });
    view.scrollDOM.addEventListener('scroll', () => this.render());
  }
  configure(settings: EditorSettings) { this.settings = settings; }
  async settleFocus(): Promise<void> {
    while (this.focusSettled) { await this.focusSettled; }
  }
  focusTarget(target: MathCompletionTarget): void {
    if (this.focusHandoff) { this.focusHandoff(target); }
    else { this.handoff().focus(target); }
  }
  get active() { return Boolean(this.target); }
  get sourceCursor(): number | undefined { return this.target ? this.range.to : undefined; }
  ownsFocus() { return Boolean(this.target && document.activeElement === this.target.element); }
  start(target: MathCompletionTarget, prefix: string) {
    if (!this.replayingHandoff && !this.continuingHandoff) { this.stopHandoff?.(); }
    this.cancel();
    if (!target.element.isConnected || !target.begin()) { return; }
    this.target = target; this.rollback = undefined;
    this.editing = true;
    try { this.range = target.buffer(prefix); } finally { this.editing = false; }
    this.prefix = prefix; this.selectedLatex = target.selectedLatex();
    this.command = startInlineMathCommand(target.element, prefix, {
      input: () => this.commandInput(), keydown: event => this.commandKeydown(event),
      composition: active => {
        this.resolver.cancel(); this.composing = active; clearTimeout(this.timer);
        if (!active) { this.schedule({ kind: 'invoke' }); }
      },
      blur: () => queueMicrotask(() => { if (this.target === target && !this.ownsFocus()) { this.cancel(false); } }),
      leave: () => queueMicrotask(() => { if (this.target === target) { this.acceptTyped(); } }),
    });
    if (!this.command) { this.cancel(); return; }
    if (!this.ownsFocus()) { this.focusTarget(target); }
    void this.request(prefix ? { kind: 'char', char: '\\' } : { kind: 'invoke' });
  }
  update(update: ViewUpdate) {
    if (!this.target || !update.docChanged) { return; }
    this.resolver.cancel();
    if (this.editing) {
      const inverse = update.changes.invert(update.startState.doc);
      this.rollback = this.rollback ? inverse.compose(this.rollback) : inverse;
      if (this.requestState) { this.requestState.changes = this.requestState.changes.compose(update.changes); }
    } else {
      this.rollback = this.rollback?.map(update.changes);
      const target = this.target;
      queueMicrotask(() => { if (this.target === target) { this.cancel(false); } });
    }
  }
  private schedule(trigger: Trigger) {
    clearTimeout(this.timer);
    if (this.composing) { return; }
    this.timer = setTimeout(() => { if (this.composing || !this.ownsFocus() || this.prefix.includes('\n')) { return; } void this.request(trigger); }, this.settings?.quickSuggestionsDelay ?? 10);
  }
  private async request(trigger: Trigger, retry = 0) {
    clearTimeout(this.timer);
    this.resolver.cancel();
    if (this.requestState) { this.post({ t: 'cancelCompletion', req: this.requestState.req }); }
    const generation = ++this.generation;
    this.requestState = undefined; this.listed = []; this.selected = 0; this.popup.hide();
    await this.sync.flush();
    if (generation !== this.generation || !this.target || !this.sync.matches(this.view.state)) { return; }
    const at = this.range.to;
    const request = this.requestState = { req: `math-${++counter}`, version: this.sync.version, at, doc: this.view.state.doc, changes: ChangeSet.empty(this.view.state.doc.length), retry };
    this.post({ t: 'complete', req: request.req, version: request.version, at, trigger, ctx: 'math' });
  }
  receive(message: Extract<HostMessage, { t: 'completions' }>) {
    const request = this.requestState;
    if (!this.target || !request || request.req !== message.req) { return; }
    if (message.version !== request.version || message.at !== request.at) {
      if (!request.retry) { void this.request({ kind: 'incomplete' }, 1); } else { this.cancel(); }
      return;
    }
    request.items = message.items; request.incomplete = message.isIncomplete; this.filter();
    if (message.isIncomplete && !request.changes.empty) { this.schedule({ kind: 'incomplete' }); }
  }
  receiveResolved(message: Extract<HostMessage, { t: 'completionResolved' }>) { this.resolver.receive(message); }
  private filter() {
    const request = this.requestState, target = this.target;
    if (!target || !request?.items) { return; }
    const old = this.selectionExplicit ? this.listed[this.selected]?.i : undefined;
    const mapped = request.items.filter(item => isMathCompletion(item, target.macros, this.settings?.mathCompletionAllowPatterns))
      .filter(item => [item.range.insFrom, item.range.insTo, item.range.repFrom, item.range.repTo, ...(item.extraEdits?.flatMap(e => [e.from, e.to]) ?? [])].every(p => p >= 0 && p <= request.doc.length))
      .map(item => {
        const r = item.range, m = request.changes;
        return { ...item, range: { insFrom: m.mapPos(r.insFrom, -1), insTo: m.mapPos(r.insTo, 1), repFrom: m.mapPos(r.repFrom, -1), repTo: m.mapPos(r.repTo, 1) },
          extraEdits: item.extraEdits?.map(e => ({ ...e, from: m.mapPos(e.from, -1), to: m.mapPos(e.to, 1) })) };
      });
    const candidates = mapped.flatMap((item, index) => {
      const from = this.settings?.suggestReplace ? item.range.repFrom : item.range.insFrom;
      const to = this.settings?.suggestReplace ? item.range.repTo : item.range.insTo;
      if (from < this.range.from || to > this.range.to || from > to) { return []; }
      const score = completionScore(this.view.state.doc.sliceString(from, this.range.to), item.filterText ?? item.label);
      return score === null ? [] : [{ item, score, index }];
    });
    candidates.sort((a, b) => b.score - a.score || Number(Boolean(b.item.preselect)) - Number(Boolean(a.item.preselect))
      || (a.item.sortText ?? a.item.label).localeCompare(b.item.sortText ?? b.item.label) || a.index - b.index);
    this.listed = candidates.slice(0, 300).map(c => c.item); this.selected = Math.max(0, this.listed.findIndex(i => i.i === old));
    this.render();
  }
  private commandInput() {
    if (!this.target || !this.command) { return; }
    this.resolver.cancel(); this.prefix = this.command.text();
    this.editing = true;
    try {
      // Provider coordinates use real source, whose formula scanner must remain
      // balanced while an argument is still being typed in the native group.
      let depth = 0;
      for (const token of tokenize(this.prefix)) {
        if (token.value === '{') { depth++; }
        else if (token.value === '}') { depth = Math.max(0, depth - 1); }
      }
      const range = this.target.buffer(this.prefix + '}'.repeat(depth));
      this.range = { from: range.from, to: range.to - depth };
    } finally { this.editing = false; }
    this.filter();
    if (this.composing) { return; }
    if (this.requestState?.incomplete) { this.schedule({ kind: 'incomplete' }); }
    else if (!this.requestState) { this.schedule({ kind: 'invoke' }); }
  }
  private commandKeydown(event: KeyboardEvent) {
    if (event.isComposing || this.composing) { return; }
    if (['Enter', 'Tab', ' '].includes(event.key) && this.command?.text() !== this.prefix) { this.commandInput(); }
    if (event.key !== 'Enter' && event.key !== 'Tab') { this.resolver.cancel(); }
    let handled = true;
    if (event.key === 'Escape') { this.cancel(); }
    else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') { this.command?.selectAll(); }
    else if (event.key === 'ArrowRight' && !event.shiftKey && !event.ctrlKey && !event.metaKey && this.command?.atEnd()) { this.acceptTyped(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (this.listed.length) {
        this.selectionExplicit = true;
        this.selected = (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + this.listed.length) % this.listed.length;
        this.render();
      }
    } else if (event.key === 'Enter' && !this.listed.length) { this.acceptTyped(); }
    else if (event.key === 'Enter' && !this.settings?.completionAcceptOnEnter) {
      const target = this.target;
      this.cancel(false);
      if (target) { this.handoff({ kind: 'key', key: {
        key: event.key, code: event.code, location: event.location, repeat: event.repeat,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      } }).focus(target); }
    } else if (event.key === 'Enter' || event.key === 'Tab') { this.listed.length ? this.accept() : this.acceptTyped(); }
    else if (event.ctrlKey && event.code === 'Space') { void this.request({ kind: 'invoke' }); }
    else if (event.key === ' ' && !event.ctrlKey && !event.metaKey && !event.altKey) { this.acceptTyped(); }
    else { handled = false; }
    if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
  }
  private render() {
    if (!this.target) { return; }
    this.popup.show(this.listed, this.selected, this.range.to, this.target.anchor(), this.target.element);
  }
  /** Space or a completed native LaTeX group commits the exact command typed. */
  private acceptTyped() {
    const target = this.target;
    if (!target || !this.command) { return; }
    const latex = this.command.text();
    if (!latex) { this.cancel(); return; }
    this.command.restore(); this.command.dispose(); this.command = undefined;
    this.editing = true;
    let ok = false;
    try { ok = target.acceptTyped(latex); } finally { this.editing = false; }
    if (!ok) { this.cancel(); return; }
    this.clear(); this.focusTarget(target.acceptedTarget?.() ?? target);
    void this.sync.flush();
  }
  private accept() {
    // MathLive dispatches input on a timer. Enter/Tab can reach this handler
    // before the last character has refreshed source coordinates and ranges.
    if (this.command && this.command.text() !== this.prefix) { this.commandInput(); }
    const target = this.target, item = this.listed[this.selected], request = this.requestState;
    if (!target || !item || !request) { return; }
    if (item.needsResolve) {
      if (this.resolver.pending) { return; }
      clearTimeout(this.timer);
      const at = this.range.to, generation = this.generation, selection = this.command?.selectionKey();
      this.resolver.start(request.req, item.i, this.view, at,
        () => this.target === target && this.requestState === request && this.generation === generation && this.ownsFocus()
          && !this.composing && this.range.to === at && this.listed[this.selected]?.i === item.i
          && this.command?.selectionKey() === selection,
        (resolved, version) => {
          if (!resolved || resolved.needsResolve || !isMathCompletion(resolved, target.macros, this.settings?.mathCompletionAllowPatterns)) {
            this.post({ t: 'log', level: 'warn', message: 'Completion changed while resolving; choose it again.' });
            void this.request({ kind: 'invoke' }); return;
          }
          this.requestState = { ...request, version, at, doc: this.view.state.doc, changes: ChangeSet.empty(this.view.state.doc.length), items: [resolved], incomplete: false };
          this.listed = [resolved]; this.selected = 0; this.accept();
        });
      return;
    }
    const from = this.settings?.suggestReplace ? item.range.repFrom : item.range.insFrom;
    const to = this.settings?.suggestReplace ? item.range.repTo : item.range.insTo;
    if (from < this.range.from || to > this.range.to || from > to) { this.cancel(); return; }
    const body = this.prefix.slice(0, from - this.range.from) + item.insert.value + this.prefix.slice(to - this.range.from);
    const variables = { TM_SELECTED_TEXT: this.selectedLatex };
    const template = item.insert.snippet ? snippetToMathTemplate(body, variables, `omt-${++counter}`) : { latex: body, firstPromptId: undefined };
    const sourceLatex = item.insert.snippet ? parseSnippet(body, variables).text : body;
    this.command?.restore(); this.command?.dispose(); this.command = undefined;
    this.editing = true;
    let ok = false;
    try { ok = target.accept(template.latex, template.firstPromptId, item.extraEdits ?? [], sourceLatex); } finally { this.editing = false; }
    if (!ok) { this.cancel(); return; }
    this.clear();
    // Resolve an argument editor only after releasing the completion rollback.
    // Its open() path may cancel completion and starts MathLive's delayed focus.
    const next = target.acceptedTarget?.() ?? target;
    if (item.command === 'triggerSuggest') {
      this.start(next, '');
    } else { this.focusTarget(next); }
    void this.sync.flush().then(() => {
      if (item.command === 'host') { this.post({ t: 'runItemCommand', req: request.req, item: item.i }); }
    });
  }
  /** Capture only the gap between accepting a completion and genuine MathLive focus. */
  private handoff(initial?: BufferedMathInput) {
    this.stopHandoff?.();
    let finish = () => {};
    const settled = new Promise<void>(resolve => { finish = resolve; });
    this.focusSettled = settled;
    const controller = new AbortController(), { signal } = controller;
    const queue: BufferedMathInput[] = initial ? [initial] : [];
    let destination: HTMLElement | undefined;
    let pendingKey: Extract<BufferedMathInput, { kind: 'key' }> | undefined;
    let deliveryScheduled = false;
    let timeout: ReturnType<typeof setTimeout>;
    const stop = () => {
      controller.abort(); clearTimeout(timeout); queue.length = 0;
      if (this.stopHandoff === stop) { this.stopHandoff = undefined; this.focusHandoff = undefined; }
      if (this.focusSettled === settled) { this.focusSettled = undefined; }
      this.continuingHandoff = false;
      finish();
    };
    this.stopHandoff = stop;
    const focused = () => destination && (document.activeElement === destination || destination.contains(document.activeElement));
    const deliver = () => {
      if (this.replayingHandoff || this.continuingHandoff || deliveryScheduled || signal.aborted || !destination || !focused()) { return; }
      if (!destination.isConnected) { stop(); return; }
      if (!queue.length) { stop(); return; }
      deliveryScheduled = true;
      queueMicrotask(() => {
        deliveryScheduled = false;
        if (signal.aborted || !destination || !focused()) { return; }
        if (!destination.isConnected) { stop(); return; }
        const event = queue.shift()!;
        if (pendingKey === event) { pendingKey = undefined; }
        this.continuingHandoff = true;
        this.replayingHandoff = true;
        try {
          replayMathInput(destination, event);
        } finally { this.replayingHandoff = false; }
        // A replayed backslash may synchronously open an inline command. Tab,
        // Enter and Escape may request another field's asynchronous focus; its
        // focus-request event already changed destination, so pause here.
        if (this.target && this.ownsFocus()) { destination = this.target.element; }
        // Navigation may defer disposal/focus to a microtask so MathLive can
        // finish its current key handler before the next record is replayed.
        queueMicrotask(() => {
          if (signal.aborted) { return; }
          this.continuingHandoff = false; deliver();
        });
      });
    };
    document.addEventListener('omt-focus-request', event => {
      const element = event.composedPath()[0];
      if (element instanceof HTMLElement) { destination = element; }
    }, { capture: true, signal });
    document.addEventListener('keydown', event => {
      if (this.replayingHandoff) { return; }
      if (focused()) { deliver(); if (signal.aborted) { return; } }
      if (event.isComposing || event.ctrlKey || event.metaKey || /^(?:Control|Meta|Alt|Shift|CapsLock)$/.test(event.key)) { return; }
      event.preventDefault(); event.stopImmediatePropagation();
      const buffered: Extract<BufferedMathInput, { kind: 'key' }> = { kind: 'key', key: {
        key: event.key, code: event.code, location: event.location, repeat: event.repeat,
        ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, shiftKey: event.shiftKey,
      } };
      queue.push(buffered);
      pendingKey = [...event.key].length === 1 || /^(?:Dead|Process|Unidentified)$/.test(event.key) ? buffered : undefined;
    }, { capture: true, signal });
    document.addEventListener('beforeinput', event => {
      if (this.replayingHandoff) { return; }
      if (focused()) { deliver(); if (signal.aborted) { return; } }
      const input = event as InputEvent;
      if (input.isComposing) { return; }
      event.preventDefault(); event.stopImmediatePropagation();
      const value: InputEventInit = { data: input.data, inputType: input.inputType, isComposing: input.isComposing };
      // A prevented physical key normally emits no beforeinput. Pair synthetic or
      // accessibility follow-ups with that key so the character is replayed once.
      const sameKey = pendingKey && input.inputType === 'insertText' && input.data !== null
        && (input.data === pendingKey.key.key || /^(?:Dead|Process|Unidentified)$/.test(pendingKey.key.key ?? ''));
      if (pendingKey && sameKey) { pendingKey.input = value; }
      else { queue.push({ kind: 'input', input: value }); }
      pendingKey = undefined;
    }, { capture: true, signal });
    document.addEventListener('focusin', () => {
      queueMicrotask(() => {
        if (signal.aborted) { return; }
        if (focused()) { deliver(); }
        // MathLive can briefly refocus the old sink while processing a Tab.
        // A requested new math field remains the destination until real focus.
        else if (destination && document.activeElement !== document.body
          && document.activeElement?.tagName !== 'MATH-FIELD') { stop(); }
      });
    }, { capture: true, signal });
    document.addEventListener('pointerdown', stop, { capture: true, signal });
    window.addEventListener('blur', stop, { signal });
    timeout = setTimeout(stop, 1000);
    const focus = (target: MathCompletionTarget) => {
      destination = target.element;
      if (!target.element.isConnected) { stop(); return; }
      target.focus(); deliver();
    };
    this.focusHandoff = focus;
    return { focus };
  }
  cancel(focus = true) {
    if (!this.replayingHandoff && !this.continuingHandoff) { this.stopHandoff?.(); }
    const target = this.target, rollback = this.rollback;
    if (!target) { return; }
    this.command?.restore();
    this.clear();
    if (rollback && !rollback.empty) { this.view.dispatch({ changes: rollback, annotations: editKind.of('mathCompletionCancel') }); }
    target.end(); if (focus) { target.focus(); }
  }
  private clear() {
    this.resolver.cancel();
    if (this.requestState) { this.post({ t: 'cancelCompletion', req: this.requestState.req }); }
    if (!this.replayingHandoff && !this.continuingHandoff) { this.stopHandoff?.(); }
    this.generation++; clearTimeout(this.timer); this.requestState = undefined; this.target = undefined;
    this.rollback = undefined; this.listed = []; this.selected = 0; this.popup.hide(); this.command?.dispose(); this.command = undefined; this.prefix = ''; this.selectionExplicit = false;
    this.composing = false;
  }
}
