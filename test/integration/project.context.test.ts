import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ProjectIndex } from '../../src/host/projectIndex.ts';
import { Session, type SessionServices } from '../../src/host/session.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';
import type { ProjectContext } from '../../src/shared/types.ts';

const folder = () => vscode.workspace.workspaceFolders![0].uri;
const cleanup: (() => void | PromiseLike<void>)[] = [];
const directories: vscode.Uri[] = [];
const emptyState: vscode.Memento = { keys: () => [], get: () => undefined, update: async () => {} };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function until<T>(probe: () => T | undefined | PromiseLike<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 25000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) { return value; }
    if (Date.now() > deadline) { throw new Error(`Timed out waiting for ${description}`); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function fixture() {
  const directory = vscode.Uri.joinPath(folder(), `.omt-context-${randomUUID()}`);
  directories.push(directory);
  await vscode.workspace.fs.createDirectory(directory);
  const main = vscode.Uri.joinPath(directory, 'main.tex'), old = vscode.Uri.joinPath(directory, 'old.tex');
  const child = vscode.Uri.joinPath(directory, 'part.tex');
  await vscode.workspace.fs.writeFile(main, Buffer.from('\\documentclass{article}\n\\newcommand{\\frommain}{M}\n\\input{part}\n'));
  await vscode.workspace.fs.writeFile(old, Buffer.from('\\documentclass{article}\n\\newcommand{\\fromold}{O}\n'));
  await vscode.workspace.fs.writeFile(child, Buffer.from('% !TeX root = main.tex\n$\\frommain+x$\n'));
  return { main, old, child };
}

suite('P6.6 root and context ordering', () => {
  teardown(async () => {
    for (const dispose of cleanup.splice(0).reverse()) { await dispose(); }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const directory of directories.splice(0)) { await vscode.workspace.fs.delete(directory, { recursive: true }); }
  });

  test('a magic root overrides old workspaceState before the first real webview context', async function () {
    this.timeout(30000);
    const { main, old, child } = await fixture(), uri = child.toString();
    await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
    await vscode.commands.executeCommand('oh-my-tex.test.rootSelection', uri, old.toString());
    cleanup.push(() => vscode.commands.executeCommand('oh-my-tex.test.rootSelection', uri, undefined));
    await vscode.commands.executeCommand('vscode.openWith', child, 'oh-my-tex.visual');
    const first = await until(async () => (await vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri))
      .find(message => message.t === 'context') as Extract<HostMessage, { t: 'context' }> | undefined, 'the first project context');
    assert.ok(first.macros.some(macro => macro.name === 'frommain' && macro.source?.uri === main.toString()));
    assert.ok(!first.macros.some(macro => macro.name === 'fromold'));
    const document = await vscode.workspace.openTextDocument(child);
    assert.equal(document.isDirty, false);
  });

  test('an invalidated delayed index retries with fresh facts and preserves request versions', async () => {
    const { main, child } = await fixture();
    const document = await vscode.workspace.openTextDocument(child), index = new ProjectIndex(emptyState);
    cleanup.push(() => index.dispose());
    const originalRead = index.reader.read, entered = deferred<void>(), release = deferred<void>();
    let reads = 0;
    index.reader.read = async uri => {
      if (uri !== main.toString()) { return originalRead(uri); }
      if (++reads === 1) { entered.resolve(); await release.promise; return '\\newcommand{\\value}{old}'; }
      return '\\newcommand{\\value}{fresh}';
    };
    const older = index.context(document);
    await entered.promise;
    index.invalidate(main.toString());
    const newer = await index.context(document);
    release.resolve();
    const retried = await older;
    const cached = await index.context(document);
    assert.equal(newer.macros.find(macro => macro.name === 'value')?.body, 'fresh');
    assert.equal(retried.macros.find(macro => macro.name === 'value')?.body, 'fresh');
    assert.equal(cached.macros.find(macro => macro.name === 'value')?.body, 'fresh');
    assert.ok(retried.contextVersion < newer.contextVersion);
    assert.ok(newer.contextVersion < cached.contextVersion);
    assert.equal(reads, 2, 'the stale read must not repopulate the facts cache');
  });

  test('conflicting magic root informs once; a saved root still applies when magic is absent', async () => {
    const { main, old, child } = await fixture();
    const state: vscode.Memento = {
      keys: () => [`root:${child.toString()}`],
      get: <T>(key: string) => key === `root:${child.toString()}` ? old.toString() as T : undefined,
      update: async () => {},
    };
    const index = new ProjectIndex(state), notices: string[] = [];
    const api = vscode.window as { showInformationMessage: (...args: unknown[]) => Thenable<unknown> };
    const notify = api.showInformationMessage;
    api.showInformationMessage = message => { notices.push(String(message)); return Promise.resolve(undefined); };
    cleanup.push(() => { api.showInformationMessage = notify; index.dispose(); });
    let source = '% !TeX root = main.tex\n$\\frommain+x$';
    const document = { uri: child, getText: () => source } as vscode.TextDocument;
    assert.equal(await index.rootOf(document), main.toString());
    assert.equal(await index.rootOf(document), main.toString());
    index.invalidate();
    assert.equal(await index.rootOf(document), main.toString());
    assert.equal(notices.length, 1);
    assert.match(notices[0], /% !TeX root.*priority/);
    source = '$x$';
    assert.equal(await index.rootOf(document), old.toString());
    assert.equal(notices.length, 1);
  });

  test('Session drops an earlier context that resolves after a later request, including after disposal', async () => {
    const document = await vscode.workspace.openTextDocument({ language: 'latex', content: '$x$' });
    const change = new vscode.EventEmitter<string>(), receive = new vscode.EventEmitter<unknown>();
    const first = deferred<ProjectContext>(), second = deferred<ProjectContext>(), third = deferred<ProjectContext>();
    const requests = [first, second, third], messages: HostMessage[] = [];
    const panel = { webview: {
      onDidReceiveMessage: receive.event,
      postMessage: async (message: HostMessage) => { messages.push(message); return true; },
    } } as unknown as vscode.WebviewPanel;
    const session = new Session(document, panel, {
      project: { onDidChange: change.event, context: () => requests.shift()!.promise },
      completion: { dispose: () => {} },
    } as unknown as SessionServices);
    cleanup.push(() => { session.dispose(); change.dispose(); receive.dispose(); });
    const older = session.sendContext(), newer = session.sendContext();
    const context = (contextVersion: number, body: string): ProjectContext => ({ contextVersion,
      macros: [{ name: 'value', arity: 0, body }], templates: [], diagnostics: [] });
    second.resolve(context(2, 'fresh'));
    await newer;
    first.resolve(context(1, 'old'));
    await older;
    assert.deepEqual(messages, [{ t: 'context', ...context(2, 'fresh') }]);
    const pending = session.sendContext();
    session.dispose();
    third.resolve(context(3, 'disposed'));
    await pending;
    assert.equal(messages.length, 1);
  });
});
