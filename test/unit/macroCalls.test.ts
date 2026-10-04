import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMacroCalls, editMacroArgument, deleteMacroCall, type MacroCall } from '../../src/core/macroCalls.ts';
import { applyPatches, validatePatches } from '../../src/core/patch.ts';
import { buildIslands, restoreIslands } from '../../src/core/islands.ts';
import type { MacroDef, Patch } from '../../src/shared/types.ts';

const macros = new Map<string, MacroDef>([
  ['norm', { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' }],
  ['ket', { name: 'ket', arity: 1, body: '\\left|#1\\right\\rangle' }],
  ['dup', { name: 'dup', arity: 1, body: '#1+#1' }],
  ['pair', { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'd' }],
]);

const first = (source: string) => parseMacroCalls(source, macros)[0];
function apply(source: string, patch: Patch | undefined): string {
  if (!patch) { return source; }
  assert.equal(validatePatches(source, [patch]), undefined);
  return applyPatches(source, [patch]);
}
const edit = (source: string, index: number, value: string | null, call: MacroCall = first(source)) =>
  apply(source, editMacroArgument(source, call, index, value));

test('a braced argument edit changes only its content and retains the original macro definition', () => {
  const source = '\\norm  { x + \\alpha } + q';
  const snapshot = JSON.stringify([...macros]);
  const patch = editMacroArgument(source, first(source), 1, ' y + \\alpha ');
  assert.deepEqual(patch, { from: 9, to: 10, expected: 'x', insert: 'y' });
  assert.equal(apply(source, patch), '\\norm  { y + \\alpha } + q');
  assert.equal(JSON.stringify([...macros]), snapshot);
  assert.equal(editMacroArgument(source, first(source), 1, ' x + \\alpha '), undefined);
});

test('one source argument drives every occurrence of a repeated macro parameter', () => {
  const source = edit('\\dup{x}+a', 1, 'y');
  assert.equal(source, '\\dup{y}+a');
  const { view, islands } = buildIslands(source, macros);
  assert.equal(islands[0].render, '{y}+{y}');
  assert.equal(restoreIslands(view, islands), source);
});

test('parameter numbers and shell ranges include an omitted optional parameter', () => {
  const source = '\\pair {w}';
  const call = first(source);
  assert.deepEqual(call.args.map(a => [a.index, a.value, a.optional, a.omitted, a.from, a.to, a.shellFrom, a.shellTo]),
    [[1, '', true, true, 5, 5, 5, 5], [2, 'w', false, false, 7, 8, 6, 9]]);
  assert.equal(call.args[0].defaultValue, 'd');
  assert.equal(edit(source, 2, 'v'), '\\pair {v}');
  assert.equal(buildIslands(source, macros).islands[0].args[1].index, 2);
});

test('optional edit, insertion, explicit empty contents, and omission preserve mandatory arguments', () => {
  assert.equal(edit('\\pair[z]  {w}+a', 1, 'u'), '\\pair[u]  {w}+a');
  assert.equal(edit('\\pair  {w}+a', 1, 'z'), '\\pair[z]  {w}+a');
  assert.equal(edit('\\pair[z]  {w}+a', 1, ''), '\\pair[]  {w}+a');
  assert.equal(edit('\\pair[z]  {w}+a', 1, null), '\\pair  {w}+a');
  assert.equal(edit('\\pair  {w}+a', 1, null), '\\pair  {w}+a');
  assert.equal(edit('\\pair  {w}+a', 1, ''), '\\pair[]  {w}+a');
  assert.throws(() => edit('\\pair[z]{w}', 2, null), /required/);
});

test('a growing unbraced argument acquires braces without changing following text', () => {
  assert.equal(edit('\\norm x + a', 1, 'xy'), '\\norm{xy} + a');
  assert.equal(edit('\\norm x + a', 1, 'y'), '\\norm y + a');
  assert.equal(edit('\\norm x+a', 1, ''), '\\norm{}+a');
  assert.equal(edit('\\norm x+a', 1, '\\alpha'), '\\norm \\alpha+a');
  assert.equal(edit('\\norm xa', 1, '\\alpha'), '\\norm{\\alpha}a');
  assert.equal(edit('\\norm\\alpha+a', 1, 'y'), '\\norm{y}+a');
  assert.equal(edit('\\pair x+a', 2, '['), '\\pair{[}+a');
  assert.equal(edit('\\norm x+a', 1, '😀'), '\\norm 😀+a');
});

test('nested calls retain parent relationships and only the innermost argument changes', () => {
  const source = '\\norm{\\ket{\\psi}} + \\dup{x}';
  const calls = parseMacroCalls(source, macros);
  assert.deepEqual(calls.map(c => c.name), ['norm', 'ket', 'dup']);
  assert.equal(calls[1].parentId, calls[0].id);
  assert.equal(calls[1].parentArgumentIndex, 1);
  assert.deepEqual(calls[0].args[0].childIds, [calls[1].id]);
  const patch = editMacroArgument(source, calls[1], 1, '\\phi')!;
  assert.equal(patch.expected, 's');
  assert.equal(apply(source, patch), '\\norm{\\ket{\\phi}} + \\dup{x}');
});

test('calls in optional parameters and unknown command groups are recursively editable', () => {
  const source = '\\foo[\\pair{w}]{\\norm{x}} + \\ket{q}';
  const calls = parseMacroCalls(source, macros, new Set(['foo']));
  assert.deepEqual(calls.map(c => [c.name, c.kind]), [['foo', 'unknown'], ['pair', 'macro'], ['norm', 'macro'], ['ket', 'macro']]);
  assert.equal(calls[1].parentArgumentIndex, 1);
  assert.equal(calls[2].parentArgumentIndex, 2);
  assert.equal(edit(source, 1, 'y', calls[2]), '\\foo[\\pair{w}]{\\norm{y}} + \\ket{q}');
  assert.equal(edit(source, 1, null, calls[0]), '\\foo{\\norm{x}} + \\ket{q}');
});

test('unknown definitions render as chips while preserving editable project macro arguments', () => {
  const source = '\\pair[z]{w}+a';
  const { islands, view } = buildIslands(source, macros, new Set(['pair']));
  assert.equal(islands[0].kind, 'macro');
  assert.match(islands[0].render, /textbackslash pair/);
  assert.equal(islands[0].args[1].value, 'w');
  assert.equal(restoreIslands(view, islands), source);
  const noArgs = new Map([['opaque', { name: 'opaque', arity: 0, body: '\\unsupported' }]]);
  const noArgsSource = '\\opaque{x}';
  const opaque = parseMacroCalls(noArgsSource, noArgs, new Set(['opaque']))[0];
  assert.equal(opaque.text, '\\opaque');
  assert.deepEqual(opaque.args, []);
  assert.equal(buildIslands(noArgsSource, noArgs, new Set(['opaque'])).view, '\\OMTa{x}');
});

test('deleting a call removes exactly its source range including all arguments', () => {
  const source = 'a + \\pair [z]  {w} + \\norm{x}';
  const call = first(source);
  const patch = deleteMacroCall(source, call);
  assert.equal(patch.expected, '\\pair [z]  {w}');
  assert.equal(apply(source, patch), 'a +  + \\norm{x}');
  const nested = '\\norm{\\ket{x}}';
  assert.equal(apply(nested, deleteMacroCall(nested, parseMacroCalls(nested, macros)[1])), '\\norm{}');
});

test('absolute offsets and surrogate pairs preserve valid patch boundaries', () => {
  const source = '\\norm{😀x}';
  const call = parseMacroCalls(source, macros, new Set(), 100)[0];
  assert.equal(call.from, 100);
  assert.equal(call.to, 110);
  const patch = editMacroArgument(source, call, 1, '😁x', 100)!;
  assert.deepEqual(patch, { from: 106, to: 108, expected: '😀', insert: '😁' });
  assert.equal(apply(source, { ...patch, from: patch.from - 100, to: patch.to - 100 }), '\\norm{😁x}');
});

test('incomplete calls are not offered as editable invocations and unbraced arguments stay one TeX token', () => {
  for (const source of ['\\norm', '\\norm{', '\\norm{a', '\\pair[z', '\\pair[z]']) {
    assert.deepEqual(parseMacroCalls(source, macros), [], source);
  }
  const source = '\\norm\\ket{x}';
  assert.equal(first(source).text, '\\norm\\ket');
  assert.equal(first(source).args[0].value, '\\ket');
  assert.equal(parseMacroCalls(source, macros).length, 1);
});

test('unsafe argument input and stale calls never produce a patch', () => {
  for (const value of ['{x', 'x}', '\\placeholder[p]{}', '\\OMTa', 'x%comment', '\\verb|x|', 'x\\']) {
    assert.throws(() => edit('\\norm{x}', 1, value), Error, value);
  }
  for (const value of ['x]', '[x', 'x][y']) { assert.throws(() => edit('\\pair[z]{w}', 1, value), /bracket|delimiter/); }
  assert.equal(edit('\\pair[z]{w}', 1, '{]}'), '\\pair[{]}]{w}');
  assert.throws(() => editMacroArgument('\\norm{y}', first('\\norm{x}'), 1, 'z'), /changed/);
  assert.throws(() => deleteMacroCall('\\norm{y}', first('\\norm{x}')), /changed/);
  assert.throws(() => edit('\\norm{x}', 2, 'z'), /exist/);
});

test('deeply nested source uses an iterative call traversal', () => {
  const source = '\\norm{'.repeat(200) + 'x' + '}'.repeat(200);
  const calls = parseMacroCalls(source, macros);
  assert.equal(calls.length, 200);
  assert.equal(calls.at(-1)!.args[0].value, 'x');
  assert.equal(edit(source, 1, 'y', calls.at(-1)!), '\\norm{'.repeat(200) + 'y' + '}'.repeat(200));
});
