import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanFormulas } from '../../src/core/formulaScanner.ts';

const kinds = (text: string) => scanFormulas(text).map(f => [f.kind, text.slice(f.bodyFrom, f.bodyTo), f.sourceOnly ?? '']);

test('delimiters', () => {
  assert.deepEqual(kinds('a $x$ b $$y$$ \\(z\\) \\[w\\]'), [['$', 'x', ''], ['$$', 'y', ''], ['\\(', 'z', ''], ['\\[', 'w', '']]);
});

test('escaped dollars, comments and verbatim are skipped', () => {
  assert.deepEqual(kinds('cost \\$5 % $no$\n\\verb|$x$| $ok$'), [['$', 'ok', '']]);
  assert.deepEqual(kinds('\\begin{verbatim}\n$x$\n\\end{verbatim} $y$'), [['$', 'y', '']]);
});

test('inline math does not cross a blank line; braces may hold $', () => {
  assert.deepEqual(kinds('$a\n\nb$ c'), []);
  assert.deepEqual(kinds('$\\text{a $b$} c$'), [['$', '\\text{a $b$} c', '']]);
});

test('environments, wrappers and nested environments', () => {
  const text = '\\begin{align}\n a &= b \\\\\n \\begin{align}x\\end{align}\\end{align}';
  const [f] = scanFormulas(text);
  assert.equal(f.kind, 'align');
  assert.equal(f.wrapper, 'aligned');
  assert.equal(f.to, text.length);
  assert.deepEqual(kinds('\\begin{equation}\\label{e} x\\end{equation}'), [['equation', '\\label{e} x', '']]);
});

test('source-only reasons', () => {
  assert.equal(scanFormulas('$a % c\n b$')[0].sourceOnly, 'contains a comment');
  assert.equal(scanFormulas('$a & b$')[0].sourceOnly, 'alignment outside an environment');
  assert.equal(scanFormulas('$\\begin{pmatrix}a & b\\end{pmatrix}$')[0].sourceOnly, undefined);
  assert.equal(scanFormulas('$\\csname x\\endcsname$')[0].sourceOnly, 'contains \\csname');
  assert.match(scanFormulas('\\begin{alignat}{2}a\\end{alignat}')[0].sourceOnly!, /source/);
});

test('unterminated $$ and environments produce no span', () => {
  assert.deepEqual(kinds('$$ a $ b'), []);
  assert.deepEqual(kinds('\\begin{equation} a'), []);
});
