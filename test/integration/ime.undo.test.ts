import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { DocumentSync } from '../../src/host/documentSync.ts';

suite('P6.5 composition document history', () => {
  test('one committed Chinese word is one native VS Code undo and redo', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: 'Prefix ' });
    await vscode.window.showTextDocument(document);
    const sync = new DocumentSync();
    const attachment = sync.attach(document, { changed: () => {}, reset: () => {} });
    try {
      assert.equal(await sync.apply(document, 'ime-native-undo', document.version, [
        { from: 7, to: 7, expected: '', insert: '公式中文' },
      ]), undefined);
      assert.equal(document.getText(), 'Prefix 公式中文');
      await vscode.commands.executeCommand('undo');
      assert.equal(document.getText(), 'Prefix ', 'one native undo must remove the entire committed word');
      await vscode.commands.executeCommand('redo');
      assert.equal(document.getText(), 'Prefix 公式中文', 'one native redo must restore the entire committed word');
    } finally {
      attachment.dispose(); sync.dispose();
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
