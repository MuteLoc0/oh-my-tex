import * as assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { CompletionBridge } from '../../src/host/completionBridge.ts';
import type { Session } from '../../src/host/session.ts';
import { toLF } from '../../src/core/eol.ts';
import type { HostMessage, WebMessage } from '../../src/shared/protocol.ts';
import { isWebMessage } from '../../src/shared/protocol.ts';

const folder = () => vscode.workspace.workspaceFolders![0].uri;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type Reply = Extract<HostMessage, { t: 'completions' }>;

async function until<T>(probe: () => T | undefined | PromiseLike<T | undefined>, what: string): Promise<T> {
  const end = Date.now() + 25000;
  for (;;) {
    const value = await probe();
    if (value) { return value as T; }
    if (Date.now() > end) { throw new Error(`timed out waiting for ${what}`); }
    await sleep(30);
  }
}

async function open(name = 'main.tex') {
  const uri = vscode.Uri.joinPath(folder(), name);
  await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
  await vscode.commands.executeCommand('vscode.openWith', uri, 'oh-my-tex.visual');
  await until(() => vscode.commands.executeCommand<boolean>('oh-my-tex.test.ready', uri.toString()), 'webview ready');
  const document = await vscode.workspace.openTextDocument(uri);
  const receive = (message: unknown) => vscode.commands.executeCommand('oh-my-tex.test.receive', uri.toString(), message);
  const sent = () => vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri.toString());
  const complete = async (at: number, version = document.version, trigger: Extract<WebMessage, { t: 'complete' }>['trigger'] = { kind: 'invoke' }) => {
    const req = randomUUID();
    await receive({ t: 'complete', req, version, at, ctx: 'prose', trigger });
    return until(async () => (await sent()).find(m => m.t === 'completions' && m.req === req) as Reply | undefined, 'completion response');
  };
  return { uri, document, receive, sent, complete };
}

async function replace(document: vscode.TextDocument, text: string) {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), text);
  assert.equal(await vscode.workspace.applyEdit(edit), true);
}

function fake(document: vscode.TextDocument, context = { contextVersion: 0, macros: [], templates: [], diagnostics: [] }) {
  const sent: HostMessage[] = [];
  const session = { document, completionContext: async () => context, post: async (message: HostMessage) => { sent.push(message); return true; } } as unknown as Session;
  return { session, sent, reply: (req: string) => sent.find(m => m.t === 'completions' && m.req === req) as Reply };
}
const request = (document: vscode.TextDocument, req: string, at: number): Extract<WebMessage, { t: 'complete' }> => ({
  t: 'complete', req, at, version: document.version, ctx: 'prose', trigger: { kind: 'invoke' },
});

suite('P2 completion bridge', () => {
  const disposables: vscode.Disposable[] = [];
  teardown(async () => {
    disposables.splice(0).forEach(d => d.dispose());
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  });

  test('real Workshop 10.19.0 supplies usepackage snippet/range/triggerSuggest and package follow-up', async function () {
    this.timeout(60000);
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    assert.ok(workshop, 'Workshop must be installed in the integration profile');
    assert.equal(workshop.packageJSON.version, '10.19.0');
    await workshop.activate();
    const s = await open();
    assert.notEqual(vscode.window.activeTextEditor?.document.uri.toString(), s.uri.toString());
    const seed = `${s.document.getText()}\n\\use`;
    await replace(s.document, seed);
    const reply = await s.complete(toLF(seed).length);
    const item = reply.items.find(i => /\\?usepackage/.test(i.label) && i.source === 'provider');
    assert.ok(item, `usepackage missing from ${reply.items.map(i => i.label).join(',')}`);
    assert.equal(item.insert.snippet, true);
    assert.match(item.insert.value, /^usepackage\{/);
    assert.equal(item.command, 'triggerSuggest');
    assert.equal(item.range.insFrom, toLF(seed).length - 3);
    assert.equal(item.range.repTo, toLF(seed).length);
    assert.ok(reply.items.length <= 300);
    await replace(s.document, `${seed.slice(0, -4)}\\usepackage{ams}`);
    const packages = await s.complete(toLF(s.document.getText()).length - 1);
    assert.ok(packages.items.some(i => i.label === 'amsmath'));
    console.log('[P2] Workshop completion:', JSON.stringify({ label: item.label, snippet: item.insert.value, range: item.range, command: item.command }));
  });

  test('user/workspace snippets and document words reach the custom editor, filling provider gaps', async () => {
    const s = await open();
    const userDirectory = vscode.Uri.joinPath(folder(), '..', '..', '..', '.vscode-test', 'user-data', 'User', 'snippets');
    const userFile = vscode.Uri.joinPath(userDirectory, 'omt-p2.code-snippets');
    await vscode.workspace.fs.createDirectory(userDirectory);
    await vscode.workspace.fs.writeFile(userFile, Buffer.from(JSON.stringify({ 'P2 user snippet': { scope: 'latex', prefix: 'omtuser', body: '\\emph{${1:user}}$0' } })));
    try {
      for (const [text, prefix, source] of [
        ['omtworkspace', 'omtworkspace', 'snippet'], ['omtuser', 'omtuser', 'snippet'], ['omtwordalpha omtword', 'omtwordalpha', 'word'],
      ] as const) {
        await replace(s.document, `${s.document.getText().split('\n').slice(0, 3).join('\n')}\n${text}`);
        const position = s.document.positionAt(s.document.getText().length);
        const native = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', s.uri, position);
        const nativeLabels = native?.items.map(i => typeof i.label === 'string' ? i.label : i.label.label) ?? [];
        const response = await s.complete(toLF(s.document.getText()).length);
        const item = response.items.find(i => i.label === prefix && (i.source === source || i.source === 'provider'));
        assert.ok(item, `${source} ${prefix} missing`);
        assert.equal(item.insert.snippet, source === 'snippet');
        console.log('[P2] snippet/word API coverage:', JSON.stringify({ prefix, inCommandAPI: nativeLabels.includes(prefix), finalSource: item.source }));
      }
    } finally { await vscode.workspace.fs.delete(userFile); }
  });

  test('DTO conversion preserves LF ranges, snippet, docs, insert/replace and atomic additional edits', async () => {
    const s = await open('crlf.tex');
    await replace(s.document, 'line one\r\nline two\r\nzzQtail\r\n');
    const document = s.document, bridge = new CompletionBridge(), mock = fake(document);
    disposables.push(vscode.languages.registerCompletionItemProvider({ language: 'latex', scheme: 'file', pattern: '**/crlf.tex' }, {
      provideCompletionItems() {
        const rich = new vscode.CompletionItem({ label: 'zzQrich', description: 'rich label' }, vscode.CompletionItemKind.Snippet);
        rich.insertText = new vscode.SnippetString('zzQ${1:default}\r\n$0');
        rich.range = { inserting: new vscode.Range(2, 0, 2, 3), replacing: new vscode.Range(2, 0, 2, 7) };
        rich.documentation = new vscode.MarkdownString('**markdown docs**');
        rich.detail = 'Fixture provider'; rich.filterText = 'zzQrich'; rich.preselect = true;
        rich.additionalTextEdits = [vscode.TextEdit.insert(new vscode.Position(0, 0), '%extra\r\n')];
        const bare = new vscode.CompletionItem('zzQbare');
        bare.insertText = 'zzQbare';
        return [rich, bare];
      },
    }));
    const at = toLF(document.getText()).indexOf('zzQ') + 3;
    await bridge.complete(mock.session, request(document, 'dto', at));
    const rich = mock.reply('dto').items.find(i => i.label === 'zzQrich')!;
    assert.ok(rich);
    assert.deepEqual(rich.range, { insFrom: 18, insTo: 21, repFrom: 18, repTo: 25 });
    assert.equal(rich.insert.value, 'zzQ${1:default}\n$0');
    assert.equal(rich.doc, '**markdown docs**'); assert.equal(rich.description, 'rich label');
    assert.deepEqual(rich.extraEdits, [{ from: 0, to: 0, insert: '%extra\n' }]);
    const bare = mock.reply('dto').items.find(i => i.label === 'zzQbare')!;
    assert.deepEqual(bare.range, rich.range);
    const text = toLF(document.getText());
    const edits = [...rich.extraEdits!, { from: rich.range.repFrom, to: rich.range.repTo, insert: 'zzQaccepted' }].map(e => ({ ...e, expected: text.slice(e.from, e.to) }));
    await s.receive({ t: 'edit', txn: 'completion-extra', baseVersion: document.version, kind: 'completion', patches: edits });
    const result = (await s.sent()).find(m => m.t === 'txnResult' && m.txn === 'completion-extra');
    assert.ok(result?.t === 'txnResult' && result.ok);
    assert.equal(toLF(document.getText()), '%extra\nline one\nline two\nzzQaccepted\n');
    await s.receive({ t: 'undo' });
    await until(() => toLF(document.getText()) === text, 'single undo of completion plus extra edits');
  });

  test('commands are scoped to returned req/item/session, reject replay and expire after eight requests', async () => {
    const s = await open('crlf.tex');
    await replace(s.document, 'zzQ');
    const bridge = new CompletionBridge(), a = fake(s.document), b = fake(s.document);
    const calls: unknown[] = [];
    disposables.push(vscode.commands.registerCommand('oh-my-tex.test.completionCommand', (...args: unknown[]) => calls.push(args)),
      vscode.languages.registerCompletionItemProvider({ language: 'latex', scheme: 'file', pattern: '**/crlf.tex' }, {
        provideCompletionItems() {
          const item = new vscode.CompletionItem('zzQcommand');
          item.command = { title: 'fixture', command: 'oh-my-tex.test.completionCommand', arguments: ['trusted'] };
          return [item];
        },
      }));
    await bridge.complete(a.session, request(s.document, 'allowed', 3));
    const item = a.reply('allowed').items.find(i => i.label === 'zzQcommand')!;
    assert.equal(item.command, 'host');
    await bridge.runCommand(a.session, 'missing', item.i);
    await bridge.runCommand(a.session, 'allowed', 9999);
    await bridge.runCommand(b.session, 'allowed', item.i);
    assert.equal(calls.length, 0);
    await bridge.complete(a.session, request(s.document, 'allowed', 3));
    assert.equal(a.sent.filter(m => m.t === 'completions').length, 1, 'request IDs cannot be reused');
    await bridge.runCommand(a.session, 'allowed', item.i);
    await bridge.runCommand(a.session, 'allowed', item.i);
    assert.deepEqual(calls, [['trusted']]);
    await bridge.complete(a.session, request(s.document, 'expire', 3));
    const expired = a.reply('expire').items.find(i => i.label === 'zzQcommand')!;
    for (let i = 0; i < 8; i++) { await bridge.complete(a.session, request(s.document, `new-${i}`, 3)); }
    await bridge.runCommand(a.session, 'expire', expired.i);
    bridge.dispose(a.session);
    await bridge.runCommand(a.session, 'new-7', 0);
    assert.equal(calls.length, 1);
  });

  test('large sets are bounded/incomplete and stale versions or in-flight edits cannot return applicable results', async () => {
    const s = await open('crlf.tex');
    await replace(s.document, 'zzQ');
    const bridge = new CompletionBridge(), mock = fake(s.document);
    let slow = false, entered: (() => void) | undefined, release: (() => void) | undefined;
    disposables.push(vscode.languages.registerCompletionItemProvider({ language: 'latex', scheme: 'file', pattern: '**/crlf.tex' }, {
      async provideCompletionItems() {
        if (slow) { entered?.(); await new Promise<void>(resolve => { release = resolve; }); }
        return Array.from({ length: 450 }, (_, i) => new vscode.CompletionItem(`zzQ${String(i).padStart(3, '0')}`));
      },
    }));
    await bridge.complete(mock.session, request(s.document, 'big', 3));
    assert.equal(mock.reply('big').items.length, 300);
    assert.equal(mock.reply('big').isIncomplete, true);
    await bridge.complete(mock.session, { ...request(s.document, 'stale', 3), version: s.document.version - 1 });
    assert.deepEqual(mock.reply('stale').items, []); assert.equal(mock.reply('stale').isIncomplete, true);
    slow = true;
    const providerStarted = new Promise<void>(resolve => { entered = resolve; });
    const pending = bridge.complete(mock.session, request(s.document, 'during-edit', 3));
    await providerStarted;
    await replace(s.document, 'zzQx');
    release!();
    await pending;
    assert.deepEqual(mock.reply('during-edit').items, []); assert.equal(mock.reply('during-edit').isIncomplete, true);
    assert.equal(mock.reply('during-edit').version, s.document.version);
  });

  test('completion trigger messages are validated before host API calls', () => {
    const base = { t: 'complete', req: 'req', version: 1, at: 0, ctx: 'prose' };
    assert.equal(isWebMessage({ ...base, trigger: { kind: 'invoke' } }), true);
    assert.equal(isWebMessage({ ...base, trigger: { kind: 'incomplete' } }), true);
    assert.equal(isWebMessage({ ...base, trigger: { kind: 'char', char: '\\' } }), true);
    for (const trigger of [{}, { kind: 'bad' }, { kind: 'char' }, { kind: 'char', char: 'ab' }, { kind: 'invoke', char: 'x' }, []]) {
      assert.equal(isWebMessage({ ...base, trigger }), false);
    }
  });
});
