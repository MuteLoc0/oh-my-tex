import { test, expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MockHost } from './host.ts';
import type { TextMateGrammar, TextMateThemeRule } from '../../src/shared/types.ts';

const fixtures = path.resolve('test/fixtures/textmate');
const grammars: TextMateGrammar[] = [
  { scopeName: 'text.tex.latex', format: 'json', content: fs.readFileSync(path.join(fixtures, 'LaTeX.tmLanguage.json'), 'utf8') },
  { scopeName: 'text.tex', format: 'json', content: fs.readFileSync(path.join(fixtures, 'TeX.tmLanguage.json'), 'utf8') },
];
const tokenColors: TextMateThemeRule[] = JSON.parse(fs.readFileSync(path.join(fixtures, 'ayu-dark-tokenColors.json'), 'utf8'));
const tokens = { grammars, tokenColors, bracketPairs: { enabled: true, independentColorPoolPerBracketType: false } };

interface TestField extends HTMLElement { position: number }
interface Lifecycle { field: Element; mount: number; unmount: number }

async function watchField(field: Locator) {
  await expect(field).toBeFocused();
  await field.evaluate(element => {
    const lifecycle: Lifecycle = { field: element, mount: 0, unmount: 0 };
    for (const event of ['mount', 'unmount'] as const) element.addEventListener(event, () => lifecycle[event]++);
    (window as unknown as { lifecycle: Lifecycle }).lifecycle = lifecycle;
  });
}

async function expectStableField(page: Page, field: Locator, position?: number) {
  // The syntax worker draws in asynchronous slices. Let its subsequent updates
  // run before checking the live field's lifecycle and focus.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(field).toBeFocused();
  expect(await field.evaluate(element => {
    const lifecycle = (window as unknown as { lifecycle: Lifecycle }).lifecycle;
    return { same: element === lifecycle.field, mount: lifecycle.mount, unmount: lifecycle.unmount };
  })).toEqual({ same: true, mount: 0, unmount: 0 });
  if (position !== undefined) expect(await field.evaluate(element => (element as TestField).position)).toBe(position);
}

for (const [open, close] of [['$', '$'], ['\\(', '\\)']]) {
test(`an inline ${open} formula beside prose keeps its field and caret through consecutive input`, async ({ page }) => {
  const host = new MockHost(page, `A test: ${open}a${close}.`, [], { settings: { tokens } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
  await page.locator('.omt-formula').click();
  const field = page.locator('.omt-live math-field');
  await watchField(field);
  await page.keyboard.press('Meta+ArrowRight');
  let position = 1;
  for (const key of ['b', 'c', '+', 'd']) {
    await page.keyboard.type(key);
    await expectStableField(page, field, ++position);
  }
  await page.keyboard.press('Backspace');
  await expectStableField(page, field, --position);
  await page.keyboard.type('d');
  await expectStableField(page, field, ++position);
  await host.flush();
  expect(host.text).toBe(`A test: ${open}abc+d${close}.`);
  expect(errors).toEqual([]);
});
}

test('two inline formulas stay editable without writing back the untouched neighbor', async ({ page }) => {
  const host = new MockHost(page, 'Before $a$ between $z$ after.', [], { settings: { tokens } });
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
  // Start with the prose caret beside the second formula, then click the first.
  await page.evaluate(position => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(position), host.text.length);
  await page.locator('.omt-formula').first().click();
  const field = page.locator('.omt-live math-field');
  await watchField(field);
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('b');
  await expectStableField(page, field, 2);
  await page.keyboard.type('c');
  await expectStableField(page, field, 3);
  await host.flush();
  expect(host.text).toBe('Before $abc$ between $z$ after.');
  expect(host.edits.flatMap(edit => edit.patches).every(patch => patch.from >= 8 && patch.to <= 10)).toBe(true);
  await page.locator('.omt-formula').nth(1).click();
  await expect(field).toBeFocused();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe('Before $abc$ between $zq$ after.');
});

test('short formula source regains TextMate colors after selection and mode changes', async ({ page }) => {
  const host = new MockHost(page, 'Text $\\alpha$.', [], { settings: { tokens } });
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
  const formula = page.locator('.omt-formula');
  const wrappers = formula.locator('xpath=ancestor::*[contains(@class, "tm-c")]');
  await expect(wrappers).toHaveCount(0);
  const source = page.locator('.cm-line').getByText('\\alpha', { exact: true });
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(8));
  await expect(formula).toHaveCount(0);
  await expect(source).toHaveCSS('color', 'rgb(149, 230, 203)');
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));
  await expect(formula).toHaveCount(1);
  await expect(wrappers).toHaveCount(0);
  await host.toggleSource();
  await expect(source).toHaveCSS('color', 'rgb(149, 230, 203)');
  await host.toggleSource();
  await expect(formula).toHaveCount(1);
  await expect(wrappers).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe('Text $\\alpha$.');
  expect(host.edits).toEqual([]);
});

test('TextMate redraw preserves inline completion prompts and continued fraction editing', async ({ page }) => {
  const host = new MockHost(page, 'Fraction: $x+$.', [], {
    settings: { tokens },
    completion: (request, host) => {
      const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
      return { items: [{ i: 0, label: '\\frac', filterText: '\\frac', source: 'provider', insert: { snippet: true, value: 'frac{$1}{$2}$0' },
        range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at } }] };
    },
  });
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
  await page.locator('.omt-formula').click();
  const field = page.locator('.omt-live math-field');
  await watchField(field);
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('\\fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await expectStableField(page, field);
  await page.keyboard.type('a');
  await expectStableField(page, field);
  await page.keyboard.press('Tab');
  await page.keyboard.type('b');
  await expectStableField(page, field);
  await host.flush();
  expect(host.text).toBe('Fraction: $x+\\frac{a}{b}$.');
  expect(host.text).not.toMatch(/\\placeholder|\\OMT[A-Za-z]+/);
});

test('removing an active inline formula reloads the adjacent formula and disposes a field when none remain', async ({ page }) => {
  const host = new MockHost(page, 'Text $a$ $z$ end', [], { settings: { tokens } });
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
  await page.locator('.omt-formula').first().click();
  const field = page.locator('.omt-live math-field');
  await watchField(field);
  await host.remote([{ from: 5, to: 9, insert: '' }]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.omt-formula')).toHaveCount(1);
  await page.locator('.omt-formula').click();
  await expect(field).toBeFocused();
  expect(await field.evaluate(element => (element as HTMLElement & { value: string }).value)).toBe('z');
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe('Text $zq$ end');
  await watchField(field);
  await host.remote([{ from: 5, to: 9, insert: '' }]);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => (window as unknown as { lifecycle: Lifecycle }).lifecycle.field.isConnected)).toBe(false);
  await expect(page.locator('.omt-live')).toHaveCount(0);
  await expect(page.locator('.omt-formula')).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe('Text  end');
});
