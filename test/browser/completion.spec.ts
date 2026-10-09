import { test, expect, type Page } from '@playwright/test';
import type { CompletionItemDTO } from '../../src/shared/protocol.ts';
import { MockHost, type MockHostOptions } from './host.ts';
import { projectMacroSnippet } from '../../src/core/macroCompletion.ts';

/** A provider item whose offsets use the same LF document coordinates as the real bridge. */
function item(label: string, value: string, from: number, to: number, options: Partial<CompletionItemDTO> = {}): CompletionItemDTO {
  return {
    i: 0, label, filterText: label, insert: { snippet: false, value },
    range: { insFrom: from, insTo: to, repFrom: from, repTo: to }, ...options,
  };
}

interface EditorHooks {
  setCaret(position: number): void;
  setSelection(anchor: number, head: number): void;
  caret(): number;
  selection(): { anchor: number; head: number };
  text(): string;
}
const editorText = (page: Page) => page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.text());
const editorCaret = (page: Page) => page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.caret());

async function setup(page: Page, text: string, options: MockHostOptions) {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  const host = new MockHost(page, text, [], options);
  await host.open();
  await page.evaluate(position => (window as unknown as { __omt: EditorHooks }).__omt.setCaret(position), text.length);
  return { host, errors };
}

async function invoke(page: Page) {
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.omt-completion')).toBeVisible();
}

async function expectSelection(page: Page, value: string) {
  await expect.poll(() => page.evaluate(() => {
    const editor = (window as unknown as { __omt: EditorHooks }).__omt;
    const { anchor, head } = editor.selection();
    return editor.text().slice(Math.min(anchor, head), Math.max(anchor, head));
  })).toBe(value);
}

test('Workshop usepackage snippet flushes before querying and retriggers the package list', async ({ page }) => {
  const { host, errors } = await setup(page, '', {
    completion: (request, host) => {
      if (host.text.endsWith('\\usepackage{')) {
        return { items: [item('amsmath', 'amsmath', request.at, request.at)] };
      }
      if (host.text.endsWith('\\usepackage{}') && request.at === host.text.length - 1) {
        return { items: [item('amsmath', 'amsmath', request.at, request.at)] };
      }
      return { items: [item('\\usepackage', 'usepackage{$1}', 1, request.at, {
        insert: { snippet: true, value: 'usepackage{$1}' }, command: 'triggerSuggest',
      })] };
    },
  });
  await page.keyboard.type('\\use');
  await expect(page.locator('.omt-completion-item')).toContainText('\\usepackage');
  expect(host.completionDocuments[0]).toEqual({ text: '\\use', version: host.requests[0]!.version });
  await page.keyboard.press('Enter');
  await expect.poll(() => host.text).toBe('\\usepackage{}');
  await expect(page.locator('.omt-completion-item')).toContainText('amsmath');
  expect(await editorCaret(page)).toBe('\\usepackage{'.length);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\usepackage{amsmath}');
  await page.keyboard.press('Tab');
  expect(await editorCaret(page)).toBe(host.text.length);
  expect(host.requests).toHaveLength(2);
  expect(host.requests[1]!.trigger.kind).toBe('invoke');
  expect(errors).toEqual([]);
});

test('user snippets and document words are selectable alongside provider items', async ({ page }) => {
  const { host } = await setup(page, 'word worm\nwo', {
    completion: request => ({ items: [
      item('word', 'word', 10, request.at, { i: 0, kind: 1 }),
      item('work snippet', 'work{$1}', 10, request.at, { i: 1, kind: 15, filterText: 'work', insert: { snippet: true, value: 'work{$1}' } }),
    ] }),
  });
  await invoke(page);
  await expect(page.locator('.omt-completion-item')).toHaveCount(2);
  await expect(page.locator('.omt-completion-item')).toContainText(['word', 'work snippet']);
  await page.locator('.omt-completion-item').filter({ hasText: 'work snippet' }).click();
  await host.flush();
  expect(host.text).toBe('word worm\nwork{}');
});

test('snippet Tab, Shift-Tab, choices, mirrors and filename variables cooperate', async ({ page }) => {
  const snippet = 'demo{${1:foo}}{$1}{${2|one,two|}}{${TM_FILENAME_BASE}}$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'foo');
  await page.keyboard.type('bar');
  await expect.poll(() => editorText(page)).toBe('\\demo{bar}{bar}{one}{t}');
  await page.keyboard.press('Tab');
  await expectSelection(page, 'one');
  await page.keyboard.press('Alt+ArrowDown');
  await expectSelection(page, 'two');
  await page.keyboard.press('Shift+Tab');
  await expectSelection(page, 'bar');
  await page.keyboard.type('x');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('\\demo{x}{x}{two}{t}');
  expect(await editorCaret(page)).toBe(host.text.length);
});

test('Escape ends a snippet so subsequent edits do not update its mirrors', async ({ page }) => {
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', 'demo{${1:x}}{$1}$0', 1, request.at, {
      insert: { snippet: true, value: 'demo{${1:x}}{$1}$0' },
    })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'x');
  await page.keyboard.press('Escape');
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('\\demo{y}{x}');
});

test('editing a nested snippet placeholder updates the enclosing mirror', async ({ page }) => {
  const snippet = 'demo{${1:outer ${2:inner}}}/{$1}/${3:end}$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'outer inner');
  await page.keyboard.press('Tab');
  await expectSelection(page, 'inner');
  await page.keyboard.type('inside');
  await host.flush();
  expect(host.text).toBe('\\demo{outer inside}/{outer inside}/end');
  await page.keyboard.press('Tab');
  await expectSelection(page, 'end');
});

test('replacing a parent snippet placeholder removes its child tabstops', async ({ page }) => {
  const snippet = 'demo{${1:outer ${2:inner}}}/{$1}/${3:end}$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'outer inner');
  await page.keyboard.type('replacement');
  await page.keyboard.press('Tab');
  await expectSelection(page, 'end');
  await host.flush();
  expect(host.text).toBe('\\demo{replacement}/{replacement}/end');
});

test('the final cursor after a snippet mirror stays at the end when its text grows', async ({ page }) => {
  const snippet = 'demo{${1:x}}/$1$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'x');
  await page.keyboard.type('longer');
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('\\demo{longer}/longer');
  expect(await editorCaret(page)).toBe(host.text.length);
});

test('adjacent empty snippet mirrors retain their own ranges while typing', async ({ page }) => {
  const snippet = 'demo$1$1$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('xy');
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('\\demoxyxy');
  expect(await editorCaret(page)).toBe(host.text.length);
});

test('an inactive empty tabstop at the edited placeholder end stays navigable', async ({ page }) => {
  const snippet = 'demo${1:x}$2$0';
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', snippet, 1, request.at, { insert: { snippet: true, value: snippet } })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('longer');
  await page.keyboard.press('Tab');
  await expectSelection(page, '');
  expect(await editorCaret(page)).toBe('\\demolonger'.length);
  await page.keyboard.type('y');
  await page.keyboard.press('Shift+Tab');
  await expectSelection(page, 'longer');
  await host.flush();
  expect(host.text).toBe('\\demolongery');
});

test('a snippet variable wraps the current selection and keeps it editable', async ({ page }) => {
  const snippet = '\\textbf{${1:${TM_SELECTED_TEXT}}}$0';
  const { host } = await setup(page, 'hello', {
    completion: request => ({ items: [item('Wrap selection', snippet, 0, request.at, {
      filterText: 'hello', insert: { snippet: true, value: snippet },
    })] }),
  });
  await page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.setSelection(0, 5));
  await invoke(page);
  await page.keyboard.press('Enter');
  await expectSelection(page, 'hello');
  await page.keyboard.type('world');
  await host.flush();
  expect(host.text).toBe('\\textbf{world}');
});

test('additionalTextEdits and the primary insertion are one document transaction', async ({ page }) => {
  const { host } = await setup(page, 'Header\n\\sec', {
    completion: request => ({ items: [item('\\section', 'section{${1:title}}$0', 8, request.at, {
      insert: { snippet: true, value: 'section{${1:title}}$0' },
      extraEdits: [{ from: 0, to: 6, insert: '% Header' }], command: 'host', i: 7,
    })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('% Header\n\\section{title}');
  expect(host.edits).toHaveLength(1);
  expect(host.edits[0]!.patches).toEqual([
    { from: 0, to: 6, expected: 'Header', insert: '% Header' },
    { from: 8, to: 11, expected: 'sec', insert: 'section{title}' },
  ]);
  await expectSelection(page, 'title');
  expect(host.commands).toEqual([{ t: 'runItemCommand', req: host.requests[0]!.req, item: 7 }]);
});

test('an additional edit adjacent to the main range preserves the snippet position', async ({ page }) => {
  const snippet = 'section{${1:title}}$0';
  const { host } = await setup(page, 'prefix\\sec', {
    completion: request => ({ items: [item('\\section', snippet, 7, request.at, {
      insert: { snippet: true, value: snippet }, extraEdits: [{ from: 0, to: 7, insert: 'New \\' }],
    })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('New \\section{title}');
  expect(host.edits).toHaveLength(1);
  await expectSelection(page, 'title');
  await page.keyboard.type('heading');
  await host.flush();
  expect(host.text).toBe('New \\section{heading}');
});

test('completion items with different replacement starts filter their own document prefix', async ({ page }) => {
  const { host } = await setup(page, 'ab', {
    completion: request => ({ items: [
      item('abacus', 'abacus', 0, request.at),
      item('beta', 'beta', 1, request.at, { i: 1 }),
    ] }),
  });
  await invoke(page);
  await expect(page.locator('.omt-completion-item')).toHaveCount(2);
  await page.locator('.omt-completion-item').filter({ hasText: 'beta' }).click();
  await host.flush();
  expect(host.text).toBe('abeta');
});

test('typing during an outstanding request filters its response and extends the replacement range', async ({ page }) => {
  const { host } = await setup(page, '\\s', {
    completionDelay: 250,
    completion: request => ({ items: [
      item('\\section', 'section', 1, request.at),
      item('\\sum', 'sum', 1, request.at, { i: 1 }),
    ] }),
  });
  await page.keyboard.press('Control+Space');
  await expect.poll(() => host.requests.length).toBe(1);
  await page.keyboard.type('ec');
  await expect(page.locator('.omt-completion-item')).toHaveCount(1);
  await expect(page.locator('.omt-completion-item')).toContainText('\\section');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\section');
  expect(host.requests).toHaveLength(1);
});

test('an incomplete list requests the provider again as its prefix grows', async ({ page }) => {
  const { host } = await setup(page, '\\s', {
    completion: (request, host) => ({
      items: [item('\\section', 'section', 1, request.at)], isIncomplete: host.requests.length === 1,
    }),
  });
  await invoke(page);
  await page.keyboard.type('ec');
  await expect.poll(() => host.requests.length).toBe(2);
  expect(host.requests[1]!.trigger.kind).toBe('incomplete');
  expect(host.completionDocuments[1]!.text).toBe('\\sec');
  await expect(page.locator('.omt-completion-item')).toContainText('\\section');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\section');
});

test('an incomplete refresh hides the previous list until new request indices arrive', async ({ page }) => {
  let respond: (() => void) | undefined;
  const { host } = await setup(page, '\\s', {
    completion: (request, host) => {
      if (host.requests.length === 1) {
        return { items: [item('old section', 'section', 1, request.at, { filterText: 'section' })], isIncomplete: true };
      }
      return new Promise(resolve => {
        respond = () => resolve({ items: [item('new section', 'section', 1, request.at, { i: 7, filterText: 'section', command: 'host' })] });
      });
    },
  });
  await invoke(page);
  await expect(page.locator('.omt-completion-item')).toContainText('old section');
  await page.keyboard.type('e');
  await expect.poll(() => host.requests.length).toBe(2);
  await expect(page.locator('.omt-completion')).toBeHidden();
  respond!();
  await expect(page.locator('.omt-completion-item')).toContainText('new section');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\section');
  expect(host.commands).toEqual([{ t: 'runItemCommand', req: host.requests[1]!.req, item: 7 }]);
});

test('a stale provider response is retried once, without an unbounded request loop', async ({ page }) => {
  const { host } = await setup(page, '\\s', {
    completion: request => ({ items: [item('\\section', 'section', 1, request.at)], version: request.version + 1, isIncomplete: true }),
  });
  await page.keyboard.press('Control+Space');
  await expect.poll(() => host.requests.length).toBe(2);
  await page.waitForTimeout(200);
  expect(host.requests).toHaveLength(2);
  expect(host.requests[1]!.trigger.kind).toBe('incomplete');
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(host.edits).toEqual([]);
  expect(host.text).toBe('\\s');
});

test('disabling quickSuggestions keeps automatic completion quiet and permits Ctrl-Space', async ({ page }) => {
  const { host } = await setup(page, '', {
    settings: { quickSuggestions: false, triggerCharacters: [] },
    completion: request => ({ items: [item('\\section', 'section', 1, request.at)] }),
  });
  await page.keyboard.type('\\sec');
  await page.waitForTimeout(200);
  expect(host.requests).toEqual([]);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await invoke(page);
  expect(host.requests[0]!.trigger.kind).toBe('invoke');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\section');
});

test('Workshop trigger characters still request completion when quickSuggestions is disabled', async ({ page }) => {
  const { host } = await setup(page, '', {
    settings: { quickSuggestions: false, triggerCharacters: ['\\'] },
    completion: request => ({ items: [item('\\section', 'section', 1, request.at)] }),
  });
  await page.keyboard.type('\\');
  await expect(page.locator('.omt-completion-item')).toContainText('\\section');
  expect(host.requests[0]!.trigger).toEqual({ kind: 'char', char: '\\' });
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\section');
});

test('quickSuggestionsInComments controls automatic completion in comments', async ({ page }) => {
  const { host } = await setup(page, '% ', {
    settings: { quickSuggestions: true, quickSuggestionsInComments: false, triggerCharacters: [] },
    completion: request => ({ items: [item('section', 'section', 2, request.at)] }),
  });
  await page.keyboard.type('sec');
  await page.waitForTimeout(200);
  expect(host.requests).toEqual([]);
  await expect(page.locator('.omt-completion')).toBeHidden();
  await host.updateSettings({ quickSuggestionsInComments: true });
  await page.keyboard.type('t');
  await expect(page.locator('.omt-completion-item')).toContainText('section');
  expect(host.requests[0]!.trigger.kind).toBe('invoke');
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('% section');
});

for (const suggestReplace of [false, true]) {
  test(`completion respects the ${suggestReplace ? 'replace' : 'insert'} range setting`, async ({ page }) => {
    const { host } = await setup(page, '\\sectionSuffix', {
      settings: { suggestReplace },
      completion: request => ({ items: [item('\\section', 'section', 1, request.at, {
        range: { insFrom: 1, insTo: request.at, repFrom: 1, repTo: '\\sectionSuffix'.length },
      })] }),
    });
    await page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.setCaret(4));
    await invoke(page);
    await page.keyboard.press('Enter');
    await host.flush();
    expect(host.text).toBe(suggestReplace ? '\\section' : '\\sectiontionSuffix');
  });
}

test('completion labels and details are rendered as text, including hostile HTML', async ({ page }) => {
  const label = '<img src=x onerror="window.__completionInjected=1">';
  const { host, errors } = await setup(page, 'x', {
    completion: request => ({ items: [item(label, 'safe', 0, request.at, {
      filterText: 'x', detail: '<svg onload="window.__completionInjected=2">', doc: '<script>bad()</script>',
    })] }),
  });
  await invoke(page);
  await expect(page.locator('.omt-completion-item')).toContainText(label);
  await expect(page.locator('.omt-completion img, .omt-completion svg, .omt-completion script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __completionInjected?: number }).__completionInjected)).toBeUndefined();
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('safe');
  expect(errors).toEqual([]);
});

test('a foreign document edit cancels an outstanding completion response', async ({ page }) => {
  const { host } = await setup(page, '\\s', {
    completionDelay: 250,
    completion: request => ({ items: [item('\\section', 'section', 1, request.at)] }),
  });
  await page.keyboard.press('Control+Space');
  await expect.poll(() => host.requests.length).toBe(1);
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await page.waitForTimeout(350);
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(await editorText(page)).toBe('Native \\s');
  await page.keyboard.type('ec');
  await host.flush();
  expect(host.text).toBe('Native \\sec');
});

test('a foreign edit ends a snippet and leaves its mirrored text intact', async ({ page }) => {
  const { host } = await setup(page, '\\demo', {
    completion: request => ({ items: [item('\\demo', 'demo{${1:x}}{$1}$0', 1, request.at, {
      insert: { snippet: true, value: 'demo{${1:x}}{$1}$0' },
    })] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await host.flush();
  await expectSelection(page, 'x');
  await host.remote([{ from: 0, to: 0, insert: 'Native ' }]);
  await page.keyboard.type('y');
  await host.flush();
  expect(host.text).toBe('Native \\demo{y}{x}');
});


test('Tab-only completion leaves Enter as a newline and accepts Tab after a live setting change', async ({ page }) => {
  const { host, errors } = await setup(page, '\\al', {
    settings: { completionAcceptOnEnter: undefined },
    completion: (request, host) => ({ items: [item('\\alpha', '\\alpha', host.text.lastIndexOf('\n') + 1, request.at)] }),
  });
  await invoke(page);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\al\n');
  await expect(page.locator('.omt-completion')).toBeHidden();
  await page.keyboard.type('\\al');
  await invoke(page);
  await page.keyboard.press('Tab');
  await host.flush();
  expect(host.text).toBe('\\al\n\\alpha');
  await host.updateSettings({ completionAcceptOnEnter: true });
  await invoke(page);
  await page.keyboard.press('Enter');
  await host.flush();
  expect(host.text).toBe('\\al\n\\alpha');
  await expect(page.locator('.omt-completion')).toBeHidden();
  expect(errors).toEqual([]);
});

for (const mode of ['visual', 'source']) {
  test(`indexed custom macros accept Tab and navigate arguments in ${mode} mode`, async ({ page }) => {
    const macros = [{ name: 'R', arity: 0, body: '\\mathbb{R}' }, { name: 'duo', arity: 2, body: '#1+#2' }];
    const { host, errors } = await setup(page, '$a$\n', {
      settings: { completionAcceptOnEnter: false },
      completion: (request, current) => {
        const from = current.text.lastIndexOf('\\', request.at - 1) + 1;
        return { items: macros.map((macro, i) => item(`\\${macro.name}`, projectMacroSnippet(macro, true), from, request.at, {
          i, filterText: macro.name, source: 'macro', insert: { snippet: true, value: projectMacroSnippet(macro, true) },
        })) };
      },
    });
    if (mode === 'source') { await host.toggleSource(); }
    await page.evaluate(() => (window as unknown as { __omt: EditorHooks }).__omt.setCaret(4));
    await page.keyboard.type('\\R');
    await invoke(page);
    await expect(page.locator('.omt-completion-item[aria-selected="true"] .omt-completion-label')).toHaveText('\\R');
    await page.keyboard.press('Tab');
    await host.flush();
    expect(host.text).toBe('$a$\n\\R');
    await expect(page.locator('.cm-content')).toBeFocused();

    await page.keyboard.press('Enter');
    await page.keyboard.type('\\du');
    await invoke(page);
    await page.keyboard.press('Tab');
    await page.keyboard.type('x');
    await page.keyboard.press('Tab');
    await page.keyboard.type('y');
    await page.keyboard.press('Tab');
    await host.flush();
    expect(host.text).toBe('$a$\n\\R\n\\duo{x}{y}');
    expect(await editorCaret(page)).toBe(host.text.length);
    expect(errors).toEqual([]);
  });
}
