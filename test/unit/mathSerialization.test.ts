import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeWithoutPlaceholders } from '../../src/core/mathSerialization.ts';

test('math serialization: empty macro slots become empty source arguments', () => {
  assert.equal(serializeWithoutPlaceholders('\\norm{\\placeholder{}}'), '\\norm{}');
  assert.equal(serializeWithoutPlaceholders('\\pair{\\placeholder{}}{\\placeholder{}}'), '\\pair{}{}');
  assert.equal(serializeWithoutPlaceholders('\\frac{\\placeholder{}}{b}'), '\\frac{}{b}');
});

test('math serialization: prompts keep contents and remove all generated options', () => {
  assert.equal(serializeWithoutPlaceholders('\\norm{\\placeholder[omt-1]{x+y}}'), '\\norm{x+y}');
  assert.equal(serializeWithoutPlaceholders('\\placeholder[p][correct][locked]{\\alpha}'), '\\alpha');
  assert.equal(serializeWithoutPlaceholders('a+\\placeholder[p][][locked]{}+b'), 'a++b');
  assert.equal(serializeWithoutPlaceholders('\\placeholder [p] { x }'), ' x ');
});

test('math serialization: nested prompts preserve braces, Unicode and whitespace', () => {
  assert.equal(serializeWithoutPlaceholders('  \\norm{\\placeholder[p]{\\frac{\\placeholder[q]{𝔸}}{\\placeholder{}}}}\n'),
    '  \\norm{\\frac{𝔸}{}}\n');
  assert.equal(serializeWithoutPlaceholders('\\placeholder[a]{\\placeholder[b]{x}}+\\placeholder[c]{y}'), 'x+y');
  assert.equal(serializeWithoutPlaceholders('\\placeholder[a]{\\{x\\}}'), '\\{x\\}');
});

test('math serialization: unrelated commands, comments and verbatim content stay exact', () => {
  for (const value of ['x + \\alpha', '\\placeholderSymbol{x}', '\\\\placeholder{x}', '% \\placeholder[p]{x}\nq', '\\verb|\\placeholder[p]{x}|']) {
    assert.equal(serializeWithoutPlaceholders(value), value);
  }
  assert.equal(serializeWithoutPlaceholders('% \\placeholder{x}\n\\placeholder[p]{y}'), '% \\placeholder{x}\ny');
});

test('math serialization: malformed wrappers are preserved rather than partially removed', () => {
  for (const value of ['\\placeholder', '\\placeholder[p]', '\\placeholder[p]{x', '\\placeholder[p{x}', '\\placeholder[p][a][b][c]{x}']) {
    assert.equal(serializeWithoutPlaceholders(value), value);
  }
});

test('math serialization: deep nesting does not recurse on the JavaScript stack', () => {
  const depth = 1000;
  assert.equal(serializeWithoutPlaceholders('\\placeholder[p]{'.repeat(depth) + 'x' + '}'.repeat(depth)), 'x');
});
