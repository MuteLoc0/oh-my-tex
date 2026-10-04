import type { Page } from '@playwright/test';
import { applyPatches, validatePatches } from '../../src/core/patch.ts';
import type { Change, MacroDef, EditorSettings } from '../../src/shared/types.ts';
import type { CompletionItemDTO, WebMessage } from '../../src/shared/protocol.ts';

export type CompletionRequest = Extract<WebMessage, { t: 'complete' }>;
export interface CompletionResponse {
  items: CompletionItemDTO[];
  isIncomplete?: boolean;
  version?: number;
  at?: number;
}
export interface MockHostOptions {
  completion?: (request: CompletionRequest, host: MockHost) => CompletionResponse | Promise<CompletionResponse>;
  completionDelay?: number;
  beforeEditAck?: (edit: Extract<WebMessage, { t: 'edit' }>, host: MockHost) => void | Promise<void>;
  settings?: Partial<EditorSettings>;
  renderMacros?: MacroDef[];
  contextVersion?: number;
}

export const settings: EditorSettings = {
  fontFamily: 'Menlo, monospace', fontSize: 14, fontWeight: 'normal', lineHeight: 21, tabSize: 2, insertSpaces: true, wordWrap: true,
  quickSuggestions: true, suggestReplace: false, inlineShortcuts: true, triggerCharacters: ['\\', '{'], tokens: {},
  // Existing acceptance tests also cover the opt-in Enter binding. Tab-only
  // tests explicitly omit/disable this setting to exercise the product default.
  completionAcceptOnEnter: true,
};

/** A fake extension host: holds the document, applies edits exactly like DocumentSync. */
export class MockHost {
  text: string; version = 1;
  edits: Extract<WebMessage, { t: 'edit' }>[] = [];
  requests: CompletionRequest[] = [];
  commands: Extract<WebMessage, { t: 'runItemCommand' }>[] = [];
  completionDocuments: { text: string; version: number }[] = [];
  currentSettings: EditorSettings;
  private page: Page;
  private macros: MacroDef[];
  private options: MockHostOptions;
  private flushed = new Set<string>();
  private flushCounter = 0;
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  constructor(page: Page, text: string, macros: MacroDef[] = [], options: MockHostOptions = {}) {
    this.page = page; this.text = text; this.macros = macros; this.options = options;
    this.currentSettings = { ...settings, ...options.settings };
  }

  async open() {
    await this.page.exposeFunction('__toHost', (m: WebMessage) => this.receive(m));
    await this.page.goto('http://127.0.0.1:41731/test/browser/harness.html');
    await this.page.waitForSelector('body[data-ready="true"]');
    await this.page.waitForTimeout(100);
  }

  private send(message: unknown) { return this.page.evaluate(m => window.postMessage(m, '*'), message); }

  private async receive(m: WebMessage) {
    if (m.t === 'ready') {
      await this.send({ t: 'init', proto: 1, uri: 'file:///t.tex', version: this.version, text: this.text, settings: this.currentSettings });
      await this.send({ t: 'context', contextVersion: this.options.contextVersion ?? 1, macros: this.macros, renderMacros: this.options.renderMacros ?? [], templates: [], diagnostics: [] });
    } else if (m.t === 'edit') {
      this.edits.push(m);
      const reason = m.baseVersion !== this.version ? 'stale' : validatePatches(this.text, m.patches);
      if (!reason) {
        this.undoStack.push(this.text); this.redoStack = [];
        this.text = applyPatches(this.text, m.patches); this.version++;
        await this.options.beforeEditAck?.(m, this);
        await this.send({ t: 'docChanged', version: this.version, changes: m.patches.map(({ from, to, insert }) => ({ from, to, insert })), originTxn: m.txn });
      }
      await this.send({ t: 'txnResult', txn: m.txn, ok: !reason, reason });
    } else if (m.t === 'undo' || m.t === 'redo') {
      const stack = m.t === 'undo' ? this.undoStack : this.redoStack;
      const previous = stack.pop();
      if (previous !== undefined) {
        (m.t === 'undo' ? this.redoStack : this.undoStack).push(this.text);
        await this.remote([{ from: 0, to: this.text.length, insert: previous }]);
      }
    } else if (m.t === 'complete') {
      this.requests.push(m);
      this.completionDocuments.push({ text: this.text, version: this.version });
      const response = await this.options.completion?.(m, this) ?? { items: [] };
      if (this.options.completionDelay) { await new Promise(resolve => setTimeout(resolve, this.options.completionDelay)); }
      await this.send({
        t: 'completions', req: m.req, version: response.version ?? m.version, at: response.at ?? m.at,
        isIncomplete: response.isIncomplete ?? false, items: response.items,
      });
    } else if (m.t === 'runItemCommand') {
      this.commands.push(m);
    } else if (m.t === 'flushed') {
      this.flushed.add(m.req);
    } else if (m.t === 'resync') {
      await this.send({ t: 'reset', version: this.version, text: this.text });
    }
  }

  /** Ask the webview to send batched edits now and wait for the round trip. */
  async flush() {
    const before = this.edits.length;
    const req = `flush-${++this.flushCounter}`;
    await this.send({ t: 'command', name: 'flush', req });
    const deadline = Date.now() + 5000;
    while (!this.flushed.has(req)) {
      if (Date.now() > deadline) { throw new Error('Webview did not acknowledge the flush request'); }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    this.flushed.delete(req);
    return this.edits.slice(before);
  }

  /** Apply an external native-editor edit and deliver the authoritative document change. */
  async remote(changes: Change[]) {
    const patches = changes.map(change => ({ ...change, expected: this.text.slice(change.from, change.to) }));
    const reason = validatePatches(this.text, patches);
    if (reason) { throw new Error(`Invalid remote edit: ${reason}`); }
    this.text = applyPatches(this.text, patches); this.version++;
    await this.send({ t: 'docChanged', version: this.version, changes });
  }

  async updateSettings(overrides: Partial<EditorSettings>) {
    this.currentSettings = { ...this.currentSettings, ...overrides };
    await this.send({ t: 'settings', settings: this.currentSettings });
  }

  async toggleSource() { await this.send({ t: 'command', name: 'toggleSource' }); }
}
