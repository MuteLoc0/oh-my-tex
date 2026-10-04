import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Spike S3: what does executeCompletionItemProvider return for a document only open in our custom editor? */
suite('spike: completion through the command API', () => {
  test('Workshop items for \\use, \\usepackage{, project macros and math commands', async function () {
    this.timeout(60000);
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    console.log('[spike] workshop installed:', !!workshop);
    if (!workshop) { this.skip(); }
    await workshop!.activate();
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'main.tex');
    await vscode.commands.executeCommand('vscode.openWith', uri, 'oh-my-tex.visual');
    const document = await vscode.workspace.openTextDocument(uri);
    console.log('[spike] languageId:', document.languageId, 'activeTextEditor:', vscode.window.activeTextEditor?.document.uri.toString());
    await sleep(3000); // let Workshop index the project
    const edit = new vscode.WorkspaceEdit();
    const line = document.lineCount - 1;
    edit.insert(uri, new vscode.Position(line, 0), '\\use\n$\\fr$ $\\ke$\n\\usepackage{ams}\n');
    await vscode.workspace.applyEdit(edit);
    const query = async (l: number, c: number, trigger?: string) => {
      const t0 = Date.now();
      const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, new vscode.Position(l, c), trigger, 2000);
      return { list, ms: Date.now() - t0 };
    };
    const show = (name: string, r: { list: vscode.CompletionList; ms: number }, pick: (label: string) => boolean) => {
      const items = r.list.items;
      console.log(`[spike] ${name}: ${items.length} items in ${r.ms}ms, incomplete=${r.list.isIncomplete}, payload≈${JSON.stringify(items.map(i => ({ l: i.label, f: i.filterText, s: i.sortText }))).length}B`);
      for (const item of items.filter(i => pick(typeof i.label === 'string' ? i.label : i.label.label)).slice(0, 4)) {
        const range = item.range as vscode.Range | { inserting: vscode.Range; replacing: vscode.Range } | undefined;
        console.log('   ', JSON.stringify({
          label: item.label, kind: item.kind, filterText: item.filterText, sortText: item.sortText,
          insertText: item.insertText instanceof vscode.SnippetString ? { snippet: item.insertText.value } : item.insertText,
          range, command: item.command?.command, extra: item.additionalTextEdits?.length,
        }));
      }
    };
    show('\\use|', await query(line, 4), l => /usepackage/.test(l));
    show('\\use| (trigger \\)', await query(line, 1, '\\'), l => /^\\?usepackage$/.test(l));
    show('$\\fr|$', await query(line + 1, 4), l => /frac/.test(l));
    show('$\\ke|$ (project macro)', await query(line + 1, 9), l => /ket/.test(l));
    show('\\usepackage{ams|}', await query(line + 2, 15), l => /amsmath/.test(l));
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    assert.ok(true);
  });
});
