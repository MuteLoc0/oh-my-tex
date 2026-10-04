import * as vscode from 'vscode';
import { Session, type SessionServices } from './session.ts';
import { webviewHtml } from './webviewHtml.ts';

export const VIEW_TYPE = 'oh-my-tex.visual';

export class EditorProvider implements vscode.CustomTextEditorProvider, vscode.Disposable {
  readonly sessions = new Set<Session>();
  private disposables: vscode.Disposable[] = [];
  private savePanels = new Map<string, { panel: vscode.WebviewPanel; sameColumn: boolean }>();

  private context: vscode.ExtensionContext;
  private services: SessionServices;

  constructor(context: vscode.ExtensionContext, services: SessionServices) {
    this.context = context; this.services = services;
    const refresh = () => { for (const s of this.sessions) { void s.refreshSettings(); } };
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (['editor', 'workbench.colorTheme', 'workbench.colorCustomizations', 'latex-workshop.intellisense', 'oh-my-tex'].some(k => e.affectsConfiguration(k))) { refresh(); }
      }),
      vscode.window.onDidChangeActiveColorTheme(refresh),
      vscode.extensions.onDidChange(refresh),
      // Pending webview batches must reach the document before any save, wherever it is triggered.
      vscode.workspace.onWillSaveTextDocument(event => {
        // Our explicit save/build already flushed before opening the native tab.
        // Its same-column bridge may now hide/suspend the visual webview.
        if (services.workshop.hasFlushedSave(event.document)) { return; }
        const sessions = [...this.sessions].filter(s => s.document === event.document);
        if (sessions.length) { event.waitUntil((async () => {
          await Promise.all(sessions.map(s => s.flush(1000)));
          // One native bridge per document, even if several visual panels show it.
          const session = sessions.find(s => s.panel.active) ?? sessions[0];
          if (!services.workshop.isSaving(event.document) && services.workshop.wantsBuildOnSave(event.document)) {
            if (session.panel.active) {
              this.savePanels.set(event.document.uri.toString(), {
                panel: session.panel,
                sameColumn: vscode.workspace.getConfiguration('oh-my-tex', event.document.uri).get('workshop.nativeEditorColumn') === 'same',
              });
            }
            await services.workshop.prepareSave(event.document, session.selectionRange(), session.panel, await services.project.rootOf(event.document));
          }
          return [];
        })()); }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        const saved = this.savePanels.get(document.uri.toString());
        this.savePanels.delete(document.uri.toString());
        if (saved) {
          const { panel, sameColumn } = saved;
          // Run after every onDidSave listener: Workshop must first capture the native editor.
          setTimeout(() => {
            if ((panel.visible || sameColumn) && vscode.window.activeTextEditor?.document === document) {
              try { panel.reveal(panel.viewColumn, false); } catch { /* Panel was closed during save. */ }
            }
          }, 0);
        }
      }),
      // Reverse sync: a native selection (e.g. from PDF inverse search) follows into our views.
      vscode.window.onDidChangeTextEditorSelection(event => {
        if (services.workshop.ignoresSelection(event)) { return; }
        const selection = event.selections[0];
        if (!selection) { return; }
        for (const s of this.sessions) { if (s.document === event.textEditor.document) { s.reveal(selection, false); } }
      }),
    );
  }

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    const session = new Session(document, panel, this.services);
    session.recordMessages = this.context.extensionMode === vscode.ExtensionMode.Test;
    this.sessions.add(session);
    panel.onDidDispose(() => { this.sessions.delete(session); session.dispose(); });
    panel.webview.html = webviewHtml(panel.webview, this.context.extensionUri);
  }

  active(): Session | undefined { return [...this.sessions].find(s => s.panel.active); }

  dispose() { this.disposables.forEach(d => d.dispose()); }
}
