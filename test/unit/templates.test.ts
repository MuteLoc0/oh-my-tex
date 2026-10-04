import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRenderMacros, normalizeUserMacros } from '../../src/core/templates.ts';

test('render macros accept the macro configuration format, including optional arguments', () => {
  const value = {
    '\\R': '\\mathbb{R}',
    norm: { args: 1, def: '\\left\\lVert#1\\right\\rVert' },
    '\\pair': { args: 2, def: '#1+#2', default: 'x' },
    zero: { def: '0', default: 'ignored without an argument' },
  };
  const before = structuredClone(value);
  assert.deepEqual(normalizeRenderMacros(value), [
    { name: 'R', arity: 0, body: '\\mathbb{R}' },
    { name: 'norm', arity: 1, body: '\\left\\lVert#1\\right\\rVert' },
    { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'x' },
    { name: 'zero', arity: 0, body: '0' },
  ]);
  assert.deepEqual(normalizeRenderMacros(value), normalizeUserMacros(value));
  assert.deepEqual(value, before, 'normalization must not rewrite the configured definitions');
});

test('render macros discard invalid definitions and preserve valid arity bounds', () => {
  for (const value of [null, undefined, false, 12, 'not a macro map', []]) {
    assert.deepEqual(normalizeRenderMacros(value), []);
  }
  assert.deepEqual(normalizeRenderMacros({
    'bad name': 'x',
    '\\': 'x',
    'name1': 'x',
    negative: { args: -1, def: 'x' },
    tooMany: { args: 10, def: 'x' },
    fractional: { args: 1.5, def: 'x' },
    noDefinition: { args: 1 },
    badDefinition: { args: 1, def: 12 },
    empty: null,
    maximum: { args: 9, def: '#1+#9', default: 12 },
  }), [{ name: 'maximum', arity: 9, body: '#1+#9' }]);
});
