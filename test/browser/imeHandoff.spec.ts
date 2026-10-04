import { test, expect, type Page } from '@playwright/test';
import { MockHost, type CompletionRequest } from './host.ts';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';

interface FocusGap { pending?: HTMLElement; attempts: number; release(): void }

function item(request: CompletionRequest, host: MockHost, name: string, value: string): CompletionItemDTO {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  return { i: 0, label: `\\${name}`, filterText: name, source: 'macro', insert: { snippet: true, value },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at } };
}

async function holdArgumentFocus(page: Page) {
  await page.evaluate(() => {
    const prototype = customElements.get('math-field')!.prototype as HTMLElement;
    const original = prototype.focus;
    const gap: FocusGap = { attempts: 0,
      release() { prototype.focus = original; if (this.pending?.isConnected) { original.call(this.pending); } },
    };
    prototype.focus = function(options?: FocusOptions) {
      if (this.closest('.omt-macro-args')) { gap.pending = this; gap.attempts++; return; }
      original.call(this, options);
    };
    (window as unknown as { __imeGap: FocusGap }).__imeGap = gap;
  });
}

for (const count of [1, 2]) {
  test(`CJK beforeinput queued during completion focus handoff replays into ${count} text parameter${count === 1 ? '' : 's'}`, async ({ page }) => {
    const name = count === 1 ? 'wrap' : 'duo';
    const host = new MockHost(page, '$b+$', [{ name, arity: count, body: count === 1 ? '#1' : '#1+#2' }], {
      completion: (request, current) => ({ items: [item(request, current, name, count === 1 ? 'wrap{$1}$0' : 'duo{$1}{$2}$0')] }),
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await host.open();
    await page.locator('.omt-formula').click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
    await page.keyboard.press('End');
    await page.keyboard.type('\\' + name);
    await expect(page.locator('.omt-completion-item')).toContainText('\\' + name);
    await holdArgumentFocus(page);
    try {
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __imeGap: FocusGap }).__imeGap.attempts)).toBeGreaterThan(0);
      expect(await page.evaluate(() => {
        const gap = (window as unknown as { __imeGap: FocusGap }).__imeGap;
        return !!gap.pending?.isConnected && document.activeElement !== gap.pending;
      })).toBe(true);
      // This exercises the application's legitimate accessibility/focus queue,
      // whose replay is synthetic by design. Native IME is covered by ime.spec.
      const prevented = await page.evaluate(count => {
        const first = new InputEvent('beforeinput', { data: '中文', inputType: 'insertText', bubbles: true, composed: true, cancelable: true });
        document.body.dispatchEvent(first);
        if (count === 1) { return [first.defaultPrevented]; }
        const tab = new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, composed: true, cancelable: true });
        document.body.dispatchEvent(tab);
        const second = new InputEvent('beforeinput', { data: '公式', inputType: 'insertText', bubbles: true, composed: true, cancelable: true });
        document.body.dispatchEvent(second);
        return [first.defaultPrevented, tab.defaultPrevented, second.defaultPrevented];
      }, count);
      expect(prevented.every(Boolean)).toBe(true);
    } finally {
      await page.evaluate(() => (window as unknown as { __imeGap: FocusGap }).__imeGap.release());
    }
    const field = page.locator(`.omt-macro-arg[data-index="${count}"] math-field`);
    await expect(field).toBeFocused();
    await host.flush();
    expect(host.text).toBe(count === 1 ? '$b+\\wrap{\\text{中文}}$' : '$b+\\duo{\\text{中文}}{\\text{公式}}$');
    expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
    expect(host.edits.flatMap(edit => edit.patches).every(patch => !/\\OMT[A-Za-z]+|\\placeholder/.test(patch.insert))).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const escape of [false, true]) {
  test(`native CDP cancellation ${escape ? 'after IME Escape ' : ''}preserves source and releases flush`, async ({ page }) => {
    const source = '$\\text{原词}+x$';
    const host = new MockHost(page, source);
    await host.open();
    await page.locator('.omt-formula').click();
    await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
    await page.keyboard.press('ControlOrMeta+a');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'gong', selectionStart: 4, selectionEnd: 4 });
    await expect(page.locator('.omt-ime-preview')).toHaveText('gong');
    expect(host.edits).toHaveLength(0);
    if (escape) {
      await page.keyboard.press('Escape');
      await expect(page.locator('.omt-live math-field')).toBeVisible();
      expect(host.edits).toHaveLength(0);
    }
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await host.flush();
    expect(host.text).toBe(source);
    expect(host.edits).toHaveLength(0);
    await expect(page.locator('.omt-ime-preview')).toHaveCount(0);
    await cdp.detach();
  });
}

test('disposing a native IME field releases its sync hold without writing temporary mode conversion', async ({ page }) => {
  const host = new MockHost(page, '$x$');
  await host.open();
  await page.locator('.omt-formula').click();
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await page.keyboard.press('ControlOrMeta+a');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'gong', selectionStart: 4, selectionEnd: 4 });
  await expect(page.locator('.omt-ime-preview')).toHaveText('gong');
  await host.toggleSource();
  await expect(page.locator('.omt-live')).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe('$x$');
  expect(host.edits).toHaveLength(0);
  await expect(page.locator('.omt-ime-preview')).toHaveCount(0);
  await cdp.detach();
});
