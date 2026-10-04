import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { DocumentSync } from '../../src/host/documentSync.ts';
import { Session, type SessionServices } from '../../src/host/session.ts';
import { WorkshopBridge } from '../../src/host/workshopBridge.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';

// Instrument only the installed test extension. Production integration uses
// public VS Code commands, never these version-specific Workshop internals.
const load = createRequire(__filename);
type Runtime = {
  commands: { synctex: () => unknown; view: () => unknown };
  root: { file: { path?: string }; find: () => Promise<void> };
};
let workshop: vscode.Extension<unknown>, runtime: Runtime;
let originalSettings: Uint8Array | undefined;
const settingsFile = () => vscode.Uri.joinPath(folder(), '.vscode', 'settings.json');
const cleanup: (() => void | PromiseLike<void>)[] = [];
const files: vscode.Uri[] = [];
const folder = () => vscode.workspace.workspaceFolders![0].uri;

async function until(probe: () => boolean | PromiseLike<boolean>, description: string, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!await probe()) {
    if (Date.now() >= deadline) { throw new Error(`Timed out waiting for ${description}`); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function config(section: string, key: string, value: unknown) {
  const config = vscode.workspace.getConfiguration(section), before = config.inspect(key)?.workspaceValue;
  await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  cleanup.push(() => config.update(key, before, vscode.ConfigurationTarget.Workspace));
}

async function document(text = '\\documentclass{article}\n\\begin{document}\nThird line $x$.\n\\end{document}\n') {
  const uri = vscode.Uri.joinPath(folder(), `.omt-p5-${randomUUID()}.tex`);
  files.push(uri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(text));
  return vscode.workspace.openTextDocument(uri);
}

function harness(document: vscode.TextDocument, bridge = new WorkshopBridge()) {
  const sync = new DocumentSync(), messages: HostMessage[] = [], receive = new vscode.EventEmitter<unknown>();
  let restores = 0;
  let onFlush: ((req: string) => Promise<void>) | undefined;
  const panel = {
    viewColumn: vscode.ViewColumn.One, active: true,
    reveal: () => { restores++; },
    webview: {
      onDidReceiveMessage: receive.event,
      postMessage: async (message: HostMessage) => {
        messages.push(message);
        if (message.t === 'command' && message.name === 'flush' && message.req && onFlush) {
          void Promise.resolve().then(() => onFlush!(message.req!));
        }
        return true;
      },
    },
  } as unknown as vscode.WebviewPanel;
  const services = {
    sync, workshop: bridge, completion: { dispose: () => {} },
    project: {
      onDidChange: new vscode.EventEmitter<string>().event,
      rootOf: async () => document.uri.toString(),
      context: async () => ({ contextVersion: 0, macros: [], templates: [], diagnostics: [] }),
    },
  } as unknown as SessionServices;
  const session = new Session(document, panel, services);
  cleanup.push(() => { session.dispose(); sync.dispose(); receive.dispose(); });
  return {
    session, bridge, sync, messages, panel, restores: () => restores,
    flush: (action: (req: string) => Promise<void>) => { onFlush = action; },
    ack: (req: string) => session.receive({ t: 'flushed', req, ok: true }),
    select: (anchor: number, head = anchor) => session.receive({ t: 'selection', version: document.version, anchor, head }),
  };
}

suite('P5 Workshop bridge', () => {
  suiteSetup(async function () {
    this.timeout(60000);
    try { originalSettings = await vscode.workspace.fs.readFile(settingsFile()); } catch { originalSettings = undefined; }
    workshop = vscode.extensions.getExtension('James-Yu.latex-workshop')!;
    assert.ok(workshop, 'Workshop must be installed in the integration profile');
    assert.equal(workshop.packageJSON.version, '10.19.0');
    await workshop.activate();
    runtime = load(join(workshop.extensionPath, 'out/src/lw.js')).lw as Runtime;
  });
  suiteTeardown(async () => {
    if (originalSettings) { await vscode.workspace.fs.writeFile(settingsFile(), originalSettings); }
    else { try { await vscode.workspace.fs.delete(settingsFile()); } catch { /* No configuration was written. */ } }
  });
  setup(async () => { await config('latex-workshop', 'latex.autoBuild.run', 'never'); });
  teardown(async () => {
    for (const dispose of cleanup.splice(0).reverse()) { await dispose(); }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const file of files.splice(0)) { await vscode.workspace.fs.delete(file); }
  });

  test('flush applies pending changes before SyncTeX captures the CRLF cursor and backwards selection', async () => {
    const doc = await document('\\documentclass{article}\r\nline two\r\nline three\r\n'), h = harness(doc);
    const previous = runtime.commands.synctex;
    let seen: { uri: string; selection: vscode.Selection; text: string } | undefined;
    runtime.commands.synctex = () => {
      const editor = vscode.window.activeTextEditor!;
      seen = { uri: editor.document.uri.toString(), selection: editor.selection, text: editor.document.getText() };
    };
    cleanup.push(() => { runtime.commands.synctex = previous; });
    h.flush(async req => {
      await h.sync.apply(doc, 'p5-flush', doc.version, [{ from: 0, to: 0, expected: '', insert: '% pending\n' }]);
      const text = h.sync.text(doc), head = text.indexOf('three');
      await h.select(head + 5, head);
      await h.ack(req);
    });
    const other = await vscode.workspace.openTextDocument({ content: 'Another active editor', language: 'plaintext' });
    await vscode.window.showTextDocument(other);
    await h.session.synctex();
    assert.ok(seen);
    assert.equal(seen.uri, doc.uri.toString());
    assert.ok(seen.text.startsWith('% pending\r\n'));
    assert.equal(seen.selection.anchor.line, 3);
    assert.equal(seen.selection.anchor.character, 10);
    assert.equal(seen.selection.active.line, 3);
    assert.equal(seen.selection.active.character, 5);
    assert.equal(seen.selection.isReversed, true);
    assert.equal(h.restores(), 1);
  });

  test('returnToVisualEditor=false leaves the native editor active after SyncTeX', async () => {
    await config('oh-my-tex', 'workshop.returnToVisualEditor', false);
    const doc = await document(), h = harness(doc);
    const previous = runtime.commands.synctex;
    runtime.commands.synctex = () => {};
    cleanup.push(() => { runtime.commands.synctex = previous; });
    h.flush(async req => { await h.select(0); await h.ack(req); });
    await h.session.synctex();
    assert.equal(vscode.window.activeTextEditor?.document.uri.toString(), doc.uri.toString());
    assert.equal(h.restores(), 0);
  });

  test('focus-sensitive commands serialize across documents and recover after a failed command', async () => {
    const bridge = new WorkshopBridge(), a = await document(), b = await document();
    const ha = harness(a, bridge), hb = harness(b, bridge), order: string[] = [];
    const previous = runtime.commands.synctex;
    let release: () => void = () => {}, started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    runtime.commands.synctex = async () => {
      const uri = vscode.window.activeTextEditor!.document.uri.toString();
      order.push(uri);
      if (order.length === 1) { started(); await waiting; assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), uri); throw new Error('fixture failure'); }
    };
    cleanup.push(() => { runtime.commands.synctex = previous; });
    const selection = new vscode.Selection(2, 0, 2, 0);
    const first = bridge.synctex(a, selection, ha.panel);
    const rejected = assert.rejects(first, /fixture failure/);
    await entered;
    const second = bridge.synctex(b, selection, hb.panel);
    assert.deepEqual(order, [a.uri.toString()]);
    release();
    await rejected;
    await second;
    assert.deepEqual(order, [a.uri.toString(), b.uri.toString()]);
    assert.equal(bridge.positioning, false);
  });

  test('explicit build saves to disk before the single manual build; ordinary Save uses Workshop onSave once', async () => {
    await config('latex-workshop', 'latex.autoBuild.run', 'onSave');
    await config('latex-workshop', 'latex.autoBuild.interval', 10000);
    const doc = await document(), h = harness(doc);
    h.flush(async req => { await h.select(0); await h.ack(req); });
    const executor = load(join(workshop.extensionPath, 'out/src/compile/executor.js')).executor as {
      run: (request: { isAuto: boolean }) => Promise<void>;
    };
    const original = executor.run, runs: { auto: boolean; active: string; disk: string; dirty: boolean }[] = [];
    executor.run = async request => {
      runs.push({ auto: request.isAuto, active: vscode.window.activeTextEditor!.document.uri.toString(),
        disk: Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString(), dirty: doc.isDirty });
    };
    cleanup.push(() => { executor.run = original; });
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(2, 0), 'Saved first. ');
    assert.equal(await vscode.workspace.applyEdit(edit), true);
    await h.session.build();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].auto, false);
    assert.equal(runs[0].active, doc.uri.toString());
    assert.equal(runs[0].dirty, false);
    assert.match(runs[0].disk, /Saved first/);
    await config('latex-workshop', 'latex.autoBuild.interval', 0);
    const autoEdit = new vscode.WorkspaceEdit();
    autoEdit.insert(doc.uri, new vscode.Position(2, 0), 'Auto save. ');
    assert.equal(await vscode.workspace.applyEdit(autoEdit), true);
    await h.session.save();
    // Workshop's onDidSave listener intentionally starts autoBuild without
    // awaiting it. Our instrumented executor also reads disk asynchronously.
    await until(() => runs.length >= 2, 'the native onSave build to read the saved source');
    assert.equal(runs.length, 2);
    assert.equal(runs[1].auto, true);
    assert.equal(runs[1].active, doc.uri.toString());
    assert.match(runs[1].disk, /Auto save/);
  });

  test('real visual same-column Save flushes once, saves dirty source and starts one native onSave build', async function () {
    this.timeout(30000);
    await config('oh-my-tex', 'workshop.nativeEditorColumn', 'same');
    await config('latex-workshop', 'latex.autoBuild.run', 'onSave');
    await config('latex-workshop', 'latex.autoBuild.interval', 0);
    await config('files', 'autoSave', 'off');
    const doc = await document(), uri = doc.uri.toString();
    await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'oh-my-tex.visual');
    await until(() => vscode.commands.executeCommand<boolean>('oh-my-tex.test.ready', uri), 'the real visual webview to initialize', 25000);
    await vscode.commands.executeCommand('oh-my-tex.test.show', uri);
    const sent = () => vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri);
    const receive = (message: unknown) => vscode.commands.executeCommand('oh-my-tex.test.receive', uri, message);
    const executor = load(join(workshop.extensionPath, 'out/src/compile/executor.js')).executor as {
      run: (request: { isAuto: boolean }) => Promise<void>;
    };
    const original = executor.run, runs: { auto: boolean; active: string; disk: string; dirty: boolean }[] = [];
    executor.run = async request => {
      // Capture synchronously: Session may restore the visual tab while disk I/O runs.
      const active = vscode.window.activeTextEditor!.document.uri.toString(), dirty = doc.isDirty;
      const disk = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)).toString();
      runs.push({ auto: request.isAuto, active, dirty, disk });
    };
    cleanup.push(() => { executor.run = original; });
    const insert = '% same-column saved edit\n', txn = randomUUID();
    await receive({ t: 'edit', txn, baseVersion: doc.version, kind: 'type',
      patches: [{ from: 0, to: 0, expected: '', insert }] });
    assert.equal(doc.isDirty, true);
    assert.ok((await sent()).some(message => message.t === 'txnResult' && message.txn === txn && message.ok));
    const flushes = (messages: HostMessage[]) => messages.filter(message => message.t === 'command' && message.name === 'flush').length;
    const before = flushes(await sent());
    await receive({ t: 'save' });
    await until(() => runs.length > 0, 'the real visual Save to trigger Workshop onSave');
    assert.equal(doc.isDirty, false);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].auto, true);
    assert.equal(runs[0].active, uri);
    assert.equal(runs[0].dirty, false);
    assert.ok(runs[0].disk.startsWith(insert));
    assert.equal(flushes(await sent()) - before, 1, 'onWillSave must reuse the completed flush after hiding the same-column webview');
    await until(() => vscode.window.tabGroups.activeTabGroup.activeTab?.input instanceof vscode.TabInputCustom,
      'the same-column visual editor to regain focus after Save');
    const active = vscode.window.tabGroups.activeTabGroup.activeTab!.input as vscode.TabInputCustom;
    assert.equal(active.viewType, 'oh-my-tex.visual');
    assert.equal(active.uri.toString(), uri);
  });

  test('reverse reveal preserves LF offsets, document version and selection direction', async () => {
    const doc = await document('one\r\ntwo\r\nthree\r\n'), h = harness(doc);
    h.session.reveal(new vscode.Selection(2, 5, 1, 1), false);
    assert.deepEqual(h.messages.at(-1), { t: 'reveal', version: doc.version, anchor: 13, head: 5, focus: false });
    const selection = h.session.selectionRange()!;
    assert.equal(selection.anchor.line, 2);
    assert.equal(selection.active.line, 1);
    assert.equal(selection.isReversed, true);
    await h.select(999999);
    assert.equal(h.session.selectionRange()!.anchor.line, 2, 'out-of-range webview selections are ignored');
  });

  test('failed or timed-out flush cancels commands and a disposed session rejects promptly', async () => {
    const doc = await document(), h = harness(doc);
    await assert.rejects(h.session.flush(25), /Timed out/);
    h.flush(req => h.session.receive({ t: 'flushed', req, ok: false }));
    await assert.rejects(h.session.synctex(), /could not flush/);
    assert.equal(h.restores(), 0);
    h.session.dispose();
    await assert.rejects(h.session.flush(), /editor was closed/);
  });

  test('syncRoot waits for Workshop root discovery through its public view command', async () => {
    const root = await document(), child = await document('Child without a documentclass.\n'), h = harness(child);
    const previous = runtime.commands.view;
    let seen: string | undefined;
    runtime.commands.view = async () => {
      assert.equal(vscode.window.activeTextEditor!.document.uri.toString(), root.uri.toString());
      await runtime.root.find();
      seen = runtime.root.file.path;
    };
    cleanup.push(() => { runtime.commands.view = previous; });
    await h.bridge.syncRoot(child, h.panel, root.uri.toString());
    assert.equal(seen, root.uri.fsPath);
    assert.equal(h.restores(), 0);
  });
});
