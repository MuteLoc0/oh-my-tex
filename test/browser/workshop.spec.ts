import { test, expect, type Page } from '@playwright/test';
import { MockHost } from './host.ts';
import type { WebMessage } from '../../src/shared/protocol.ts';

async function setup(page: Page, text: string) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, text, [{ name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' }], { settings: { quickSuggestions: false } });
  await host.open();
  return { host, errors };
}
async function enter(page: Page) {
  await page.locator('.omt-formula').first().click();
  await expect(page.locator('.omt-live math-field')).toBeFocused();
}
async function posted(page: Page) { return page.evaluate(() => (window as unknown as { __posted: WebMessage[] }).__posted); }
async function selection(page: Page) { return (await posted(page)).filter(message => message.t === 'selection').at(-1) as Extract<WebMessage, { t: 'selection' }>; }
async function end(page: Page, selector = '.omt-live math-field', environment = false) {
  await expect(page.locator(selector)).toBeFocused();
  await page.locator(selector).evaluate(async (element, env) => {
    const field = element as HTMLElement & { position: number; lastOffset: number };
    // MathLive finishes focus/textarea setup on the following animation frame.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    field.position = field.lastOffset - (env ? 1 : 0);
  }, environment);
}

test('formula caret reports a real source offset without modifying source', async ({ page }) => {
  const { host, errors } = await setup(page, 'Text\n\\[\n  x + y\n\\]\n');
  await enter(page); await end(page); await host.flush();
  expect((await selection(page)).head).toBe(host.text.indexOf('y') + 1);
  expect(host.edits).toEqual([]); expect(host.version).toBe(1); expect(errors).toEqual([]);
});

test('align second-row caret and macro parameter caret map to their own source lines', async ({ page }) => {
  const { host, errors } = await setup(page, '\\begin{align}\n a &= b \\\\\n c &= \\norm{d}\n\\end{align}\n');
  await enter(page); await end(page, '.omt-live math-field', true); await host.flush();
  const second = host.text.indexOf('c &=');
  expect((await selection(page)).head).toBeGreaterThanOrEqual(second);
  expect((await selection(page)).head).toBeLessThan(host.text.indexOf('\\end'));
  await page.locator('.omt-macro-tools button').filter({ hasText: '\\norm' }).click();
  await end(page, '.omt-macro-arg math-field'); await host.flush();
  expect((await selection(page)).head).toBe(host.text.indexOf('{d}') + 2);
  expect(host.edits).toEqual([]); expect(errors).toEqual([]);
});

test('SyncTeX shortcut immediately after an edit flushes and reports the acknowledged caret first', async ({ page }) => {
  const { host } = await setup(page, 'Text $x$');
  await enter(page); await end(page); await page.keyboard.type('+y');
  await page.keyboard.press('Control+Alt+j');
  await expect.poll(async () => (await posted(page)).filter(message => message.t === 'synctex').length).toBe(1);
  const messages = await posted(page), command = messages.findIndex(message => message.t === 'synctex');
  const caret = messages.slice(0, command).filter(message => message.t === 'selection').at(-1) as Extract<WebMessage, { t: 'selection' }>;
  expect(host.text).toBe('Text $x+y$'); expect(caret.version).toBe(host.version); expect(caret.head).toBe(host.text.indexOf('y') + 1);
});

test('SyncTeX from an unaccepted parameter command keeps the parameter source line', async ({ page }) => {
  const original = 'Text\n\\[\\norm{\n  x+y\n}\\]\n';
  const { host, errors } = await setup(page, original);
  await enter(page); await page.locator('.omt-macro-tools button').click();
  await end(page, '.omt-macro-arg math-field');
  await page.keyboard.type('\\'); await expect(page.locator('.omt-math-buffer input')).toBeFocused();
  await page.keyboard.type('fr'); await page.keyboard.press('Control+Alt+j');
  await expect.poll(async () => (await posted(page)).some(message => message.t === 'synctex')).toBe(true);
  expect(host.text).toBe(original);
  expect((await selection(page)).head).toBe(original.indexOf('y') + 1);
  expect(errors).toEqual([]);
});

for (const [key, action] of [['Control+s', 'save'], ['Control+Alt+b', 'build'], ['Meta+Alt+j', 'synctex'], ['Control+Alt+v', 'view']] as const) {
  test(`${key} rolls back an unaccepted math command before ${action}`, async ({ page }) => {
    const original = 'Text $x$'; const { host, errors } = await setup(page, original);
    await enter(page); await end(page); await page.keyboard.type('\\');
    await expect(page.locator('.omt-math-buffer input')).toBeFocused(); await page.keyboard.type('fr');
    await page.keyboard.press(key);
    await expect.poll(async () => (await posted(page)).some(message => message.t === action)).toBe(true);
    await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
    expect(host.text).toBe(original); expect(errors).toEqual([]);
  });
}

test('reverse reveal waits for pending input and maps source coordinates through it', async ({ page }) => {
  const original = 'Text $x+y$ end'; const { host, errors } = await setup(page, original);
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));
  await page.keyboard.type('Q');
  await page.evaluate(message => window.postMessage(message, '*'), { t: 'reveal', version: host.version, anchor: original.indexOf('y'), head: original.indexOf('y') + 1, focus: true });
  await expect.poll(() => host.text).toBe('Q' + original);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: original.indexOf('y') + 1, head: original.indexOf('y') + 2 });
  await expect(page.locator('.cm-content')).toContainText('$x+y$'); expect(errors).toEqual([]);
});

test('reverse reveal closes active macro editing and ignores obsolete locations', async ({ page }) => {
  const { host, errors } = await setup(page, 'Text $\\norm{x}+y$ end');
  await enter(page); await page.locator('.omt-macro-tools button').click();
  const at = host.text.indexOf('x');
  await page.evaluate(message => window.postMessage(message, '*'), { t: 'reveal', version: host.version, anchor: at + 1, head: at, focus: false });
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: at + 1, head: at });
  await page.evaluate(message => window.postMessage(message, '*'), { t: 'reveal', version: host.version - 1, anchor: 0, head: 0, focus: true });
  await page.waitForTimeout(30);
  expect(await page.evaluate(() => (window as unknown as { __omt: { caret(): number } }).__omt.caret())).toBe(at);
  expect(host.edits).toEqual([]); expect(errors).toEqual([]);
});

test('source toggle shortcut is captured once inside MathLive', async ({ page }) => {
  const { host } = await setup(page, 'Text $x+y$ end'); await enter(page);
  await page.keyboard.press('Control+Alt+Shift+m');
  await expect(page.locator('.omt-formula')).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('$x+y$');
  await host.flush(); expect(host.edits).toEqual([]);
});
