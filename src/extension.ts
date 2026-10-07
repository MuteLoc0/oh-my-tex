import * as vscode from 'vscode';
import { CompletionBridge } from './host/completionBridge.ts';
import { DocumentSync } from './host/documentSync.ts';
import { EditorProvider, VIEW_TYPE } from './host/editorProvider.ts';
import { ProjectIndex } from './host/projectIndex.ts';
import { WorkshopBridge } from './host/workshopBridge.ts';
import { configureGrammarFallback } from './host/grammar.ts';

export async function activate(context: vscode.ExtensionContext) {
  configureGrammarFallback(context.extensionUri);
  const sync = new DocumentSync(), project = new ProjectIndex(context.workspaceState);
  const services = { sync, project, workshop: new WorkshopBridge(), completion: new CompletionBridge(context.globalStorageUri) };
  await services.workshop.refreshAvailability();
  const provider = new EditorProvider(context, services);
  const withSession = (action: (s: NonNullable<ReturnType<EditorProvider['active']>>) => unknown) => () => {
    const session = provider.active();
    if (session) { return Promise.resolve(action(session)).catch(error => services.workshop.report(error)); }
  };
  context.subscriptions.push(sync, project, services.completion, provider,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true } }),
    vscode.commands.registerCommand('oh-my-tex.toggleVisual', () => {
      const session = provider.active();
      if (session) { session.toggleSource(); return; }
      const uri = vscode.window.activeTextEditor?.document.uri;
      if (uri?.path.endsWith('.tex')) { return vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE); }
    }),
    vscode.commands.registerCommand('oh-my-tex.openSource', withSession(s => s.openNative())),
    vscode.commands.registerCommand('oh-my-tex.synctex', withSession(s => s.synctex())),
    vscode.commands.registerCommand('oh-my-tex.build', withSession(s => s.build())),
    vscode.commands.registerCommand('oh-my-tex.view', withSession(s => s.view())),
    vscode.commands.registerCommand('oh-my-tex.syncRoot', withSession(s => s.syncRoot())),
    vscode.commands.registerCommand('oh-my-tex.find', withSession(s => s.find())),
    vscode.commands.registerCommand('oh-my-tex.chooseRoot', () => {
      const document = provider.active()?.document ?? vscode.window.activeTextEditor?.document;
      if (document) { return project.chooseRoot(document); }
    }),
  );
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    // Integration tests drive sessions as if they were the webview.
    const find = (uri: string) => [...provider.sessions].find(s => s.document.uri.toString() === uri);
    context.subscriptions.push(
      vscode.commands.registerCommand('oh-my-tex.test.receive', (uri: string, message: unknown) => find(uri)?.receive(message)),
      vscode.commands.registerCommand('oh-my-tex.test.ready', (uri: string) => !!find(uri)?.sent.some(m => m.t === 'init')),
      vscode.commands.registerCommand('oh-my-tex.test.sent', (uri: string) => find(uri)?.sent ?? []),
      vscode.commands.registerCommand('oh-my-tex.test.rootSelection', (uri: string, root?: string) => context.workspaceState.update(`root:${uri}`, root)),
      vscode.commands.registerCommand('oh-my-tex.test.selection', (uri: string) => find(uri)?.selectionSnapshot()),
      vscode.commands.registerCommand('oh-my-tex.test.show', (uri: string) => {
        const session = find(uri); session?.panel.reveal(session.panel.viewColumn, false); return session?.panel.viewColumn;
      }),
    );
  }
}

export function deactivate() {}
