import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import nodePath from 'node:path';
import { MockHost } from './host.ts';
import type { TextMateGrammar } from '../../src/shared/types.ts';

const fixtures = nodePath.resolve('test/fixtures/textmate');
const grammars: TextMateGrammar[] = ['LaTeX', 'TeX'].map((name, index) => ({
  scopeName: index ? 'text.tex' : 'text.tex.latex', format: 'json',
  content: fs.readFileSync(nodePath.join(fixtures, `${name}.tmLanguage.json`), 'utf8'),
}));
const tokens = { grammars, tokenColors: JSON.parse(fs.readFileSync(nodePath.join(fixtures, 'ayu-dark-tokenColors.json'), 'utf8')) };

async function scrollLastLineToTop(page: Page) {
  await expect.poll(() => page.locator('.cm-scroller').evaluate(scroller => {
    scroller.scrollTop = scroller.scrollHeight;
    const lastLine = scroller.querySelector('.cm-line:last-child')!;
    return lastLine.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  })).toBeLessThanOrEqual(6);
  expect(await page.locator('.cm-scroller').evaluate(scroller => scroller.scrollTop)).toBeGreaterThan(0);
}

test('the last line scrolls to the top in visual/source modes and after resizing without edits', async ({ page }) => {
  const source = 'First $x+y$.\nMiddle line.\nLast line.';
  const host = new MockHost(page, source);
  await host.open();
  await expect(page.locator('.omt-formula')).toHaveCount(1);
  await scrollLastLineToTop(page);

  await host.toggleSource();
  await expect(page.locator('.omt-formula')).toHaveCount(0);
  await scrollLastLineToTop(page);
  await page.setViewportSize({ width: 900, height: 450 });
  await scrollLastLineToTop(page);
  await page.setViewportSize({ width: 900, height: 900 });
  await scrollLastLineToTop(page);

  await host.flush();
  expect(host.text).toBe(source);
  expect(host.edits).toEqual([]);
});

async function formulaScrollSample(page: Page, label: string) {
  return page.locator('.omt-formula').evaluate(async (formula, label) => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const scroller = document.querySelector('.cm-scroller')!;
    const rect = formula.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
    const field = formula.querySelector('math-field') as HTMLElement & { position: number; getElementInfo(offset: number): { bounds?: { top: number; bottom: number } } } | null;
    const caret = field?.getElementInfo(field.position)?.bounds;
    return { label, scrollTop: scroller.scrollTop, top: rect.top - viewport.top, bottom: rect.bottom - viewport.top,
      caretTop: caret && caret.top - viewport.top, caretBottom: caret && caret.bottom - viewport.top };
  }, label);
}

for (const [mode, formula] of [['inline', 'Formula $a$.'], ['display', '\\[a\\]']] as const) {
  test(`${mode} formula typing keeps a visible formula at the same scroll position`, async ({ page }) => {
    const before = Array.from({ length: mode === 'inline' ? 159 : 60 }, (_, i) => `Before line ${i}.`).join('\n');
    const tail = mode === 'inline' ? '' : '\nLast line.';
    const source = `${before}\n${formula}${tail}`;
    const host = new MockHost(page, source, [], { settings: { tokens } });
    await host.open();
    await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', 'textmate');
    await page.locator('.cm-scroller').evaluate((scroller, mode) => {
      scroller.scrollTop = mode === 'inline' ? scroller.scrollHeight : 900;
    }, mode);
    const rendered = page.locator('.omt-formula');
    await expect(rendered).toHaveCount(1);
    if (mode === 'inline') {
      await rendered.evaluate(formula => {
        const scroller = formula.closest('.cm-scroller')!;
        scroller.scrollTop += formula.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 364;
      });
    }
    const samples = [await formulaScrollSample(page, 'before click')];
    await rendered.click();
    const field = page.locator('.omt-live math-field');
    await expect(field).toBeFocused();
    samples.push(await formulaScrollSample(page, 'after click'));
    await page.keyboard.press('Meta+ArrowRight');
    samples.push(await formulaScrollSample(page, 'after caret to end'));
    const baseline = samples.at(-1)!;
    expect(baseline.top).toBeGreaterThan(250);
    expect(baseline.bottom).toBeLessThan(600);
    await field.evaluate(element => {
      const inspected = element as HTMLElement & { nativeScrollIntoViewCalls: number };
      inspected.nativeScrollIntoViewCalls = 0;
      const native = inspected.scrollIntoView.bind(inspected);
      inspected.scrollIntoView = options => { inspected.nativeScrollIntoViewCalls++; native(options); };
    });
    for (const key of mode === 'inline' ? Array(7).fill('a') : ['b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      await page.keyboard.type(key);
      samples.push(await formulaScrollSample(page, `after ${key}`));
      await expect(field).toBeFocused();
    }
    await host.flush();
    expect(host.text).toBe(`${before}\n${mode === 'inline' ? 'Formula $aaaaaaaa$.' : '\\[abcdefgh\\]'}${tail}`);
    expect(await field.evaluate(element => (element as HTMLElement & { nativeScrollIntoViewCalls: number }).nativeScrollIntoViewCalls), 'visible math input must not reveal the whole host on every key').toBe(0);
    for (const sample of samples.slice(3)) {
      expect(Math.abs(sample.scrollTop - baseline.scrollTop), `${sample.label} must preserve editor scrollTop`).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.top - baseline.top), `${sample.label} must preserve the visible formula position`).toBeLessThanOrEqual(1);
    }
    if (mode === 'inline') {
      await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop -= 400; });
      const outside = await formulaScrollSample(page, 'caret below viewport');
      expect(outside.top).toBeGreaterThan(700);
      await page.keyboard.type('i');
      // MathLive's cached atom bounds refresh after the scroller has moved.
      await expect.poll(async () => {
        const sample = await formulaScrollSample(page, 'caret geometry settled');
        return sample.caretTop !== undefined && sample.caretBottom !== undefined
          && sample.caretTop >= sample.top && sample.caretBottom <= sample.bottom;
      }).toBe(true);
      const revealed = await formulaScrollSample(page, 'caret revealed by input');
      expect(revealed.scrollTop).toBeGreaterThan(outside.scrollTop);
      expect(revealed.scrollTop - outside.scrollTop).toBeLessThanOrEqual(outside.bottom - 700 + 2);
      expect(revealed.caretTop).toBeGreaterThan(650);
      expect(revealed.caretBottom).toBeLessThanOrEqual(701);
      await host.flush();
      expect(host.text).toBe(`${before}\nFormula $aaaaaaaai$.`);
    }
  });
}

test('typing into a visible caret preserves scrolling when a tall formula extends below the viewport', async ({ page }) => {
  const before = Array.from({ length: 60 }, (_, i) => `Before line ${i}.`).join('\n');
  const rows = Array.from({ length: 24 }, () => '\\frac{a}{b}').join(' \\\\\n');
  const formula = `\\[\\begin{matrix}\n${rows}\n\\end{matrix}\\]`;
  const host = new MockHost(page, `${before}\n${formula}\nLast line.`, [], { settings: { tokens } });
  await host.open();
  await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = 900; });
  const rendered = page.locator('.omt-formula');
  await expect(rendered).toHaveCount(1);
  const box = await rendered.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, 450);
  const field = page.locator('.omt-live math-field');
  await expect(field).toBeFocused();
  await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = 900; });
  await field.evaluate(element => {
    const field = element as HTMLElement & { position: number; getOffsetFromPoint(x: number, y: number, options: { bias: number }): number };
    const rect = field.getBoundingClientRect();
    field.position = field.getOffsetFromPoint(rect.left + rect.width / 2, 450, { bias: 0 });
  });
  const samples = [await formulaScrollSample(page, 'visible caret baseline')];
  expect(samples[0]!.bottom).toBeGreaterThan(700);
  expect(samples[0]!.caretTop).toBeGreaterThan(0);
  expect(samples[0]!.caretBottom).toBeLessThan(700);
  for (const key of ['b', 'c', 'd', 'e']) {
    await page.keyboard.type(key);
    samples.push(await formulaScrollSample(page, `after ${key}`));
  }
  await host.flush();
  expect(host.text).toContain('bcde');
  expect(host.text.startsWith(before + '\n')).toBe(true);
  expect(host.text.endsWith('\nLast line.')).toBe(true);
  for (const sample of samples.slice(1)) {
    expect(Math.abs(sample.scrollTop - samples[0]!.scrollTop), `${sample.label} must preserve the editor scrollTop while the caret is visible`).toBeLessThanOrEqual(1);
    expect(Math.abs(sample.top - samples[0]!.top), `${sample.label} must preserve the visible formula position`).toBeLessThanOrEqual(1);
  }
});

for (const [mode, open, close] of [['inline', '$', '$'], ['display', '\\[', '\\]']] as const) {
  test(`${mode} macro arguments keep the formula position through consecutive input and deletion`, async ({ page }) => {
    const before = Array.from({ length: 159 }, (_, i) => `第 ${i + 1} 行正文：${'含参数宏编辑时保留当前位置，公式源码保持一致。'.repeat(5)}`).join('\n');
    const source = `${before}\n${open}a+\\dup{x}+b${close}`;
    const host = new MockHost(page, source, [{ name: 'dup', arity: 1, body: '#1+#1' }], { settings: { tokens } });
    await host.open();
    await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = scroller.scrollHeight; });
    const rendered = page.locator('.omt-formula');
    await expect(rendered).toHaveCount(1);
    await rendered.evaluate(formula => {
      const scroller = formula.closest('.cm-scroller')!;
      scroller.scrollTop += formula.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 364;
    });
    await rendered.click();
    if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
    await expect(page.locator('.omt-live math-field')).toBeFocused();
    await page.locator('.omt-macro-edit').filter({ hasText: '\\dup' }).click();
    const field = page.locator('.omt-macro-arg math-field');
    await expect(field).toBeFocused();
    await page.keyboard.press('Meta+ArrowRight');
    const baseline = await formulaScrollSample(page, 'argument baseline');
    const samples = [];
    for (const key of ['c', 'd', 'e', 'f', 'Backspace', 'Backspace', 'g']) {
      if (key === 'Backspace') { await page.keyboard.press(key); }
      else { await page.keyboard.type(key); }
      samples.push(await formulaScrollSample(page, `argument ${key}`));
      await expect(field).toBeFocused();
    }
    await host.flush();
    expect(host.text).toBe(`${before}\n${open}a+\\dup{xcdg}+b${close}`);
    for (const sample of samples) {
      expect(Math.abs(sample.scrollTop - baseline.scrollTop), `${sample.label}: ${JSON.stringify({ baseline, sample })}`).toBeLessThanOrEqual(1);
      expect(Math.abs(sample.top - baseline.top), `${sample.label} keeps the formula position`).toBeLessThanOrEqual(1);
    }
    await page.locator('.omt-macro-close').click();
    const main = page.locator('.omt-live math-field');
    await expect(main).toBeFocused();
    await main.evaluate(element => {
      const field = element as HTMLElement & {
        lastOffset: number; selection: { ranges: [number, number][] };
        getElementInfo(offset: number): { latex?: string } | undefined;
        getValue(from: number, to: number, format: string): string;
      };
      for (let to = 1; to <= field.lastOffset; to++) {
        const token = field.getElementInfo(to)?.latex;
        if (!/^\\OMT[a-z]+$/.test(token ?? '')) { continue; }
        for (let from = 0; from < to; from++) {
          if (field.getValue(from, to, 'latex-without-placeholders') === token) {
            field.selection = { ranges: [[from, to]] }; return;
          }
        }
      }
      throw new Error('Could not select the source-owned macro');
    });
    const beforeDelete = await formulaScrollSample(page, 'macro selected');
    await page.keyboard.press('Backspace');
    const afterDelete = await formulaScrollSample(page, 'macro deleted');
    await expect(main).toBeFocused();
    await host.flush();
    expect(host.text).toBe(`${before}\n${open}a++b${close}`);
    expect(Math.abs(afterDelete.scrollTop - beforeDelete.scrollTop)).toBeLessThanOrEqual(1);
    expect(Math.abs(afterDelete.top - beforeDelete.top)).toBeLessThanOrEqual(1);
  });
}

for (const path of ['argument', 'command', 'delete'] as const) {
  const intents = path === 'argument' ? ['none', 'wheel', 'page'] as const : ['none', 'wheel'] as const;
  for (const intent of intents) {
    const userScroll = intent !== 'none';
    test(`${path} writeback ${userScroll ? `respects user ${intent === 'page' ? 'PageDown navigation' : 'scrolling'}` : 'restores the viewport'} during a controlled measurement displacement`, async ({ page }) => {
      const before = Array.from({ length: 159 }, (_, i) => `Before line ${i}.`).join('\n');
      const original = `${before}\n$\\dup{x}+a$`;
      const host = new MockHost(page, original, [{ name: 'dup', arity: 1, body: '#1+#1' }], { settings: { tokens } });
      await host.open();
      await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = scroller.scrollHeight; });
      const rendered = page.locator('.omt-formula');
      await expect(rendered).toHaveCount(1);
      await rendered.evaluate(formula => {
        const scroller = formula.closest('.cm-scroller')!;
        scroller.scrollTop += formula.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 364;
      });
      await rendered.click();
      if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
      let field = page.locator('.omt-live math-field');
      if (path !== 'command') {
        await page.locator('.omt-macro-edit').filter({ hasText: '\\dup' }).click();
        field = page.locator('.omt-macro-arg math-field');
      }
      await expect(field).toBeFocused();
      await page.keyboard.press('Meta+ArrowRight');
      if (path === 'command') { await page.keyboard.type('\\'); }
      const baseline = await formulaScrollSample(page, 'before controlled displacement');
      const trigger = path === 'delete' ? page.locator('.omt-macro-delete') : field;
      await trigger.evaluate((element, options) => {
        // Inject a viewport displacement after the source write but before the
        // next CodeMirror measure. This is a controlled fault, not a claim that
        // the standalone harness reproduced the user's SSH scrolling problem.
        element.addEventListener(options.event, () => {
          const scroller = document.querySelector('.cm-scroller')!;
          if (options.intent === 'wheel') { scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 64 })); }
          if (options.intent === 'page') { scroller.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'PageDown' })); }
          scroller.scrollTop += 64;
        }, { once: true });
      }, { intent, event: path === 'delete' ? 'click' : 'input' });
      if (path === 'delete') { await trigger.click(); field = page.locator('.omt-live math-field'); }
      else { await page.keyboard.type('y'); }
      const displaced = await formulaScrollSample(page, 'after controlled displacement');
      const evidence = test.info().outputPath('controlled-measurement-displacement.json');
      fs.mkdirSync(nodePath.dirname(evidence), { recursive: true });
      fs.writeFileSync(evidence, JSON.stringify({ path, intent, userScroll, injectedPixels: 64, baseline, displaced }, null, 2));
      await test.info().attach('controlled-measurement-displacement', {
        path: evidence, contentType: 'application/json',
      });
      expect(displaced.scrollTop - baseline.scrollTop).toBe(userScroll ? 64 : 0);
      expect(displaced.top - baseline.top).toBe(userScroll ? -64 : 0);
      await expect(field).toBeFocused();
      if (path === 'command') { await page.keyboard.press('Escape'); }
      await host.flush();
      expect(host.text).toBe(path === 'argument' ? `${before}\n$\\dup{xy}+a$` : path === 'delete' ? `${before}\n$+a$` : original);
    });
  }
}

test('deleting next to a tall parameter macro does not scroll its visible caret upward', async ({ page }) => {
  const before = Array.from({ length: 60 }, (_, i) => `Before line ${i}.`).join('\n');
  const rows = Array.from({ length: 10 }, () => '\\frac{#1}{b}').join(' \\\\\n');
  const host = new MockHost(page, `${before}\n\\[\\tall{x}+a\\]\nLast line.`, [{ name: 'tall', arity: 1, body: `\\begin{matrix}\n${rows}\n\\end{matrix}` }], { settings: { tokens } });
  await host.open();
  await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = 900; });
  const rendered = page.locator('.omt-formula');
  await expect(rendered).toHaveCount(1);
  const box = await rendered.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, 450);
  if (await page.locator('.omt-macro-args').count()) { await page.locator('.omt-macro-close').click(); }
  const field = page.locator('.omt-live math-field');
  await expect(field).toBeFocused();
  await page.keyboard.press('Meta+ArrowRight');
  await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = 900; });
  const baseline = await formulaScrollSample(page, 'tall macro baseline');
  const samples = [];
  for (const key of ['b', 'c', 'Backspace', 'Backspace', 'Backspace', 'Backspace', 'd']) {
    if (key === 'Backspace') { await page.keyboard.press(key); }
    else { await page.keyboard.type(key); }
    samples.push(await formulaScrollSample(page, `tall macro ${key}`));
    await expect(field).toBeFocused();
  }
  await host.flush();
  expect(host.text).toBe(`${before}\n\\[\\tall{x} d\\]\nLast line.`);
  for (const sample of samples) {
    expect(Math.abs(sample.scrollTop - baseline.scrollTop), `${sample.label}: ${JSON.stringify({ baseline, sample })}`).toBeLessThanOrEqual(1);
  }
});

for (const [mode, open, close] of [['inline', '$', '$'], ['display', '\\[', '\\]']] as const) {
  test(`${mode} parameter command insertion keeps the page position while completing and filling prompts`, async ({ page }) => {
    const before = Array.from({ length: 159 }, (_, i) => `第 ${i + 1} 行正文：${'含参数命令输入时保留当前位置，公式源码保持一致。'.repeat(5)}`).join('\n');
    const host = new MockHost(page, `${before}\n${open}a+${close}`, [], {
      settings: { tokens },
      completion: (request, host) => {
        const from = host.text.lastIndexOf('\\', request.at - 1) + 1;
        return { items: [{ i: 0, label: '\\frac', filterText: '\\frac', source: 'provider', insert: { snippet: true, value: 'frac{$1}{$2}$0' },
          range: { insFrom: from, insTo: request.at, repFrom: from, repTo: request.at } }] };
      },
    });
    await host.open();
    await page.locator('.cm-scroller').evaluate(scroller => { scroller.scrollTop = scroller.scrollHeight; });
    const rendered = page.locator('.omt-formula');
    await expect(rendered).toHaveCount(1);
    await rendered.evaluate(formula => {
      const scroller = formula.closest('.cm-scroller')!;
      scroller.scrollTop += formula.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 364;
    });
    await rendered.click();
    const field = page.locator('.omt-live math-field');
    await expect(field).toBeFocused();
    await page.keyboard.press('Meta+ArrowRight');
    const baseline = await formulaScrollSample(page, 'command baseline');
    const samples = [];
    for (const key of ['\\', 'f', 'r']) {
      await page.keyboard.type(key);
      samples.push(await formulaScrollSample(page, `command ${key}`));
    }
    await expect(page.locator('.omt-completion-item').filter({ hasText: '\\frac' }).first()).toBeVisible();
    await page.keyboard.press('Enter');
    samples.push(await formulaScrollSample(page, 'accepted fraction'));
    await expect(field).toBeFocused();
    for (const key of ['b', 'c', 'd', 'Tab', 'e', 'f', 'g', 'Backspace']) {
      if (key === 'Tab' || key === 'Backspace') { await page.keyboard.press(key); }
      else { await page.keyboard.type(key); }
      samples.push(await formulaScrollSample(page, `fraction ${key}`));
      await expect(field).toBeFocused();
    }
    await host.flush();
    expect(host.text).toBe(`${before}\n${open}a+\\frac{bcd}{ef}${close}`);
    for (const sample of samples) {
      expect(Math.abs(sample.scrollTop - baseline.scrollTop), `${sample.label}: ${JSON.stringify({ baseline, sample })}`).toBeLessThanOrEqual(1);
    }
    await page.keyboard.type('hijklmnop');
    const burst = await formulaScrollSample(page, 'rapid input');
    expect(Math.abs(burst.scrollTop - baseline.scrollTop)).toBeLessThanOrEqual(1);
    await expect(field).toBeFocused();
    await host.flush();
    expect(host.text).toBe(`${before}\n${open}a+\\frac{bcd}{efhijklmnop}${close}`);
  });
}
