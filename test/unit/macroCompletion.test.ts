import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completedMacroCall, isMacroCompletionSource } from '../../src/core/macroCompletion.ts';
import { renderDefinitions } from '../../src/core/renderCompat.ts';
import type { MacroDef } from '../../src/shared/types.ts';

const definitions: MacroDef[] = [
  { name: 'duo', arity: 2, body: '#1+#2' },
  { name: 'pair', arity: 2, defaultArgument: 'd', body: '#1+#2' },
  { name: 'zero', arity: 0, body: '0' },
];
const macros = new Map(renderDefinitions(definitions, [], () => false).map(macro => [macro.name, macro]));

test('source completion validation accepts nested groups and escaped TeX symbols without imposing delimiter syntax', () => {
  for (const source of ['', '\\duo{a}{b}', '\\pair[z]{\\norm{\\alpha}}', '\\duo{\\$\\%\\{\\}}{b}',
    '\\duo{x}{y}[', '\\duo{x}{y}]', '\\duo{😀}{x}', '\\duo{a}{b} \\\\ c']) {
    assert.equal(isMacroCompletionSource(source), true, source);
  }
});

test('source completion validation rejects incomplete groups, formula delimiters, comments and internal markers', () => {
  for (const source of ['\\duo{}{} {', '\\duo{}{} }', '\\duo{}{} }{', '\\duo{x}{y', '\\duo{}{}\\',
    '\\duo{}{}$x$', '\\duo{}{}%comment', '\\duo{\\verb|x|}{}', '\\duo{\\verb*|x|}{}',
    '\\duo{\\OMTa}{}', '\\duo{\\OMTCompletionCursor}{}', '\\duo{\\placeholder[p]{x}}{}']) {
    assert.equal(isMacroCompletionSource(source), false, source);
  }
});

test('source completion validation refuses formula delimiter commands and unowned environment endings', () => {
  for (const source of ['\\duo{}{}\\(', '\\duo{}{}\\)', '\\duo{}{}\\[', '\\duo{}{}\\]',
    '\\duo{}{}\\end{align}', '\\duo{}{}\\end{equation}', '\\duo{}{}\\end{matrix}',
    '\\duo{}{}\\begin{matrix}', '\\duo{}{}\\begin{cases}x\\end{align}', '\\duo{}{}\\begin']) {
    assert.equal(isMacroCompletionSource(source), false, source);
  }
});

test('source completion validation preserves self-contained matrix and cases environments with proper nesting', () => {
  for (const source of ['\\duo{\\begin{matrix}x&y\\\\z&w\\end{matrix}}{}',
    '\\duo{\\begin{cases}\\begin{pmatrix}x\\end{pmatrix}&x>0\\\\0&x<0\\end{cases}}{}',
    '\\duo{}{}\\begin {matrix}x\\end {matrix}\\begin{cases}y\\end{cases}']) {
    assert.equal(isMacroCompletionSource(source), true, source);
  }
  assert.equal(isMacroCompletionSource('\\duo{\\begin{matrix}\\begin{cases}x\\end{matrix}\\end{cases}}{}'), false);
});

test('completed macro detection uses the exact source insertion offset and keeps default argument contents', () => {
  const source = 'x+\\pair[z]{w}+\\duo{}{}';
  const call = completedMacroCall(source, 2, macros)!;
  assert.equal(call.name, 'pair');
  assert.deepEqual(call.args.map(arg => [arg.index, arg.value, arg.optional]), [[1, 'z', true], [2, 'w', false]]);
  assert.equal(completedMacroCall(source, 0, macros), undefined);
  assert.equal(completedMacroCall(source, 3, macros), undefined);
  assert.equal(completedMacroCall(source, source.indexOf('\\duo'), macros)?.name, 'duo');
});

test('new nested macros and package compatibility calls remain source-owned', () => {
  const source = '\\norm{a+\\duo{}{}}';
  const call = completedMacroCall(source, source.indexOf('\\duo'), macros)!;
  assert.equal(call.name, 'duo');
  assert.equal(call.parentId, '0:norm');
  assert.equal(completedMacroCall('\\slashed{p}', 0, macros)?.name, 'slashed');
  assert.equal(completedMacroCall('\\pair{w}', 0, macros)?.args[0].omitted, true);
});

test('incomplete, zero-argument, unknown and unrelated calls do not enter an argument editor', () => {
  for (const source of ['\\duo', '\\duo{a}', '\\duo{a}{', '\\pair[z]', '\\zero', '\\missing{}']) {
    assert.equal(completedMacroCall(source, 0, macros, new Set(['missing'])), undefined, source);
  }
  assert.equal(completedMacroCall('\\duo{}{}', -1, macros), undefined);
  assert.equal(completedMacroCall('\\duo{}{}', 0.5, macros), undefined);
  assert.equal(completedMacroCall('\\duo{}{}', 99, macros), undefined);
  assert.equal(completedMacroCall('\\duo{\\OMTa}{}', 0, macros), undefined);
  assert.equal(completedMacroCall('\\pair[z]{\\placeholder[p]{}}', 0, macros), undefined);
});
