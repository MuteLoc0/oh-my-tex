import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CompletionBridge } from '../../src/host/completionBridge.ts';
import { ProjectIndex } from '../../src/host/projectIndex.ts';
import type { Session } from '../../src/host/session.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';

suite('P6.1 render macro host context', () => {
  test('display overrides are separate from project/user definitions and completion candidates', async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'main.tex');
    const document = await vscode.workspace.openTextDocument(uri);
    const source = document.getText();
    const disk = await vscode.workspace.fs.readFile(uri);
    const config = vscode.workspace.getConfiguration('oh-my-tex', uri);
    const originalMacros = config.inspect('macros')?.workspaceValue;
    const originalRenderMacros = config.inspect('renderMacros')?.workspaceValue;
    const state: vscode.Memento = { keys: () => [], get: () => undefined, update: async () => {} };
    const index = new ProjectIndex(state);
    const bridge = new CompletionBridge();
    let session: Session | undefined;
    try {
      await config.update('macros', {
        '\\omtnormal': { args: 1, def: '\\mathbf{#1}' },
        '\\ket': 'user definition loses to the project definition',
      }, vscode.ConfigurationTarget.Workspace);
      await config.update('renderMacros', {
        '\\omtrender': { args: 1, def: '\\mathit{#1}' },
        '\\ket': { args: 1, def: '\\mathbf{#1}' },
      }, vscode.ConfigurationTarget.Workspace);

      const context = await index.context(document);
      assert.ok(context.macros.some(macro => macro.name === 'omtnormal'));
      assert.ok(!context.macros.some(macro => macro.name === 'omtrender'));
      assert.equal(context.macros.find(macro => macro.name === 'ket')?.body, '\\left|#1\\right\\rangle');
      assert.deepEqual(context.renderMacros, [
        { name: 'omtrender', arity: 1, body: '\\mathit{#1}' },
        { name: 'ket', arity: 1, body: '\\mathbf{#1}' },
      ]);

      const completionDocument = await vscode.workspace.openTextDocument({ language: 'latex', content: '$\\omt$' });
      const sent: HostMessage[] = [];
      session = {
        document: completionDocument,
        completionContext: async () => context,
        post: async (message: HostMessage) => { sent.push(message); return true; },
      } as unknown as Session;
      await bridge.complete(session, {
        t: 'complete', req: 'render-macros-separate', version: completionDocument.version, at: 5,
        ctx: 'math', trigger: { kind: 'invoke' },
      });
      const reply = sent.find(message => message.t === 'completions');
      assert.ok(reply?.t === 'completions');
      assert.ok(reply.items.some(item => item.source === 'macro' && item.label === '\\omtnormal'));
      assert.ok(!reply.items.some(item => item.label === '\\omtrender'));
      assert.equal(document.getText(), source, 'display overrides must not change the source document');
      assert.deepEqual(await vscode.workspace.fs.readFile(uri), disk);
    } finally {
      if (session) { bridge.dispose(session); }
      index.dispose();
      await config.update('renderMacros', originalRenderMacros, vscode.ConfigurationTarget.Workspace);
      await config.update('macros', originalMacros, vscode.ConfigurationTarget.Workspace);
    }
  });
});
