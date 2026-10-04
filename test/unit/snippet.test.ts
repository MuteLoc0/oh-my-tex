import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnippet } from '../../src/core/snippet.ts';

test('snippet: placeholders, mirrors and the final cursor have UTF-16 ranges', () => {
  assert.deepEqual(parseSnippet('𝔸${2:b}-$1-${1:a}-$2$0'), {
    text: '𝔸b-a-a-b', tabstops: [
      { index: 1, from: 4, to: 5 }, { index: 1, from: 6, to: 7 },
      { index: 2, from: 2, to: 3 }, { index: 2, from: 8, to: 9 },
      { index: 0, from: 9, to: 9 },
    ],
  });
  assert.deepEqual(parseSnippet('usepackage{$1}$0'), {
    text: 'usepackage{}', tabstops: [{ index: 1, from: 11, to: 11 }, { index: 0, from: 12, to: 12 }],
  });
});

test('snippet: nested defaults are resolved and mirrored without infinite cycles', () => {
  assert.deepEqual(parseSnippet('${1:a${2:b}}-$1'), {
    text: 'ab-ab', tabstops: [
      { index: 1, from: 0, to: 2 }, { index: 1, from: 3, to: 5 },
      { index: 2, from: 1, to: 2, parents: [1] }, { index: 2, from: 4, to: 5, parents: [1] },
    ],
  });
  assert.equal(parseSnippet('${1:x$1}').text, 'x');
  assert.equal(parseSnippet('${1:$2}${2:$1}').text, '');
  assert.equal(parseSnippet('${1:first}-${1:second}').text, 'first-first');
});

test('snippet: choices decode escaped comma, pipe and backslash and populate mirrors', () => {
  assert.deepEqual(parseSnippet('${1|a\\,b,c\\|d,e\\\\f|}:$1'), {
    text: 'a,b:a,b', tabstops: [
      { index: 1, from: 0, to: 3, choices: ['a,b', 'c|d', 'e\\f'] },
      { index: 1, from: 4, to: 7, choices: ['a,b', 'c|d', 'e\\f'] },
    ],
  });
});

test('snippet: variables use values/defaults, preserve empty values and render unknown names', () => {
  assert.equal(parseSnippet('$TM_FILENAME:${TM_SELECTED_TEXT:${1:default}}:${UNKNOWN}', { TM_FILENAME: 'main.tex', TM_SELECTED_TEXT: '' }).text, 'main.tex::UNKNOWN');
  assert.deepEqual(parseSnippet('${TM_SELECTED_TEXT:${1:word}}', {}), {
    text: 'word', tabstops: [{ index: 1, from: 0, to: 4 }],
  });
  assert.deepEqual(parseSnippet('${TM_SELECTED_TEXT:${1:word}}', { TM_SELECTED_TEXT: '$1' }), { text: '$1', tabstops: [] });
});

test('snippet: escapes preserve LaTeX commands and malformed syntax stays readable', () => {
  assert.equal(parseSnippet('\\frac{${1:a}}{${2:b}} \\$x\\$ \\} \\\\').text, '\\frac{a}{b} $x$ } \\');
  for (const source of ['${1:open', '${x|a,b|}', '${1|a,b}', '${9999999999999999999999}', '$-']) {
    assert.equal(parseSnippet(source).text, source);
  }
});

test('snippet: transforms degrade to the original variable or placeholder value', () => {
  assert.equal(parseSnippet('${TM_FILENAME/(.*)\\..+$/$1/}', { TM_FILENAME: 'main.tex' }).text, 'main.tex');
  assert.equal(parseSnippet('${1:foo}-${1/(.*)/${1:/upcase}/}').text, 'foo-foo');
  assert.equal(parseSnippet('${1/a/b/g}-${1:original}').text, 'original-original');
  assert.equal(parseSnippet('${UNKNOWN/a/b/}').text, 'UNKNOWN');
});
