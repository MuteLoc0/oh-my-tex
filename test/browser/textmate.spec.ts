import { test, expect, type Page, type Browser } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MockHost } from './host.ts';
import type { EditorTokens, TextMateGrammar, TextMateThemeRule } from '../../src/shared/types.ts';

const fixtures = path.resolve('test/fixtures/textmate');
const grammars: TextMateGrammar[] = [
  { scopeName: 'text.tex.latex', format: 'json', content: fs.readFileSync(path.join(fixtures, 'LaTeX.tmLanguage.json'), 'utf8') },
  { scopeName: 'text.tex', format: 'json', content: fs.readFileSync(path.join(fixtures, 'TeX.tmLanguage.json'), 'utf8') },
];
const tokenColors: TextMateThemeRule[] = JSON.parse(fs.readFileSync(path.join(fixtures, 'ayu-dark-tokenColors.json'), 'utf8'));
const nativeTokens = (overrides: Partial<EditorTokens> = {}): EditorTokens => ({
  grammars, tokenColors, command: '#f07178', comment: '#5a6673', bracket: '#bfbdb6', math: '#95e6cb',
  bracketPairs: { enabled: true, independentColorPoolPerBracketType: false }, ...overrides,
});
const ready = (page: Page, engine = 'textmate') => expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', engine);

interface CharacterStyle { char: string; color: string; italic: string; weight: string; decoration: string; rainbow: boolean }
/** Read actual painted characters, including marks split by nested decorations. */
const styles = (page: Page, needle: string): Promise<CharacterStyle[]> => page.evaluate(text => {
  for (const line of document.querySelectorAll('.cm-line')) {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    const chars: CharacterStyle[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement!;
      if (parent.closest('.omt-formula, .omt-live')) continue;
      const css = getComputedStyle(parent);
      for (const char of node.textContent ?? '') chars.push({ char, color: css.color, italic: css.fontStyle, weight: css.fontWeight, decoration: css.textDecorationLine,
        rainbow: !!parent.closest('[class*="omt-bracket-"]') });
    }
    const at = chars.map(char => char.char).join('').indexOf(text);
    if (at >= 0) return chars.slice(at, at + Array.from(text).length);
  }
  return [];
}, needle);
async function color(page: Page, needle: string, expected: string) {
  await expect.poll(async () => {
    const painted = await styles(page, needle);
    return painted.length === Array.from(needle).length && painted.every(char => char.color === expected);
  }, { message: `native color of ${needle}` }).toBe(true);
}
const editor = (page: Page) => page.evaluate(() => (window as unknown as { __omt: { text(): string; selection(): unknown } }).__omt.text());

test('Workshop scopes use the complete Ayu theme under the webview CSP', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const text = '\\section{Title}\n\\textit{Italic}\n%注释\n\\begin{equation}\n\\alpha+1\n\\end{equation}\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens() } });
  await host.open();
  await ready(page);
  await host.toggleSource();
  await color(page, '\\section', 'rgb(240, 113, 120)');
  await color(page, 'Title', 'rgb(89, 194, 255)');
  await color(page, '\\textit', 'rgb(240, 113, 120)');
  await color(page, '\\begin', 'rgb(240, 113, 120)');
  await color(page, 'equation', 'rgb(210, 166, 255)');
  await color(page, '\\alpha', 'rgb(149, 230, 203)');
  await color(page, '1', 'rgb(210, 166, 255)');
  await color(page, '%注释', 'rgb(90, 102, 115)');
  expect((await styles(page, '%注释')).every(char => char.italic === 'italic')).toBe(true);
  expect((await styles(page, 'Italic')).every(char => char.italic === 'italic')).toBe(true);
  fs.mkdirSync('out/p6.3', { recursive: true });
  await page.screenshot({ path: 'out/p6.3/textmate-ayu-source.png' });
  await host.flush();
  expect(host.text).toBe(text);
  expect(host.edits).toEqual([]);
  expect(errors).toEqual([]);
});

test('scope-specific font styles and the latest theme refresh preserve source and selection', async ({ page }) => {
  const text = '\\section{Title}\n% comment\nText $x+y$.\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens() } });
  await host.open();
  await ready(page);
  await page.evaluate(() => (window as unknown as { __omt: { setSelection(a: number, h: number): void } }).__omt.setSelection(2, 10));
  await host.updateSettings({ tokens: nativeTokens({ tokenColors: [...tokenColors,
    { scope: 'support.function.section.latex', settings: { foreground: '#123456', fontStyle: 'bold italic underline strikethrough' } },
  ] }) });
  await color(page, '\\section', 'rgb(18, 52, 86)');
  const painted = await styles(page, '\\section');
  expect(painted.every(char => char.italic === 'italic' && char.weight === '700' && char.decoration.includes('underline') && char.decoration.includes('line-through'))).toBe(true);
  // Queue two settings messages before the async engine can publish the first.
  await Promise.all([
    host.updateSettings({ tokens: nativeTokens({ tokenColors: [...tokenColors, { scope: 'support.function', settings: { foreground: '#ff0000' } }] }) }),
    host.updateSettings({ themeKind: 'light', tokens: nativeTokens({ tokenColors: [...tokenColors,
      { scope: 'support.function.section.latex', settings: { foreground: '#654321', fontStyle: '' } },
      { scope: 'meta.function.section entity.name.section', settings: { foreground: '#abcdef' } },
    ] }) }),
  ]);
  await color(page, '\\section', 'rgb(101, 67, 33)');
  await color(page, 'Title', 'rgb(171, 205, 239)');
  expect((await styles(page, '\\section')).every(char => char.italic === 'normal' && char.weight === '400' && char.decoration === 'none')).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: 2, head: 10 });
  expect(await editor(page)).toBe(text);
  await host.flush();
  expect(host.edits).toEqual([]);
});

test('bracket colors use depth, independent type pools, comments and escapes, and can be disabled', async ({ page }) => {
  const text = 'escaped \\{literal\\} % ([{\n([{}])\n{after}\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens() } });
  await host.open();
  await ready(page);
  await page.evaluate(() => {
    ['#ff0000', '#00ff00', '#0000ff', '#ff00ff', '#00ffff', '#ffff00'].forEach((value, i) =>
      document.documentElement.style.setProperty(`--vscode-editorBracketHighlight-foreground${i + 1}`, value));
  });
  await expect.poll(async () => (await styles(page, '([{}])')).map(char => char.color)).toEqual([
    'rgb(255, 0, 0)', 'rgb(0, 255, 0)', 'rgb(0, 0, 255)', 'rgb(0, 0, 255)', 'rgb(0, 255, 0)', 'rgb(255, 0, 0)',
  ]);
  await color(page, '% ([{', 'rgb(90, 102, 115)');
  const escaped = await styles(page, '\\{literal\\}');
  expect(escaped.filter(char => char.char === '{' || char.char === '}').every(char => !['rgb(255, 0, 0)', 'rgb(0, 255, 0)', 'rgb(0, 0, 255)'].includes(char.color))).toBe(true);
  expect((await styles(page, '{after}')).filter(char => '{}'.includes(char.char)).map(char => char.color)).toEqual(['rgb(255, 0, 0)', 'rgb(255, 0, 0)']);
  await host.updateSettings({ tokens: nativeTokens({ bracketPairs: { enabled: true, independentColorPoolPerBracketType: true } }) });
  await color(page, '([{}])', 'rgb(255, 0, 0)');
  await host.updateSettings({ tokens: nativeTokens({ bracketPairs: { enabled: false, independentColorPoolPerBracketType: false } }) });
  await color(page, '([{}])', 'rgb(191, 189, 182)');
  await host.flush();
  expect(host.text).toBe(text);
  expect(host.edits).toEqual([]);
});

test('comment environments and conditional comments do not change the bracket depth', async ({ page }) => {
  const text = '\\begin{comment}\n{[ignored(\n\\end{comment}\n{a}\n\\iffalse\n[[hidden((\n\\fi\n{b}\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens() } });
  await host.open();
  await ready(page);
  await page.evaluate(() => document.documentElement.style.setProperty('--vscode-editorBracketHighlight-foreground1', '#ff0000'));
  await expect.poll(async () => (await styles(page, '{[ignored(')).map(char => char.rainbow)).toEqual(Array(10).fill(false));
  await expect.poll(async () => (await styles(page, '[[hidden((')).map(char => char.rainbow)).toEqual(Array(10).fill(false));
  for (const text of ['{a}', '{b}']) {
    await expect.poll(async () => (await styles(page, text)).filter(char => '{}'.includes(char.char)).map(char => char.color)).toEqual(['rgb(255, 0, 0)', 'rgb(255, 0, 0)']);
  }
  await host.flush();
  expect(host.edits).toEqual([]);
});

for (const reason of ['missing Workshop', 'wasm fetch failure', 'invalid grammar JSON', 'invalid grammar regex'] as const) {
  test(`stex fallback remains editable after ${reason}`, async ({ page }) => {
    if (reason === 'wasm fetch failure') await page.route('**/onig.wasm', route => route.abort('failed'));
    const broken = reason === 'invalid grammar JSON' ? '{not JSON' : JSON.stringify({ scopeName: 'text.tex.latex', patterns: [{ match: '[', name: 'support.function' }] });
    const tokens = nativeTokens({ command: '#123456', comment: '#654321',
      grammars: reason === 'missing Workshop' ? undefined : reason.startsWith('invalid grammar') ? [{ scopeName: 'text.tex.latex', format: 'json', content: broken }] : grammars,
    });
    const host = new MockHost(page, '\\section{Title}\n% fallback\n', [], { settings: { tokens } });
    await host.open();
    await ready(page, 'fallback');
    await color(page, '\\section', 'rgb(18, 52, 86)');
    await color(page, '% fallback', 'rgb(101, 67, 33)');
    await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));
    await page.keyboard.type('z');
    await host.flush();
    expect(host.text).toBe('z\\section{Title}\n% fallback\n');
  });
}

test('switching from a failed grammar to Workshop and back activates the correct engine', async ({ page }) => {
  const broken = nativeTokens({ command: '#123456', grammars: [{ scopeName: 'text.tex.latex', format: 'json', content: '{broken' }] });
  const host = new MockHost(page, '\\section{Title}\n', [], { settings: { tokens: broken } });
  await host.open();
  await ready(page, 'fallback');
  await host.updateSettings({ tokens: nativeTokens() });
  await ready(page);
  await color(page, '\\section', 'rgb(240, 113, 120)');
  await host.updateSettings({ tokens: broken });
  await ready(page, 'fallback');
  await color(page, '\\section', 'rgb(18, 52, 86)');
  await host.flush();
  expect(host.text).toBe('\\section{Title}\n');
  expect(host.edits).toEqual([]);
});

test('formula replacement keeps grammar state continuous and sourceOnly formulas are colored', async ({ page }) => {
  const text = 'Text $\\alpha+1$.\n\\begin{equation}\n\\gamma+2\n\\end{equation}\n\\section{After}\n$\\beta % comment\n+3$\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens() } });
  await host.open();
  await ready(page);
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  await color(page, '\\section', 'rgb(240, 113, 120)');
  await color(page, 'After', 'rgb(89, 194, 255)');
  await color(page, '\\beta', 'rgb(149, 230, 203)');
  fs.mkdirSync('out/p6.3', { recursive: true });
  await page.screenshot({ path: 'out/p6.3/textmate-ayu-visual.png' });
  await host.toggleSource();
  await expect(page.locator('.omt-formula')).toHaveCount(0);
  await color(page, '\\alpha', 'rgb(149, 230, 203)');
  await color(page, '\\gamma', 'rgb(149, 230, 203)');
  await host.toggleSource();
  await expect(page.locator('.omt-formula')).toHaveCount(2);
  await color(page, '\\section', 'rgb(240, 113, 120)');
  await host.flush();
  expect(host.text).toBe(text);
  expect(host.edits).toEqual([]);
});

test('edits before a distant viewport invalidate multiline grammar state without losing input', async ({ page }) => {
  const prefix = '\\begin{equation}\n';
  const text = prefix + Array.from({ length: 2500 }, (_, i) => `x+${i} % line ${i}`).join('\n') + '\n\\section{Tail}\n';
  const host = new MockHost(page, text, [], { settings: { tokens: nativeTokens(), wordWrap: false } });
  await host.open();
  await ready(page);
  await host.toggleSource();
  await page.locator('.cm-scroller').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await color(page, '\\section', 'rgb(149, 230, 203)');
  await host.remote([{ from: 0, to: prefix.length, insert: '' }]);
  await color(page, '\\section', 'rgb(240, 113, 120)');
  await color(page, 'Tail', 'rgb(89, 194, 255)');
  await host.remote([{ from: 0, to: 0, insert: prefix }]);
  await color(page, '\\section', 'rgb(149, 230, 203)');
  expect(await editor(page)).toBe(text);
  await page.evaluate(pos => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(pos), text.length);
  await page.keyboard.type('z');
  await host.flush();
  expect(host.text).toBe(text + 'z');
});

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function interactiveTime(browser: Browser, text: string, tokens: EditorTokens) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  try {
    const host = new MockHost(page, text, [], { settings: { tokens } });
    const start = performance.now();
    await host.open();
    await ready(page, tokens.grammars ? 'textmate' : 'fallback');
    const elapsed = performance.now() - start;
    await page.evaluate(() => (window as unknown as { __omt: { setCaret(p: number): void } }).__omt.setCaret(0));
    const inputStart = performance.now();
    await page.keyboard.type('z');
    await expect.poll(() => editor(page)).toBe('z' + text);
    const inputElapsed = performance.now() - inputStart;
    await host.flush();
    expect(host.text).toBe('z' + text);
    return { elapsed, inputElapsed };
  } finally { await context.close(); }
}

test('2000 formulas keep first-screen latency near fallback and remain editable during tokenization', async ({ browser }) => {
  const text = Array.from({ length: 2000 }, (_, i) => `Line ${i}: $x_{${i}}^2 + \\frac{a}{b}$ text.`).join('\n');
  const fallback: number[] = [], textmate: number[] = [], input: number[] = [];
  // Alternate engines to avoid attributing browser warmup to either engine.
  for (let i = 0; i < 3; i++) {
    for (const native of i % 2 ? [true, false] : [false, true]) {
      const measured = await interactiveTime(browser, text, native ? nativeTokens() : nativeTokens({ grammars: undefined }));
      (native ? textmate : fallback).push(measured.elapsed);
      if (native) input.push(measured.inputElapsed);
    }
  }
  console.log(`2000 formulas: fallback median ${median(fallback).toFixed(1)} ms; TextMate ${median(textmate).toFixed(1)} ms; input ${median(input).toFixed(1)} ms`);
  expect(median(textmate) - median(fallback)).toBeLessThan(100);
  expect(median(input)).toBeLessThan(150);
});
