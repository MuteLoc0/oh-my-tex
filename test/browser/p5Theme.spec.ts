import { test, expect, type Page } from '@playwright/test';
import { MockHost } from './host.ts';

const caret = (page: Page, pos: number) => page.evaluate(p => {
  (window as unknown as { __omt: { setCaret(pos: number): void } }).__omt.setCaret(p);
}, pos);

test('fallback theme and resource fonts refresh without changing the document or selection', async ({ page }) => {
  const text = '\\section{Title}\n% comment\nText $x+y$.\n';
  const host = new MockHost(page, text, [], { settings: { themeKind: 'dark', tokens: { command: '#ff0000', comment: '#00ff00', bracket: '#0000ff' } } });
  await host.open();
  await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'fallback');
  await caret(page, 3);
  const command = page.locator('.cm-content span').filter({ hasText: /^\\section$/ });
  await expect(command).toHaveCSS('color', 'rgb(255, 0, 0)');
  await host.updateSettings({ themeKind: 'light', fontSize: 19, fontFamily: 'Courier New, monospace', fontWeight: '600', lineHeight: 29,
    fontLigatures: false, letterSpacing: 1.25, tokens: { command: '#123456', comment: '#654321', bracket: '#456789' } });
  await expect(page.locator('body')).toHaveAttribute('data-omt-theme', 'light');
  await expect(page.locator('.cm-editor')).toHaveCSS('font-size', '19px');
  await expect(page.locator('.cm-editor')).toHaveCSS('font-weight', '600');
  await expect(page.locator('.cm-editor')).toHaveCSS('letter-spacing', '1.25px');
  await expect(page.locator('.cm-editor')).toHaveCSS('font-variant-ligatures', 'none');
  await expect(page.locator('.cm-content')).toHaveCSS('line-height', '29px');
  await expect(command).toHaveCSS('color', 'rgb(18, 52, 86)');
  await expect(page.locator('.cm-content span').filter({ hasText: /^% comment$/ })).toHaveCSS('color', 'rgb(101, 67, 33)');
  expect(await page.evaluate(() => (window as unknown as { __omt: { caret(): number } }).__omt.caret())).toBe(3);
  await host.flush();
  expect(host.text).toBe(text);
  expect(host.edits).toEqual([]);
});

test('high contrast search controls and formulas retain visible borders and focus', async ({ page }) => {
  const host = new MockHost(page, 'Text $x+y$.', [], { settings: { themeKind: 'hcDark' } });
  await host.open();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--vscode-contrastBorder', '#ffffff');
    document.documentElement.style.setProperty('--vscode-focusBorder', '#ffff00');
    document.documentElement.style.setProperty('--vscode-input-background', '#000000');
    document.documentElement.style.setProperty('--vscode-input-foreground', '#ffffff');
  });
  await expect(page.locator('.omt-formula')).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.omt-formula')).toHaveCSS('border-top-width', '1px');
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.locator('.cm-search input[name=search]');
  await expect(search).toBeFocused();
  await expect(search).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(search).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await expect(search).toHaveCSS('border-top-color', 'rgb(255, 255, 255)');
  await expect(search).toHaveCSS('outline-color', 'rgb(255, 255, 0)');
  await host.updateSettings({ themeKind: 'hcLight' });
  await expect(page.locator('body')).toHaveAttribute('data-omt-theme', 'hcLight');
  await expect(search).toHaveCSS('border-top-width', '1px');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-search')).toHaveCount(0);
  await host.flush();
  expect(host.edits).toEqual([]);
});

test('search reveals a match inside a rendered formula and replaces only its source range', async ({ page }) => {
  const host = new MockHost(page, 'Text $x+needle$ then $z+needle$.');
  await host.open();
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  await caret(page, 0);
  await page.keyboard.press('ControlOrMeta+f');
  await page.locator('.cm-search input[name=search]').fill('needle');
  await page.locator('.cm-search input[name=search]').press('Enter');
  await expect(page.locator('.cm-content')).toContainText('$x+needle$');
  expect(await page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: 8, head: 14 });
  await page.locator('.cm-search input[name=replace]').fill('found');
  await page.locator('.cm-search button[name=replace]').click();
  await host.flush();
  expect(host.text).toBe('Text $x+found$ then $z+needle$.');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 8, to: 14, expected: 'needle', insert: 'found' }]);
  await page.locator('.cm-search button[name=replaceAll]').click();
  await host.flush();
  expect(host.text).toBe('Text $x+found$ then $z+found$.');
});

test('search can open from an active math field and leaves no math completion buffer behind', async ({ page }) => {
  const host = new MockHost(page, 'Text $a+needle$.');
  await host.open();
  await page.locator('.omt-formula').click();
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+f');
  const search = page.locator('.cm-search input[name=search]');
  await expect(search).toBeFocused();
  await search.fill('needle');
  await search.press('Enter');
  await expect(page.locator('.cm-content')).toContainText('$a+needle$');
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  await host.flush();
  expect(host.edits).toEqual([]);
});

test('unknown macros and metadata chips inherit high contrast foreground without writing source', async ({ page }) => {
  const text = '$\\unknown{a}+b$ and $x\\label{eq:a}+y$';
  const host = new MockHost(page, text, [], { settings: { themeKind: 'hcLight' } });
  await host.open();
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--vscode-editor-foreground', '#000000');
    document.documentElement.style.setProperty('--vscode-editor-background', '#ffffff');
  });
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  const colors = await page.locator('.omt-formula').evaluateAll(formulas => formulas.flatMap(formula =>
    Array.from(formula.querySelectorAll('span')).filter(span => !span.childElementCount && span.textContent?.trim()).map(span => getComputedStyle(span).color)));
  expect(colors.length).toBeGreaterThan(0);
  expect(new Set(colors)).toEqual(new Set(['rgb(0, 0, 0)']));
  await host.flush();
  expect(host.text).toBe(text);
  expect(host.edits).toEqual([]);
});
