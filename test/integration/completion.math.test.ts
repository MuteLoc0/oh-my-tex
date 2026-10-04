import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { CompletionBridge } from '../../src/host/completionBridge.ts';
import { ProjectIndex } from '../../src/host/projectIndex.ts';
import { editorSettings } from '../../src/host/settings.ts';
import { toLF } from '../../src/core/eol.ts';
import type { Session } from '../../src/host/session.ts';
import type { HostMessage, WebMessage } from '../../src/shared/protocol.ts';

type Reply = Extract<HostMessage, { t: 'completions' }>;
const settings = () => vscode.workspace.getConfiguration('oh-my-tex', vscode.workspace.workspaceFolders![0].uri);

suite('P3 math completion host filtering and templates', () => {
  const disposables: vscode.Disposable[] = [];
  const cleanups: (() => Promise<void>)[] = [];
  const restore = new Map<string, unknown>();
  const configure = async (key: string, value: unknown) => {
    if (!restore.has(key)) { restore.set(key, settings().inspect(key)?.workspaceValue); }
    await settings().update(key, value, vscode.ConfigurationTarget.Workspace);
  };
  teardown(async () => {
    disposables.splice(0).forEach(disposable => disposable.dispose());
    for (const cleanup of cleanups.splice(0)) { await cleanup(); }
    for (const [key, value] of restore) { await settings().update(key, value, vscode.ConfigurationTarget.Workspace); }
    restore.clear();
  });

  async function fixture() {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'crlf.tex');
    const document = await vscode.workspace.openTextDocument(uri);
    const original = document.getText();
    const replace = async (text: string) => {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(document.getText().length)), text);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
    };
    await replace('\\newcommand{\\zzQmacro}[1]{#1}\n$\\zzQ$');
    const state = { get: () => undefined, update: async () => {}, keys: () => [] } as unknown as vscode.Memento;
    const project = new ProjectIndex(state);
    disposables.push(project);
    cleanups.push(() => replace(original));
    const replies: Reply[] = [];
    const session = {
      document, completionContext: () => project.context(document),
      post: async (message: HostMessage) => { if (message.t === 'completions') { replies.push(message); } return true; },
    } as unknown as Session;
    const bridge = new CompletionBridge();
    const complete = async (ctx: 'math' | 'prose', req: string, at = toLF(document.getText()).lastIndexOf('zzQ') + 3) => {
      const request: Extract<WebMessage, { t: 'complete' }> = { t: 'complete', ctx, req, version: document.version,
        at, trigger: { kind: 'invoke' } };
      await bridge.complete(session, request);
      return replies.find(reply => reply.req === req)!;
    };
    return { document, project, complete, replace, original };
  }

  test('math filtering runs before the host response cap and keeps commands, macros, environments and allowed items', async () => {
    await configure('math.completionAllowPatterns', ['[', '^zzQallow$']);
    const s = await fixture();
    disposables.push(vscode.languages.registerCompletionItemProvider({ language: 'latex', scheme: 'file', pattern: '**/crlf.tex' }, {
      provideCompletionItems() {
        const make = (label: string, value: string) => { const item = new vscode.CompletionItem(label); item.insertText = new vscode.SnippetString(value); return item; };
        return [
          ...Array.from({ length: 450 }, (_, n) => make(`zzQ${String(n).padStart(3, '0')}prose`, 'section{${1:Title}}')),
          make('zzQfrac', 'frac{$1}{$2}'), make('zzQmatrix', 'begin{matrix}$1\\end{matrix}'),
          make('zzQcases', 'begin{cases}$1\\end{cases}'), make('zzQaligned', 'begin{aligned}$1\\end{aligned}'),
          make('zzQallow', 'customMath{$1}'), make('zzQsection', 'section{${1:Title}}'),
        ];
      },
    }));
    const math = await s.complete('math', 'math-host');
    for (const label of ['zzQfrac', 'zzQmatrix', 'zzQcases', 'zzQaligned', 'zzQallow', '\\zzQmacro']) {
      assert.ok(math.items.some(item => item.label === label), `${label} missing from ${math.items.map(item => item.label)}`);
    }
    assert.equal(math.items.some(item => item.insert.value.startsWith('section{')), false);
    assert.ok(math.items.length < 300, 'filtered prose entries must not consume the response budget');
    assert.equal(math.isIncomplete, false);
    const prose = await s.complete('prose', 'prose-host');
    assert.equal(prose.items.length, 300);
    assert.equal(prose.isIncomplete, true);
    assert.ok(prose.items.some(item => item.insert.value.startsWith('section{')));
  });

  test('configured math/prose/both templates are indexed and offered only in their configured contexts', async () => {
    await configure('templates', [
      { prefix: '\\zzQmath', body: '\\frac{$1}{$2}', context: 'math' },
      { prefix: '\\zzQprose', body: '\\emph{$1}', context: 'prose' },
      { prefix: '\\zzQboth', body: '${TM_SELECTED_TEXT}^2$0', context: 'both' },
      { prefix: '\\zzQdefault', body: '\\sqrt{$1}' }, { body: 'invalid' },
    ]);
    const s = await fixture();
    const context = await s.project.context(s.document);
    assert.equal(context.templates.length, 4);
    const labels = (reply: Reply) => reply.items.filter(item => item.source === 'template').map(item => item.label).sort();
    const math = await s.complete('math', 'math-templates');
    assert.deepEqual(labels(math), ['\\zzQboth', '\\zzQdefault', '\\zzQmath']);
    assert.deepEqual(labels(await s.complete('prose', 'prose-templates')), ['\\zzQboth', '\\zzQprose']);
    for (const template of math.items.filter(item => item.source === 'template')) {
      assert.equal(template.insert.snippet, true);
      assert.equal(toLF(s.document.getText()).slice(template.range.repFrom, template.range.repTo), '\\zzQ');
    }
  });

  test('settings preserve boolean shortcut compatibility and validate shortcut/pattern overrides', async () => {
    await configure('math.inlineShortcuts', false);
    await configure('math.inlineShortcutOverrides', { alpha: '\\alpha', '>=': '', '': 'invalid', wrong: 42 });
    await configure('math.completionAllowPatterns', ['^custom', 42]);
    const s = await fixture();
    const value = await editorSettings(s.document);
    assert.equal(value.inlineShortcuts, false);
    assert.deepEqual(value.inlineShortcutOverrides, { alpha: '\\alpha', '>=': '' });
    assert.deepEqual(value.mathCompletionAllowPatterns, ['^custom']);
  });

  test('real Workshop 10.19.0 supplies a math fraction snippet with LF command-name ranges', async function () {
    this.timeout(60000);
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    assert.ok(workshop, 'Workshop must be installed in the integration profile');
    assert.equal(workshop.packageJSON.version, '10.19.0');
    await workshop.activate();
    const s = await fixture();
    // The trailing space separates the temporary prefix from the closing delimiter.
    await s.replace('\\documentclass{article}\n\\begin{document}\n$x+\\fr $\n\\end{document}\n');
    const text = toLF(s.document.getText()), at = text.indexOf('\\fr ') + 3;
    const reply = await s.complete('math', 'math-workshop-fr', at);
    const fraction = reply.items.find(item => /^\\?frac(?:\b|\{)/.test(item.label) && item.source === 'provider');
    assert.ok(fraction, `frac missing from ${reply.items.map(item => item.label).join(',')}`);
    assert.equal(fraction.insert.snippet, true);
    assert.match(fraction.insert.value, /^frac\{\$1\}\{\$2\}/);
    assert.equal(fraction.range.insFrom, at - 2);
    assert.equal(fraction.range.insTo, at);
    assert.equal(fraction.range.repFrom, at - 2);
    assert.equal(fraction.range.repTo, at);
    assert.equal(text.slice(fraction.range.repFrom, fraction.range.repTo), 'fr');
    assert.equal(reply.items.some(item => /^\\?section\b/.test(item.label) || /^\\?section\b/.test(item.insert.value)), false);
    console.log('[P3] Workshop math completion:', JSON.stringify({ label: fraction.label, snippet: fraction.insert.value, range: fraction.range }));
  });
});
