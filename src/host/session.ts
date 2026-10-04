import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { isWebMessage, PROTOCOL_VERSION, type HostMessage, type WebMessage } from '../shared/protocol.ts';
import type { DocumentSync } from './documentSync.ts';
import type { WorkshopBridge } from './workshopBridge.ts';
import type { CompletionBridge } from './completionBridge.ts';
import type { ProjectIndex } from './projectIndex.ts';
import { editorSettings } from './settings.ts';
import { log } from './log.ts';

export interface SessionServices { sync: DocumentSync; workshop: WorkshopBridge; completion: CompletionBridge; project: ProjectIndex }

/** One webview panel showing one document. */
export class Session implements vscode.Disposable {
  readonly id = randomBytes(6).toString('hex');
  /** LF offsets of the webview selection at `selectionVersion`. */
  private selection = { version: -1, anchor: 0, head: 0 };
  private reportedSelection = { version: -1, anchor: 0, head: 0 };
  private flushes = new Map<string, (error?: Error) => void>();
  private disposed = false;
  private settingsGeneration = 0;
  private contextGeneration = 0;
  private pendingReveal?: Extract<HostMessage, { t: 'reveal' }>;
  private disposables: vscode.Disposable[] = [];
  private attachment?: ReturnType<DocumentSync['attach']>;
  /** Test-only record of outgoing messages. */
  readonly sent: HostMessage[] = [];
  recordMessages = false;

  readonly document: vscode.TextDocument;
  readonly panel: vscode.WebviewPanel;
  private services: SessionServices;

  constructor(document: vscode.TextDocument, panel: vscode.WebviewPanel, services: SessionServices) {
    this.document = document; this.panel = panel; this.services = services;
    this.disposables.push(
      panel.webview.onDidReceiveMessage(message => { void this.receive(message).catch(error => {
        log().error(`message ${JSON.stringify((message as WebMessage)?.t)} failed: ${error instanceof Error ? error.stack : String(error)}`);
        if (['save', 'synctex', 'build', 'view', 'syncRoot', 'openNative'].includes((message as WebMessage)?.t)) { services.workshop.report(error); }
      }); }),
      services.project.onDidChange(uri => { if (uri === document.uri.toString()) { void this.sendContext(); } }),
    );
    const visibility = panel.onDidChangeViewState?.(() => {
      if (panel.visible && this.pendingReveal) {
        if (this.pendingReveal.version === document.version) { void this.post(this.pendingReveal); }
        else { this.pendingReveal = undefined; }
      }
    });
    if (visibility) { this.disposables.push(visibility); }
  }

  post(message: HostMessage) {
    if (this.recordMessages) { this.sent.push(message); }
    return this.panel.webview.postMessage(message);
  }

  async receive(message: unknown): Promise<void> {
    if (!isWebMessage(message)) { log().warn(`dropped malformed webview message`); return; }
    const { sync, workshop } = this.services;
    switch (message.t) {
      case 'ready': {
        // Theme loading reads files asynchronously. Attach and snapshot only
        // afterwards so concurrent native edits cannot precede an obsolete init.
        const settings = await editorSettings(this.document);
        if (this.disposed) { return; }
        this.attachment?.dispose();
        this.attachment = sync.attach(this.document, {
          changed: (version, changes, originTxn) => { void this.post({ t: 'docChanged', version, changes, originTxn }); },
          reset: (version, text) => { void this.post({ t: 'reset', version, text }); },
        });
        await this.post({ t: 'init', proto: PROTOCOL_VERSION, uri: this.document.uri.toString(), version: this.attachment.version, text: this.attachment.text, settings });
        await this.sendContext();
        break;
      }
      case 'resync':
        await this.post({ t: 'reset', version: this.document.version, text: sync.text(this.document) });
        break;
      case 'edit': {
        const reason = await sync.apply(this.document, message.txn, message.baseVersion, message.patches);
        if (reason) { log().info(`rejected ${message.kind} txn ${message.txn}: ${reason}`); }
        await this.post({ t: 'txnResult', txn: message.txn, ok: !reason, reason });
        break;
      }
      case 'flushed': this.flushes.get(message.req)?.(message.ok === false ? new Error('The editor could not flush pending changes.') : undefined); break;
      case 'selection': {
        const length = sync.text(this.document).length;
        if (message.version === this.document.version && message.anchor <= length && message.head <= length) {
          this.selection = this.reportedSelection = { version: message.version, anchor: message.anchor, head: message.head };
          if (this.pendingReveal?.version === message.version && this.pendingReveal.anchor === message.anchor && this.pendingReveal.head === message.head) { this.pendingReveal = undefined; }
        }
        break;
      }
      case 'undo': case 'redo':
        await sync.idle(this.document);
        // Our panel is the active editor, so the workbench routes this to the document's history.
        await vscode.commands.executeCommand(message.t);
        break;
      case 'save': await this.save(); break;
      case 'openNative': await this.openNative(); break;
      case 'synctex': await this.synctex(); break;
      case 'build': await this.build(); break;
      case 'view': await this.view(); break;
      case 'syncRoot': await this.syncRoot(); break;
      case 'complete': await this.services.completion.complete(this, message); break;
      case 'runItemCommand': await this.services.completion.runCommand(this, message.req, message.item); break;
      case 'log': log()[message.level](`[webview] ${message.message}`); break;
    }
  }

  async save() {
    await this.flush();
    const root = await this.services.project.rootOf(this.document);
    await this.services.workshop.save(this.document, this.selectionRange(), this.panel, root);
  }

  async synctex() {
    await this.flush();
    const root = await this.services.project.rootOf(this.document);
    const range = this.selectionRange();
    if (!range) { void vscode.window.showInformationMessage('Oh My TeX: cursor position is out of date; click in the editor and retry.'); return; }
    await this.services.workshop.synctex(this.document, range, this.panel, root);
  }

  async build() {
    await this.flush();
    const root = await this.services.project.rootOf(this.document);
    await this.services.workshop.build(this.document, this.selectionRange(), this.panel, root);
  }

  async openNative() { await this.flush(); await this.services.workshop.openNative(this.document, this.selectionRange(), this.panel); }

  async view() {
    await this.flush();
    const root = await this.services.project.rootOf(this.document);
    await this.services.workshop.view(this.document, this.selectionRange(), this.panel, root);
  }

  async syncRoot() {
    await this.flush();
    await this.services.workshop.syncRoot(this.document, this.panel, await this.services.project.rootOf(this.document));
  }

  /** Ask the webview to send any batched edits, then wait until they are applied. */
  flush(timeout = 1500): Promise<void> {
    const req = randomBytes(6).toString('hex');
    if (this.disposed) { return Promise.reject(new Error('The editor was closed before pending changes could be flushed.')); }
    return new Promise<void>((resolve, reject) => {
      const done = (error?: Error) => { clearTimeout(timer); this.flushes.delete(req); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => done(new Error('Timed out waiting for pending editor changes; retry after the editor responds.')), timeout);
      this.flushes.set(req, done);
      void this.post({ t: 'command', name: 'flush', req, stabilize: true }).then(delivered => {
        if (!delivered) { done(new Error('The editor could not receive the flush request.')); }
      }, error => done(error instanceof Error ? error : new Error(String(error))));
    }).then(() => this.services.sync.idle(this.document));
  }

  reveal(selection: vscode.Selection, focus: boolean) {
    const { sync } = this.services;
    const anchor = sync.toOffset(this.document, selection.anchor), head = sync.toOffset(this.document, selection.active);
    this.selection = { version: this.document.version, anchor, head };
    this.pendingReveal = { t: 'reveal', version: this.document.version, anchor, head, focus };
    void this.post(this.pendingReveal);
  }

  toggleSource() { void this.post({ t: 'command', name: 'toggleSource' }); }
  find() { void this.post({ t: 'command', name: 'find' }); }

  async sendContext() {
    const generation = ++this.contextGeneration;
    const context = await this.services.project.context(this.document);
    if (!this.disposed && generation === this.contextGeneration) { await this.post({ t: 'context', ...context }); }
  }

  completionContext() { return this.services.project.context(this.document); }

  async refreshSettings() {
    const generation = ++this.settingsGeneration, settings = await editorSettings(this.document);
    if (!this.disposed && generation === this.settingsGeneration) { await this.post({ t: 'settings', settings }); }
  }

  selectionSnapshot() { return { ...this.reportedSelection }; }

  selectionRange(): vscode.Selection | undefined {
    const length = this.services.sync.text(this.document).length;
    if (this.selection.version !== this.document.version || this.selection.anchor > length || this.selection.head > length) { return undefined; }
    const { sync } = this.services;
    return new vscode.Selection(sync.toPosition(this.document, this.selection.anchor), sync.toPosition(this.document, this.selection.head));
  }

  dispose() {
    if (this.disposed) { return; }
    this.disposed = true;
    for (const done of this.flushes.values()) { done(new Error('The editor was closed before pending changes could be flushed.')); }
    this.services.completion.dispose(this); this.attachment?.dispose(); this.disposables.forEach(d => d.dispose());
  }
}
