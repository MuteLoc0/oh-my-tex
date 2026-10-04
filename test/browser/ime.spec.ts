import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { MockHost } from './host.ts';

type IMETrace = { type: string; trusted: boolean; at: number; kind?: string; surface?: string };

async function nativeIME(page: Page): Promise<CDPSession> {
  await page.evaluate(() => {
    const state = window as unknown as { __imeTrace: IMETrace[]; __posted: { t: string; kind?: string }[] };
    state.__imeTrace = [];
    const editContext = (document.querySelector('.cm-content') as HTMLElement & { editContext?: EventTarget }).editContext;
    for (const [surface, target] of [['dom', document], ['editcontext', editContext]] as const) {
      if (!target) { continue; }
      for (const type of ['compositionstart', 'compositionupdate', 'compositionend']) {
        target.addEventListener(type, event => {
          state.__imeTrace.push({ type, trusted: event.isTrusted, at: performance.now(), surface });
        }, { capture: true });
      }
    }
    const push = state.__posted.push;
    state.__posted.push = (...messages) => {
      for (const message of messages) {
        if (message.t === 'edit') { state.__imeTrace.push({ type: 'edit', trusted: true, at: performance.now(), kind: message.kind }); }
      }
      return push.apply(state.__posted, messages);
    };
  });
  return page.context().newCDPSession(page);
}

async function revise(cdp: CDPSession, text: string) {
  await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
}

async function commit(cdp: CDPSession, text: string) {
  await cdp.send('Input.insertText', { text });
}

async function enterFormula(page: Page) {
  await page.locator('.omt-formula').first().click();
  await page.waitForSelector('.omt-live math-field');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
}

async function expectTrustedComposition(page: Page) {
  const trace = await page.evaluate(() => (window as unknown as { __imeTrace: IMETrace[] }).__imeTrace);
  // CodeMirror forwards native EditContext composition to its DOM as untrusted
  // copies. Verify the browser's original events on the actual input surface.
  const nativeSurface = trace.some(event => event.surface === 'editcontext' && event.trusted) ? 'editcontext' : 'dom';
  const events = trace.filter(event => event.type.startsWith('composition') && event.surface === nativeSurface);
  expect(events.map(event => event.type)).toContain('compositionstart');
  expect(events.map(event => event.type)).toContain('compositionend');
  expect(events.filter(event => event.type !== 'compositionend').every(event => event.trusted)).toBe(true);
  expect(events.some(event => event.type === 'compositionstart' && event.trusted)).toBe(true);
  // Chromium Input.insertText ends native composition with an untrusted end
  // event, including on a plain contenteditable with no editor or MathLive.
  const end = events.findLast(event => event.type === 'compositionend')!;
  const edit = trace.find(event => event.type === 'edit' && event.at >= end.at);
  expect(edit).toBeDefined();
  expect(edit!.at - end.at).toBeGreaterThanOrEqual(45);
}

test('native prose composition defers boundaries, completion and flush and undoes the whole word', async ({ page }) => {
  const host = new MockHost(page, 'Prefix ');
  await host.open();
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(pos: number): void } }).__omt.setCaret(7));
  const cdp = await nativeIME(page);
  await revise(cdp, 'gong.');
  await page.waitForTimeout(350);
  expect(host.edits).toHaveLength(0);
  expect(host.requests).toHaveLength(0);
  let flushed = false;
  const flushing = host.flush().then(() => { flushed = true; });
  await page.waitForTimeout(75);
  expect(flushed).toBe(false);
  await revise(cdp, '公式中文');
  await commit(cdp, '公式中文');
  await flushing;
  expect(host.text).toBe('Prefix 公式中文');
  expect(host.edits).toHaveLength(1);
  expect(host.edits[0]!.kind).toBe('composition');
  expect(host.edits[0]!.patches).toEqual([{ from: 7, to: 7, expected: '', insert: '公式中文' }]);
  expect(host.requests).toHaveLength(0);
  await expectTrustedComposition(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => host.text).toBe('Prefix ');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => host.text).toBe('Prefix 公式中文');
  await cdp.detach();
});

for (const source of ['$x$', '$\\text{旧词}+y$']) {
  test(`native formula composition retains text wrapping after selecting all ${source}`, async ({ page }) => {
    const host = new MockHost(page, source);
    await host.open();
    await enterFormula(page);
    await page.keyboard.press('ControlOrMeta+a');
    const cdp = await nativeIME(page);
    await revise(cdp, 'gong');
    await expect(page.locator('.omt-ime-preview')).toBeVisible();
    await expect(page.locator('.omt-ime-preview')).toHaveText('gong');
    expect(host.edits).toHaveLength(0);
    await revise(cdp, '公式中文');
    await commit(cdp, '公式中文');
    await host.flush();
    expect(host.text).toBe('$\\text{公式中文}$');
    await expect(page.locator('.omt-ime-preview')).toHaveCount(0);
    expect(host.edits).toHaveLength(1);
    await expectTrustedComposition(page);
    await page.keyboard.type('+x');
    await host.flush();
    expect(host.text).toBe('$\\text{公式中文}+x$');
    await cdp.detach();
  });
}

test('native formula composition after deleting the first text character keeps its wrapper', async ({ page }) => {
  const host = new MockHost(page, '$\\text{甲乙}+x$');
  await host.open();
  await enterFormula(page);
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await host.flush();
  expect(host.text).toBe('$\\text{乙}+x$');
  const cdp = await nativeIME(page);
  await revise(cdp, '公式中文');
  await commit(cdp, '公式中文');
  await host.flush();
  expect(host.text).toBe('$\\text{公式中文乙}+x$');
  await expectTrustedComposition(page);
  await cdp.detach();
});

test('macro context refresh waits for native composition without losing its committed text', async ({ page }) => {
  const host = new MockHost(page, '$\\keep+x$', [{ name: 'keep', arity: 0, body: 'a' }]);
  await host.open();
  await enterFormula(page);
  await page.keyboard.press('End');
  const cdp = await nativeIME(page);
  await revise(cdp, 'gong');
  await page.evaluate(() => window.postMessage({
    t: 'context', contextVersion: 2, macros: [{ name: 'keep', arity: 0, body: 'b' }],
    renderMacros: [], templates: [], diagnostics: [],
  }, '*'));
  await page.waitForTimeout(75);
  expect(host.edits).toHaveLength(0);
  await revise(cdp, '公式中文');
  await commit(cdp, '公式中文');
  await host.flush();
  expect(host.text).toBe('$\\keep+x\\text{公式中文}$');
  await expect.poll(() => page.locator('.omt-live math-field').evaluate(element =>
    element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '')).toBe('b+x公式中文');
  await expectTrustedComposition(page);
  await cdp.detach();
});

test('macro argument native composition survives context refresh and commits as one text edit', async ({ page }) => {
  const host = new MockHost(page, '$\\wrap{x}+z$', [{ name: 'wrap', arity: 1, body: 'a+#1' }]);
  await host.open();
  await enterFormula(page);
  await page.locator('.omt-macro-edit').filter({ hasText: '\\wrap' }).click();
  const field = page.locator('.omt-macro-arg[data-index="1"] math-field');
  await field.evaluate(element => element.focus());
  await expect(field).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  const cdp = await nativeIME(page);
  await revise(cdp, 'gong');
  await page.evaluate(() => window.postMessage({
    t: 'context', contextVersion: 2, macros: [{ name: 'wrap', arity: 1, body: 'b+#1' }],
    renderMacros: [], templates: [], diagnostics: [],
  }, '*'));
  await page.waitForTimeout(75);
  await expect(field).toBeFocused();
  expect(host.edits).toHaveLength(0);
  await revise(cdp, '公式中文');
  await commit(cdp, '公式中文');
  await host.flush();
  expect(host.text).toBe('$\\wrap{\\text{公式中文}}+z$');
  expect(host.edits).toHaveLength(1);
  await expect.poll(() => page.locator('.omt-live math-field').evaluate(element =>
    element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '')).toBe('b+公式中文+z');
  await expectTrustedComposition(page);
  await cdp.detach();
});

test('native beforeinput CJK without a composition also uses text atoms', async ({ page }) => {
  const host = new MockHost(page, '$x$');
  await host.open();
  await enterFormula(page);
  await page.keyboard.press('ControlOrMeta+a');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.insertText', { text: '公式中文' });
  await host.flush();
  expect(host.text).toBe('$\\text{公式中文}$');
  await page.keyboard.type('+x');
  await host.flush();
  expect(host.text).toBe('$\\text{公式中文}+x$');
  await cdp.detach();
});
