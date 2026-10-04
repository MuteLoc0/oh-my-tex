import { test, expect, type Page } from '@playwright/test';
import { MockHost } from './host.ts';

const macros = [
  { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' },
  { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'x' },
  { name: 'R', arity: 0, body: '\\mathbb{R}' },
];

async function setup(page: Page, text: string) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(String(e)));
  const host = new MockHost(page, text, macros);
  await host.open();
  return { host, errors };
}

/** Click a rendered formula (nth .omt-formula) and wait for its live math field. */
async function enterFormula(page: Page, nth: number) {
  await page.locator('.omt-formula').nth(nth).click();
  await page.waitForSelector('.omt-live math-field');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
}

const mf = (page: Page, script: string) => page.evaluate(script);
/** Leave the live formula and park the prose caret at the document start. */
const park = (page: Page) => page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));

test('formulas render in place and opening writes nothing', async ({ page }) => {
  const { host, errors } = await setup(page, 'Text $E=mc^2$ and\n\\[\n  \\frac{a}{b}\n\\]\nend $a % c\n b$.\n');
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  await expect(page.locator('.omt-display')).toHaveCount(1);
  // The comment formula stays source text.
  await expect(page.locator('.cm-content')).toContainText('% c');
  await page.waitForTimeout(400);
  expect(host.edits).toEqual([]);
  expect(host.version).toBe(1);
  expect(errors).toEqual([]);
});

test('typing in a formula produces one minimal patch', async ({ page }) => {
  const { host } = await setup(page, 'Einstein $E=mc^2$.');
  await enterFormula(page, 0);
  // Select the "m" and type over it.
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.selection = { ranges: [[2, 3]] }; })()`);
  await page.keyboard.type('M');
  const edits = await host.flush();
  expect(host.text).toBe('Einstein $E=Mc^2$.');
  expect(edits.flatMap(e => e.patches)).toEqual([{ from: 12, to: 13, expected: 'm', insert: 'M' }]);
});

test('user spacing and braces survive an edit', async ({ page }) => {
  const { host } = await setup(page, '$ E = m c^{2} $ and $\\sum_{i=1}^n a_i$');
  await enterFormula(page, 1);
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset; })()`);
  await page.keyboard.type('+b');
  await host.flush();
  expect(host.text).toBe('$ E = m c^{2} $ and $\\sum_{i=1}^n a_i+b$');
});

test('environment wrapper and \\label are preserved', async ({ page }) => {
  const text = '\\begin{equation}\\label{eq:a}\n  x + y\n\\end{equation}\n\\begin{align}\n  a &= b \\\\\n  c &= d \\label{eq:b}\n\\end{align}\n';
  const { host } = await setup(page, text);
  await enterFormula(page, 0);
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset; })()`);
  await page.keyboard.type('+z');
  await host.flush();
  expect(host.text).toBe(text.replace('x + y', 'x + y+z'));
  await page.keyboard.press('Escape');
  await park(page);
  await enterFormula(page, 1);
  // The end of the last cell is one offset before the end of the aligned environment.
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset - 1; })()`);
  await page.keyboard.type('+e');
  await host.flush();
  expect(host.text).toContain('c &= d \\label{eq:b}+e\n\\end{align}');
  expect(host.text).toContain('\\begin{align}\n  a &= b \\\\\n');
});

test('macro calls stay calls, definitions are never touched', async ({ page }) => {
  const text = '$\\norm{x}+a$ and $\\pair[z] w + a$ and $\\R^n$';
  const { host } = await setup(page, text);
  for (const nth of [0, 1]) {
    await enterFormula(page, nth);
    await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset; })()`);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('q');
    await host.flush();
    await page.keyboard.press('Escape');
    await park(page);
  }
  expect(host.text).toBe('$\\norm{x}+q$ and $\\pair[z] w + q$ and $\\R^n$');
});

test('templates from typing never leak placeholders', async ({ page }) => {
  const { host } = await setup(page, 'Frac: $x$.');
  await enterFormula(page, 0);
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset; })()`);
  await page.keyboard.type('+/');
  await host.flush();
  expect(host.text).not.toContain('placeholder');
  expect(host.text).toMatch(/\$x\+\\frac\{.*\}\{.*\}\$/);
  await page.keyboard.type('1');
  await host.flush();
  expect(host.text).not.toContain('placeholder');
});

test('arrow keys move between prose and formulas', async ({ page }) => {
  await setup(page, 'ab $xy$ cd');
  await page.locator('.cm-content').click({ position: { x: 5, y: 5 } });
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(3));
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('.omt-live math-field');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  const pos = await mf(page, `document.querySelector('math-field').position`);
  expect(pos).toBe(0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight'); // leaves the formula
  await expect(page.locator('.omt-live')).toHaveCount(0);
  const head = await page.evaluate(() => (window as unknown as { __omt: { caret(): number } }).__omt.caret());
  expect(head).toBe(7);
});

test('an undo/redo coming from the host reloads the live field', async ({ page }) => {
  const { host } = await setup(page, '$a+b$');
  await enterFormula(page, 0);
  await mf(page, `(() => { const f = document.querySelector('math-field'); f.position = f.lastOffset; })()`);
  await page.keyboard.type('c');
  await host.flush();
  expect(host.text).toBe('$a+bc$');
  // Simulate VS Code undo: a foreign change back to the original.
  host.text = '$a+b$'; host.version++;
  await page.evaluate(v => window.postMessage({ t: 'docChanged', version: v, changes: [{ from: 4, to: 5, insert: '' }] }, '*'), host.version);
  await page.waitForTimeout(50);
  expect(await mf(page, `document.querySelector('math-field').value`)).toBe('a+b');
});

test('2000 formulas load quickly', async ({ page }) => {
  const text = Array.from({ length: 2000 }, (_, i) => `Line ${i}: $x_{${i}}^2 + \\frac{a}{b}$ text.`).join('\n');
  const t0 = Date.now();
  const { host } = await setup(page, text);
  const elapsed = Date.now() - t0;
  console.log(`2000-formula document interactive in ${elapsed} ms`);
  expect(elapsed).toBeLessThan(5000);
  expect(host.edits).toEqual([]);
});
