import { ChangeSet, Prec, Transaction, type Extension, type Text } from '@codemirror/state';
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type { CompletionItemDTO, HostMessage, WebMessage } from '../../shared/protocol.ts';
import type { EditorSettings } from '../../shared/types.ts';
import { completionScore } from '../../core/completionFilter.ts';
import { parseSnippet } from '../../core/snippet.ts';
import { editKind, remoteEdit } from '../editor/annotations.ts';
import { activeFormulaRange } from '../editor/formulas.ts';
import { snippetSpec } from '../snippet/snippetSession.ts';
import type { SyncClient } from '../sync.ts';
import { CompletionPopup } from './popup.ts';
import { CompletionResolver } from './resolve.ts';

type Trigger = Extract<WebMessage, { t: 'complete' }>['trigger'];
interface Request {
  req: string; version: number; at: number; doc: Text; changes: ChangeSet; retry: number;
  items?: CompletionItemDTO[]; incomplete?: boolean;
}
let requestNumber = 0;

export class ProseCompletion {
  private view?: EditorView;
  private popup?: CompletionPopup;
  private settings?: EditorSettings;
  private uri = '';
  private requestState?: Request;
  private listed: CompletionItemDTO[] = [];
  private selected = 0;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private accepting = false;
  private sync: SyncClient;
  private post: (message: WebMessage) => void;
  private readonly resolver: CompletionResolver;
  constructor(sync: SyncClient, post: (message: WebMessage) => void) { this.sync = sync; this.post = post; this.resolver = new CompletionResolver(sync, post); }
  attach(view: EditorView) {
    this.view = view; this.popup = new CompletionPopup(view, index => { this.resolver.cancel(); this.selected = index; this.accept(); });
    view.contentDOM.addEventListener('blur', () => this.close());
    view.scrollDOM.addEventListener('scroll', () => this.render());
  }
  configure(settings: EditorSettings, uri?: string) { this.settings = settings; if (uri) { this.uri = uri; } }
  extensions(): Extension {
    return Prec.highest(keymap.of([
      { key: 'Ctrl-Space', run: () => { void this.request({ kind: 'invoke' }); return true; } },
      { key: 'ArrowDown', run: () => this.move(1) },
      { key: 'ArrowUp', run: () => this.move(-1) },
      { key: 'Enter', run: () => {
        if (this.settings?.completionAcceptOnEnter) { return this.accept(); }
        this.close(); return false;
      } },
      { key: 'Tab', run: () => this.accept() },
      { key: 'Escape', run: () => { const visible = this.listed.length > 0; this.close(); return visible; } },
    ]));
  }
  update(update: ViewUpdate) {
    if (this.accepting) { return; }
    if (update.docChanged || update.selectionSet) { this.resolver.cancel(); }
    if (this.sync.composing || this.view?.composing) { this.close(); return; }
    if (update.transactions.some(tr => tr.annotation(remoteEdit))) { this.close(); return; }
    if (activeFormulaRange()) { this.close(); return; }
    const request = this.requestState;
    if (request && update.docChanged) { request.changes = request.changes.compose(update.changes); }
    if (request && (update.docChanged || update.selectionSet)) {
      const head = update.state.selection.main.head;
      const at = request.changes.mapPos(request.at, 1);
      const before = request.doc.lineAt(request.at).text.slice(0, request.at - request.doc.lineAt(request.at).from);
      const prefix = /[\\\w@:-]*$/.exec(before)![0];
      const from = request.changes.mapPos(request.at - prefix.length, -1);
      const current = update.state.doc.sliceString(from, head);
      if (head !== at || !/^[\\\w@:-]*$/.test(current) || !update.state.selection.main.empty) { this.close(); }
      else { this.filter(); }
    } else if (update.selectionSet && !update.docChanged) { this.close(); }
    if (!update.docChanged || !this.view?.hasFocus || !this.settings) { return; }
    const typing = update.transactions.some(tr => tr.isUserEvent('input.type') || tr.isUserEvent('delete.backward'));
    if (!typing) { return; }
    let typed = '';
    update.changes.iterChanges((_a, _b, _c, _d, insert) => { typed += insert.toString(); });
    const last = typed.slice(-1);
    const trigger = last && this.settings.triggerCharacters.includes(last);
    const head = update.state.selection.main.head, line = update.state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    const token = syntaxTree(update.state).resolveInner(head, -1).name;
    const inComment = /comment/i.test(token) || /(^|[^\\])(\\\\)*%/.test(before);
    const quick = inComment ? this.settings.quickSuggestionsInComments === true
      : /string/i.test(token) ? this.settings.quickSuggestionsInStrings === true : this.settings.quickSuggestions;
    if (this.requestState?.incomplete) { this.schedule({ kind: 'incomplete' }); }
    else if (trigger) { this.schedule({ kind: 'char', char: last }); }
    else if (!this.requestState && quick && /[\w@]$/.test(before)) { this.schedule({ kind: 'invoke' }); }
  }
  private schedule(trigger: Trigger) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; void this.request(trigger); }, this.settings?.quickSuggestionsDelay ?? 100);
  }
  async request(trigger: Trigger, retry = 0) {
    clearTimeout(this.timer); this.timer = undefined;
    this.resolver.cancel();
    if (this.requestState) { this.post({ t: 'cancelCompletion', req: this.requestState.req }); }
    if (this.sync.composing || this.view?.composing) { this.close(); return; }
    const generation = ++this.generation;
    await this.sync.flush();
    const view = this.view;
    if (generation !== this.generation || !view?.hasFocus || view.composing || this.sync.composing || activeFormulaRange() || !this.sync.matches(view.state)) { return; }
    const at = view.state.selection.main.head;
    this.listed = []; this.selected = 0; this.popup?.hide();
    this.requestState = { req: `prose-${++requestNumber}`, version: this.sync.version, at, doc: view.state.doc, changes: ChangeSet.empty(view.state.doc.length), retry };
    this.post({ t: 'complete', req: this.requestState.req, version: this.sync.version, at, trigger, ctx: 'prose' });
  }
  receive(message: Extract<HostMessage, { t: 'completions' }>) {
    if (this.sync.composing || this.view?.composing) { this.close(); return; }
    const request = this.requestState;
    if (!request || request.req !== message.req) { return; }
    if (message.version !== request.version || message.at !== request.at) {
      if (request.retry === 0) { void this.request({ kind: 'incomplete' }, 1); } else { this.close(); }
      return;
    }
    request.items = message.items; request.incomplete = message.isIncomplete;
    this.filter();
    // A truncated provider result must be queried again for the prefix typed while it was in flight.
    if (message.isIncomplete && !request.changes.empty) { this.schedule({ kind: 'incomplete' }); }
  }
  receiveResolved(message: Extract<HostMessage, { t: 'completionResolved' }>) { this.resolver.receive(message); }
  private mapItem(item: CompletionItemDTO, request: Request): CompletionItemDTO {
    const m = request.changes, r = item.range;
    return { ...item, range: { insFrom: m.mapPos(r.insFrom, -1), insTo: m.mapPos(r.insTo, 1), repFrom: m.mapPos(r.repFrom, -1), repTo: m.mapPos(r.repTo, 1) },
      extraEdits: item.extraEdits?.map(e => ({ ...e, from: m.mapPos(e.from, -1), to: m.mapPos(e.to, 1) })) };
  }
  private filter() {
    const view = this.view, request = this.requestState;
    if (!view || !request?.items) { return; }
    const old = this.listed[this.selected]?.i;
    const head = view.state.selection.main.head;
    const mapped = request.items.filter(i => [i.range.insFrom, i.range.insTo, i.range.repFrom, i.range.repTo, ...(i.extraEdits?.flatMap(e => [e.from, e.to]) ?? [])].every(p => p >= 0 && p <= request.doc.length))
      .map(i => this.mapItem(i, request));
    // Each provider may choose a different replacement start (Workshop excludes the backslash).
    const candidates = mapped.flatMap((item, index) => {
      const score = item.range.insFrom <= head ? completionScore(view.state.doc.sliceString(item.range.insFrom, head), item.filterText ?? item.label) : null;
      return score === null ? [] : [{ item, index, score }];
    });
    candidates.sort((a, b) => b.score - a.score || Number(Boolean(b.item.preselect)) - Number(Boolean(a.item.preselect))
      || (a.item.sortText ?? a.item.label).localeCompare(b.item.sortText ?? b.item.label) || a.index - b.index);
    this.listed = candidates.slice(0, 300).map(c => c.item);
    this.selected = Math.max(0, this.listed.findIndex(i => i.i === old));
    if (old === undefined) { const preselect = this.listed.findIndex(i => i.preselect); if (preselect >= 0) { this.selected = preselect; } }
    this.render();
  }
  private render() { if (this.view) { this.popup?.show(this.listed, this.selected, this.view.state.selection.main.head); } }
  private move(delta: number) {
    if (!this.listed.length) { return false; }
    this.resolver.cancel();
    this.selected = (this.selected + delta + this.listed.length) % this.listed.length; this.render(); return true;
  }
  private variables(from: number, to: number): Record<string, string> {
    const state = this.view!.state, line = state.doc.lineAt(state.selection.main.head);
    const path = decodeURIComponent(this.uri.replace(/^file:\/\//, '')), filename = path.split('/').pop() ?? '';
    const now = new Date();
    return { TM_SELECTED_TEXT: state.sliceDoc(state.selection.main.from, state.selection.main.to), TM_CURRENT_LINE: line.text,
      TM_CURRENT_WORD: state.sliceDoc(from, to).replace(/^\\/, ''), TM_LINE_INDEX: String(line.number - 1), TM_LINE_NUMBER: String(line.number),
      TM_FILENAME: filename, TM_FILENAME_BASE: filename.replace(/\.[^.]+$/, ''), TM_DIRECTORY: path.slice(0, path.lastIndexOf('/')), TM_FILEPATH: path,
      CURRENT_YEAR: String(now.getFullYear()), CURRENT_YEAR_SHORT: String(now.getFullYear()).slice(-2), CURRENT_MONTH: String(now.getMonth() + 1).padStart(2, '0'),
      CURRENT_DATE: String(now.getDate()).padStart(2, '0'), CURRENT_HOUR: String(now.getHours()).padStart(2, '0'), CURRENT_MINUTE: String(now.getMinutes()).padStart(2, '0'), CURRENT_SECOND: String(now.getSeconds()).padStart(2, '0') };
  }
  private accept(): boolean {
    if (this.sync.composing || this.view?.composing) { this.close(); return false; }
    const item = this.listed[this.selected], view = this.view, request = this.requestState;
    if (!item || !view || !request) { return false; }
    if (item.needsResolve) {
      if (this.resolver.pending) { return true; }
      clearTimeout(this.timer); this.timer = undefined;
      const at = view.state.selection.main.head, generation = this.generation;
      this.resolver.start(request.req, item.i, view, at,
        () => this.requestState === request && this.generation === generation && view.hasFocus && !view.composing
          && !this.sync.composing && view.state.selection.main.head === at && this.listed[this.selected]?.i === item.i,
        (resolved, version) => {
          if (!resolved || resolved.needsResolve) {
            this.post({ t: 'log', level: 'warn', message: 'Completion changed while resolving; choose it again.' });
            void this.request({ kind: 'invoke' }); return;
          }
          this.requestState = { ...request, version, at, doc: view.state.doc, changes: ChangeSet.empty(view.state.doc.length), items: [resolved], incomplete: false };
          this.listed = [resolved]; this.selected = 0; this.accept();
        });
      return true;
    }
    const from = this.settings?.suggestReplace ? item.range.repFrom : item.range.insFrom;
    const to = this.settings?.suggestReplace ? item.range.repTo : item.range.insTo;
    const parsed = item.insert.snippet ? parseSnippet(item.insert.value, this.variables(from, to)) : { text: item.insert.value, tabstops: [] };
    const primary = { from, to, insert: parsed.text };
    const edits = [primary, ...(item.extraEdits ?? [])].sort((a, b) => a.from - b.from || a.to - b.to);
    if (edits.some((e, i) => e.from < 0 || e.to < e.from || e.to > view.state.doc.length
      || i > 0 && (e.from < edits[i - 1]!.to || e.from === edits[i - 1]!.from))) { this.close(); return true; }
    const changes = ChangeSet.of(edits, view.state.doc.length);
    const start = from + edits.slice(0, edits.indexOf(primary)).reduce((delta, e) => delta + e.insert.length - (e.to - e.from), 0);
    const stops = parsed.tabstops.map(s => ({ ...s, from: start + s.from, to: start + s.to }));
    this.close(); this.accepting = true;
    try {
      view.dispatch({ changes, ...snippetSpec(stops, start + parsed.text.length, stops.length === 0), annotations: [editKind.of('completion'), Transaction.userEvent.of('input.complete')], scrollIntoView: true });
    } finally { this.accepting = false; }
    void this.sync.flush().then(() => {
      if (item.command === 'triggerSuggest') { return this.request({ kind: 'invoke' }); }
      if (item.command === 'host') { this.post({ t: 'runItemCommand', req: request.req, item: item.i }); }
    });
    return true;
  }
  close() {
    this.resolver.cancel();
    if (this.requestState) { this.post({ t: 'cancelCompletion', req: this.requestState.req }); }
    clearTimeout(this.timer); this.timer = undefined; this.generation++; this.requestState = undefined; this.listed = []; this.selected = 0; this.popup?.hide();
  }
}
