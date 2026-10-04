import * as vscode from 'vscode';
import { LineIndex, toLF } from '../core/eol.ts';
import { applyPatches, validatePatches } from '../core/patch.ts';
import { SerialQueue } from '../core/serial.ts';
import type { Change, Patch } from '../shared/types.ts';
import { log } from './log.ts';

export interface SyncListener {
  changed(version: number, changes: Change[], originTxn?: string): void;
  reset(version: number, text: string): void;
}

/** LF-normalised mirror of one TextDocument, kept in step with change events. */
class Mirror {
  index: LineIndex;
  version: number;
  listeners = new Set<SyncListener>();
  /** The webview transaction whose change event has not arrived yet. */
  applying?: string;
  private eventSeen?: () => void;
  waitForEvent(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.eventSeen = undefined; resolve(); }, ms);
      this.eventSeen = () => { clearTimeout(timer); this.eventSeen = undefined; resolve(); };
    });
  }
  sawEvent() { this.eventSeen?.(); }
  readonly document: vscode.TextDocument;
  constructor(document: vscode.TextDocument) {
    this.document = document;
    this.index = new LineIndex(toLF(document.getText()));
    this.version = document.version;
  }
  get text() { return this.index.text; }
}

/** Owns every webview write to a TextDocument: versioned, expected-text checked, serialized per document. */
export class DocumentSync implements vscode.Disposable {
  private mirrors = new Map<string, Mirror>();
  private queue = new SerialQueue();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(event => this.onChange(event)));
  }

  attach(document: vscode.TextDocument, listener: SyncListener): { text: string; version: number; dispose(): void } {
    const key = document.uri.toString();
    let mirror = this.mirrors.get(key);
    if (!mirror || mirror.version !== document.version) {
      const listeners = mirror?.listeners ?? new Set<SyncListener>();
      mirror = new Mirror(document); mirror.listeners = listeners;
      this.mirrors.set(key, mirror);
    }
    mirror.listeners.add(listener);
    const owned = mirror;
    return {
      text: mirror.text, version: mirror.version,
      dispose: () => { owned.listeners.delete(listener); if (!owned.listeners.size && this.mirrors.get(key) === owned) { this.mirrors.delete(key); } },
    };
  }

  text(document: vscode.TextDocument): string { return this.mirror(document).text; }

  toPosition(document: vscode.TextDocument, offset: number): vscode.Position {
    const p = this.mirror(document).index.positionAt(offset);
    return new vscode.Position(p.line, p.character);
  }

  toOffset(document: vscode.TextDocument, position: vscode.Position): number {
    return this.mirror(document).index.offsetAt(position.line, position.character);
  }

  /** Apply a webview transaction. Rejects (without touching the document) if anything is stale. */
  apply(document: vscode.TextDocument, txn: string, baseVersion: number, patches: Patch[]): Promise<string | undefined> {
    return this.queue.run(document.uri.toString(), async () => {
      const mirror = this.mirror(document);
      if (baseVersion !== document.version || mirror.version !== document.version) { return 'stale'; }
      const reason = validatePatches(mirror.text, patches);
      if (reason) { return reason; }
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const edit = new vscode.WorkspaceEdit();
      for (const p of patches) {
        edit.replace(document.uri, new vscode.Range(this.toPosition(document, p.from), this.toPosition(document, p.to)), eol === '\n' ? p.insert : p.insert.replace(/\n/g, eol));
      }
      mirror.applying = txn;
      try {
        if (!await vscode.workspace.applyEdit(edit)) { return 'applyFailed'; }
        // The change event normally precedes the applyEdit reply; tolerate it arriving just after.
        if (mirror.applying === txn) { await mirror.waitForEvent(250); }
      } finally { if (mirror.applying === txn) { mirror.applying = undefined; } }
      return undefined;
    });
  }

  idle(document: vscode.TextDocument): Promise<void> { return this.queue.idle(document.uri.toString()); }

  private mirror(document: vscode.TextDocument): Mirror {
    let mirror = this.mirrors.get(document.uri.toString());
    if (!mirror || mirror.version !== document.version) {
      const listeners = mirror?.listeners ?? new Set<SyncListener>();
      mirror = new Mirror(document); mirror.listeners = listeners;
      this.mirrors.set(document.uri.toString(), mirror);
    }
    return mirror;
  }

  private onChange(event: vscode.TextDocumentChangeEvent) {
    const mirror = this.mirrors.get(event.document.uri.toString());
    if (!mirror) { return; }
    if (!event.contentChanges.length) { mirror.version = event.document.version; return; }
    // Content changes are relative to the pre-event document; apply them back to front.
    const changes: Change[] = event.contentChanges.map(c => ({
      from: mirror.index.offsetAt(c.range.start.line, c.range.start.character),
      to: mirror.index.offsetAt(c.range.end.line, c.range.end.character),
      insert: toLF(c.text),
    })).sort((a, b) => b.from - a.from);
    const next = applyPatches(mirror.text, changes);
    const actual = toLF(event.document.getText());
    mirror.version = event.document.version;
    mirror.index = new LineIndex(actual);
    if (next !== actual) {
      log().warn(`mirror drift on ${event.document.uri.toString()}; resetting webviews`);
      for (const l of mirror.listeners) { l.reset(mirror.version, actual); }
      return;
    }
    const origin = mirror.applying;
    mirror.applying = undefined;
    mirror.sawEvent();
    // Base-relative and ascending, as CodeMirror's ChangeSet.of expects.
    const ascending = changes.reverse();
    for (const l of mirror.listeners) { l.changed(mirror.version, ascending, origin); }
  }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}
