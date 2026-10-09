import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type * as vscode from 'vscode';
import type { CompletionBridge } from '../../src/host/completionBridge.ts';
import type { Session } from '../../src/host/session.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';
import type { MacroDef } from '../../src/shared/types.ts';
import { parseSnippet } from '../../src/core/snippet.ts';

type ProviderItem = Pick<vscode.CompletionItem, 'label'> & Partial<vscode.CompletionItem>;
type Reply = Extract<HostMessage, { t: 'completions' }>;
interface Fixture {
  items: ProviderItem[];
  queries: { command: string; resolveCount: number }[];
  wordSuggestions: string;
}
interface TestApi {
  fixture: Fixture;
  Position: typeof vscode.Position;
  Range: typeof vscode.Range;
  SnippetString: typeof vscode.SnippetString;
  CompletionItemKind: typeof vscode.CompletionItemKind;
}

// Exercise the real bridge without starting an extension host. These two
// fixtures only replace the VS Code boundary and unrelated snippet-file IO.
const apiFixture = `
export const fixture = { items: [], queries: [], wordSuggestions: 'off' };
export class Position {
  constructor(line, character) { this.line = line; this.character = character; }
}
export class Range {
  constructor(a, b, c, d) {
    this.start = typeof a === 'number' ? new Position(a, b) : a;
    this.end = typeof a === 'number' ? new Position(c, d) : b;
  }
  contains(point) {
    return point.line === this.start.line && point.line === this.end.line &&
      point.character >= this.start.character && point.character <= this.end.character;
  }
}
export class SnippetString { constructor(value) { this.value = value; } }
export const CompletionItemKind = { Text: 0, Function: 2, Snippet: 14 };
export const commands = {
  async executeCommand(command, _uri, _position, _trigger, resolveCount) {
    fixture.queries.push({ command, resolveCount });
    return { items: fixture.items, isIncomplete: false };
  },
};
export const workspace = {
  getConfiguration() {
    return { get(key, fallback) { return key === 'wordBasedSuggestions' ? fixture.wordSuggestions : fallback; } };
  },
};
export const window = {
  createOutputChannel() { return { warn(message) { throw new Error(message); } }; },
};
`;

const harness = (async () => {
  const source = fileURLToPath(new URL('../../src/host/completionBridge.ts', import.meta.url));
  const result = await build({
    stdin: { contents: `export { CompletionBridge } from ${JSON.stringify(source)}; export * as testApi from 'vscode';`,
      resolveDir: fileURLToPath(new URL('../../', import.meta.url)) },
    bundle: true, platform: 'node', format: 'esm', write: false,
    plugins: [{
      name: 'completion-bridge-fixture',
      setup(plugin) {
        plugin.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
        plugin.onResolve({ filter: /[\/]snippetStore\.ts$/ }, () => ({ path: 'snippets', namespace: 'fixture' }));
        plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: args.path === 'vscode' ? apiFixture : 'export class SnippetStore { async get() { return []; } dispose() {} }',
          loader: 'js',
        }));
      },
    }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`) as {
    CompletionBridge: new () => CompletionBridge;
    testApi: TestApi;
  };
})();

async function complete(text: string, macro: MacroDef | undefined, providers: (api: TestApi) => ProviderItem[],
  options: { ctx?: 'prose' | 'math'; wordSuggestions?: string } = {}) {
  const { CompletionBridge: Bridge, testApi: api } = await harness;
  api.fixture.items = providers(api); api.fixture.queries = [];
  api.fixture.wordSuggestions = options.wordSuggestions ?? 'off';
  const document = {
    version: 1, uri: { toString: () => 'file:///fixture.tex' }, languageId: 'latex', lineCount: 1,
    getText: () => text, lineAt: () => ({ text }),
    getWordRangeAtPosition: () => new api.Range(0, text.length - (/[A-Za-z@]*$/.exec(text)?.[0].length ?? 0), 0, text.length),
  } as unknown as vscode.TextDocument;
  const sent: HostMessage[] = [];
  const session = {
    document, completionContext: async () => ({ macros: macro ? [macro] : [], templates: [] }),
    post: async (message: HostMessage) => { sent.push(message); return true; },
  } as unknown as Session;
  const bridge = new Bridge();
  try {
    await bridge.complete(session, { t: 'complete', req: 'fixture', version: 1, at: text.length, ctx: options.ctx ?? 'prose', trigger: { kind: 'invoke' } });
    assert.deepEqual(api.fixture.queries, [{ command: 'vscode.executeCompletionItemProvider', resolveCount: 0 }]);
    const reply = sent.find(message => message.t === 'completions') as Reply | undefined;
    assert.ok(reply, 'bridge must return a completion list');
    return reply.items;
  } finally { bridge.dispose(); }
}

test('completion bridge: a same-name zero-argument provider cannot hide the immediate project macro', async () => {
  for (const slash of [false, true]) {
    const items = await complete('\\R', { name: 'R', arity: 0, body: '\\mathbb{R}' }, api => [{
      label: '\\R', filterText: 'R', kind: api.CompletionItemKind.Function,
      insertText: slash ? '\\R' : 'R', range: new api.Range(0, slash ? 0 : 1, 0, 2),
    }]);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.source, 'macro');
    assert.equal(items[0]!.needsResolve, undefined);
    assert.deepEqual(items[0]!.insert, { snippet: true, value: 'R' });
    assert.deepEqual(items[0]!.range, { insFrom: 1, insTo: 2, repFrom: 1, repTo: 2 });
  }
});

test('completion bridge: command and math contexts exclude both provider and fallback document words', async () => {
  const providers = (api: TestApi) => [
    { label: 'alphabet', kind: api.CompletionItemKind.Text, insertText: 'alphabet' },
    { label: '\\alpha', kind: api.CompletionItemKind.Function, insertText: 'alpha' },
  ];
  for (const [text, ctx] of [['alphabet alpaca \\al', 'prose'], ['alphabet alpaca al', 'math']] as const) {
    const items = await complete(text, undefined, providers, { ctx, wordSuggestions: 'currentDocument' });
    assert.deepEqual(items.map(item => item.label), ['\\alpha']);
  }
  const ordinary = await complete('alphabet alpaca al', undefined, providers, { wordSuggestions: 'currentDocument' });
  assert.ok(ordinary.some(item => item.source === 'provider' && item.kind === 0));
  assert.ok(ordinary.some(item => item.source === 'word'));
});

test('completion bridge: a Workshop argument-label variant leaves one complete source macro snippet', async () => {
  for (const slash of [false, true]) {
    const items = await complete('\\du', { name: 'duo', arity: 2, body: '#1+#2' }, api => [{
      label: '\\duo{}{}', filterText: 'duo', kind: api.CompletionItemKind.Function,
      insertText: new api.SnippetString(`${slash ? '\\' : ''}duo{\${1}}{\${2}}$0`),
      range: new api.Range(0, slash ? 0 : 1, 0, 3),
    }]);
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.equal(item.label, '\\duo');
    assert.equal(item.source, 'macro');
    assert.equal(item.needsResolve, undefined);
    assert.equal(item.insert.value, 'duo{$1}{$2}');
    assert.equal(parseSnippet(item.insert.value).text, 'duo{}{}');
    assert.deepEqual(parseSnippet(item.insert.value).tabstops.map(stop => stop.index), [1, 2]);
  }
});

test('completion bridge: different snippet semantics and provider side effects remain separate choices', async () => {
  const variants = [
    ['default', 'duo{${1:x}}{$2}'],
    ['mirror', 'duo{$1}{$1}'],
    ['choice', 'duo{${1|,x|}}{$2}'],
    ['middle final stop', 'duo{$1}$0{$2}'],
    ['variable', 'duo{${1:${TM_SELECTED_TEXT:}}}{$2}'],
    ['transform', 'duo{${1/(.*)/$1/}}{$2}'],
  ] as const;
  const items = await complete('\\du', { name: 'duo', arity: 2, body: '#1+#2' }, api => {
    const base = { filterText: 'duo', kind: api.CompletionItemKind.Function, range: new api.Range(0, 1, 0, 3) };
    return [
      ...variants.map(([label, snippet]) => ({ ...base, label: `\\duo ${label}`, insertText: new api.SnippetString(snippet) })),
      { ...base, label: '\\duo command', insertText: new api.SnippetString('duo{$1}{$2}'),
        command: { title: 'fixture', command: 'fixture.postCompletion' } },
      { ...base, label: '\\duo extra edit', insertText: new api.SnippetString('duo{$1}{$2}'),
        additionalTextEdits: [{ range: new api.Range(0, 0, 0, 0), newText: '%extra\n' }] },
    ];
  });
  assert.equal(items.length, variants.length + 3);
  assert.equal(items.filter(item => item.source === 'macro').length, 1);
  for (const [label, snippet] of variants) {
    const retained = items.find(item => item.label === `\\duo ${label}`);
    assert.ok(retained, `${label} variant must remain available`);
    assert.equal(retained.source, 'provider');
    assert.equal(retained.needsResolve, true);
    assert.equal(retained.insert.value, snippet);
  }
  for (const label of ['\\duo command', '\\duo extra edit']) {
    const retained = items.find(item => item.label === label)!;
    assert.equal(retained.source, 'provider');
    assert.equal(retained.needsResolve, true);
  }
  assert.equal(items.find(item => item.label === '\\duo command')?.command, 'host');
  assert.deepEqual(items.find(item => item.label === '\\duo extra edit')?.extraEdits, [{ from: 0, to: 0, insert: '%extra\n' }]);
});
