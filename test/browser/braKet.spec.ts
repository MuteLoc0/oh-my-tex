import { test, expect } from '@playwright/test';
import { MockHost } from './host.ts';

interface MathField extends HTMLElement {
  position: number;
  lastOffset: number;
  executeCommand(command: string): boolean;
  getValue(format?: string): string;
  getElementInfo(offset: number): { latex?: string } | undefined;
}

for (const name of ['bra', 'ket', 'braket']) {
  for (const display of [false, true]) {
    test(`\\${name} arguments persist through typing, deletion and reopening (${display ? 'display' : 'inline'})`, async ({ page }) => {
      const body = ` \\${name}  { x } + a `;
      const source = display ? `Before\n\\[${body}\\]\nAfter` : `Before $${body}$ after`;
      const host = new MockHost(page, source);
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(String(error)));
      await host.open();
      await page.locator('.omt-formula').click();
      await expect(page.locator('.omt-live math-field')).toBeVisible();
      if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
      await page.locator('.omt-macro-edit').filter({ hasText: `\\${name}` }).click();
      const argument = page.locator('.omt-macro-arg[data-index="1"] math-field');
      await expect(argument).toBeFocused();
      await argument.evaluate(element => (element as MathField).executeCommand('selectAll'));
      await page.keyboard.type('yz');
      await host.flush();
      // The argument content changes, while source-owned shells, trivia and
      // neighboring formula text retain their exact original representation.
      expect(host.text).toBe(source.replace(' x ', ' yz '));
      await page.keyboard.press('Backspace');
      await host.flush();
      expect(host.text).toBe(source.replace(' x ', ' y '));
      await page.locator('.omt-macro-close').click();
      await page.locator('.omt-macro-edit').filter({ hasText: `\\${name}` }).click();
      expect(await argument.evaluate(element => (element as MathField).getValue('latex-without-placeholders'))).toBe('y');
      await page.locator('.omt-macro-close').click();
      await page.locator('.omt-live math-field').evaluate(element => {
        const field = element as MathField; field.position = field.lastOffset; field.focus();
      });
      await page.keyboard.type('+q');
      await host.flush();
      expect(host.text).toBe(source.replace(' x ', ' y ').replace('+ a ', '+ a+q '));
      expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
      expect(errors).toEqual([]);
    });
  }
}

test('project braket arity takes priority and both physics-style arguments persist', async ({ page }) => {
  const source = '$\\braket  {x} {y}+a$';
  const host = new MockHost(page, source, [{ name: 'braket', arity: 2, body: '\\left\\langle#1\\middle|#2\\right\\rangle' }]);
  await host.open();
  await page.locator('.omt-formula').click();
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await page.locator('.omt-macro-edit').filter({ hasText: '\\braket' }).click();
  await expect(page.locator('.omt-macro-arg')).toHaveCount(2);
  const second = page.locator('.omt-macro-arg[data-index="2"] math-field');
  await second.evaluate(element => { element.focus(); (element as MathField).executeCommand('selectAll'); });
  await expect(second).toBeFocused();
  await page.keyboard.type('z');
  await host.flush();
  expect(host.text).toBe('$\\braket  {x} {z}+a$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: source.indexOf('y'), to: source.indexOf('y') + 1, expected: 'y', insert: 'z' }]);
});

test('braket keeps pipe separators and nested ket calls while their arguments change', async ({ page }) => {
  const source = '$\\braket  { x | \\ket{y} } + a$';
  const host = new MockHost(page, source);
  await host.open();
  await page.locator('.omt-formula').click();
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await page.locator('.omt-macro-edit').filter({ hasText: '\\braket' }).click();
  const argument = page.locator('.omt-macro-arg[data-index="1"] math-field');
  await argument.evaluate(element => {
    const field = element as MathField;
    const offset = Array.from({ length: field.lastOffset + 1 }, (_, index) => index)
      .find(index => field.getElementInfo(index)?.latex === 'x');
    if (offset === undefined) { throw new Error('braket argument is not editable'); }
    (field as MathField & { selection: { ranges: number[][] } }).selection = { ranges: [[offset - 1, offset]] };
  });
  await page.keyboard.type('z');
  await host.flush();
  expect(host.text).toBe(source.replace(' x ', ' z '));
  await page.locator('.omt-nested-macros .omt-macro-edit').filter({ hasText: '\\ket' }).click();
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\ket');
  await expect(argument).toBeFocused();
  await argument.evaluate(element => (element as MathField).executeCommand('selectAll'));
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe(source.replace(' x ', ' z ').replace('\\ket{y}', '\\ket{q}'));
  expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
});
