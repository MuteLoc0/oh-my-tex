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
  getValue(from: number, to: number, format?: string): string;
  getElementInfo(offset: number): { latex?: string; bounds: { left: number; top: number; right: number; bottom: number } } | undefined;
}

const macros: MacroDef[] = [
  { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' },
  { name: 'dup', arity: 1, body: '#1+#1' },
  { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'd' },
  { name: 'ket', arity: 1, body: '\\left|#1\\right\\rangle' },
];

async function setup(page: Page, text: string, options: MockHostOptions = {}) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, text, macros.map((macro, i) => ({
    ...macro, source: { uri: 'file:///macros.tex', from: 100 + 30 * i, to: 120 + 30 * i },
  })), options);
  await host.open();
  await page.locator('.omt-formula').first().click();
  await expect(page.locator('.omt-live math-field')).toBeVisible();
  // Clicking a rendered island can open its arguments during activation. Each
  // test starts at the main field and invokes its intended entry point explicitly.
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  return { host, errors };
}

async function openMacro(page: Page, name: string) {
  if (await page.locator('.omt-macro-args').count()) {
    if (await page.locator('.omt-macro-header strong').textContent() === `\\${name}`) {
      await expect(page.locator('.omt-macro-arg').first()).toBeVisible();
      return;
    }
    await page.locator('.omt-macro-close').click();
    await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  }
  await page.locator('.omt-macro-edit').filter({ hasText: `\\${name}` }).first().click();
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  await expect(page.locator('.omt-macro-arg').first()).toBeVisible();
}

/** A foreign edit may preserve a formula DOM or replace its widget; both must use the new source offsets. */
async function reopenMacroIfNeeded(page: Page, name: string) {
  if (await page.locator('.omt-macro-args').count()) { return; }
  if (!await page.locator('.omt-live math-field').count()) {
    await page.locator('.omt-formula').first().click();
    await expect(page.locator('.omt-live math-field')).toBeVisible();
  }
  await openMacro(page, name);
}

const argument = (page: Page, index: number) => page.locator(`.omt-macro-arg[data-index="${index}"] math-field`);

async function replaceArgument(page: Page, index: number, value: string) {
  const field = argument(page, index);
  await field.click();
  await field.evaluate(element => element.focus());
  await expect(field).toBeFocused();
  await field.evaluate(element => (element as TestMathField).executeCommand('selectAll'));
  if (value) { await page.keyboard.type(value); }
  else { await page.keyboard.press('Backspace'); }
}

async function endOfField(field: Locator) {
  await field.click();
  await field.evaluate(element => element.focus());
  await expect(field).toBeFocused();
  await field.evaluate(element => {
    const math = element as TestMathField;
    math.position = math.lastOffset;
  });
}

async function prefix(page: Page, value: string) {
  await page.keyboard.type('\\');
  await expect(page.locator('math-field.omt-math-command')).toBeVisible();
  await page.keyboard.type(value);
}

function fraction(request: CompletionRequest, host: MockHost, extras: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
  return {
    i: 0, label: '\\frac', filterText: '\\frac', source: 'provider', insert: { snippet: true, value: 'frac{$1}{$2}$0' },
    range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at }, ...extras,
  };
}

function expectCleanSource(host: MockHost) {
  expect(host.text).not.toMatch(/\\placeholder|\\OMT[A-Za-z]+/);
  for (const edit of host.edits) {
    for (const patch of edit.patches) { expect(patch.insert).not.toMatch(/\\placeholder|\\OMT[A-Za-z]+/); }
  }
}

test('opening and closing an argument editor preserves the source and document version', async ({ page }) => {
  const original = 'Before $ \\norm  { x } + a $ after';
  const { host, errors } = await setup(page, original);
  await openMacro(page, 'norm');
  await expect(argument(page, 1)).toBeVisible();
  await page.locator('.omt-macro-close').click();
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  await host.flush();
  expect(host.text).toBe(original);
  expect(host.edits).toEqual([]);
  expect(host.version).toBe(1);
  expect(errors).toEqual([]);
});

test('control-word-adjacent macro parameters render as math instead of an unknown chip', async ({ page }) => {
  const source = '$\\norm{x}+a$';
  const host = new MockHost(page, source, macros);
  await host.open();
  await expect(page.locator('.omt-formula')).toContainText('x');
  await expect(page.locator('.omt-formula')).not.toContainText('norm');
  await page.locator('.omt-formula').click();
  await expect.poll(() => page.locator('.omt-live math-field').evaluate(element => element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '')).toContain('x');
  await host.flush();
  expect(host.edits).toEqual([]); expect(host.text).toBe(source); expect(host.version).toBe(1);
});

test('a required argument edit touches only its contents and preserves call whitespace', async ({ page }) => {
  const original = 'Before $ \\norm  { x } + a $ after';
  const { host, errors } = await setup(page, original);
  await openMacro(page, 'norm');
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('Before $ \\norm  { y } + a $ after');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([
    { from: original.indexOf('x'), to: original.indexOf('x') + 1, expected: 'x', insert: 'y' },
  ]);
  expectCleanSource(host);
  expect(errors).toEqual([]);
});

test('a repeated macro argument changes one call and refreshes both rendered copies', async ({ page }) => {
  const { host } = await setup(page, '$\\dup{x}+a$');
  await openMacro(page, 'dup');
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\dup{y}+a$');
  await expect.poll(() => page.locator('.omt-live math-field').evaluate(element =>
    (element.shadowRoot?.querySelector('.ML__base')?.textContent ?? '').match(/y/g)?.length ?? 0,
  )).toBe(2);
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 6, to: 7, expected: 'x', insert: 'y' }]);
  expectCleanSource(host);
});

test('an optional argument can be changed, cleared, removed and added without changing required arguments', async ({ page }) => {
  const { host } = await setup(page, '$\\pair[z]{w}+a$');
  await openMacro(page, 'pair');
  await replaceArgument(page, 1, 'q');
  await host.flush();
  expect(host.text).toBe('$\\pair[q]{w}+a$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 7, to: 8, expected: 'z', insert: 'q' }]);
  await replaceArgument(page, 1, '');
  await host.flush();
  expect(host.text).toBe('$\\pair[]{w}+a$');
  await page.locator('.omt-optional-remove').click();
  await host.flush();
  expect(host.text).toBe('$\\pair{w}+a$');
  await expect(argument(page, 1)).toHaveCount(0);
  await page.locator('.omt-optional-add').click();
  await host.flush();
  expect(host.text).toBe('$\\pair[d]{w}+a$');
  await expect(argument(page, 1)).toBeVisible();
  expect(await argument(page, 2).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('w');
  expectCleanSource(host);
});

test('an unbraced one-token argument receives braces when it grows', async ({ page }) => {
  const { host } = await setup(page, '$\\norm x+a$');
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('$\\norm{xy}+a$');
  expectCleanSource(host);
});

test('a nested macro editor changes only the inner parameter and returns to its parent', async ({ page }) => {
  const { host } = await setup(page, '$\\norm{\\ket{\\psi}}+a$');
  await openMacro(page, 'norm');
  await page.locator('.omt-macro-arg[data-index="1"] .omt-macro-edit').filter({ hasText: '\\ket' }).click();
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\norm{\\ket{y}}+a$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 12, to: 16, expected: '\\psi', insert: 'y' }]);
  await page.locator('.omt-macro-back').click();
  await expect(page.locator('.omt-macro-arg[data-index="1"] .omt-macro-edit')).toContainText('\\ket');
  expectCleanSource(host);
});

test('unknown command chips expose their existing arguments for visual editing', async ({ page }) => {
  const { host, errors } = await setup(page, '$\\omtUnknownPackageCommand[z]{x}+a$');
  expect(await page.locator('.omt-live math-field').evaluate(element => element.shadowRoot?.querySelector('.ML__base')?.textContent ?? ''))
    .toContain('\\omtUnknownPackageCommand');
  await openMacro(page, 'omtUnknownPackageCommand');
  await expect(page.locator('.omt-macro-arg math-field')).toHaveCount(2);
  await replaceArgument(page, 2, 'y');
  await host.flush();
  expect(host.text).toBe('$\\omtUnknownPackageCommand[z]{y}+a$');
  await expect(page.locator('.omt-live math-field')).toBeVisible();
  expectCleanSource(host);
  expect(errors).toEqual([]);
});

test('Alt-Enter opens the macro argument editor at the MathLive caret', async ({ page }) => {
  const { host } = await setup(page, '$\\norm{x}+a$');
  await page.locator('.omt-live math-field').evaluate(element => {
    const field = element as TestMathField;
    for (let offset = 0; offset <= field.lastOffset; offset++) {
      if (/^\\OMT[a-z]+$/.test(field.getElementInfo(offset)?.latex ?? '')) {
        field.position = offset; field.focus(); return;
      }
    }
    throw new Error('Could not locate the macro island at the MathLive caret');
  });
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.press('Alt+Enter');
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\norm{y}+a$');
});

test('clicking the rendered macro island opens its parameter editor', async ({ page }) => {
  const { host } = await setup(page, '$\\norm{x}+a$');
  const point = await page.locator('.omt-live math-field').evaluate(element => {
    const field = element as TestMathField;
    for (let offset = 0; offset <= field.lastOffset; offset++) {
      const info = field.getElementInfo(offset), bounds = info?.bounds;
      if (bounds && /^\\OMT[a-z]+$/.test(info?.latex ?? '')) {
        return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
      }
    }
    throw new Error('The macro island has no rendered bounds');
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\norm{y}+a$');
});

test('the delete button removes the exact call and preserves surrounding source', async ({ page }) => {
  const original = '$a + \\norm  { x } + b$';
  const { host } = await setup(page, original);
  await openMacro(page, 'norm');
  await page.locator('.omt-macro-delete').click();
  await host.flush();
  expect(host.text).toBe('$a +  + b$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([
    { from: 5, to: 17, expected: '\\norm  { x }', insert: '' },
  ]);
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  expectCleanSource(host);
});

test('deleting the selected island in MathLive removes its whole call', async ({ page }) => {
  const { host } = await setup(page, '$\\norm  { x }+a$');
  await page.locator('.omt-live math-field').evaluate(element => {
    const field = element as TestMathField;
    for (let offset = 1; offset <= field.lastOffset; offset++) {
      if (/^\\OMT[a-z]+$/.test(field.getElementInfo(offset)?.latex ?? '')) {
        field.selection = { ranges: [[0, offset]] }; field.focus(); return;
      }
    }
    throw new Error('Could not select the complete macro island');
  });
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.press('Backspace');
  await host.flush();
  expect(host.text).toBe('$+a$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 1, to: 13, expected: '\\norm  { x }', insert: '' }]);
  expectCleanSource(host);
});

test('an external edit closes the argument editor and prevents a stale parameter overwrite', async ({ page }) => {
  const { host } = await setup(page, '$\\norm{x}+a$');
  await openMacro(page, 'norm');
  await host.remote([{ from: 7, to: 8, insert: 'z' }]);
  await expect(page.locator('.omt-macro-args')).toHaveCount(0);
  await openMacro(page, 'norm');
  expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('z');
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\norm{y}+a$');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 7, to: 8, expected: 'z', insert: 'y' }]);
});

test('macro parameter completion uses source coordinates and edits MathLive fraction prompts', async ({ page }) => {
  const { host, errors } = await setup(page, '$\\norm{x}+a$', {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  expect(host.requests[0]!.ctx).toBe('math');
  expect(host.completionDocuments[0]!.text).toMatch(/^\$\\norm\{x\\[a-z]*\s*\}\+a\$$/);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('$\\norm{x\\frac{}{}}+a$');
  await page.waitForFunction(() => document.activeElement?.closest('.omt-macro-args'));
  await page.keyboard.type('p');
  await page.keyboard.press('Tab');
  await page.keyboard.type('q');
  await host.flush();
  expect(host.text).toBe('$\\norm{x\\frac{p}{q}}+a$');
  expectCleanSource(host);
  expect(errors).toEqual([]);
});

test('Escape cancels a parameter command buffer and restores the exact call', async ({ page }) => {
  const original = '$\\norm  { x } + a$';
  const { host } = await setup(page, original, {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await host.flush();
  expect(host.text).not.toBe(original);
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe(original);
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  expectCleanSource(host);
});

test('parameter completion and additional edits commit together and retain the parameter editor', async ({ page }) => {
  const { host } = await setup(page, 'Header\n$\\norm{x}+a$', {
    completion: (request, host) => ({ items: [fraction(request, host, {
      i: 7, extraEdits: [{ from: 0, to: 6, insert: '% Header' }], command: 'host',
    })] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await host.flush();
  const before = host.edits.length;
  const request = host.requests.at(-1)!;
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('% Header\n$\\norm{x\\frac{}{}}+a$');
  expect(host.edits.slice(before)).toHaveLength(1);
  expect(host.edits[before]!.patches).toHaveLength(2);
  expect(host.commands).toEqual([{ t: 'runItemCommand', req: request.req, item: 7 }]);
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  expectCleanSource(host);
});

test('invalid additional edits cancel parameter completion and restore its editable field', async ({ page }) => {
  const original = '$\\norm{x}+a$';
  const { host, errors } = await setup(page, original, {
    completion: (request, host) => ({ items: [fraction(request, host, {
      extraEdits: [{ from: 7, to: 8, insert: 'bad' }], command: 'host',
    })] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe(original);
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  expect(await argument(page, 1).evaluate(element => (element as TestMathField).getValue('latex-without-placeholders'))).toBe('x');
  expect(host.commands).toEqual([]);
  await endOfField(argument(page, 1));
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('$\\norm{xy}+a$');
  expectCleanSource(host);
  expect(errors).toEqual([]);
});

test('a foreign edit cancels an outstanding parameter completion without losing the native change', async ({ page }) => {
  const original = '$\\norm{x}+a$';
  const { host } = await setup(page, original, {
    completionDelay: 250,
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect.poll(() => host.requests.length).toBeGreaterThan(0);
  await host.flush();
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await host.flush();
  await page.waitForTimeout(350);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
  expect(host.text).toBe('Native ' + original);
  await reopenMacroIfNeeded(page, 'norm');
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('Native $\\norm{y}+a$');
  expect(host.edits.at(-1)!.patches).toEqual([{ from: 14, to: 15, expected: 'x', insert: 'y' }]);
  expectCleanSource(host);
});

test('cancelling completion restores an unbraced parameter and its original separator', async ({ page }) => {
  const original = '$\\norm x+a$';
  const { host } = await setup(page, original, {
    completion: (request, host) => ({ items: [fraction(request, host)] }),
  });
  await openMacro(page, 'norm');
  await endOfField(argument(page, 1));
  await prefix(page, 'fr');
  await expect(page.locator('.omt-completion-item')).toContainText('\\frac');
  await host.flush();
  expect(host.text).toContain('\\norm{');
  await page.keyboard.press('Escape');
  await host.flush();
  expect(host.text).toBe(original);
  await expect(page.locator('.omt-macro-args')).toBeVisible();
  await endOfField(argument(page, 1));
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('$\\norm{xy}+a$');
  expectCleanSource(host);
});

test('later parameter and macro positions follow preceding argument edits and a native prefix', async ({ page }) => {
  const { host } = await setup(page, '$\\pair[z]{w}+\\norm{x}$');
  await openMacro(page, 'pair');
  await replaceArgument(page, 1, 'uv');
  await replaceArgument(page, 2, 'pq');
  await host.flush();
  expect(host.text).toBe('$\\pair[uv]{pq}+\\norm{x}$');
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await host.flush();
  await reopenMacroIfNeeded(page, 'pair');
  await replaceArgument(page, 2, 't');
  await host.flush();
  expect(host.text).toBe('Native $\\pair[uv]{t}+\\norm{x}$');
  await page.locator('.omt-macro-close').click();
  await openMacro(page, 'norm');
  const at = host.text.indexOf('{x}') + 1;
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('Native $\\pair[uv]{t}+\\norm{y}$');
  expect(host.edits.at(-1)!.patches).toEqual([{ from: at, to: at + 1, expected: 'x', insert: 'y' }]);
  expectCleanSource(host);
});

test('a nested call remains reachable after an earlier optional argument changes length', async ({ page }) => {
  const { host } = await setup(page, '$\\pair[z]{\\ket{x}}+a$');
  await openMacro(page, 'pair');
  await replaceArgument(page, 1, 'zz');
  await host.flush();
  expect(host.text).toBe('$\\pair[zz]{\\ket{x}}+a$');
  await page.locator('.omt-macro-arg[data-index="2"] .omt-macro-edit').filter({ hasText: '\\ket' }).click();
  await replaceArgument(page, 1, 'y');
  await host.flush();
  expect(host.text).toBe('$\\pair[zz]{\\ket{y}}+a$');
  expect(host.edits.at(-1)!.patches).toEqual([{ from: 16, to: 17, expected: 'x', insert: 'y' }]);
  expectCleanSource(host);
});

test('keyboard deletion of an island preserves its surrounding source whitespace', async ({ page }) => {
  const original = '$ a + \\dup  { x } + b $';
  const { host } = await setup(page, original);
  await page.locator('.omt-live math-field').evaluate(element => {
    const field = element as TestMathField;
    for (let to = 1; to <= field.lastOffset; to++) {
      const token = field.getElementInfo(to)?.latex;
      if (!/^\\OMT[a-z]+$/.test(token ?? '')) { continue; }
      for (let from = 0; from < to; from++) {
        if (field.getValue(from, to, 'latex-without-placeholders') === token) {
          field.selection = { ranges: [[from, to]] }; field.focus(); return;
        }
      }
    }
    throw new Error('Could not select the macro island between the surrounding atoms');
  });
  await expect(page.locator('.omt-live math-field')).toBeFocused();
  await page.keyboard.press('Backspace');
  await host.flush();
  expect(host.text).toBe('$ a +  + b $');
  expect(host.edits.flatMap(edit => edit.patches)).toEqual([{ from: 6, to: 17, expected: '\\dup  { x }', insert: '' }]);
  expectCleanSource(host);
});

for (const remove of ['formula', 'closing delimiter']) {
  test(`a foreign removal of the ${remove} cancels a parameter completion safely`, async ({ page }) => {
    const original = '$\\norm{x}+a$';
    const { host, errors } = await setup(page, original, {
      completionDelay: 250,
      completion: (request, host) => ({ items: [fraction(request, host)] }),
    });
    await openMacro(page, 'norm');
    await endOfField(argument(page, 1));
    await prefix(page, 'fr');
    await expect.poll(() => host.requests.length).toBeGreaterThan(0);
    await host.flush();
    await host.remote([{ from: remove === 'formula' ? 0 : host.text.length - 1, to: host.text.length, insert: '' }]);
    await host.flush();
    await page.waitForTimeout(350);
    expect(host.text).toBe(remove === 'formula' ? '' : original.slice(0, -1));
    await expect(page.locator('.omt-macro-args')).toHaveCount(0);
    await expect(page.locator('math-field.omt-math-command')).toHaveCount(0);
    await expect(page.locator('.omt-live')).toHaveCount(0);
    await expect(page.locator('.omt-completion')).toBeHidden();
    expectCleanSource(host);
    expect(errors).toEqual([]);
  });
}
