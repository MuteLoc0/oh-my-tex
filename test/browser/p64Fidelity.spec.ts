import { test, expect } from '@playwright/test';
import { MockHost } from './host.ts';

async function rejectStyleEdit(page: import('@playwright/test').Page) {
  await page.locator('.omt-formula').first().click();
  const live = page.locator('.omt-live math-field');
  await expect(live).toBeFocused();
  await live.evaluate(element => (element as HTMLElement & { executeCommand(command: string): boolean }).executeCommand('moveToMathfieldEnd'));
  await page.keyboard.type('q');
  await expect(page.locator('.omt-formula-notice[role="alert"]')).toBeVisible();
}

const source = '\\begin{align}\n  a&=b\\\\\n  c&=d\n\\end{align}';

test('align keyboard entry starts inside the first cell', async ({ page }) => {
  const host = new MockHost(page, source);
  await host.open();
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.type('q');
  await host.flush();
  const from = source.indexOf('\n');
  expect(host.text).toBe(source.slice(0, from) + 'q' + source.slice(from));
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from, to: from, expected: '', insert: 'q' }]);
});

test('align click and Cmd+Right remain in its last cell', async ({ page }) => {
  const host = new MockHost(page, source);
  await host.open();
  await page.locator('.omt-formula').click();
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.press('Meta+ArrowRight');
  await page.keyboard.type('+q');
  await host.flush();
  expect(host.text).toBe(source.replace('=d', '=d+q'));
  const from = source.indexOf('=d') + 2;
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from, to: from, expected: '', insert: '+q' }]);
});

test('input outside an align wrapper retries in the last cell', async ({ page }) => {
  const host = new MockHost(page, source);
  await host.open();
  await page.locator('.omt-formula').click();
  const live = page.locator('.omt-live math-field');
  await expect(live).toBeFocused();
  // Exercise the recovery from MathLive's own whole-field navigation command.
  await live.evaluate(element => (element as HTMLElement & { executeCommand(command: string): boolean }).executeCommand('moveToMathfieldEnd'));
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe(source.replace('=d', '=dq'));
  const from = source.indexOf('=d') + 2;
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from, to: from, expected: '', insert: 'q' }]);
});

test('destroying an align wrapper preserves source and explains the source fallback', async ({ page }) => {
  const host = new MockHost(page, source);
  await host.open();
  await page.locator('.omt-formula').click();
  const live = page.locator('.omt-live math-field');
  await expect(live).toBeFocused();
  await live.evaluate(element => (element as HTMLElement & { executeCommand(command: string): boolean }).executeCommand('selectAll'));
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.edits).toEqual([]);
  await expect(page.locator('.omt-formula-notice[role="alert"]')).toContainText('源码模式');
  await expect(page.locator('.omt-live')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('\\begin{align}');
  // The refusal belongs to this formula and persists when the caret leaves it.
  await page.evaluate(position => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(position), source.length);
  await expect(page.locator('.omt-formula')).toHaveCount(0);
});

test('a non-idempotent style formula refuses a whole-body normalization', async ({ page }) => {
  const source = '$\\scriptstyle x+y$';
  const host = new MockHost(page, source);
  await host.open();
  await rejectStyleEdit(page);
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.edits).toEqual([]);
  await expect(page.locator('.omt-formula-notice')).toContainText('无法安全地保留原始格式');
});

test('a MathLive parse error cannot normalize the whole source body', async ({ page }) => {
  const source = '$\\left(x+y$';
  const host = new MockHost(page, source);
  await host.open();
  await page.locator('.omt-formula').click();
  const live = page.locator('.omt-live math-field');
  await expect(live).toBeFocused();
  expect(await live.evaluate(element => (element as HTMLElement & { errors: unknown[] }).errors.length)).toBeGreaterThan(0);
  await live.evaluate(element => (element as HTMLElement & { executeCommand(command: string): boolean }).executeCommand('moveToMathfieldEnd'));
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.edits).toEqual([]);
  await expect(page.locator('.omt-formula-notice[role="alert"]')).toContainText('源码模式');
});

test('inserting a formula before a source fallback does not transfer the fallback', async ({ page }) => {
  const source = '$\\scriptstyle x+y$ and $z$';
  const host = new MockHost(page, source);
  await host.open();
  await rejectStyleEdit(page);
  await host.flush();
  await host.remote([{ from: 0, to: 0, insert: '$w$ ' }]);
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  expect(await page.locator('.omt-formula').allTextContents()).toEqual(['w', 'z']);
  expect(host.text).toBe('$w$ ' + source);
});

test('deleting a source fallback leaves the next formula visually editable', async ({ page }) => {
  const source = '$\\scriptstyle x+y$ $z$';
  const host = new MockHost(page, source);
  await host.open();
  await rejectStyleEdit(page);
  await host.flush();
  await host.remote([{ from: 0, to: source.indexOf('$ $') + 2, insert: '' }]);
  await expect(page.locator('.omt-formula')).toHaveCount(1);
  await expect(page.locator('.omt-formula')).toHaveText('z');
  await page.locator('.omt-formula').click();
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  expect(host.text).toBe('$z$');
});
