import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { HostMessage } from '../../src/shared/protocol.ts';

const folder = () => vscode.workspace.workspaceFolders![0].uri;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(probe: () => T | undefined | PromiseLike<T | undefined>, what: string, timeout = 15000): Promise<T> {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) { return value as T; }
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(50);
  }
}

async function open(name: string) {
  const uri = vscode.Uri.joinPath(folder(), name);
  await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
  await vscode.commands.executeCommand('vscode.openWith', uri, 'oh-my-tex.visual');
  // The real webview's `ready` attaches the session to the document.
  await until(() => vscode.commands.executeCommand<boolean>('oh-my-tex.test.ready', uri.toString()), 'webview ready', 25000);
  const document = await vscode.workspace.openTextDocument(uri);
  const receive = (message: unknown) => vscode.commands.executeCommand('oh-my-tex.test.receive', uri.toString(), message);
  const sent = () => vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri.toString());
  const result = (txn: string) => until(async () => (await sent()).find(m => m.t === 'txnResult' && m.txn === txn) as Extract<HostMessage, { t: 'txnResult' }> | undefined, `result of ${txn}`);
  return { uri, document, receive, sent, result };
}

suite('document sync', () => {
  teardown(async () => { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); });

  test('versioned patch applies and is echoed with its origin', async () => {
    const s = await open('main.tex');
    const at = s.document.getText().indexOf('mc^2');
    await s.receive({ t: 'edit', txn: 'a1', baseVersion: s.document.version, kind: 'math', patches: [{ from: at, to: at + 1, expected: 'm', insert: 'M' }] });
    const r = await s.result('a1');
    assert.equal(r.ok, true);
    assert.match(s.document.getText(), /E=Mc\^2/);
    assert.ok((await s.sent()).some(m => m.t === 'docChanged' && m.originTxn === 'a1'));
  });

  test('stale version and mismatched expected text are rejected without changes', async () => {
    const s = await open('main.tex');
    const before = s.document.getText(), at = before.indexOf('mc^2');
    await s.receive({ t: 'edit', txn: 'b1', baseVersion: s.document.version - 1, kind: 'type', patches: [{ from: at, to: at + 1, expected: 'm', insert: 'M' }] });
    assert.equal((await s.result('b1')).reason, 'stale');
    await s.receive({ t: 'edit', txn: 'b2', baseVersion: s.document.version, kind: 'type', patches: [{ from: at, to: at + 1, expected: 'x', insert: 'M' }] });
    assert.equal((await s.result('b2')).reason, 'expectedMismatch');
    await s.receive({ t: 'edit', txn: 'b3', baseVersion: s.document.version, kind: 'math', patches: [{ from: at, to: at, expected: '', insert: '\\placeholder{}' }] });
    assert.equal((await s.result('b3')).reason, 'placeholder leak');
    assert.equal(s.document.getText(), before);
  });

  test('undo and redo go through the document history', async () => {
    const s = await open('main.tex');
    const before = s.document.getText();
    await s.receive({ t: 'edit', txn: 'c1', baseVersion: s.document.version, kind: 'type', patches: [{ from: 0, to: 0, expected: '', insert: '% hello\n' }] });
    await s.result('c1');
    await s.receive({ t: 'undo' });
    await until(() => s.document.getText() === before, 'undo');
    await s.receive({ t: 'redo' });
    await until(() => s.document.getText().startsWith('% hello\n'), 'redo');
  });

  test('save writes the file', async () => {
    const s = await open('main.tex');
    await s.receive({ t: 'edit', txn: 'd1', baseVersion: s.document.version, kind: 'type', patches: [{ from: 0, to: 0, expected: '', insert: '%x\n' }] });
    await s.result('d1');
    assert.equal(s.document.isDirty, true);
    await s.receive({ t: 'save' });
    await until(() => !s.document.isDirty, 'save');
    const disk = Buffer.from(await vscode.workspace.fs.readFile(s.uri)).toString('utf8');
    assert.ok(disk.startsWith('%x\n'));
    // restore the fixture
    await s.receive({ t: 'edit', txn: 'd2', baseVersion: s.document.version, kind: 'type', patches: [{ from: 0, to: 3, expected: '%x\n', insert: '' }] });
    await s.result('d2');
    await s.receive({ t: 'save' });
    await until(() => !s.document.isDirty, 'restore save');
  });

  test('CRLF documents use LF offsets in the protocol', async () => {
    const s = await open('crlf.tex');
    assert.equal(s.document.eol, vscode.EndOfLine.CRLF);
    const lf = 'line one\nline two\nline three\n', at = lf.indexOf('three');
    await s.receive({ t: 'edit', txn: 'e1', baseVersion: s.document.version, kind: 'type', patches: [{ from: at, to: at + 5, expected: 'three', insert: '3\nand 4' }] });
    assert.equal((await s.result('e1')).ok, true);
    assert.equal(s.document.getText(), 'line one\r\nline two\r\nline 3\r\nand 4\r\n');
  });

  test('a native edit makes an older webview transaction stale; both survive after resend', async () => {
    const s = await open('main.tex');
    const base = s.document.version, text = s.document.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(s.uri, new vscode.Position(0, 0), '%native\n');
    await vscode.workspace.applyEdit(edit);
    const changed = await until(async () => (await s.sent()).find(m => m.t === 'docChanged' && !m.originTxn) as Extract<HostMessage, { t: 'docChanged' }> | undefined, 'native change');
    assert.deepEqual(changed.changes, [{ from: 0, to: 0, insert: '%native\n' }]);
    const at = text.indexOf('mc^2');
    await s.receive({ t: 'edit', txn: 'f1', baseVersion: base, kind: 'type', patches: [{ from: at, to: at + 1, expected: 'm', insert: 'M' }] });
    assert.equal((await s.result('f1')).reason, 'stale');
    const shifted = at + '%native\n'.length;
    await s.receive({ t: 'edit', txn: 'f2', baseVersion: s.document.version, kind: 'type', patches: [{ from: shifted, to: shifted + 1, expected: 'm', insert: 'M' }] });
    assert.equal((await s.result('f2')).ok, true);
    assert.ok(s.document.getText().startsWith('%native\n') && s.document.getText().includes('E=Mc^2'));
  });
});

suite('project context', () => {
  teardown(async () => { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); });

  test('macros from the root and its \\input files reach the webview; definition files stay clean', async () => {
    const s = await open('sections/part.tex');
    const context = await until(async () => (await s.sent()).find(m => m.t === 'context' && m.macros.length) as Extract<HostMessage, { t: 'context' }> | undefined, 'context');
    assert.deepEqual(context.macros.map(m => m.name).sort(), ['Tr', 'bra', 'ket', 'pair']);
    assert.equal(context.macros.find(m => m.name === 'pair')?.defaultArgument, 'x');
    const defs = vscode.workspace.textDocuments.find(d => d.uri.path.endsWith('/macros.tex'));
    assert.ok(!defs?.isDirty);
  });
});
