import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { toLF } from '../../src/core/eol.ts';
import { scanFormulas } from '../../src/core/formulaScanner.ts';
import { parseMacroCalls, editMacroArgument, deleteMacroCall } from '../../src/core/macroCalls.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';
import type { Patch } from '../../src/shared/types.ts';

const folder = () => vscode.workspace.workspaceFolders![0].uri;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(probe: () => T | undefined | PromiseLike<T | undefined>, what: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) { return value; }
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(50);
  }
}

suite('P4 macro argument host transactions', function () {
  this.timeout(60000);
  const cleanups: (() => Promise<void>)[] = [];
  let sequence = 0;

  teardown(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) { await cleanup(); }
  });

  async function fixture(name: string, text: string) {
    await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
    const uri = vscode.Uri.joinPath(folder(), name);
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const originalDisk = await vscode.workspace.fs.readFile(uri);
    const definitionUri = vscode.Uri.joinPath(folder(), 'macros.tex');
    const definitions = await vscode.workspace.openTextDocument(definitionUri);
    const definitionText = definitions.getText();
    const definitionDisk = await vscode.workspace.fs.readFile(definitionUri);
    assert.equal(definitions.isDirty, false, 'definition fixture must start clean');
    let opened = false;
    const replace = async (value: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), value);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    const unchanged = async () => {
      assert.equal(definitions.getText(), definitionText, 'macro definitions must remain byte-for-byte unchanged');
      assert.equal(definitions.isDirty, false, 'editing calls must not dirty macro definitions');
      assert.deepEqual(await vscode.workspace.fs.readFile(definitionUri), definitionDisk);
      assert.deepEqual(await vscode.workspace.fs.readFile(uri), originalDisk, 'unsaved call edits must not modify fixture files');
    };
    cleanups.push(async () => {
      await replace(original);
      if (opened) { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
      await unchanged();
    });
    await replace(text);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'oh-my-tex.visual');
    opened = true;
    await until(() => vscode.commands.executeCommand<boolean>('oh-my-tex.test.ready', uri.toString()), 'macro editor ready', 25000);
    const receive = (message: unknown) => vscode.commands.executeCommand('oh-my-tex.test.receive', uri.toString(), message);
    const sent = () => vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri.toString());
    const context = await until(async () => (await sent()).find(message => message.t === 'context' &&
      message.macros.some(macro => macro.name === 'pair')) as Extract<HostMessage, { t: 'context' }> | undefined, 'project macros');
    const macros = new Map(context.macros.map(macro => [macro.name, macro]));
    assert.ok(macros.has('ket') && macros.has('bra'));
    const body = () => {
      const lf = toLF(document.getText());
      const span = scanFormulas(lf)[0];
      assert.ok(span, 'fixture must contain a formula');
      const source = lf.slice(span.bodyFrom, span.bodyTo);
      return { source, offset: span.bodyFrom, calls: parseMacroCalls(source, macros, new Set(), span.bodyFrom) };
    };
    const commit = async (patch: Patch | undefined) => {
      assert.ok(patch, 'edit must produce a source patch');
      const txn = `p4-macro-${++sequence}`;
      await receive({ t: 'edit', txn, baseVersion: document.version, kind: 'macro-argument', patches: [patch] });
      const result = await until(async () => (await sent()).find(message => message.t === 'txnResult' && message.txn === txn) as
        Extract<HostMessage, { t: 'txnResult' }> | undefined, `macro transaction ${txn}`);
      assert.equal(result.ok, true, result.reason);
      assert.ok((await sent()).some(message => message.t === 'docChanged' && message.originTxn === txn));
      await unchanged();
    };
    const editArgument = async (name: string, index: number, value: string | null) => {
      const current = body();
      const call = current.calls.find(item => item.name === name);
      assert.ok(call, `missing call ${name}`);
      const patch = editMacroArgument(current.source, call, index, value, current.offset);
      await commit(patch);
      return patch!;
    };
    return { document, receive, body, commit, editArgument, unchanged };
  }

  test('minimal and optional parameter edits use project macros and retain native undo/redo', async () => {
    const before = '% !TeX root = ../main.tex\nCalls: $\\ket{x}+\\pair[z]{w}+a$.\n';
    const s = await fixture('sections/part.tex', before);
    const patch = await s.editArgument('ket', 1, 'y');
    assert.deepEqual({ expected: patch.expected, insert: patch.insert }, { expected: 'x', insert: 'y' });
    assert.equal(toLF(s.document.getText()), before.replace('\\ket{x}', '\\ket{y}'));
    await s.receive({ t: 'undo' });
    await until(() => toLF(s.document.getText()) === before, 'macro argument undo');
    await s.receive({ t: 'redo' });
    await until(() => toLF(s.document.getText()) === before.replace('\\ket{x}', '\\ket{y}'), 'macro argument redo');
    await s.editArgument('pair', 1, 'u');
    assert.ok(s.document.getText().includes('\\pair[u]{w}'));
    await s.editArgument('pair', 1, '');
    assert.ok(s.document.getText().includes('\\pair[]{w}'));
    await s.editArgument('pair', 1, null);
    assert.ok(s.document.getText().includes('\\pair{w}'));
    await s.editArgument('pair', 1, 'v');
    assert.equal(toLF(s.document.getText()), before.replace('\\ket{x}', '\\ket{y}').replace('[z]', '[v]'));
    await s.unchanged();
  });

  test('nested arguments, unbraced growth and deletion preserve enclosing formula source', async () => {
    const before = '% !TeX root = ../main.tex\nCalls: $\\bra{\\ket{\\psi}}+\\ket x+a$.\n';
    const s = await fixture('sections/part.tex', before);
    const initial = s.body();
    const inner = initial.calls.find(call => call.name === 'ket' && call.parentId);
    assert.ok(inner);
    const patch = editMacroArgument(initial.source, inner, 1, '\\phi', initial.offset);
    assert.equal(patch?.expected, 's');
    assert.equal(patch?.insert, 'h');
    await s.commit(patch);
    assert.equal(toLF(s.document.getText()), before.replace('\\psi', '\\phi'));
    const current = s.body();
    const unbraced = current.calls.find(call => call.name === 'ket' && !call.parentId);
    assert.ok(unbraced);
    await s.commit(editMacroArgument(current.source, unbraced, 1, 'xy', current.offset));
    assert.equal(toLF(s.document.getText()), before.replace('\\psi', '\\phi').replace('\\ket x', '\\ket{xy}'));
    const grown = s.body();
    const outer = grown.calls.find(call => call.name === 'bra');
    assert.ok(outer);
    const deletion = deleteMacroCall(grown.source, outer, grown.offset);
    assert.equal(deletion.expected, '\\bra{\\ket{\\phi}}');
    await s.commit(deletion);
    assert.equal(toLF(s.document.getText()), '% !TeX root = ../main.tex\nCalls: $+\\ket{xy}+a$.\n');
    await s.unchanged();
  });

  test('macro patches after multiple CRLF lines use LF body offsets', async () => {
    const before = '% !TeX root = main.tex\nline one 😀\nline two\n$\\pair{w}+\\ket{x}$\n';
    const s = await fixture('crlf.tex', before);
    assert.equal(s.document.eol, vscode.EndOfLine.CRLF);
    const rawBefore = s.document.getText();
    const patch = await s.editArgument('ket', 1, 'y');
    assert.equal(patch.from, before.indexOf('x}'));
    assert.equal(rawBefore.indexOf('x}') - patch.from, 3, 'three CRLF lines precede the edited parameter');
    assert.equal(s.document.getText(), before.replace('\\ket{x}', '\\ket{y}').replace(/\n/g, '\r\n'));
    await s.editArgument('pair', 1, 'z');
    assert.equal(s.document.getText(), before.replace('\\ket{x}', '\\ket{y}').replace('\\pair{w}', '\\pair[z]{w}').replace(/\n/g, '\r\n'));
    await s.unchanged();
  });
});
