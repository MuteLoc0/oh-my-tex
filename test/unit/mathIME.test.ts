import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containsCJK, hasMathModeCJK } from '../../src/core/mathText.ts';

test('CJK covers Han supplementary planes, kana and Hangul', () => {
  for (const text of ['中文', '𠀀', 'あ', 'カ', '한']) { assert.equal(containsCJK(text), true, text); }
  assert.equal(containsCJK('x+abc'), false);
});

test('CJK serialization must retain a text-mode wrapper', () => {
  for (const latex of ['中文+x', '\\text{中}文', '\\mathbf{中}', '\\operatorname{中文}', '\\text{中\\ensuremath{文}}', '\\text{中$文$}']) {
    assert.equal(hasMathModeCJK(latex), true, latex);
  }
  for (const latex of ['\\text{公式中文}+x', '\\text{中{文}}', '\\textbf{中}+\\text{文}', '\\text 中+x', 'x % 中文\n+y']) {
    assert.equal(hasMathModeCJK(latex), false, latex);
  }
});
