import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { MockHost } from './host.ts';
import type { EditorTokens, TextMateGrammar } from '../../src/shared/types.ts';

const fixtures = path.resolve('test/fixtures/textmate');
const grammars: TextMateGrammar[] = ['LaTeX', 'TeX'].map((name, index) => ({
  scopeName: index ? 'text.tex' : 'text.tex.latex', format: 'json',
  content: fs.readFileSync(path.join(fixtures, `${name}.tmLanguage.json`), 'utf8'),
}));
const textmate: EditorTokens = { grammars, tokenColors: JSON.parse(fs.readFileSync(path.join(fixtures, 'ayu-dark-tokenColors.json'), 'utf8')) };

async function characterPoint(page: Page, lineNumber: number, offset: number) {
  return page.locator('.cm-line').nth(lineNumber).evaluate((line, at) => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const length = node.textContent?.length ?? 0;
      if (at <= length) {
        const range = document.createRange();
        range.setStart(node, at); range.setEnd(node, at);
        const rect = range.getBoundingClientRect();
        return { x: rect.left, y: (rect.top + rect.bottom) / 2 };
      }
      at -= length;
    }
    throw new Error(`No text position ${at}`);
  }, offset);
}

for (const syntax of ['fallback', 'textmate'] as const) {
  for (const mode of ['visual', 'source'] as const) {
    test(`${syntax} ${mode}: mouse dragging paints a single-line selection above the active line`, async ({ page }) => {
      const source = 'A test: Select     this.\nSecond line for selection.\nFormula $x+y$.\n';
      const host = new MockHost(page, source, [], { settings: { tokens: syntax === 'textmate' ? textmate : {} } });
      await host.open();
      await expect(page.locator('.cm-editor')).toHaveAttribute('data-omt-syntax', syntax);
      if (mode === 'source') await host.toggleSource();
      await expect(page.locator('.omt-formula')).toHaveCount(mode === 'visual' ? 1 : 0);
      // VS Code themes may use an opaque current-line color. It must not hide
      // drawSelection's layer, which CodeMirror places behind the text lines.
      await page.evaluate(() => {
        document.documentElement.style.setProperty('--vscode-editor-lineHighlightBackground', '#171b24');
        document.documentElement.style.setProperty('--vscode-editor-selectionBackground', '#1e66bf');
        (window as unknown as { __omt: { setCaret(pos: number): void } }).__omt.setCaret(8);
      });
      const start = await characterPoint(page, 0, 8), end = await characterPoint(page, 0, 22);
      const whitespace = await characterPoint(page, 0, 16);
      const clip = { x: Math.floor(whitespace.x + 2), y: Math.floor(whitespace.y), width: 1, height: 1 };
      await page.evaluate(point => {
        const swatch = document.createElement('div');
        swatch.id = 'selection-color-swatch';
        swatch.style.cssText = `position:fixed;z-index:10000;left:${point.x}px;top:${point.y}px;width:1px;height:1px;background:#1e66bf`;
        document.body.appendChild(swatch);
      }, clip);
      const expectedPixel = await page.screenshot({ clip });
      await page.locator('#selection-color-swatch').evaluate(element => element.remove());
      const before = await page.screenshot({ clip });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 12 });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: 8, head: 22 });
      await expect(page.locator('.cm-selectionBackground')).toHaveCount(1);
      // A pixel in selected whitespace proves the highlight is actually painted,
      // rather than only checking a background declaration hidden by a layer.
      const during = await page.screenshot({ clip });
      if (process.env.OMT_SELECTION_EVIDENCE) {
        fs.mkdirSync(process.env.OMT_SELECTION_EVIDENCE, { recursive: true });
        await page.screenshot({ path: path.join(process.env.OMT_SELECTION_EVIDENCE, `${syntax}-${mode}-selection.png`) });
        fs.writeFileSync(path.join(process.env.OMT_SELECTION_EVIDENCE, `${syntax}-${mode}-pixel-before.png`), before);
        fs.writeFileSync(path.join(process.env.OMT_SELECTION_EVIDENCE, `${syntax}-${mode}-pixel-during.png`), during);
        fs.writeFileSync(path.join(process.env.OMT_SELECTION_EVIDENCE, `${syntax}-${mode}-pixel-expected.png`), expectedPixel);
      }
      expect(during.equals(before), 'selected whitespace must visibly change color while dragging').toBe(false);
      expect(during, 'the visible pixel must match the configured selection color').toEqual(expectedPixel);
      await page.mouse.up();
      const after = await page.screenshot({ clip });
      expect(after.equals(during), 'selection remains visible after mouse release').toBe(true);
      for (const themeKind of ['light', 'hcDark', 'hcLight'] as const) {
        await host.updateSettings({ themeKind });
        expect(await page.screenshot({ clip }), `${themeKind} refresh preserves the visible selection`).toEqual(during);
        expect(await page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: 8, head: 22 });
      }
      await page.evaluate(() => (window as unknown as { __omt: { setCaret(pos: number): void } }).__omt.setCaret(8));
      expect(await page.screenshot({ clip }), 'collapsing the selection restores the active-line background').toEqual(before);
      const secondEnd = await characterPoint(page, 1, 18), secondWhitespace = await characterPoint(page, 1, 11);
      const secondClip = { x: Math.floor(secondWhitespace.x + 2), y: Math.floor(secondWhitespace.y), width: 1, height: 1 };
      const secondBefore = await page.screenshot({ clip: secondClip });
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(secondEnd.x, secondEnd.y, { steps: 12 });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __omt: { selection(): unknown } }).__omt.selection())).toEqual({ anchor: 8, head: source.indexOf('\n') + 19 });
      expect(await page.screenshot({ clip }), 'the first selected line remains highlighted').toEqual(during);
      const secondDuring = await page.screenshot({ clip: secondClip });
      expect(secondDuring.equals(secondBefore), 'the active end of a multiline selection is highlighted too').toBe(false);
      expect(secondDuring, 'the multiline head must have the configured selection color').toEqual(expectedPixel);
      await page.mouse.up();
      await host.flush();
      expect(host.text).toBe(source);
      expect(host.edits).toEqual([]);
    });
  }
}
