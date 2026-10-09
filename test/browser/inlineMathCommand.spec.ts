import { test, expect, type Page } from '@playwright/test';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import { MockHost, type CompletionRequest } from './host.ts';

interface Field extends HTMLElement {
  mode: string;
  position: number;
  lastOffset: number;
  getValue(from?: number | string, to?: number, format?: string): string;
}

async function enter(page: Page) {
  await page.locator('.omt-formula').first().click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await page.evaluate(() => { const field = document.activeElement as Field; field.position = field.lastOffset; });
}

function candidate(request: CompletionRequest, host: MockHost, command: string, i: number, extra: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  return { i, label: `\\${command}`, source: 'provider', insert: { value: command, snippet: false },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at }, ...extra };
}

test('command characters and their caret stay inside the focused visual formula', async ({ page }) => {
  const host = new MockHost(page, '$x+$'); await host.open(); await enter(page);
  await page.keyboard.type('\\fr');
  await expect(page.locator('math-field.omt-math-command')).toBeFocused();
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  expect(await page.evaluate(() => {
    const field = document.activeElement as Field;
    return { mode: field.mode, command: field.getValue(field.position - 3, field.position, 'latex'),
      rendered: field.shadowRoot?.textContent?.includes('\\fr') };
  })).toEqual({ mode: 'latex', command: '\\fr', rendered: true });
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Backspace');
  await page.keyboard.type('a');
  await host.flush(); expect(host.text).toBe('$x+\\ar $');
  await page.keyboard.press('Escape'); await host.flush(); expect(host.text).toBe('$x+$');
});

for (const key of ['Space', 'Tab']) {
  test(`a typed command commits with ${key} when providers have no candidates`, async ({ page }) => {
    const host = new MockHost(page, '$x+$'); await host.open(); await enter(page);
    await page.keyboard.type('\\alpha'); await page.keyboard.press(key);
    await page.keyboard.type('+q'); await host.flush();
    expect(host.text).toBe('$x+\\alpha+q$');
    await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  });
}

test('typing a complete fraction directly inside the formula writes both arguments', async ({ page }) => {
  const host = new MockHost(page, '$x+$'); await host.open(); await enter(page);
  await page.keyboard.type('\\frac{a}{b}'); await page.keyboard.press('Space');
  await host.flush(); expect(host.text).toBe('$x+\\frac{a}{b}$');
});

test('an unfinished command argument keeps its native field and cancels byte for byte', async ({ page }) => {
  const original = 'Text $ x^{2}+y $.';
  const host = new MockHost(page, original); await host.open(); await enter(page);
  await page.keyboard.type('\\frac{a'); await host.flush();
  await expect(page.locator('math-field.omt-math-command')).toBeFocused();
  await page.keyboard.press('Escape'); await host.flush(); expect(host.text).toBe(original);
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
});

test('select-all edits only the active command and preserves its surrounding formula', async ({ page }) => {
  const host = new MockHost(page, '$x+b$'); await host.open(); await enter(page);
  await page.evaluate(() => { (document.activeElement as Field).position = 2; });
  await page.keyboard.type('\\fr'); await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('\\alpha'); await page.keyboard.press('Space');
  await host.flush(); expect(host.text).toBe('$x+\\alpha b$');
});

test('leaving a command with the right arrow preserves it and the following atom', async ({ page }) => {
  const host = new MockHost(page, '$x+b$'); await host.open(); await enter(page);
  await page.evaluate(() => { (document.activeElement as Field).position = 2; });
  await page.keyboard.type('\\alpha'); await page.keyboard.press('ArrowRight');
  await host.flush(); expect(host.text).toBe('$x+\\alpha b$');
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
});

test('a directly typed bra command saves its source-owned argument and later edits', async ({ page }) => {
  const host = new MockHost(page, '$x+$'); await host.open(); await enter(page);
  await page.keyboard.type('\\bra{a}'); await page.keyboard.press('Space');
  await host.flush(); expect(host.text).toBe('$x+\\bra{a}$');
  await expect(page.locator('.omt-macro-args math-field')).toBeVisible();
  await page.waitForFunction(() => document.activeElement?.closest('.omt-macro-args'));
  await page.keyboard.type('b'); await page.keyboard.press('Enter'); await host.flush();
  expect(host.text).toBe('$x+\\bra{b}$');
});

test('an external formula edit cancels the native command and keeps the new visual model', async ({ page }) => {
  const host = new MockHost(page, '$x+$'); await host.open(); await enter(page);
  await page.keyboard.type('\\fr'); await host.flush();
  await host.remote([{ from: 1, to: 2, insert: 'y' }]); await host.flush();
  expect(host.text).toBe('$y+$');
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  await expect(page.locator('.omt-formula')).toContainText('y');
  await page.locator('.omt-formula').first().click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  expect(await page.evaluate(() => (document.activeElement as Field).getValue('latex'))).toBe('y+');
});

test('math candidates follow the typed case and suppress word suggestions with math names', async ({ page }) => {
  const host = new MockHost(page, '$x+$', [], {
    completion: (request, current) => ({ items: [
      candidate(request, current, 'psi', 0, { preselect: true, sortText: '0' }),
      candidate(request, current, 'Psi', 1, { sortText: '1' }),
      candidate(request, current, 'Psi', 2, { source: 'word' }),
      candidate(request, current, 'psi', 3, { kind: 0 }),
    ] }),
  });
  await host.open(); await enter(page); await page.keyboard.type('\\');
  await expect(page.locator('.omt-completion-item')).toHaveCount(2);
  await page.keyboard.type('Psi');
  await expect(page.locator('.omt-completion-item').first()).toContainText('\\Psi');
  await expect(page.locator('.omt-completion-item[aria-selected="true"]')).toContainText('\\Psi');
  await page.keyboard.press('Tab'); await host.flush(); expect(host.text).toBe('$x+\\Psi$');
});

test('native IME commits command characters before requesting fresh candidates', async ({ page }) => {
  const host = new MockHost(page, '$x+$', [], {
    completion: (request, current) => ({ items: [candidate(request, current, 'frac', 0)], isIncomplete: true }),
  });
  await host.open(); await enter(page); await page.keyboard.type('\\');
  await expect(page.locator('.omt-completion-item')).toHaveCount(1);
  const before = host.requests.length, session = await page.context().newCDPSession(page);
  await session.send('Input.imeSetComposition', { text: 'fr', selectionStart: 2, selectionEnd: 2 });
  await page.waitForTimeout(50); expect(host.requests).toHaveLength(before);
  await session.send('Input.insertText', { text: 'fr' });
  await expect.poll(() => host.requests.length).toBeGreaterThan(before);
  expect(host.completionDocuments.at(-1)?.text).toContain('\\fr');
  await page.keyboard.press('Escape'); await host.flush(); expect(host.text).toBe('$x+$');
});

for (const command of ['\\tag{}', '\\label{}', '\\label{eq:one}', '\\missingcommand{a}[b]']) {
  for (const key of ['Space', 'Tab', 'Enter']) {
    test(`an unsupported display command ${command} saves with ${key} and subsequent visual input`, async ({ page }) => {
      const host = new MockHost(page, '\\[x+\\]', [], { settings: { completionAcceptOnEnter: false } });
      await host.open(); await enter(page);
      await page.keyboard.type(command); await page.keyboard.press(key);
      await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
      await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
      await expect(page.locator('.omt-live > math-field')).toBeFocused();
      await page.keyboard.type('+q'); await host.flush();
      expect(host.text).toBe(`\\[x+${command}+q\\]`);
      expect(host.text).not.toMatch(/\\OMT[a-zA-Z]+|\\placeholder/);
    });
  }
}

test('typed metadata and unknown commands survive source mode, remote changes and reopening', async ({ page }) => {
  const host = new MockHost(page, 'Before\n\\[x+\\]\nAfter', [], { settings: { completionAcceptOnEnter: undefined } });
  await host.open(); await enter(page);
  for (const command of ['\\label{eq:one}', '\\tag{A}', '\\missingcommand{a}[b]']) {
    await page.keyboard.type(command); await page.keyboard.press('Tab');
    await expect(page.locator('.omt-live > math-field')).toBeFocused();
  }
  await host.flush();
  const saved = 'Before\n\\[x+\\label{eq:one}\\tag{A}\\missingcommand{a}[b]\\]\nAfter';
  expect(host.text).toBe(saved);
  await host.toggleSource(); await host.flush();
  expect(host.text).toBe(saved);
  await host.remote([{ from: 0, to: 6, insert: 'Native' }]);
  await host.toggleSource(); await enter(page);
  await page.keyboard.type('+q'); await host.flush();
  expect(host.text).toBe(saved.replace('Before', 'Native').replace('\\]\nAfter', '+q\\]\nAfter'));
  expect(host.text).not.toMatch(/\\OMT[a-zA-Z]+|\\placeholder/);
});

test('a complete typed command with arguments is not replaced by a prior fuzzy candidate', async ({ page }) => {
  const host = new MockHost(page, '\\[x+\\]', [], {
    settings: { completionAcceptOnEnter: false },
    completion: (request, current) => ({ items: [candidate(request, current, 'tan', 0, { filterText: 'tag' })] }),
  });
  await host.open(); await enter(page); await page.keyboard.type('\\t');
  await expect(page.locator('.omt-completion-item')).toContainText('\\tan');
  await page.keyboard.type('ag{A}'); await page.keyboard.press('Tab'); await host.flush();
  expect(host.text).toBe('\\[x+\\tag{A}\\]');
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
});

test('an unsupported command inside a source-owned bra argument saves with following input', async ({ page }) => {
  const host = new MockHost(page, '$\\bra{x}+a$', [], { settings: { completionAcceptOnEnter: false } });
  await host.open(); await enter(page);
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await page.locator('.omt-macro-edit').filter({ hasText: '\\bra' }).click();
  const argument = page.locator('.omt-macro-arg[data-index="1"] math-field');
  await expect(argument).toBeFocused();
  await argument.evaluate(element => { const field = element as Field; field.position = field.lastOffset; });
  await page.keyboard.type('\\label{eq:a}'); await page.keyboard.press('Space');
  await expect(argument).toBeFocused();
  await page.keyboard.type('+q'); await host.flush();
  expect(host.text).toBe('$\\bra{x\\label{eq:a}+q}+a$');
  expect(host.text).not.toMatch(/\\OMT[a-zA-Z]+|\\placeholder/);
});

test('raw command insertion keeps its caret in the fraction numerator before the following atom', async ({ page }) => {
  const host = new MockHost(page, '$\\frac{ab}{c}+z$', [], { settings: { completionAcceptOnEnter: false } });
  await host.open(); await enter(page);
  await page.evaluate(() => {
    const field = document.activeElement as Field;
    for (let offset = 0; offset < field.lastOffset; offset++) {
      if (field.getValue(offset, offset + 1, 'latex-without-placeholders') === 'a') {
        field.position = offset + 1; return;
      }
    }
    throw new Error('Could not locate the fraction numerator');
  });
  await page.keyboard.type('\\label{eq:n}'); await page.keyboard.press('Tab');
  await expect(page.locator('.omt-live > math-field')).toBeFocused();
  await page.keyboard.type('+q'); await host.flush();
  expect(host.text).toBe('$\\frac{a\\label{eq:n}+qb}{c}+z$');
});

test('a raw fraction without completion candidates keeps native numerator and denominator editing', async ({ page }) => {
  const host = new MockHost(page, '$x+$', [], { settings: { completionAcceptOnEnter: false } });
  await host.open(); await enter(page);
  await page.keyboard.type('\\frac'); await page.keyboard.press('Space');
  await expect(page.locator('.omt-live > math-field')).toBeFocused();
  await page.keyboard.type('a'); await page.keyboard.press('Tab'); await page.keyboard.type('b');
  await host.flush(); expect(host.text).toBe('$x+\\frac{a}{b}$');
  expect(host.text).not.toMatch(/\\OMT[a-zA-Z]+|\\placeholder/);
});
