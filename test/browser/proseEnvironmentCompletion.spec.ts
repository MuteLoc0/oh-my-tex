import { test, expect, type Page } from '@playwright/test';
import type { CompletionItemDTO, WebMessage } from '../../src/shared/protocol.ts';
import { MockHost, type CompletionRequest, type MockHostOptions } from './host.ts';

interface EditorHooks {
  setSelection(anchor: number, head: number): void;
  setCaret(position: number): void;
  text(): string;
  selection(): { anchor: number; head: number };
}
const editorText = (page: Page) => page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.text());

function candidate(request: CompletionRequest, from: number, snippet: string, options: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  return { i: 0, label: 'equation', filterText: 'equation', source: 'snippet', kind: 14,
    insert: { snippet: true, value: snippet }, range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at }, ...options };
}

async function setup(page: Page, text: string, options: MockHostOptions, source = false) {
  const host = new MockHost(page, text, [], { ...options, settings: { completionAcceptOnEnter: false, ...options.settings } });
  await host.open();
  if (source) { await host.toggleSource(); }
  return host;
}

async function select(page: Page, from: number, to: number) {
  await page.evaluate(([anchor, head]) => (window as unknown as { __omt: EditorHooks }).__omt.setSelection(anchor!, head!), [from, to]);
}

async function invoke(page: Page) {
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.omt-completion')).toBeVisible();
}

const selection = 'x = y\n  z = w';
const original = `Header\n${selection}\nFooter`;
const from = 'Header\n'.length;

for (const mode of ['visual', 'source']) {
  test(`selected lines survive typing a command before a Workshop environment snippet in ${mode} mode`, async ({ page }) => {
    const host = await setup(page, original, {
      completion: request => ({ items: [candidate(request, from + 1, '\\begin{equation}\n\t${0:${TM_SELECTED_TEXT}}\n\\end{equation}')] }),
    }, mode === 'source');
    await select(page, from, from + selection.length);
    await page.keyboard.type('\\equa');
    await expect.poll(() => editorText(page)).toBe('Header\n\\equa\nFooter');
    await invoke(page);
    await page.keyboard.press('Tab');
    await host.flush();
    expect(host.text).toBe(`Header\n\\begin{equation}\n\t${selection}\n\\end{equation}\nFooter`);
    expect(host.text.match(/x = y/g)).toHaveLength(1);
  });
}

test('a provider body placeholder wraps a backward selection after prefix deletion and retyping', async ({ page }) => {
  const host = await setup(page, original, {
    completion: request => ({ items: [candidate(request, from + 1, 'begin{equation}\n  $1\n\\end{equation}$0', { source: 'provider' })] }),
  }, true);
  await select(page, from + selection.length, from);
  await page.keyboard.type('\\equat');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('ion');
  await invoke(page);
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe(`Header\n\\begin{equation}\n  ${selection}\n\\end{equation}\nFooter`);
  const selected = await page.evaluate(() => {
    const editor = (window as unknown as { __omt: EditorHooks }).__omt;
    const range = editor.selection();
    return editor.text().slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head));
  });
  expect(selected).toBe(selection);
});

test('plain environments acquire a content slot around the saved selection', async ({ page }) => {
  const host = await setup(page, original, {
    completion: request => ({ items: [candidate(request, from, '\\begin{equation}\n\\end{equation}', {
      source: 'template', insert: { snippet: false, value: '\\begin{equation}\n\\end{equation}' },
    })] }),
  }, true);
  await select(page, from, from + selection.length);
  await page.keyboard.type('\\equa');
  await invoke(page);
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe(`Header\n\\begin{equation}\n${selection}\n\\end{equation}\nFooter`);
});

test('a normal command does not consume a saved environment selection as TM_SELECTED_TEXT', async ({ page }) => {
  const host = await setup(page, original, {
    completion: request => ({ items: [candidate(request, from + 1, 'textbf{${1:${TM_SELECTED_TEXT}}}', { label: '\\textbf', filterText: 'textbf' })] }),
  }, true);
  await select(page, from, from + selection.length);
  await page.keyboard.type('\\textb');
  await invoke(page);
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('Header\n\\textbf{}\nFooter');
});

test('Escape discards the saved selection so a later environment completion stays empty', async ({ page }) => {
  const host = await setup(page, original, {
    completion: request => ({ items: [candidate(request, from + 1, 'begin{equation}\n${0:${TM_SELECTED_TEXT}}\n\\end{equation}')] }),
  }, true);
  await select(page, from, from + selection.length);
  await page.keyboard.type('\\equa');
  await invoke(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(await editorText(page)).toBe('Header\n\\equa\nFooter');
  await invoke(page);
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('Header\n\\begin{equation}\n\n\\end{equation}\nFooter');
});

test('remote edits invalidate the saved selection and delayed environment response', async ({ page }) => {
  const host = await setup(page, original, {
    completionDelay: 200,
    completion: request => ({ items: [candidate(request, from + 1, 'begin{equation}\n${0:${TM_SELECTED_TEXT}}\n\\end{equation}')] }),
  }, true);
  await select(page, from, from + selection.length);
  await page.keyboard.type('\\equa');
  await page.keyboard.press('Control+Space');
  await expect.poll(() => host.requests.length).toBeGreaterThan(0);
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await page.waitForTimeout(250);
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(await editorText(page)).toBe('Native Header\n\\equa\nFooter');
});

test('command prefixes hide document words and uppercase Psi stays first during continuous typing', async ({ page }) => {
  const host = await setup(page, '', {
    settings: { quickSuggestionsDelay: 0 },
    completion: request => ({ items: [
      candidate(request, 1, 'psi', { i: 0, label: '\\psi', filterText: 'psi', sortText: '00', preselect: true, source: 'provider', kind: 2, insert: { snippet: false, value: 'psi' } }),
      candidate(request, 1, 'Psi', { i: 1, label: '\\Psi', filterText: 'Psi', sortText: '99', source: 'provider', kind: 2, insert: { snippet: false, value: 'Psi' } }),
      candidate(request, 1, 'PsiWord', { i: 2, label: 'PsiWord', filterText: 'PsiWord', source: 'word', kind: 0 }),
      candidate(request, 1, 'PsiProviderWord', { i: 3, label: 'PsiProviderWord', filterText: 'PsiProviderWord', source: 'provider', kind: 0 }),
    ] }),
  }, true);
  await page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.setCaret(0));
  await page.keyboard.type('\\');
  await expect(page.locator('.omt-completion-item')).toHaveCount(2);
  await page.keyboard.type('Psi');
  await expect(page.locator('.omt-completion-item').first()).toContainText('\\Psi');
  await expect(page.locator('.omt-completion-item[aria-selected="true"]')).toContainText('\\Psi');
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('\\Psi');
});

test('a saved selection survives explicit provider resolution and is inserted exactly once', async ({ page }) => {
  const snippet = 'begin{equation}\n${0:${TM_SELECTED_TEXT}}\n\\end{equation}';
  const host = await setup(page, original, {
    completion: request => ({ items: [candidate(request, from + 1, snippet, { source: 'provider', needsResolve: true })] }),
  }, true);
  await select(page, from, from + selection.length);
  await page.keyboard.type('\\equa');
  await invoke(page);
  await page.keyboard.press('Tab');
  await expect.poll(() => page.evaluate(() => {
    const posted = (window as unknown as { __posted: WebMessage[] }).__posted;
    return [...posted].reverse().find(message => message.t === 'resolveCompletion');
  })).toBeTruthy();
  const request = await page.evaluate(() => [...(window as unknown as { __posted: WebMessage[] }).__posted].reverse().find(message => message.t === 'resolveCompletion'));
  if (request?.t !== 'resolveCompletion') { throw new Error('Expected a provider resolution request'); }
  await page.evaluate(message => window.postMessage(message, '*'), {
    ...request, t: 'completionResolved', value: { ...candidate({ ...request, t: 'complete', ctx: 'prose', trigger: { kind: 'invoke' } }, from + 1, snippet), source: 'provider', needsResolve: undefined },
  });
  await host.flush();
  expect(host.text).toBe(`Header\n\\begin{equation}\n${selection}\n\\end{equation}\nFooter`);
});
