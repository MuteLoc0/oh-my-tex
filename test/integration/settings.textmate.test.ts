import * as assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import * as vscode from 'vscode';
import { WorkshopGrammarLoader, workshopGrammars } from '../../src/host/grammar.ts';
import { editorSettings, loadTheme } from '../../src/host/settings.ts';
import type { HostMessage } from '../../src/shared/protocol.ts';

async function waitForMessage(uri: vscode.Uri, matches: (message: HostMessage) => boolean): Promise<HostMessage> {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    const messages = await vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', uri.toString());
    const message = messages?.find(matches);
    if (message) { return message; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for TextMate host settings');
}

async function openVisual(uri: vscode.Uri): Promise<void> {
  await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();
  await vscode.commands.executeCommand('vscode.openWith', uri, 'oh-my-tex.visual');
  await waitForMessage(uri, message => message.t === 'init');
}

suite('P6.3 TextMate host settings', () => {
  test('installed Workshop grammars are transferred intact with only the two TeX scopes', async function () {
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    if (!workshop) { this.skip(); }
    const grammars = await workshopGrammars();
    assert.ok(grammars);
    assert.deepEqual(grammars.map(grammar => grammar.scopeName), ['text.tex.latex', 'text.tex']);
    for (const grammar of grammars) {
      const contribution: { path: string } = workshop!.packageJSON.contributes.grammars.find((item: { scopeName: string }) => item.scopeName === grammar.scopeName);
      const content: string = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(workshop!.extensionUri, contribution.path))).toString('utf8');
      assert.equal(grammar.content, content);
      assert.equal(grammar.format, 'json');
      assert.equal(JSON.parse(grammar.content).scopeName, grammar.scopeName);
    }
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'main.tex');
    try {
      await openVisual(uri);
      const init = await waitForMessage(uri, message => message.t === 'init');
      assert.equal(init.t, 'init');
      if (init.t === 'init') {
        assert.deepEqual(init.settings.tokens.grammars, grammars);
        assert.ok(init.settings.tokens.tokenColors?.length);
        assert.equal(typeof init.settings.tokens.bracketPairs?.enabled, 'boolean');
      }
    } finally { await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor'); }
  });

  test('Workshop grammar cache shares concurrent reads and invalidates after version or installation changes', async () => {
    let reads = 0;
    let extension = {
      extensionUri: vscode.Uri.file('/tmp/workshop-textmate-a'),
      packageJSON: { version: '1', contributes: { grammars: [
        { scopeName: 'text.tex.latex', path: 'latex.json' },
        { scopeName: 'text.tex', path: 'tex.tmLanguage' },
        { scopeName: 'source.python', path: 'python.json' },
      ] } },
    };
    const loader = new WorkshopGrammarLoader(() => extension, async uri => {
      reads++;
      return Buffer.from(uri.path.endsWith('.json') ? '{"scopeName":"text.tex.latex","patterns":[]}' : '<plist><dict/></plist>');
    });
    const [first, second] = await Promise.all([loader.load(), loader.load()]);
    assert.strictEqual(first, second);
    assert.equal(reads, 2);
    assert.deepEqual(first?.map(grammar => grammar.format), ['json', 'plist']);
    assert.strictEqual(await loader.load(), first);
    extension = { ...extension, packageJSON: { ...extension.packageJSON, version: '2' } };
    assert.notStrictEqual(await loader.load(), first);
    assert.equal(reads, 4);
    extension = { ...extension, extensionUri: vscode.Uri.file('/tmp/workshop-textmate-b') };
    await loader.load();
    assert.equal(reads, 6);
  });

  test('missing Workshop, missing TeX contribution or failed reads select the fallback', async () => {
    assert.equal(await new WorkshopGrammarLoader(() => undefined).load(), undefined);
    const extension = {
      extensionUri: vscode.Uri.file('/tmp/workshop-textmate-missing'),
      packageJSON: { version: '1', contributes: { grammars: [{ scopeName: 'text.tex.latex', path: 'latex.json' }] } },
    };
    assert.equal(await new WorkshopGrammarLoader(() => extension, async () => Buffer.from('{}')).load(), undefined);
    extension.packageJSON.contributes.grammars.push({ scopeName: 'text.tex', path: 'tex.json' });
    assert.equal(await new WorkshopGrammarLoader(() => extension, async () => { throw new Error('read failed'); }).load(), undefined);
  });

  test('theme includes preserve complete scope selectors and font styles in inherited order', async () => {
    const folder = vscode.Uri.joinPath(vscode.Uri.file(tmpdir()), `omt-textmate-theme-${Date.now()}`);
    const base = {
      colors: { 'editor.foreground': '#abcdef', 'editor.background': '#101010' },
      tokenColors: [{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#123456', fontStyle: 'italic' } }],
    };
    const child = {
      include: './base.json',
      colors: { 'editor.background': '#202020' },
      tokenColors: [{ name: 'clear comment italics', scope: 'text.tex.latex comment', settings: { foreground: '#654321', fontStyle: '' } }],
    };
    try {
      await vscode.workspace.fs.createDirectory(folder);
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'base.json'), Buffer.from(JSON.stringify(base)));
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, 'child.json'), Buffer.from(JSON.stringify(child)));
      assert.deepEqual(await loadTheme(vscode.Uri.joinPath(folder, 'child.json')), {
        tokenColors: [...base.tokenColors, ...child.tokenColors],
        colors: { ...base.colors, ...child.colors },
      });
    } finally { await vscode.workspace.fs.delete(folder, { recursive: true }); }
  });

  test('settings carry theme-specific style customizations and bracket options without changing text', async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'main.tex');
    const document = await vscode.workspace.openTextDocument(uri), source = document.getText();
    const config = vscode.workspace.getConfiguration('editor', { uri, languageId: 'latex' });
    const theme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme')!;
    const keys = ['tokenColorCustomizations', 'bracketPairColorization.enabled', 'bracketPairColorization.independentColorPoolPerBracketType'];
    const previous = keys.map(key => config.inspect(key)?.workspaceValue);
    const themeRule = { scope: 'text.tex.latex support.function', settings: { foreground: '#456789', fontStyle: 'bold underline' } };
    try {
      await config.update(keys[0]!, {
        strings: { foreground: '#123456', fontStyle: 'italic' },
        [`[${theme}]`]: { textMateRules: [themeRule] },
      }, vscode.ConfigurationTarget.Workspace);
      await config.update(keys[1]!, false, vscode.ConfigurationTarget.Workspace);
      await config.update(keys[2]!, true, vscode.ConfigurationTarget.Workspace);
      const settings = await editorSettings(document);
      assert.deepEqual(settings.tokens.bracketPairs, { enabled: false, independentColorPoolPerBracketType: true });
      assert.deepEqual(settings.tokens.tokenColors?.at(-1), themeRule);
      assert.ok(settings.tokens.tokenColors?.some(rule => rule.scope === 'string' && rule.settings?.fontStyle === 'italic'));
      assert.equal(document.getText(), source);
    } finally {
      for (let index = 0; index < keys.length; index++) { await config.update(keys[index]!, previous[index], vscode.ConfigurationTarget.Workspace); }
    }
  });

  test('workbench editor color customization refreshes the default TextMate rule in an open webview', async () => {
    const uri = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'main.tex');
    const config = vscode.workspace.getConfiguration('workbench');
    const previous = config.inspect('colorCustomizations')?.workspaceValue;
    const theme = config.get<string>('colorTheme')!;
    try {
      await openVisual(uri);
      await config.update('colorCustomizations', {
        'editor.foreground': '#112233', [`[${theme}]`]: { 'editor.foreground': '#223344' },
      }, vscode.ConfigurationTarget.Workspace);
      const refreshed = await waitForMessage(uri, message => message.t === 'settings'
        && !!message.settings.tokens.tokenColors?.some(rule => !rule.scope && rule.settings?.foreground === '#223344'));
      assert.equal(refreshed.t, 'settings');
    } finally {
      await config.update('colorCustomizations', previous, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
  });
});
