import { test, expect, type Locator, type Page } from '@playwright/test';
import type { MacroDef } from '../../src/shared/types.ts';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import { MockHost, type CompletionRequest, type MockHostOptions } from './host.ts';

interface TestMathField extends HTMLElement {
  position: number;
  lastOffset: number;
  selection: { ranges: [number, number][] };
  executeCommand(command: string): boolean;
  getValue(format?: string): string;
  getValue(selection: { ranges: [number, number][] }, format?: string): string;
}

const macros: MacroDef[] = [
  { name: 'bm', arity: 1, body: '\\symbfit{#1}' },
  { name: 'duo', arity: 2, body: '#1+#2' },
  { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'd' },
  { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' },
];

const main = (page: Page) => page.locator('.omt-live math-field');
const argument = (page: Page, index: number) => page.locator(`.omt-macro-arg[data-index="${index}"] math-field`);

function candidate(request: CompletionRequest, host: MockHost, name: string, snippet: string, extras: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  return {
    i: 0, label: `\\${name}`, filterText: name, source: 'macro', insert: { snippet: true, value: snippet },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at }, ...extras,
  };
}

async function setup(page: Page, options: MockHostOptions, source = '$b+$', definitions = macros) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, source, definitions, options);
  await host.open();
  await page.locator('.omt-formula').click();
  await expect(main(page)).toBeVisible();
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await end(main(page));
  return { host, errors };
}

async function end(field: Locator) {
  await field.evaluate(element => {
    const math = element as TestMathField;
    math.position = math.lastOffset; math.focus();
  });
  await expect(field).toBeFocused();
}

async function suggest(page: Page, name: string) {
  await page.keyboard.type('\\' + name);
  await expect(page.locator('math-field.omt-math-command')).toBeVisible();
  await expect(page.locator('.omt-completion-item')).toContainText('\\' + name);
}

function clean(host: MockHost) {
  expect(host.text).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/);
  for (const edit of host.edits) {
    for (const patch of edit.patches) { expect(patch.insert).not.toMatch(/\\OMT[A-Za-z]+|\\placeholder/); }
  }
}

test('a project macro completion opens its parameter field and writes b+bm{x}', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}$0')] }),
  });
  await suggest(page, 'bm');
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\bm');
  await expect(argument(page, 1)).toBeFocused();
  await expect(main(page)).not.toBeFocused();
  await page.keyboard.type('x');
  await host.flush();
  expect(host.text).toBe('$b+\\bm{x}$');
  clean(host); expect(errors).toEqual([]);
});

test('completing a second call to the same macro edits the new source island and preserves the existing call', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}$0')] }),
  }, '$\\bm{o}+b+$');
  await suggest(page, 'bm');
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\bm');
  await expect(argument(page, 1)).toBeFocused();
  expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('');
  await page.keyboard.type('x');
  await host.flush();
  expect(host.text).toBe('$\\bm{o}+b+\\bm{x}$');
  expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('x');
  clean(host); expect(errors).toEqual([]);
});

test('a compatible macro template opens both source-owned parameters without a project definition', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'dv', 'dv{$1}{$2}$0', { source: 'template' })] }),
  }, '$b+$', []);
  await suggest(page, 'dv');
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\dv');
  await expect(page.locator('.omt-macro-arg math-field')).toHaveCount(2);
  await expect(argument(page, 1)).toBeFocused();
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await expect(argument(page, 2)).toBeFocused();
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('$b+\\dv{x}{y}$');
  clean(host); expect(errors).toEqual([]);
});

for (const close of ['Tab', 'Enter', 'Escape']) {
  test(`two-argument macro completion supports Tab, Shift-Tab and ${close} returning after the source island`, async ({ page }) => {
    const { host, errors } = await setup(page, {
      completion: (request, current) => ({ items: [candidate(request, current, 'duo', 'duo{$1}{$2}$0')] }),
    });
    await suggest(page, 'duo');
    await page.keyboard.press('Enter');
    await expect(argument(page, 1)).toBeFocused();
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await expect(argument(page, 2)).toBeFocused();
    await page.keyboard.type('y');
    await page.keyboard.press('Shift+Tab');
    await expect(argument(page, 1)).toBeFocused();
    expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('x');
    await page.keyboard.press('Tab');
    await expect(argument(page, 2)).toBeFocused();
    await page.keyboard.press(close);
    await expect(page.locator('.omt-macro-args')).toHaveCount(0);
    await expect(main(page)).toBeFocused();
    await page.keyboard.type('+q');
    await host.flush();
    expect(host.text).toBe('$b+\\duo{x}{y}+q$');
    clean(host); expect(errors).toEqual([]);
  });
}

test('macro completion preserves optional snippet defaults and selects the first argument for replacement', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'pair', 'pair[${1:z}]{${2:w}}$0')] }),
  });
  await suggest(page, 'pair');
  await page.keyboard.press('Enter');
  await expect(argument(page, 1)).toBeFocused();
  await host.flush();
  expect(host.text).toBe('$b+\\pair[z]{w}$');
  expect(await argument(page, 1).evaluate(element => {
    const field = element as TestMathField;
    return field.getValue(field.selection, 'latex-without-placeholders');
  })).toBe('z');
  await page.keyboard.type('u');
  await page.keyboard.press('Tab');
  await expect(argument(page, 2)).toBeFocused();
  expect(await argument(page, 2).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('w');
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('v');
  await host.flush();
  expect(host.text).toBe('$b+\\pair[u]{v}$');
  clean(host); expect(errors).toEqual([]);
});

test('a nested macro completion edits its own parameters and returns after its island in the parent argument', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'duo', 'duo{$1}{$2}$0')] }),
  }, '$\\norm{x}+a$');
  await page.locator('.omt-macro-edit').filter({ hasText: '\\norm' }).click();
  await end(argument(page, 1));
  await suggest(page, 'duo');
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\duo');
  await expect(page.locator('.omt-macro-back')).toBeVisible();
  await expect(argument(page, 1)).toBeFocused();
  await page.keyboard.type('p');
  await page.keyboard.press('Tab');
  await expect(argument(page, 2)).toBeFocused();
  await page.keyboard.type('q');
  await page.keyboard.press('Tab');
  await expect(page.locator('.omt-macro-header strong')).toHaveText('\\norm');
  await expect(argument(page, 1)).toBeFocused();
  await page.keyboard.type('+r');
  await host.flush();
  expect(host.text).toBe('$\\norm{x\\duo{p}{q}+r}+a$');
  clean(host); expect(errors).toEqual([]);
});

test('the first key typed immediately after accepting a macro reaches its parameter without waiting for focus', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}$0')] }),
  });
  await suggest(page, 'bm');
  await page.keyboard.press('Enter');
  // Deliberately do not wait for the new field or its asynchronous MathLive focus.
  await page.keyboard.type('x');
  await host.flush();
  expect(host.text).toBe('$b+\\bm{x}$');
  await expect(argument(page, 1)).toBeFocused();
  clean(host); expect(errors).toEqual([]);
});

test('immediate keys cross both macro parameters and return to the main field without focus waits', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'duo', 'duo{$1}{$2}$0')] }),
  });
  await suggest(page, 'duo');
  await page.keyboard.press('Enter');
  // Every key follows the preceding key immediately, including both transfers.
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await page.keyboard.type('y');
  await page.keyboard.press('Tab');
  await page.keyboard.type('+q');
  await host.flush();
  expect(host.text).toBe('$b+\\duo{x}{y}+q$');
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  await expect(main(page)).toBeFocused();
  clean(host); expect(errors).toEqual([]);
});

for (const [name, snippet] of [['comment suffix', 'bm{$1}% comment'], ['unbalanced group', 'bm{$1}{']]) {
  test(`a known macro completion with a ${name} cancels without changing the original source`, async ({ page }) => {
    const source = '$ b + a $';
    const { host, errors } = await setup(page, {
      completion: (request, current) => ({ items: [candidate(request, current, 'bm', snippet)] }),
    }, source);
    await suggest(page, 'bm');
    await page.keyboard.press('Enter');
    await host.flush();
    expect(host.text).toBe(source);
    await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
    await expect(page.locator('.omt-completion')).toBeHidden();
    await expect(page.locator('.omt-macro-args')).toHaveCount(0);
    clean(host); expect(errors).toEqual([]);
  });
}

test('a known macro completion containing a math closing command preserves the whole delimited formula', async ({ page }) => {
  const source = 'Before \\( b + a \\) after';
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}\\)')] }),
  }, source);
  await suggest(page, 'bm');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe(source);
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  clean(host); expect(errors).toEqual([]);
});

interface FocusGap {
  pending?: HTMLElement;
  attempts: number;
  events: { type: string; data: string; focused: boolean }[];
  release(): void;
}

async function holdArgumentFocus(page: Page, selector = '.omt-macro-args') {
  await page.evaluate(selector => {
    const prototype = customElements.get('math-field')!.prototype as HTMLElement;
    const original = prototype.focus;
    const state: FocusGap = {
      attempts: 0, events: [],
      release() { prototype.focus = original; if (this.pending?.isConnected) { original.call(this.pending); } },
    };
    prototype.focus = function(options?: FocusOptions) {
      if (this.closest(selector)) { state.pending = this; state.attempts++; return; }
      original.call(this, options);
    };
    (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap = state;
    for (const type of ['keydown', 'beforeinput']) {
      document.addEventListener(type, event => {
        state.events.push({ type, data: type === 'keydown' ? (event as KeyboardEvent).key : (event as InputEvent).data ?? '',
          focused: document.activeElement === state.pending });
      }, { capture: true });
    }
  }, selector);
}

test('a normal fraction template keeps MathLive focus and accepts its first key immediately', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'frac', 'frac{$1}{$2}$0', { source: 'provider' })] }),
  });
  await suggest(page, 'frac');
  await expect(main(page)).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('x');
  await expect(main(page)).toBeFocused();
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe('$b+\\frac{x}{}$');
  clean(host); expect(errors).toEqual([]);
});

for (const channel of ['keydown', 'beforeinput']) {
  test(`macro completion buffers ${channel} while the destination MathLive field has not acquired focus`, async ({ page }) => {
    const { host, errors } = await setup(page, {
      completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}$0')] }),
    });
    await suggest(page, 'bm');
    await holdArgumentFocus(page);
    try {
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.attempts)).toBeGreaterThan(0);
      expect(await page.evaluate(() => {
        const gap = (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap;
        return Boolean(gap.pending?.isConnected && document.activeElement !== gap.pending);
      })).toBe(true);
      if (channel === 'keydown') { await page.keyboard.type('x'); }
      else {
        expect(await page.evaluate(() => {
          const event = new InputEvent('beforeinput', { data: 'x', inputType: 'insertText', bubbles: true, composed: true, cancelable: true });
          document.body.dispatchEvent(event); return event.defaultPrevented;
        })).toBe(true);
      }
      expect(await page.evaluate(channel => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.events
        .some(event => event.type === channel && event.data === 'x' && !event.focused), channel)).toBe(true);
    } finally { await page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.release()); }
    await expect(argument(page, 1)).toBeFocused();
    await host.flush();
    expect(host.text).toBe('$b+\\bm{x}$');
    clean(host); expect(errors).toEqual([]);
  });
}

for (const input of [
  { name: 'an Alt-modified printable key', key: 'ñ', code: 'KeyN', altKey: true, beforeInput: null, expected: 'ñ' },
  { name: 'a matching beforeinput paired with its keydown exactly once', key: 'x', code: 'KeyX', altKey: false, beforeInput: 'x', expected: 'x' },
  { name: 'an independent beforeinput after a different keydown in order', key: 'x', code: 'KeyX', altKey: false, beforeInput: 'y', expected: 'xy' },
]) {
  test(`macro completion retains ${input.name} through the argument focus gap`, async ({ page }) => {
    const { host, errors } = await setup(page, {
      completion: (request, current) => ({ items: [candidate(request, current, 'bm', 'bm{$1}$0')] }),
    });
    await suggest(page, 'bm');
    await holdArgumentFocus(page);
    try {
      await page.keyboard.press('Enter');
      await expect.poll(() => page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.attempts)).toBeGreaterThan(0);
      expect(await page.evaluate(() => {
        const gap = (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap;
        return Boolean(gap.pending?.isConnected && document.activeElement !== gap.pending);
      })).toBe(true);
      const prevented = await page.evaluate(({ key, code, altKey, beforeInput }) => {
        const keydown = new KeyboardEvent('keydown', { key, code, altKey, bubbles: true, composed: true, cancelable: true });
        document.body.dispatchEvent(keydown);
        let beforeinput: InputEvent | undefined;
        if (beforeInput !== null) {
          beforeinput = new InputEvent('beforeinput', { data: beforeInput, inputType: 'insertText', bubbles: true, composed: true, cancelable: true });
          document.body.dispatchEvent(beforeinput);
        }
        return { key: keydown.defaultPrevented, input: beforeinput?.defaultPrevented };
      }, input);
      expect(prevented.key).toBe(true);
      if (input.beforeInput !== null) { expect(prevented.input).toBe(true); }
      expect(await page.evaluate(({ key, beforeInput }) => {
        const events = (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.events;
        return events.some(event => event.type === 'keydown' && event.data === key && !event.focused)
          && (beforeInput === null || events.some(event => event.type === 'beforeinput' && event.data === beforeInput && !event.focused));
      }, input)).toBe(true);
    } finally { await page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.release()); }
    await expect(argument(page, 1)).toBeFocused();
    await host.flush();
    expect(host.text).toBe(`$b+\\bm{${input.expected}}$`);
    expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe(input.expected);
    clean(host); expect(errors).toEqual([]);
  });
}

test('keys buffered before the first parameter is focused move through Tab into the second parameter', async ({ page }) => {
  const { host, errors } = await setup(page, {
    completion: (request, current) => ({ items: [candidate(request, current, 'duo', 'duo{$1}{$2}$0')] }),
  });
  await suggest(page, 'duo');
  await holdArgumentFocus(page);
  try {
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.attempts)).toBeGreaterThan(0);
    expect(await page.evaluate(() => {
      const gap = (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap;
      return Boolean(gap.pending?.isConnected && document.activeElement !== gap.pending);
    })).toBe(true);
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await page.keyboard.type('y');
    expect(await page.evaluate(() => {
      const events = (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.events;
      return ['x', 'Tab', 'y'].every(key => events.some(event => event.type === 'keydown' && event.data === key && !event.focused));
    })).toBe(true);
  } finally { await page.evaluate(() => (window as unknown as { __omtFocusGap: FocusGap }).__omtFocusGap.release()); }
  await expect(argument(page, 2)).toBeFocused();
  await host.flush();
  expect(host.text).toBe('$b+\\duo{x}{y}$');
  expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('x');
  expect(await argument(page, 2).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('y');
  clean(host); expect(errors).toEqual([]);
});

test('triggerSuggest opens an editable command buffer before the accepted edit is acknowledged', async ({ page }) => {
  let unblock!: () => void;
  const acknowledgement = new Promise<void>(resolve => { unblock = resolve; });
  let blocked = false, released = false;
  const { host, errors } = await setup(page, {
    beforeEditAck: async edit => {
      if (edit.kind === 'mathCompletion' && !blocked) { blocked = true; await acknowledgement; }
    },
    completion: (request, current) => {
      const command = current.text.slice(0, request.at).match(/\\([A-Za-z]*)$/)?.[1];
      if (command !== undefined && 'frac'.startsWith(command)) {
        return { items: [candidate(request, current, 'frac', 'frac{$1}{$2}$0', { source: 'provider', command: 'triggerSuggest' })] };
      }
      const from = request.at - 2;
      return { items: [{ i: 1, label: '\\alpha', filterText: 'alpha', source: 'provider', insert: { snippet: false, value: '\\alpha' },
        range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at } }] };
    },
  });
  await suggest(page, 'frac');
  const requestsBeforeAcceptance = host.requests.length;
  try {
    await page.keyboard.press('Enter');
    await expect.poll(() => blocked).toBe(true);
    expect(released).toBe(false);
    await expect(page.locator('math-field.omt-math-command')).toBeFocused();
    await page.keyboard.type('al');
    await expect.poll(() => page.locator('math-field.omt-math-command').evaluate(element => {
      const field = element as unknown as { position: number; getValue(from: number, to: number, format: string): string };
      return field.getValue(field.position - 2, field.position, 'latex');
    })).toBe('al');
    expect(host.requests).toHaveLength(requestsBeforeAcceptance);
  } finally { released = true; unblock(); }
  await expect(page.locator('.omt-completion-item')).toContainText('\\alpha');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$b+\\frac{\\alpha}{}$');
  clean(host); expect(errors).toEqual([]);
});
