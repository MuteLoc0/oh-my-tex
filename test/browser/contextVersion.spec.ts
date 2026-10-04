import { test, expect, type Page } from '@playwright/test';
import { MockHost } from './host.ts';

async function context(page: Page, contextVersion: number, body: string) {
  await page.evaluate(({ contextVersion, body }) => window.postMessage({
    t: 'context', contextVersion, macros: [{ name: 'value', arity: 0, body }], templates: [], diagnostics: [],
  }, '*'), { contextVersion, body });
}

test('first context version zero is accepted; late and duplicate contexts cannot replace newer macros', async ({ page }) => {
  const source = '$\\value+a$ and $\\value+b$';
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, source, [{ name: 'value', arity: 0, body: 'Z' }], { contextVersion: 0 });
  await host.open();
  await expect(page.locator('.omt-formula')).toHaveText(['Z+a', 'Z+b']);

  await context(page, 2, 'N');
  await expect(page.locator('.omt-formula')).toHaveText(['N+a', 'N+b']);
  await page.locator('.omt-formula').first().click();
  const live = page.locator('.omt-live math-field');
  await expect(live).toBeFocused();
  const rendered = () => live.evaluate(element => element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '');
  await expect.poll(rendered).toBe('N+a');

  // Flush acknowledgements provide a round trip after each message is handled.
  await context(page, 1, 'O');
  await host.flush();
  expect(await rendered()).toBe('N+a');
  await expect(page.locator('.omt-formula:not(.omt-live)')).toHaveText('N+b');
  await context(page, 2, 'D');
  await host.flush();
  expect(await rendered()).toBe('N+a');
  await expect(page.locator('.omt-formula:not(.omt-live)')).toHaveText('N+b');

  await context(page, 3, 'F');
  await expect.poll(rendered).toBe('F+a');
  await expect(page.locator('.omt-formula:not(.omt-live)')).toHaveText('F+b');
  await host.flush();
  expect(host.text).toBe(source);
  expect(host.edits).toEqual([]);
  expect(errors).toEqual([]);
});
