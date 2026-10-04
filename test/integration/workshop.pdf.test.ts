import * as assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { HostMessage } from '../../src/shared/protocol.ts';

const run = promisify(execFile);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const VIEW_TYPE = 'oh-my-tex.visual';
type ClientSelection = { version: number; anchor: number; head: number };
type Reveal = Extract<HostMessage, { t: 'reveal' }>;
interface PdfRecord { page: number; x: number; y: number; h?: number; v?: number; W?: number; H?: number }
interface InverseRecord { input: string; line: number; column: number }
interface ReverseRequest {
  type: 'reverse_synctex'; pdfFileUri: string; page: number; pos: [number, number];
  textBeforeSelection: string; textAfterSelection: string;
}
interface WorkshopInternals {
  root: { file: { path?: string } };
  locate: { synctex: {
    toPDF(pdfUri?: vscode.Uri): void;
    toTeX(data: ReverseRequest, pdfUri: vscode.Uri): Promise<void>;
    components: { computeToTeX(data: ReverseRequest, pdfUri: vscode.Uri): Promise<InverseRecord | undefined> };
  } };
  viewer: { locate(pdfUri: vscode.Uri, record: PdfRecord | PdfRecord[]): Promise<void> };
}

async function until<T>(probe: () => T | undefined | PromiseLike<T | undefined>, what: string, timeout = 25000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await probe();
    if (value) { return value; }
    if (Date.now() > deadline) { throw new Error(`timed out waiting for ${what}`); }
    await pause(30);
  }
}

/** The optional PDF acceptance requires a TeX installation, never downloads one. */
async function executable(name: string): Promise<string | undefined> {
  const candidates = process.platform === 'darwin' ? [name, `/Library/TeX/texbin/${name}`] : [name];
  for (const candidate of candidates) {
    try { await run(candidate, name === 'synctex' ? ['help'] : ['--version'], { timeout: 10000 }); return candidate; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
    }
  }
  return undefined;
}

/** Parse the actual binary output independently of Workshop's parser. */
function forwardRecords(output: string): PdfRecord[] {
  const records: PdfRecord[] = [];
  for (const line of output.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon < 0) { continue; }
    const key = line.slice(0, colon), value = line.slice(colon + 1);
    if (key === 'Output') { records.push({ page: 0, x: NaN, y: NaN }); }
    else if (records.length && ['Page', 'x', 'y', 'h', 'v', 'W', 'H'].includes(key)) {
      const record = records[records.length - 1];
      Object.assign(record, { [key === 'Page' ? 'page' : key]: Number(value) });
    }
  }
  assert.ok(records.length, 'synctex view must return a real PDF position');
  assert.ok(records.every(record => record.page > 0 && Number.isFinite(record.x) && Number.isFinite(record.y)));
  return records;
}

async function sameFile(actual: string, expected: string) { assert.equal(await fs.realpath(actual), await fs.realpath(expected)); }

suite('P5 real PDF and Workshop SyncTeX', function () {
  this.timeout(120000);

  test('public forward SyncTeX and real inverse parsing round-trip an included macro and align environment', async function () {
    const pdflatex = await executable('pdflatex'), synctexBinary = await executable('synctex');
    if (!pdflatex || !synctexBinary) {
      console.log('[P5 PDF] skipped: pdflatex and synctex are required for real PDF acceptance');
      this.skip(); return;
    }
    const workshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
    assert.ok(workshop, 'Workshop must be installed in the isolated integration profile');
    assert.equal(workshop.packageJSON.version, '10.19.0');
    await workshop.activate();
    await vscode.extensions.getExtension('MuteLoc0.oh-my-tex')!.activate();

    const existingTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
    // Canonicalize macOS /tmp -> /private/tmp so inverse-search paths identify
    // the same TextDocument/session even before Workshop's file cache is ready.
    const directory = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? process.env.TEMP! : '/tmp', 'omt-p5-pdf-')));
    const rootPath = path.join(directory, 'main.tex'), includedPath = path.join(directory, 'sections', 'body.tex');
    const includedUri = vscode.Uri.file(includedPath), pdfUri = vscode.Uri.file(path.join(directory, 'main.pdf'));
    const included = [
      '% !TeX root = ../main.tex',
      '\\section{PDF bridge}',
      'An included macro is $\\norm{x}$.',
      '\\begin{align}',
      '    E &= mc^2 \\\\',
      '    p &= \\gamma mv .',
      '\\end{align}',
      'Final paragraph in the included file.',
      '',
    ].join('\n');
    const root = [
      '\\documentclass{article}', '\\usepackage{amsmath}', '\\input{macros}',
      '\\begin{document}', 'Root document paragraph.', '\\input{sections/body}', '\\end{document}', '',
    ].join('\n');
    const definitions = '\\newcommand{\\norm}[1]{\\left\\lVert#1\\right\\rVert}\n';
    const receive = (message: unknown) => vscode.commands.executeCommand('oh-my-tex.test.receive', includedUri.toString(), message);
    const sent = () => vscode.commands.executeCommand<HostMessage[]>('oh-my-tex.test.sent', includedUri.toString());
    const clientSelection = () => vscode.commands.executeCommand<ClientSelection>('oh-my-tex.test.selection', includedUri.toString());
    const visualTabState = () => vscode.window.tabGroups.all.flatMap(group => group.tabs.flatMap(tab =>
      tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === includedUri.toString() && tab.input.viewType === VIEW_TYPE
        ? [{ column: group.viewColumn, selected: tab.isActive, groupActive: group.isActive }] : []));
    const waitClientAt = async (offset: number, what: string) => {
      try { return await until(async () => (await clientSelection())?.head === offset ? true : undefined, what); }
      catch (error) {
        const editor = vscode.window.activeTextEditor;
        throw new Error(`${String(error)}; PDF cursor diagnostics: ${JSON.stringify({
          expectedOffset: offset, selection: await clientSelection(), visualTabs: visualTabState(), messages: (await sent()).slice(-8),
          active: editor && { uri: editor.document.uri.toString(), column: editor.viewColumn, selection: editor.selection },
          visible: vscode.window.visibleTextEditors.map(value => ({ uri: value.document.uri.toString(), column: value.viewColumn })),
        })}`);
      }
    };
    let restoreObservation: (() => void) | undefined;

    try {
      await fs.mkdir(path.dirname(includedPath));
      await fs.writeFile(rootPath, root);
      await fs.writeFile(includedPath, included);
      await fs.writeFile(path.join(directory, 'macros.tex'), definitions);
      try {
        await run(pdflatex, ['-synctex=1', '-interaction=nonstopmode', '-halt-on-error', '-recorder', 'main.tex'],
          { cwd: directory, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
      } catch (error) {
        const details = error as Error & { stdout?: string; stderr?: string };
        throw new Error(`PDF fixture compilation failed: ${details.message}\n${details.stdout ?? ''}\n${details.stderr ?? ''}`);
      }
      assert.equal((await fs.readFile(pdfUri.fsPath)).subarray(0, 5).toString(), '%PDF-');
      assert.ok((await fs.stat(path.join(directory, 'main.synctex.gz'))).size > 0);
      await vscode.commands.executeCommand('vscode.openWith', includedUri, VIEW_TYPE);
      await until(() => vscode.commands.executeCommand<boolean>('oh-my-tex.test.ready', includedUri.toString()), 'real PDF visual editor ready');
      const document = await vscode.workspace.openTextDocument(includedUri);
      await until(async () => (await sent()).find(message => message.t === 'context' && message.macros.some(macro => macro.name === 'norm')),
        'temporary project macro context');

      // Public root synchronization awaits Workshop's own discovery and opens its PDF.
      await receive({ t: 'syncRoot' });
      // Fixed-version internals are test-only observers and the real reverse parser entry point.
      // Production code never imports them. They do not fabricate SyncTeX coordinates.
      const internalModule = require(path.join(workshop.extensionPath, 'out', 'src', 'lw.js')) as { lw: WorkshopInternals };
      const lw = internalModule.lw;
      await until(() => lw.root.file.path === rootPath ? true : undefined, 'Workshop temporary root');
      const calls: { uri: string; line: number; column: number; version: number }[] = [];
      const locations: { uri: vscode.Uri; records: PdfRecord[] }[] = [];
      const originalForward = lw.locate.synctex.toPDF, originalLocate = lw.viewer.locate;
      lw.locate.synctex.toPDF = function (...args) {
        const editor = vscode.window.activeTextEditor;
        assert.ok(editor, 'public Workshop SyncTeX must receive an active native editor');
        calls.push({ uri: editor.document.uri.toString(), line: editor.selection.active.line, column: editor.selection.active.character, version: editor.document.version });
        return originalForward.apply(this, args);
      };
      lw.viewer.locate = async function (uri, record) {
        locations.push({ uri, records: Array.isArray(record) ? record : [record] });
        await originalLocate.call(this, uri, record);
      };
      restoreObservation = () => { lw.locate.synctex.toPDF = originalForward; lw.viewer.locate = originalLocate; };
      let hiddenInverse: { request: ReverseRequest; record: InverseRecord } | undefined;

      for (const target of [{ label: 'inline macro', line: 2, column: included.split('\n')[2].indexOf('x}') },
        { label: 'align second row', line: 5, column: 9 }]) {
        const pos = new vscode.Position(target.line, target.column), offset = document.offsetAt(pos);
        const beforeReveal = (await sent()).length;
        const native = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside, preview: false });
        native.selection = new vscode.Selection(pos, pos);
        await until(async () => (await sent()).slice(beforeReveal).find(message => message.t === 'reveal' && message.anchor === offset), `${target.label} native-to-visual reveal`);
        await until(async () => {
          const selection = await clientSelection();
          return selection?.version === document.version && selection.anchor === offset && selection.head === offset ? selection : undefined;
        }, `${target.label} real webview cursor report`);
        await vscode.commands.executeCommand('vscode.openWith', includedUri, VIEW_TYPE);

        const beforeCall = calls.length, beforeLocation = locations.length;
        // VS Code does not consistently reactivate an existing custom panel
        // through openWith in this test runner. Drive its real Session using the
        // existing test hook; the bridge still executes the public Workshop
        // command, with the real webview flush and cursor report.
        await receive({ t: 'synctex' });
        const call = await until(() => calls[beforeCall], `${target.label} public SyncTeX invocation`);
        assert.deepEqual(call, { uri: includedUri.toString(), line: target.line, column: target.column, version: document.version });
        const location = await until(() => locations.slice(beforeLocation).find(value => value.uri.toString() === pdfUri.toString()), `${target.label} real PDF location`);
        await sameFile(location.uri.fsPath, pdfUri.fsPath);
        const rectangle = vscode.workspace.getConfiguration('latex-workshop').get('synctex.indicator') === 'rectangle';
        const binary = await run(synctexBinary, ['view', '-i', `${target.line + 1}:${rectangle ? 0 : target.column + 1}:${includedPath}`, '-o', pdfUri.fsPath], { timeout: 15000 });
        const expected = forwardRecords(binary.stdout);
        assert.ok(location.records.length, 'Workshop must pass a nonempty PDF position to its viewer');
        assert.ok(location.records.every(record => expected.some(value => value.page === record.page && Math.abs(value.x - record.x) < .01 && Math.abs(value.y - record.y) < .01)),
          'Workshop must locate the real binary output, not a mocked PDF position');

        // SyncTeX may return several boxes for align. Its inverse granularity is
        // engine-owned (pdfTeX often reports the closing align line).
        const record = location.records[0];
        const inverseRequest: ReverseRequest = {
          type: 'reverse_synctex', pdfFileUri: pdfUri.toString(), page: record.page, pos: [record.x + 1, record.y],
          textBeforeSelection: '', textAfterSelection: '',
        };
        const inverse = await lw.locate.synctex.components.computeToTeX(inverseRequest, pdfUri);
        assert.ok(inverse, 'Workshop must parse the generated SyncTeX file for reverse search');
        // Retest the first location while hidden, so the last visible align
        // acknowledgement cannot be mistaken for this inverse-search result.
        hiddenInverse ??= { request: inverseRequest, record: inverse };
        await sameFile(inverse.input, includedPath);
        if (target.label === 'inline macro') { assert.equal(inverse.line, 3); }
        else { assert.ok(inverse.line >= 4 && inverse.line <= 7, 'reverse location must remain inside the align environment'); }
        // Make the reverse event observable even if it resolves to the forward cursor.
        // Reuse the source group from the forward positioning. Opening the
        // native editor in the current visual group hides its webview and can
        // suspend its cursor report in Electron while this test waits for it.
        const other = await vscode.window.showTextDocument(document, { viewColumn: native.viewColumn, preview: false });
        other.selection = new vscode.Selection(0, 0, 0, 0);
        await waitClientAt(0, 'cursor moved before reverse search');
        const beforeInverse = (await sent()).length;
        await lw.locate.synctex.toTeX(inverseRequest, pdfUri);
        const reverseEditor = vscode.window.activeTextEditor;
        assert.equal(reverseEditor?.document.uri.toString(), includedUri.toString());
        assert.equal(reverseEditor.selection.active.line, inverse.line - 1);
        const reverseOffset = document.offsetAt(reverseEditor.selection.active);
        const reveal = await until(async () => (await sent()).slice(beforeInverse).find(message => message.t === 'reveal' && message.anchor === reverseOffset) as Reveal | undefined,
          `${target.label} PDF-to-webview reveal`);
        assert.equal(reveal.version, document.version);
        assert.equal(reveal.head, reverseOffset);
        await waitClientAt(reverseOffset, `${target.label} webview reverse selection`);
        console.log('[P5 PDF]', JSON.stringify({ target: target.label, sourceLine: target.line + 1, pdfPage: record.page, inverseLine: inverse.line, realPublicForward: true, realInverseParser: true }));
      }

      // Some Electron builds keep retained hidden scripts responsive. Either a
      // real acknowledgement or a deferred replay must preserve inverse search.
      assert.ok(hiddenInverse);
      const visualColumn = await vscode.commands.executeCommand<vscode.ViewColumn>('oh-my-tex.test.show', includedUri.toString());
      assert.ok(visualColumn, 'the existing visual panel must have a source group');
      const coveringEditor = await vscode.window.showTextDocument(document, { viewColumn: visualColumn, preview: false });
      assert.equal(coveringEditor.viewColumn, visualColumn);
      coveringEditor.selection = new vscode.Selection(0, 0, 0, 0);
      // Do not wait for client acknowledgement while the panel is hidden.
      const beforeHiddenInverse = (await sent()).length;
      await lw.locate.synctex.toTeX(hiddenInverse.request, pdfUri);
      const hiddenReverseEditor = vscode.window.activeTextEditor;
      assert.equal(hiddenReverseEditor?.document.uri.toString(), includedUri.toString());
      assert.equal(hiddenReverseEditor.selection.active.line, hiddenInverse.record.line - 1);
      const hiddenOffset = document.offsetAt(hiddenReverseEditor.selection.active);
      await until(async () => (await sent()).slice(beforeHiddenInverse).find(message => message.t === 'reveal' && message.anchor === hiddenOffset),
        'native reverse location while the visual panel is hidden');
      const beforeShowSelection = await clientSelection(), beforeShowViewState = visualTabState();
      const acknowledgedWhileHidden = beforeShowSelection?.version === document.version && beforeShowSelection.anchor === hiddenOffset && beforeShowSelection.head === hiddenOffset;
      const beforeShow = (await sent()).length;
      await vscode.commands.executeCommand('oh-my-tex.test.show', includedUri.toString());
      let replayed = false;
      if (!acknowledgedWhileHidden) {
        try {
          await until(async () => (await sent()).slice(beforeShow).find(message => message.t === 'reveal' && message.anchor === hiddenOffset),
            'deferred reverse location replay when the visual panel is shown');
          replayed = true;
        } catch (error) {
          throw new Error(`${String(error)}; hidden inverse diagnostics: ${JSON.stringify({
            beforeShowSelection, beforeShowViewState, selection: await clientSelection(), viewState: visualTabState(), messages: (await sent()).slice(-8),
          })}`);
        }
      }
      await waitClientAt(hiddenOffset, 'hidden PDF reverse location confirmed after returning to visual editor');
      console.log('[P5 PDF]', JSON.stringify({ hiddenInverseReplayed: replayed, acknowledgedWhileHidden, inverseLine: hiddenInverse.record.line, beforeShowViewState }));
      assert.equal(document.getText(), included);
      assert.equal(document.isDirty, false);
      assert.equal(await fs.readFile(rootPath, 'utf8'), root);
      assert.equal(await fs.readFile(includedPath, 'utf8'), included);
      assert.equal(await fs.readFile(path.join(directory, 'macros.tex'), 'utf8'), definitions);
      console.log('[P5 PDF] PDF mouse/keyboard interaction is not exercised by this API integration test.');
    } finally {
      restoreObservation?.();
      for (const document of vscode.workspace.textDocuments.filter(document => document.uri.fsPath.startsWith(directory + path.sep) && document.isDirty)) {
        await vscode.window.showTextDocument(document, { preview: false });
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
      }
      const createdTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !existingTabs.has(tab));
      if (createdTabs.length) { await vscode.window.tabGroups.close(createdTabs, true); }
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
