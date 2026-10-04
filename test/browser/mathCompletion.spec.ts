import { test, expect, type Page } from '@playwright/test';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import { MockHost, type CompletionRequest, type MockHostOptions } from './host.ts';

interface TestMathField extends HTMLElement {
  position: number;
  lastOffset: number;
  selection: { ranges: [number, number][] };
  getValue(format?: string): string;
  getValue(from: number, to: number, format?: string): string;
  getValue(selection: { ranges: [number, number][] }, format?: string): string;
}

const macros = [
  { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' },
  { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'x' },
];

/** Workshop replaces the command name after the backslash, in document coordinates. */
function item(request: CompletionRequest, host: MockHost, label: string, value: string, extra: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  return {
    i: 0, label, filterText: label, source: 'provider', insert: { snippet: true, value },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at }, ...extra,
  };
}

const fraction = (request: CompletionRequest, host: MockHost) => item(request, host, '\\frac', 'frac{$1}{$2}$0');

async function setup(page: Page, text: string, options: MockHostOptions) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, text, macros, options);
  await host.open();
  return { host, errors };
}

async function enterFormula(page: Page) {
  await page.locator('.omt-formula').first().click();
  await page.waitForSelector('.omt-live math-field');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await page.evaluate(() => {
    const field = document.querySelector('math-field') as TestMathField;
    field.position = field.lastOffset;
  });
}

async function prefix(page: Page, value: string) {
  await page.keyboard.type('\\');
  await expect(page.locator('.omt-math-buffer input')).toBeVisible();
  await page.keyboard.type(value);
}

const selectedMath = (page: Page) => page.evaluate(() => {
  const field = document.querySelector('math-field') as TestMathField;
  return field.getValue(field.selection, 'latex-without-placeholders');
});

function expectCleanSource(host: MockHost) {
  expect(host.text).not.toMatch(/\\placeholder|\\OMT[A-Za-z]+/);
  for (const edit of host.edits) {
    for (const patch of edit.patches) { expect(patch.insert).not.toMatch(/\\placeholder|\\OMT[A-Za-z]+/); }
  }
}

test('math completion flushes the command prefix, inserts a fraction and navigates its placeholders', async ({ page }) => {
  const { host, errors } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  expect(host.requests[0]!.ctx).toBe('math');
  expect(host.completionDocuments[0]!.text).toMatch(/\$x\+\\[a-z]*\s*\$$/);
  expect(host.completionDocuments[0]!.version).toBe(host.requests[0]!.version);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{}{}$');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await page.keyboard.type('a');
  await page.keyboard.press('Tab');
  await page.keyboard.type('b');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{a}{b}$');
  expectCleanSource(host);
  expect(errors).toEqual([]);
});

test('Escape withdraws the temporary command and restores the original source byte for byte', async ({ page }) => {
  const original = 'Text $ \\norm  { x } + E = m c^{2} $.';
  const { host } = await setup(page, original, {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await host.flush();
  expect(host.text).not.toBe(original);
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe(original);
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  expectCleanSource(host);
});

test('an initial backslash keeps the live formula mounted and Escape removes its temporary separator', async ({ page }) => {
  const original = '$x+$';
  const { host } = await setup(page, original, {
    completionDelay: 250,
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, '');
  await host.flush();
  // An isolated backslash must not escape the closing dollar delimiter.
  expect(host.text).toMatch(/\$x\+\\\s+\$$/);
  await expect(page.locator('.omt-live math-field')).toHaveCount(1);
  await expect(page.locator('.omt-math-buffer input')).toBeVisible();
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe(original);
  expectCleanSource(host);
});

test('math completion excludes prose commands while retaining math and template items', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [
      fraction(request, host),
      item(request, host, '\\section', 'section{${1:title}}$0', { i: 1 }),
      item(request, host, '\\myfraction', '\\frac{$1}{$2}$0', { i: 2, source: 'template' }),
    ] }),
  });
  await enterFormula(page);
  await prefix(page, '');
  await expect(page.locator('.omt-completion-item')).toHaveCount(2);
  await expect(page.locator('.omt-completion-item')).toContainText(['\\frac', '\\myfraction']);
  await expect(page.locator('.omt-completion-item').filter({ hasText: '\\section' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe('$x+$');
});

test('a math template accepts Tab and keeps subsequent placeholder Tab navigation inside MathLive', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [item(request, host, '\\ratio', '\\frac{${1:n}}{${2:d}}$0', {
      source: 'template', filterText: '\\ratio',
      range: { insFrom: host.text.lastIndexOf('\\', request.at - 1), insTo: request.at,
        repFrom: host.text.lastIndexOf('\\', request.at - 1), repTo: request.at },
    })] }),
  });
  await enterFormula(page);
  await prefix(page, 'rat');
  await expect(page.locator('.omt-completion-item')).toContainText('\\ratio');
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await expect.poll(() => selectedMath(page)).toBe('n');
  await page.keyboard.type('p');
  await page.keyboard.press('Tab');
  await expect.poll(() => selectedMath(page)).toBe('d');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{p}{q}$');
  expectCleanSource(host);
});

test('a template remains available in prose with CodeMirror snippet Tab navigation', async ({ page }) => {
  const { host } = await setup(page, '\\ratio', {
    completion: (request, host) => ({ items: [item(request, host, '\\ratio', '\\frac{$1}{$2}$0', {
      source: 'template', range: { insFrom: 0, insTo: request.at, repFrom: 0, repTo: request.at },
    })] }),
  });
  await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(6));
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.omt-completion-item')).toContainText('\\ratio');
  await page.keyboard.press('Enter');
  await page.keyboard.type('n');
  await page.keyboard.press('Tab');
  await page.keyboard.type('d');
  await host.flush();
  expect(host.requests[0]!.ctx).toBe('prose');
  expect(host.text).toBe('\\frac{n}{d}');
});

test('a wrapping math snippet consumes TM_SELECTED_TEXT from the current MathLive selection', async ({ page }) => {
  const { host } = await setup(page, '$x$', {
    completion: (request, host) => ({ items: [item(request, host, 'Wrap selection', '\\sqrt{${TM_SELECTED_TEXT}}$0', {
      source: 'template', filterText: '', range: { insFrom: request.at, insTo: request.at, repFrom: request.at, repTo: request.at },
    })] }),
  });
  await enterFormula(page);
  await page.evaluate(() => {
    const field = document.querySelector('math-field') as TestMathField;
    field.selection = { ranges: [[0, field.lastOffset]] };
  });
  expect(await selectedMath(page)).toBe('x');
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.omt-completion-item')).toContainText('Wrap selection');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$\\sqrt{x}$');
  expectCleanSource(host);
});

test('typing while a math completion request is outstanding filters its response and extends the replacement', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completionDelay: 250,
    completion: (request, host) => ({ items: [
      fraction(request, host), item(request, host, '\\sum', 'sum_{$1}^{$2}$0', { i: 1 }),
    ] }),
  });
  await enterFormula(page);
  await prefix(page, '');
  await expect.poll(() => host.requests.length).toBe(1);
  await page.keyboard.type('fr');
  await expect(page.locator('.omt-completion-item')).toHaveCount(1);
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{}{}$');
  expect(host.requests).toHaveLength(1);
  expectCleanSource(host);
});

test('a stale math completion response is retried once and cannot insert a stale item', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [fraction(request, host)], version: request.version + 1, isIncomplete: true }),
  });
  await enterFormula(page);
  await prefix(page, '');
  await expect.poll(() => host.requests.length).toBe(2);
  await page.waitForTimeout(200);
  expect(host.requests).toHaveLength(2);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe('$x+$');
});

test('Escape cancels an outstanding math response and its late result stays hidden', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completionDelay: 250,
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect.poll(() => host.requests.length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await host.flush();
  await page.waitForTimeout(350);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  expect(host.text).toBe('$x+$');
});

test('a foreign edit cancels a math completion while preserving the native edit', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completionDelay: 250,
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await host.flush();
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await host.flush();
  await page.waitForTimeout(350);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  expect(host.text).toBe('Native $x+$');
  expectCleanSource(host);
});

test('additional edits and the accepted math insertion are one transaction with a host command', async ({ page }) => {
  const { host } = await setup(page, 'Header\n$x+$', {
    completion: (request, host) => ({ items: [{
      ...fraction(request, host), i: 7, extraEdits: [{ from: 0, to: 6, insert: '% Header' }], command: 'host',
    }] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await host.flush();
  const request = host.requests[host.requests.length - 1]!;
  const before = host.edits.length;
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.edits.slice(before)).toHaveLength(1);
  expect(host.edits[before]!.patches).toHaveLength(2);
  expect(host.text).toBe('% Header\n$x+\\frac{}{}$');
  expect(host.commands).toEqual([{ t: 'runItemCommand', req: request.req, item: 7 }]);
  expectCleanSource(host);
});

test('math completion locates a nested fraction denominator and keeps macro islands verbatim', async ({ page }) => {
  const original = '$\\norm  { x }+\\frac{a}{b}+\\pair[z] w$';
  const { host } = await setup(page, original, {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await page.evaluate(() => {
    const field = document.querySelector('math-field') as TestMathField;
    for (let offset = 0; offset < field.lastOffset; offset++) {
      if (field.getValue(offset, offset + 1, 'latex-without-placeholders') === 'b') {
        field.position = offset + 1;
        return;
      }
    }
    throw new Error('Could not locate the fraction denominator in MathLive');
  });
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await page.keyboard.type('c');
  await page.keyboard.press('Tab');
  await page.keyboard.type('d');
  await host.flush();
  expect(host.text).toBe('$\\norm  { x }+\\frac{a}{b\\frac{c}{d}}+\\pair[z] w$');
  expectCleanSource(host);
});

test('macro context version and definition locations can refresh without cancelling a command buffer', async ({ page }) => {
  const { host } = await setup(page, '$\\norm{x}+a$', {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.evaluate(defs => window.postMessage({ t: 'context', contextVersion: 2,
    macros: defs.map((macro, i) => ({ ...macro, source: { uri: 'file:///macros.tex', from: 100 + i, to: 120 + i } })),
    templates: [], diagnostics: [],
  }, '*'), macros);
  await expect(page.locator('.omt-math-buffer input')).toBeVisible();
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$\\norm{x}+a\\frac{}{}$');
  expectCleanSource(host);
});

test('Escape restores the MathLive selection that a command buffer temporarily replaced', async ({ page }) => {
  const { host } = await setup(page, '$x+y$', {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await page.evaluate(() => {
    const field = document.querySelector('math-field') as TestMathField;
    field.selection = { ranges: [[0, field.lastOffset]] };
  });
  expect(await selectedMath(page)).toBe('x+y');
  await prefix(page, 'fr');
  await page.keyboard.press('Escape');
  await host.flush();
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  expect(host.text).toBe('$x+y$');
  expect(await selectedMath(page)).toBe('x+y');
  await page.keyboard.type('z');
  await host.flush();
  expect(host.text).toBe('$z$');
});

test('cancelling a new command inside a default prompt preserves its remaining Tab navigation', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [item(request, host, '\\frac', 'frac{${1:n}}{${2:d}}$0')] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await expect.poll(() => selectedMath(page)).toBe('n');
  await prefix(page, 'fr');
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{n}{d}$');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  expect(await selectedMath(page)).toBe('n');
  await page.keyboard.type('p');
  await page.keyboard.press('Tab');
  await expect.poll(() => selectedMath(page)).toBe('d');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{p}{q}$');
  expectCleanSource(host);
});

test('beforeinput can start math completion without a preceding keydown', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  const intercepted = await page.evaluate(() => {
    const event = new InputEvent('beforeinput', { data: '\\', inputType: 'insertText', bubbles: true, composed: true, cancelable: true });
    document.querySelector('math-field')!.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(intercepted).toBe(true);
  await expect(page.locator('.omt-math-buffer input')).toBeVisible();
  await page.keyboard.type('fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe('$x+$');
});

test('IME composition waits until commit before refreshing an incomplete math completion list', async ({ page }) => {
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [fraction(request, host)], isIncomplete: true }),
  });
  await enterFormula(page);
  await prefix(page, '');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  const before = host.requests.length;
  await page.evaluate(() => {
    const input = document.querySelector('.omt-math-buffer input') as HTMLInputElement;
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.value = '\\fr';
    input.dispatchEvent(new InputEvent('input', { data: 'fr', inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
  });
  await page.waitForTimeout(75);
  expect(host.requests).toHaveLength(before);
  await page.evaluate(() => {
    document.querySelector('.omt-math-buffer input')!.dispatchEvent(new CompositionEvent('compositionend', { data: 'fr', bubbles: true }));
  });
  await expect.poll(() => host.requests.length).toBeGreaterThan(before);
  expect(host.completionDocuments[host.completionDocuments.length - 1]!.text).toContain('\\fr');
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe('$x+$');
});

test('inline shortcut overrides update the mounted MathLive field when settings change', async ({ page }) => {
  const { host } = await setup(page, '$x$', {
    settings: { inlineShortcutOverrides: { abc: '\\alpha' } },
  });
  await enterFormula(page);
  const shortcuts = () => page.evaluate(() => (document.querySelector('math-field') as unknown as { inlineShortcuts: Record<string, string> }).inlineShortcuts);
  expect(await shortcuts()).toMatchObject({ abc: '\\alpha', '>=': '\\ge' });
  await host.updateSettings({ inlineShortcuts: false });
  await expect.poll(shortcuts).toEqual({});
  await host.updateSettings({ inlineShortcuts: true, inlineShortcutOverrides: { xyz: '\\beta' } });
  await expect.poll(shortcuts).toMatchObject({ xyz: '\\beta', '>=': '\\ge' });
  expect(await shortcuts()).not.toHaveProperty('abc');
  expect(host.edits).toEqual([]);
});

test('an invalid math template withdraws its prefix and restores the original source', async ({ page }) => {
  const original = '$ x^{2} +\\norm  { a } $';
  const { host } = await setup(page, original, {
    completion: (request, host) => ({ items: [item(request, host, '\\bad', '\\definitelyUnknownMathCommand{$1}', {
      source: 'template', filterText: '\\bad', command: 'host',
      range: { insFrom: host.text.lastIndexOf('\\', request.at - 1), insTo: request.at,
        repFrom: host.text.lastIndexOf('\\', request.at - 1), repTo: request.at },
    })] }),
  });
  await enterFormula(page);
  await prefix(page, 'bad');
  await expect(page.locator('.omt-completion-item')).toContainText('\\bad');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe(original);
  await expect(page.locator('.omt-math-buffer')).toHaveCount(0);
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(host.commands).toEqual([]);
  expectCleanSource(host);
});

test('a cases template inserts a real MathLive environment with editable prompt cells', async ({ page }) => {
  // VS Code snippets escape a literal backslash: four become the TeX row separator.
  const body = '\\begin{cases}${1:a}&${2:b}\\\\\\\\${3:c}&${4:d}\\end{cases}$0';
  const { host } = await setup(page, '$x+$', {
    completion: (request, host) => ({ items: [item(request, host, '\\piece', body, {
      source: 'template', filterText: '\\piece',
      range: { insFrom: host.text.lastIndexOf('\\', request.at - 1), insTo: request.at,
        repFrom: host.text.lastIndexOf('\\', request.at - 1), repTo: request.at },
    })] }),
  });
  await enterFormula(page);
  await prefix(page, 'piece');
  await expect(page.locator('.omt-completion-item')).toContainText('\\piece');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await expect.poll(() => selectedMath(page)).toBe('a');
  await page.keyboard.type('p');
  await page.keyboard.press('Tab');
  await expect.poll(() => selectedMath(page)).toBe('b');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toMatch(/^\$x\+\\begin\{cases\}\s*p\s*&\s*q\s*\\\\\s*c\s*&\s*d\s*\\end\{cases\}\$$/);
  expectCleanSource(host);
});

for (const [open, close] of [['\\(', '\\)'], ['\\[', '\\]']]) {
  test(`a ${open} formula supports completion and restores both delimiters on cancellation`, async ({ page }) => {
    const original = `Before ${open}x+${close} after`;
    const { host } = await setup(page, original, {
      completion: (request, host) => ({ items: [fraction(request, host)] }),
    });
    await enterFormula(page);
    await prefix(page, 'fr');
    await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
    await page.keyboard.press('Escape');
    await host.flush();
    expect(host.text).toBe(original);
    await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
    await prefix(page, 'fr');
    await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
    await page.keyboard.press('Enter');
    await host.flush();
    expect(host.text).toBe(`Before ${open}x+\\frac{}{}${close} after`);
    expectCleanSource(host);
  });
}

for (const [name, snippet, argument] of [['empty', 'norm{$1}$0', ''], ['default', 'norm{${1:x}}$0', 'x']]) {
  test(`a project macro snippet accepts its ${name} argument without leaking MathLive placeholders`, async ({ page }) => {
    const { host } = await setup(page, '$x+$', {
      completion: (request, host) => ({ items: [item(request, host, '\\norm', snippet, { source: 'macro' })] }),
    });
    await enterFormula(page);
    await prefix(page, 'no');
    await expect(page.locator('.omt-completion-item')).toContainText('\\norm');
    await page.keyboard.press('Enter');
    await expect(page.locator('.omt-macro-header strong')).toHaveText('\\norm');
    await expect(page.locator('.omt-macro-arg[data-index="1"] math-field')).toBeFocused();
    await expect(page.locator('.omt-live math-field')).not.toBeFocused();
    await host.flush();
    expect(host.text).toBe(`$x+\\norm{${argument}}$`);
    expectCleanSource(host);
  });
}


test('Tab-only math completion forwards Enter once to MathLive and Tab still accepts candidates', async ({ page }) => {
  const { host, errors } = await setup(page, '$x+$', {
    settings: { completionAcceptOnEnter: undefined },
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await enterFormula(page);
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.evaluate(() => {
    document.body.dataset.enterCount = '0';
    document.querySelector('math-field')!.addEventListener('keydown', event => {
      if ((event as KeyboardEvent).key === 'Enter') {
        document.body.dataset.enterCount = String(Number(document.body.dataset.enterCount) + 1);
      }
    });
  });
  await page.keyboard.press('Enter');
  await expect(page.locator('.omt-math-buffer')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.dataset.enterCount)).toBe('1');
  await host.flush();
  expect(host.text).toBe('$x+$');
  await page.waitForFunction(() => document.activeElement?.tagName === 'MATH-FIELD');
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('$x+\\frac{}{}$');
  expect(errors).toEqual([]);
});
