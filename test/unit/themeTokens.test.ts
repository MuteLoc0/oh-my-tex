import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customizationRules, editorLineHeight, themeScopeMatches, tokenColors } from '../../src/core/themeTokens.ts';

test('theme tokens prefer LaTeX descendants and the last equally specific override', () => {
  assert.deepEqual(tokenColors([
    { scope: 'keyword', settings: { foreground: '#123' } },
    { scope: 'support.function.general.tex', settings: { foreground: '#abc' } },
    { scope: 'text.tex.latex support.function.general.tex', settings: { foreground: '#def' } },
    { scope: 'text.tex.latex support.function.general.tex', settings: { foreground: '#f00' } },
    { scope: ['comment', 'keyword.operator'], settings: { foreground: '#123456' } },
    { scope: 'comment.line.percentage.tex', settings: { foreground: '#789abc' } },
    { scope: 'punctuation.definition.arguments.begin.latex, punctuation.definition.arguments.end.latex', settings: { foreground: '#ffff' } },
    { scope: 'source.js keyword', settings: { foreground: '#000' } },
  ]), { command: '#f00', comment: '#789abc', bracket: '#ffff', math: '#123456' });
});

test('theme tokens reject invalid colors, foreign language scopes and unsupported expressions', () => {
  assert.deepEqual(tokenColors([
    { scope: 'comment', settings: { foreground: '#12345' } },
    { scope: 'comment', settings: { foreground: '#1234567' } },
    { scope: 'keyword.control.python', settings: { foreground: '#123' } },
    { scope: 'comment - comment.latex', settings: { foreground: '#123' } },
    { scope: 'punctuation', settings: { foreground: 'red' } },
    { scope: 'constant.character', settings: { foreground: '#12345678' } },
    null as never,
  ]), { math: '#12345678' });
});

test('theme customization supports theme groups, wildcards and literal regex characters', () => {
  const custom = {
    comments: '#111', keywords: '#222', functions: '#333', numbers: '#444',
    '[Other][Ayu (Dark)]': { comments: '#555' },
    '[*Dark*]': { textMateRules: [{ scope: 'keyword.latex', settings: { foreground: '#666' } }] },
    '[AyuXDark]': { comments: '#777' },
  };
  assert.deepEqual(tokenColors(customizationRules(custom, 'Ayu (Dark)')), { command: '#666', comment: '#555', math: '#444' });
  assert.equal(tokenColors(customizationRules(custom, 'Ayu Light')).comment, '#111');
  assert.equal(tokenColors(customizationRules(custom)).comment, '#111');
  assert.deepEqual(customizationRules(null), []);
});

test('editor line height follows pixel, multiplier and automatic settings', () => {
  assert.equal(editorLineHeight(14, 0), 21);
  assert.equal(editorLineHeight(14, 1.8), 25.2);
  assert.equal(editorLineHeight(14, 8), 8);
  assert.equal(editorLineHeight(14, 26), 26);
  assert.equal(editorLineHeight(14, Number.NaN), 21);
});

test('stex fallback uses Workshop command colors before declared function names', () => {
  assert.equal(tokenColors([
    { scope: 'support.function', settings: { foreground: '#59c2ff' } },
    { scope: 'entity.name.function', settings: { foreground: '#ffb454' } },
  ]).command, '#59c2ff');
  assert.equal(tokenColors([
    { scope: 'support.function.general.tex', settings: { foreground: '#59c2ff' } },
    { scope: 'entity.name.function.latex', settings: { foreground: '#ffb454' } },
  ]).command, '#59c2ff');
});

test('theme shorthand supports every VS Code group and style objects before explicit rules', () => {
  const style = { foreground: '#abc', fontStyle: 'italic bold' };
  const explicit = { scope: 'support.function', settings: { foreground: '#def', fontStyle: '' } };
  const rules = customizationRules({
    comments: style, strings: style, keywords: style, numbers: style,
    types: style, functions: style, variables: style, textMateRules: [explicit],
  });
  for (const scope of ['comment', 'punctuation.definition.comment', 'string', 'meta.embedded.assembly',
    'keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type', 'constant.numeric',
    'entity.name.type', 'entity.name.class', 'support.type', 'support.class',
    'entity.name.function', 'support.function', 'variable', 'entity.name.variable']) {
    assert.deepEqual(rules.find(rule => rule.scope === scope)?.settings, style);
  }
  assert.deepEqual(rules.at(-1), explicit);
  assert.equal(tokenColors(rules).command, '#def');
});

test('matching theme groups merge shorthand overrides and concatenate explicit rules', () => {
  const first = { scope: 'comment', settings: { fontStyle: 'italic' } };
  const second = { scope: 'comment', settings: { foreground: '#456', fontStyle: '' } };
  assert.deepEqual(customizationRules({
    comments: '#123',
    '[Ayu*]': { comments: '#234', textMateRules: [first] },
    '[*Dark*]': { comments: '#345', textMateRules: [second] },
  }, 'Ayu Dark'), [
    { scope: 'comment', settings: { foreground: '#123' } },
    { scope: 'punctuation.definition.comment', settings: { foreground: '#123' } },
    { scope: 'comment', settings: { foreground: '#345' } },
    { scope: 'punctuation.definition.comment', settings: { foreground: '#345' } },
    first, second,
  ]);
  assert.equal(themeScopeMatches('[Ayu (Dark)]', 'Ayu (Dark)'), true);
  assert.equal(themeScopeMatches('[Ayu*Dark]', 'Ayu Dark'), false);
  assert.equal(themeScopeMatches('prefix[Ayu Dark]', 'Ayu Dark'), false);
  assert.equal(themeScopeMatches('[Other][Ayu Dark]', 'Ayu Dark'), true);
});
