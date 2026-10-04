import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFile } from '../../src/core/macroParser.ts';
import { indexProject, type Project } from '../../src/core/projectGraph.ts';
import { scanFormulas } from '../../src/core/formulaScanner.ts';
import { filterCompletions } from '../../src/core/completionFilter.ts';
import { filterMathCompletions } from '../../src/core/mathCompletionFilter.ts';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import { MockHost, type CompletionRequest } from './host.ts';

// This is a user-owned, external fixture. A standalone checkout may provide it
// through OMT_TESTBENCH_ROOT instead of the sibling test/testbench-v1/note path.
const fixture = path.resolve(process.env.OMT_TESTBENCH_ROOT ?? '../test/testbench-v1/note');
const available = existsSync(path.join(fixture, 'main.tex'));
const names = ['eu', 'ramuno', 'dbar', 'dif', 'bm', 'varPi', 'varPhi', 'varLambda', 'calL', 'calH', 'calF', 'calZ', 'calS'];
let project: Project;
let main: string;

test.beforeAll(async () => {
  if (!available) { return; }
  main = await fs.readFile(path.join(fixture, 'main.tex'), 'utf8');
  const root = pathToFileURL(path.join(fixture, 'main.tex')).href;
  project = await indexProject(root, {
    read: uri => fs.readFile(fileURLToPath(uri), 'utf8').catch(() => undefined),
    resolve: (parent, child) => pathToFileURL(path.resolve(path.dirname(fileURLToPath(parent)), child)).href,
  });
});
test.beforeEach(() => test.skip(!available, 'local testbench fixture unavailable; set OMT_TESTBENCH_ROOT'));

interface TestMathField extends HTMLElement {
  position: number;
  lastOffset: number;
  errors: { code: string; arg?: string }[];
  executeCommand(command: string): boolean;
  getValue(format?: string): string;
}

const live = (page: Page) => page.locator('.omt-live math-field');
const rendered = (field: Locator) => field.evaluate(element => element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '');

async function enter(page: Page, index = 0) {
  await page.locator('.omt-formula').nth(index).click();
  await expect(live(page)).toBeVisible();
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await live(page).evaluate(element => element.focus());
  await expect(live(page)).toBeFocused();
}

function macroItems(request: CompletionRequest, host: MockHost): CompletionItemDTO[] {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  const query = host.text.slice(from, request.at);
  const items = project.macros.map((macro, i): CompletionItemDTO => ({
    i, label: `\\${macro.name}`, filterText: macro.name, detail: 'Project macro', source: 'macro',
    insert: { snippet: true, value: macro.name + Array.from({ length: macro.arity }, (_, a) => `{$${a + 1}}`).join('') },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at },
  }));
  // Mock transport covers the webview acceptance path. Real host/provider
  // discovery is covered by generic integration fixtures. This external project's
  // desktop provider/root discovery still needs the separate UI test procedure.
  const contextual = request.ctx === 'math' ? filterMathCompletions(items, project.macros, []) : items;
  return filterCompletions(contextual, query, 300);
}

test('testbench indexes every main.tex macro through the real include graph', async () => {
  expect(parseFile(main, project.root).definitions.map(def => def.name)).toEqual(names);
  expect(project.macros.map(def => def.name)).toEqual(names);
  expect(project.files).toHaveLength(5);
  expect(project.diagnostics).toEqual([]);
  expect(project.macros.every(def => def.source?.uri === project.root)).toBe(true);
});

for (const name of names) {
  test(`testbench macro \\${name}: actual static and live output preserves the call`, async ({ page }) => {
    const source = `$\\${name}${name === 'bm' ? '{p}' : ''}+a$`;
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    const host = new MockHost(page, source, project.macros);
    await host.open();
    const expected = ({ eu: 'e', ramuno: 'i', dbar: 'đ', dif: 'd', bm: 'p', varPi: 'Π', varPhi: 'Φ', varLambda: 'Λ',
      calL: 'L', calH: 'H', calF: 'F', calZ: 'Z', calS: 'S' } as Record<string, string>)[name]!;
    const staticText = await page.locator('.omt-formula').textContent();
    await expect(page.locator('.omt-formula .ML__error')).toHaveCount(0);
    await enter(page);
    const liveText = await rendered(live(page));
    const fieldErrors = await live(page).evaluate(element => (element as TestMathField).errors);
    console.log('[testbench macro]', JSON.stringify({ name, staticText, liveText, fieldErrors }));
    // Exact visible glyphs establish rendering; an error-free safe chip alone would not.
    expect(staticText).toBe(expected + '+a');
    expect(liveText).toBe(expected + '+a');
    expect(staticText).not.toContain(`\\${name}`);
    expect(liveText).not.toContain(`\\${name}`);
    expect(fieldErrors).toEqual([]);
    expect(await live(page).evaluate(element => element.shadowRoot?.querySelectorAll('.ML__error').length ?? 0)).toBe(0);
    await host.flush();
    expect(host.text).toBe(source);
    expect(host.version).toBe(1);
    expect(host.edits).toEqual([]);
    await live(page).evaluate(element => { const field = element as TestMathField; field.position = field.lastOffset; });
    await page.keyboard.press('Backspace');
    await page.keyboard.type('q');
    await host.flush();
    expect(host.text).toBe(source.replace('+a$', '+q$'));
    expect(host.text).not.toMatch(/\\OMT[a-z]+|\\placeholder/);
    expect(errors).toEqual([]);
  });
}

for (const call of ['\\bm{p}', '\\bm p']) {
  test(`testbench compatible \\symbfit body remains editable through ${call}`, async ({ page }) => {
    const definitions = project.macros.map(macro => main.slice(macro.source!.from, macro.source!.to)).join('\n');
    const source = `${definitions}\n\n$${call}+a$`;
    const host = new MockHost(page, source, project.macros);
    await host.open();
    await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await enter(page);
    await page.locator('.omt-macro-edit').filter({ hasText: '\\bm' }).click();
    const argument = page.locator('.omt-macro-arg[data-index="1"] math-field');
    await expect(argument).toBeVisible();
    expect(await argument.evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('p');
    await argument.evaluate(element => { element.focus(); (element as TestMathField).executeCommand('selectAll'); });
    await page.keyboard.type('q');
    await host.flush();
    expect(host.text).toBe(source.slice(0, source.lastIndexOf('p')) + 'q' + source.slice(source.lastIndexOf('p') + 1));
    expect(host.text.slice(0, definitions.length)).toBe(definitions);
    expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: source.lastIndexOf('p'), to: source.lastIndexOf('p') + 1, expected: 'p', insert: 'q' }]);
    expect(host.text).not.toMatch(/\\OMT[a-z]+|\\placeholder/);
  });
}

for (const name of names) {
  for (const ctx of ['prose', 'math'] as const) {
    test(`testbench \\${name} completion is accepted in ${ctx}`, async ({ page }) => {
      const source = ctx === 'math' ? '$x+$' : 'Text ';
      const host = new MockHost(page, source, project.macros, { completion: (request, current) => ({ items: macroItems(request, current) }) });
      await host.open();
      if (ctx === 'math') {
        await enter(page);
        await live(page).evaluate(element => { const field = element as TestMathField; field.position = field.lastOffset; });
      } else {
        await page.evaluate(position => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(position), source.length);
      }
      await page.keyboard.type('\\' + name.slice(0, -1));
      if (ctx === 'math') { await expect(page.locator('.omt-math-buffer input')).toBeVisible(); }
      // Project macro labels retain their leading backslash in the popup.
      const label = page.locator('.omt-completion-item').filter({ hasText: `\\${name}` }).first();
      await expect(label).toBeVisible();
      await label.click();
      if (name === 'bm') {
        if (ctx === 'math') {
          await expect(page.locator('.omt-macro-arg[data-index="1"] math-field')).toBeFocused();
          await expect(live(page)).not.toBeFocused();
        }
        await page.keyboard.type('p');
      }
      await host.flush();
      const call = `\\${name}${name === 'bm' ? '{p}' : ''}`;
      expect(host.requests.length).toBeGreaterThan(0);
      expect(host.requests.every(request => request.ctx === ctx)).toBe(true);
      expect(host.completionDocuments.every((snapshot, i) => snapshot.version === host.requests[i]!.version)).toBe(true);
      expect(host.text).not.toMatch(/\\OMT[a-z]+|\\placeholder/);
      if (name === 'bm' && ctx === 'math') {
        const evidenceDirectory = path.resolve('out/testbench-v1-ui/browser-evidence');
        await fs.mkdir(evidenceDirectory, { recursive: true });
        await fs.writeFile(path.join(evidenceDirectory, 'bm-completion-argument.json'), JSON.stringify({
          source, expected: `$x+${call}$`, actual: host.text, requests: host.requests, patches: host.edits.flatMap(edit => edit.patches),
        }, null, 2) + '\n');
      }
      expect(host.text).toBe(ctx === 'math' ? `$x+${call}$` : source + call);
    });
  }
}

test('testbench bm completion opens its source-owned parameter field and writes b+bm{x}', async ({ page }) => {
  const host = new MockHost(page, '$b+$', project.macros, { completion: (request, current) => ({ items: macroItems(request, current) }) });
  await host.open();
  await enter(page);
  await live(page).evaluate(element => { const field = element as TestMathField; field.position = field.lastOffset; });
  await page.keyboard.type('\\bm');
  await expect(page.locator('.omt-completion-item').filter({ hasText: '\\bm' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\bm');
  await expect(page.locator('.omt-macro-arg[data-index="1"] math-field')).toBeFocused();
  await expect(live(page)).not.toBeFocused();
  await page.keyboard.type('x');
  await host.flush();
  expect(host.text).toBe('$b+\\bm{x}$');
  expect(host.text).not.toMatch(/\\OMT[a-z]+|\\placeholder/);
});

for (const file of ['main.tex', 'chapters/NJL-model-eng.tex', 'chapters/NJL-model.tex', 'chapters/appendix01-noethers-theorem.tex',
  'chapters/chiral-qft.tex', 'chapters/concurrence.tex', 'chapters/finite-temp-field-the.tex', 'chapters/quantum-inf.tex']) {
  test(`testbench full ${file} opens and scrolls without source writeback`, async ({ page }) => {
    const source = await fs.readFile(path.join(fixture, file), 'utf8');
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    const host = new MockHost(page, source, project.macros);
    await host.open();
    const spans = scanFormulas(source).filter(span => !span.sourceOnly);
    const observed = new Set<number>();
    const scroller = page.locator('.cm-scroller');
    // Traverse the real full document. CodeMirror mounts formula widgets for its
    // viewport, so counts from the initial screen alone understate the corpus.
    for (let top = 0; ; top += 400) {
      const metrics = await scroller.evaluate((element, top) => {
        element.scrollTop = top;
        return { maximum: element.scrollHeight - element.clientHeight };
      }, top);
      await page.waitForTimeout(15);
      const offsets = await page.locator('.omt-formula').evaluateAll(elements => elements.map(element => Number((element as HTMLElement).dataset.from)));
      offsets.forEach(offset => observed.add(offset));
      expect(await page.locator('.omt-formula.omt-error').count()).toBe(0);
      if (top >= metrics.maximum) { break; }
    }
    expect([...observed].sort((a, b) => a - b)).toEqual(spans.map(span => span.from));
    await host.flush();
    expect(host.text).toBe(source);
    expect(host.version).toBe(1);
    expect(host.edits).toEqual([]);
    expect(errors).toEqual([]);
    console.log('[testbench full document]', JSON.stringify({ file, formulas: spans.length, observed: observed.size, sourceUntouched: true }));
  });
}

for (const line of [95, 226]) {
  test(`testbench finite-temp style declaration at line ${line} survives click and Cmd+Right end editing`, async ({ page }) => {
    const chapter = await fs.readFile(path.join(fixture, 'chapters/finite-temp-field-the.tex'), 'utf8');
    const span = scanFormulas(chapter).find(span => chapter.slice(0, span.from).split('\n').length === line)!;
    expect(span).toBeDefined();
    const source = chapter.slice(span.from, span.to);
    const host = new MockHost(page, source, project.macros);
    await host.open();
    await enter(page);
    await host.flush();
    expect(host.text).toBe(source);
    expect(host.edits).toEqual([]);
    await page.keyboard.press('Meta+ArrowRight');
    await page.keyboard.type('+q');
    await host.flush();
    const body = chapter.slice(span.bodyFrom, span.bodyTo);
    const insertion = span.bodyTo - span.from - (body.match(/\s*$/)?.[0].length ?? 0);
    const expected = source.slice(0, insertion) + '+q' + source.slice(insertion);
    const evidence = { line, source, expected, actual: host.text, patches: host.edits.flatMap(edit => edit.patches) };
    console.log('[testbench style edit]', JSON.stringify(evidence));
    const evidenceDirectory = path.resolve('out/testbench-v1-ui/browser-evidence');
    await fs.mkdir(evidenceDirectory, { recursive: true });
    await fs.writeFile(path.join(evidenceDirectory, `finite-temp-style-${line}.json`), JSON.stringify(evidence, null, 2) + '\n');
    expect(host.text).toBe(expected);
    expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: insertion, to: insertion, expected: '', insert: '+q' }]);
  });
}
