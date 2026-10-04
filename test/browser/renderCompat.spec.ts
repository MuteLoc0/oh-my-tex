import { test, expect, type Locator, type Page } from '@playwright/test';
import { MATH_COMMANDS } from '../../src/core/mathCommands.ts';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import type { MacroDef } from '../../src/shared/types.ts';
import { MockHost, type MockHostOptions } from './host.ts';

interface TestMathField extends HTMLElement {
  position: number;
  lastOffset: number;
  errors: { code: string; arg?: string }[];
  executeCommand(command: string): boolean;
  getValue(format?: string): string;
}

const live = (page: Page) => page.locator('.omt-live math-field');
const rendered = (field: Locator) => field.evaluate(element => element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '');

async function open(page: Page, source: string, macros: MacroDef[] = [], options: MockHostOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, source, macros, options);
  await host.open();
  await expect(page.locator('.omt-formula')).toHaveCount(1);
  const staticText = await page.locator('.omt-formula').textContent() ?? '';
  await expect(page.locator('.omt-formula .ML__error')).toHaveCount(0);
  await page.locator('.omt-formula').click();
  await expect(live(page)).toBeVisible();
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await live(page).evaluate(element => element.focus());
  await expect(live(page)).toBeFocused();
  const liveText = await rendered(live(page));
  expect(await live(page).evaluate(element => (element as TestMathField).errors)).toEqual([]);
  expect(await live(page).evaluate(element => element.shadowRoot?.querySelectorAll('.ML__error').length ?? 0)).toBe(0);
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.version).toBe(1);
  expect(host.edits).toEqual([]);
  expect(errors).toEqual([]);
  return { host, errors, staticText, liveText };
}

async function replaceLastAtom(page: Page, host: MockHost, source: string) {
  await live(page).evaluate(element => {
    const field = element as TestMathField;
    field.position = field.lastOffset; field.focus();
  });
  await expect(live(page)).toBeFocused();
  await page.keyboard.press('Backspace');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe(source.replace('+a$', '+q$'));
  expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
  expect(host.edits.flatMap(edit => edit.patches).every(patch => !/\\OMT[A-Za-z]+|\\placeholder/.test(patch.insert))).toBe(true);
}

for (const name of ['symbfit', 'symit', 'symbf', 'symup', 'symrm', 'symsf', 'symtt', 'symcal', 'symscr', 'symfrak', 'symbb', 'symbfup', 'mathbfup']) {
  test(`unicode-math \\${name} renders in static and active formulas without changing its source`, async ({ page }) => {
    const source = `$\\${name}{X}+a$`;
    const { host, errors, staticText, liveText } = await open(page, source);
    expect(staticText).toBe('X+a');
    expect(liveText).toBe('X+a');
    expect(staticText).not.toContain(`\\${name}`);
    expect(liveText).not.toContain(`\\${name}`);
    await replaceLastAtom(page, host, source);
    expect(errors).toEqual([]);
  });
}

const packageCalls = [
  { name: 'dots', call: '\\dots', glyphs: ['…'] },
  { name: 'slashed', call: '\\slashed{\\partial}', glyphs: ['∂'] },
  { name: 'cancelto', call: '\\cancelto{0}{x}', glyphs: ['0', 'x'] },
  { name: 'dv', call: '\\dv{x}{y}', glyphs: ['x', 'y'] },
  { name: 'pdv', call: '\\pdv{x}{y}', glyphs: ['x', 'y', '∂'] },
  { name: 'abs', call: '\\abs{x}', glyphs: ['x', '∣'] },
  { name: 'norm', call: '\\norm{x}', glyphs: ['x'] },
  { name: 'qty', call: '\\qty{x}', glyphs: ['x', '(', ')'] },
  { name: 'bra', call: '\\bra{x}', glyphs: ['x', '⟨'] },
  { name: 'ket', call: '\\ket{x}', glyphs: ['x', '⟩'] },
  // MathLive already supplies the one-argument braket package macro.
  { name: 'braket', call: '\\braket{x|y}', glyphs: ['x', 'y', '⟨', '⟩'] },
];

for (const { name, call, glyphs } of packageCalls) {
  test(`package command \\${name} renders without chips or compatibility expansion leaking into source`, async ({ page }) => {
    const source = `$${call}+a$`;
    const { host, errors, staticText, liveText } = await open(page, source);
    for (const text of [staticText, liveText]) {
      expect(text).not.toContain(`\\${name}`);
      for (const glyph of glyphs) { expect(text).toContain(glyph); }
    }
    await replaceLastAtom(page, host, source);
    expect(errors).toEqual([]);
  });
}

test('a project macro takes priority over the compatibility command of the same name', async ({ page }) => {
  const source = '$\\symbf{x}+a$';
  const { host, staticText, liveText } = await open(page, source, [{ name: 'symbf', arity: 1, body: 'P+#1' }]);
  expect(staticText).toBe('P+x+a');
  expect(liveText).toBe('P+x+a');
  await replaceLastAtom(page, host, source);
});

test('renderMacros takes priority over both a project macro and its compatibility command', async ({ page }) => {
  const source = '\\newcommand{\\symbf}[1]{P+#1}\n$\\symbf{x}+a$';
  const { host, staticText, liveText } = await open(page, source, [{ name: 'symbf', arity: 1, body: 'P+#1' }], {
    renderMacros: [{ name: 'symbf', arity: 1, body: 'R+#1' }],
  });
  expect(staticText).toBe('R+x+a');
  expect(liveText).toBe('R+x+a');
  await replaceLastAtom(page, host, source);
  expect(host.text).toContain('\\newcommand{\\symbf}[1]{P+#1}');
});

test('renderMacros can override a MathLive built-in while preserving the original command', async ({ page }) => {
  const source = '$\\alpha+a$';
  const { host, staticText, liveText } = await open(page, source, [], { renderMacros: [{ name: 'alpha', arity: 0, body: 'R' }] });
  expect(staticText).toBe('R+a');
  expect(liveText).toBe('R+a');
  await replaceLastAtom(page, host, source);
});

for (const optional of [true, false]) {
  test(`a display override preserves the project's parameter count and ${optional ? 'explicit' : 'default'} optional argument`, async ({ page }) => {
    const definition = '\\newcommand{\\pair}[2][d]{P+#1+#2}';
    const call = optional ? '\\pair  [u] {v}' : '\\pair  {v}';
    const source = `${definition}\n$${call}+a$`;
    const { host, staticText, liveText } = await open(page, source, [{ name: 'pair', arity: 2, defaultArgument: 'd', body: 'P+#1+#2' }], {
      renderMacros: [{ name: 'pair', arity: 1, body: 'R+#1' }],
    });
    expect(staticText).toBe(`R+${optional ? 'u' : 'd'}+a`);
    expect(liveText).toBe(staticText);
    await page.locator('.omt-macro-edit').filter({ hasText: '\\pair' }).click();
    await expect(page.locator('.omt-macro-arg')).toHaveCount(2);
    const first = page.locator('.omt-macro-arg[data-index="1"]');
    if (optional) {
      expect(await first.locator('math-field').evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('u');
    } else { await expect(first.locator('.omt-optional-add')).toBeVisible(); }
    const second = page.locator('.omt-macro-arg[data-index="2"] math-field');
    expect(await second.evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('v');
    await second.evaluate(element => { element.focus(); (element as TestMathField).executeCommand('selectAll'); });
    await page.keyboard.type('w');
    await host.flush();
    const at = source.lastIndexOf('v');
    expect(host.text).toBe(source.slice(0, at) + 'w' + source.slice(at + 1));
    expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: at, to: at + 1, expected: 'v', insert: 'w' }]);
    expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
    expect(await rendered(live(page))).toBe(staticText);
  });
}

test('an unsupported command outside the compatibility table still renders an editable safe chip', async ({ page }) => {
  const source = '$\\omtUnknownPackageCommand{x}+a$';
  const { host, staticText, liveText } = await open(page, source);
  expect(staticText).toBe('\\omtUnknownPackageCommand+a');
  expect(liveText).toBe(staticText);
  await page.locator('.omt-macro-edit').filter({ hasText: '\\omtUnknownPackageCommand' }).click();
  await expect(page.locator('.omt-macro-arg math-field')).toHaveCount(1);
  await page.locator('.omt-macro-close').click();
  await replaceLastAtom(page, host, source);
});

test('renderMacros hot updates refresh static and active output without source writeback', async ({ page }) => {
  const source = '$\\foo+a$ and $\\foo+b$';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, source, [], { renderMacros: [{ name: 'foo', arity: 0, body: 'P' }] });
  await host.open();
  await expect(page.locator('.omt-formula')).toHaveText(['P+a', 'P+b']);
  await page.locator('.omt-formula').first().click();
  await expect(live(page)).toBeFocused();
  expect(await rendered(live(page))).toBe('P+a');
  await page.evaluate(() => window.postMessage({ t: 'context', contextVersion: 2,
    macros: [], renderMacros: [{ name: 'foo', arity: 0, body: 'R' }], templates: [], diagnostics: [],
  }, '*'));
  await expect.poll(() => rendered(live(page))).toBe('R+a');
  await expect(page.locator('.omt-formula:not(.omt-live)')).toHaveText('R+b');
  expect(await live(page).evaluate(element => (element as TestMathField).errors)).toEqual([]);
  await expect(page.locator('.omt-formula:not(.omt-live) .ML__error')).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.version).toBe(1);
  expect(host.edits).toEqual([]);
  expect(errors).toEqual([]);
});

test('source macro hot updates refresh parameter completion even when renderMacros keeps the same output', async ({ page }) => {
  const source = '$\\norm{x}+\\foo+a$';
  const norm: MacroDef = { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' };
  const foo: MacroDef = { name: 'foo', arity: 0, body: 'R' };
  // A provider candidate must pass the source-macro filter; neither MathLive nor
  // the display-only override should make this command eligible on its own.
  expect(MATH_COMMANDS.has(foo.name)).toBe(false);
  const { host, errors, liveText } = await open(page, source, [norm], {
    renderMacros: [foo],
    completion: (request, current) => {
      const from = current.text.lastIndexOf('\\', request.at - 1) + 1;
      const item: CompletionItemDTO = {
        i: 0, label: '\\foo', filterText: 'foo', source: 'provider', insert: { snippet: false, value: 'foo' },
        range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at },
      };
      return { items: [item] };
    },
  });
  await page.locator('.omt-macro-edit').filter({ hasText: '\\norm' }).click();
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  await page.evaluate(({ norm, foo }) => window.postMessage({ t: 'context', contextVersion: 2,
    macros: [norm, foo], renderMacros: [foo], templates: [], diagnostics: [],
  }, '*'), { norm, foo });
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  expect(await rendered(live(page))).toBe(liveText);
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.version).toBe(1);
  expect(host.edits).toEqual([]);
  await page.locator('.omt-macro-edit').filter({ hasText: '\\norm' }).click();
  const argument = page.locator('.omt-macro-arg[data-index="1"] math-field');
  await expect(argument).toBeVisible();
  await argument.evaluate(element => {
    const field = element as TestMathField;
    field.position = field.lastOffset; field.focus();
  });
  await expect(argument).toBeFocused();
  await page.keyboard.type('\\');
  await expect(page.locator('.omt-math-buffer input')).toBeVisible();
  await page.keyboard.type('fo');
  await expect(page.locator('.omt-completion-item')).toContainText('\\foo');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$\\norm{x\\foo}+\\foo+a$');
  expect(host.requests.every(request => request.ctx === 'math')).toBe(true);
  expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
  expect(errors).toEqual([]);
});
