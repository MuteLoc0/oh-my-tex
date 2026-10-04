import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snippetToMathTemplate } from '../../src/core/mathSnippet.ts';

test('math snippet: empty slots and the final cursor form a MathLive template', () => {
  assert.deepEqual(snippetToMathTemplate('\\frac{$1}{${2}}$0'), { latex: '\\frac{#?}{#?}' });
  assert.deepEqual(snippetToMathTemplate('x$0'), { latex: 'x' });
  assert.deepEqual(snippetToMathTemplate('${0:end}'), { latex: 'end' });
});

test('math snippet: defaults are editable prompts and the first prompt is selected', () => {
  assert.deepEqual(snippetToMathTemplate('\\frac{${1:a}}{${2:b}}$0', {}, 'insert-3'), {
    latex: '\\frac{\\placeholder[insert-3-1]{a}}{\\placeholder[insert-3-2]{b}}', firstPromptId: 'insert-3-1',
  });
  assert.deepEqual(snippetToMathTemplate('$1+${2:b}'), { latex: '#?+\\placeholder[omt-snippet-2]{b}' });
});

test('math snippet: forward mirrors and choices keep their shared initial value', () => {
  assert.deepEqual(snippetToMathTemplate('$2+${2|a\\,b,c\\|d|}'), {
    latex: '\\placeholder[omt-snippet-1]{a,b}+\\placeholder[omt-snippet-2]{a,b}', firstPromptId: 'omt-snippet-1',
  });
  assert.deepEqual(snippetToMathTemplate('${1:foo}+${1/(.*)/${1:/upcase}/}'), {
    latex: '\\placeholder[omt-snippet-1]{foo}+\\placeholder[omt-snippet-2]{foo}', firstPromptId: 'omt-snippet-1',
  });
});

test('math snippet: selected text stays an insertion argument and variables resolve normally', () => {
  assert.deepEqual(snippetToMathTemplate('\\sqrt{${TM_SELECTED_TEXT}}+$1', { TM_SELECTED_TEXT: 'x+y' }), { latex: '\\sqrt{#@}+#?' });
  assert.deepEqual(snippetToMathTemplate('$TM_FILENAME:${UNKNOWN:word}:${TM_SELECTED_TEXT:fallback}', { TM_FILENAME: 'main.tex' }), {
    latex: 'main.tex:word:#@',
  });
  assert.equal(snippetToMathTemplate('${UNKNOWN}:${TM_FILENAME/(.*)\\..+$/$1/}', { TM_FILENAME: 'main.tex' }).latex, 'UNKNOWN:main.tex');
});

test('math snippet: nested defaults and their mirrors retain all editable slots', () => {
  assert.deepEqual(snippetToMathTemplate('${1:a${2:b}}-$1'), {
    latex: '\\placeholder[omt-snippet-1]{a\\placeholder[omt-snippet-2]{b}}-\\placeholder[omt-snippet-3]{a\\placeholder[omt-snippet-4]{b}}',
    firstPromptId: 'omt-snippet-1',
  });
  assert.deepEqual(snippetToMathTemplate('${1:$2}${1:$2}'), {
    latex: '\\placeholder[omt-snippet-1]{#?}\\placeholder[omt-snippet-3]{#?}', firstPromptId: 'omt-snippet-1',
  });
  assert.deepEqual(snippetToMathTemplate('${1:x$1}'), {
    latex: '\\placeholder[omt-snippet-1]{x#?}', firstPromptId: 'omt-snippet-1',
  });
});

test('math snippet: escaped dollars, literal template hashes and malformed snippets stay literal', () => {
  assert.equal(snippetToMathTemplate('\\frac{${1:a}}{${2:b}} \\$x\\$ \\} \\\\').latex,
    '\\frac{\\placeholder[omt-snippet-1]{a}}{\\placeholder[omt-snippet-2]{b}} $x$ } \\');
  assert.equal(snippetToMathTemplate('#? #@ #1 \\# \\\\#?').latex, '\\#? \\#@ \\#1 \\# \\#?');
  for (const source of ['${1:open', '${x|a,b|}', '${1|a,b}', '${9999999999999999999999}', '$-']) {
    assert.equal(snippetToMathTemplate(source).latex, source);
  }
});

test('math snippet: prompt IDs are safe and selection sentinels cannot collide', () => {
  assert.deepEqual(snippetToMathTemplate('${1:x}', {}, 'bad]prefix{'), {
    latex: '\\placeholder[bad_prefix_-1]{x}', firstPromptId: 'bad_prefix_-1',
  });
  assert.equal(snippetToMathTemplate('\uE000omt-selected\uE001:${TM_SELECTED_TEXT}').latex, '\uE000omt-selected\uE001:#@');
  assert.equal(snippetToMathTemplate('${VALUE}:$TM_SELECTED_TEXT', { VALUE: '\uE000omt-selected\uE001' }).latex,
    '\uE000omt-selected\uE001:#@');
});
