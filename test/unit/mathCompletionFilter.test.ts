import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMathCompletion, filterMathCompletions } from '../../src/core/mathCompletionFilter.ts';
import { filterCompletions } from '../../src/core/completionFilter.ts';
import { MATH_COMMANDS } from '../../src/core/mathCommands.ts';

const item = (value: string, label = value) => ({ label, insert: { value } });

test('math completion: pinned MathLive commands are retained without loading DOM code', () => {
  assert.ok(MATH_COMMANDS.size > 900);
  for (const command of ['frac', 'alpha', 'xleftrightharpoons', 'nicefrac', 'operatorname*', 'left', 'nolimits']) {
    assert.equal(isMathCompletion(item(`\\${command}{$1}`, `\\${command}`)), true, command);
    assert.equal(isMathCompletion(item(`${command}{$1}`, `\\${command}`)), true, `${command} without leading slash`);
  }
  for (const command of [',', ';', '!', '{', '}']) { assert.equal(isMathCompletion(item(`\\${command}`)), true); }
  assert.equal(isMathCompletion(item('section{${1:Title}}', '\\section')), false);
  assert.equal(isMathCompletion(item('section{${1:Title}}', '\\frac')), false, 'insertion takes priority over decorative labels');
  assert.equal(isMathCompletion(item('someproseword')), false);
});

test('math completion: project macros and explicit templates remain available', () => {
  const macro = { name: 'myNorm', arity: 1, body: '\\unsupported{#1}' };
  assert.equal(isMathCompletion(item('myNorm{$1}'), [macro]), true);
  assert.equal(isMathCompletion(item('myNorm{$1}')), false);
  assert.equal(isMathCompletion({ ...item('${TM_SELECTED_TEXT}^2'), source: 'template' }), true);
  assert.equal(isMathCompletion({ ...item('myNorm{$1}'), source: 'macro' }, [macro]), true);
});

test('math completion: words that resemble math commands remain excluded', () => {
  assert.equal(isMathCompletion({ ...item('psi'), source: 'word' }), false);
  assert.equal(isMathCompletion({ ...item('Psi'), source: 'provider', kind: 0 }), false);
  assert.equal(isMathCompletion({ ...item('psi'), source: 'word' }, [], ['.*']), false);
  assert.equal(isMathCompletion({ ...item('Psi'), source: 'provider', kind: 2 }), true);
});

test('math completion: MathLive matrix/cases/aligned environments and supported variants are retained', () => {
  for (const environment of ['matrix', 'pmatrix', 'matrix*', 'cases', 'aligned', 'array']) {
    assert.equal(isMathCompletion(item(`begin{${environment}}$1\\end{${environment}}`)), true, environment);
  }
  assert.equal(isMathCompletion(item('begin{itemize}\\item $1\\end{itemize}')), false);
  assert.equal(isMathCompletion(item('begin{$1}')), false);
  assert.equal(isMathCompletion(item('end{matrix}')), true);
});

test('math completion: user patterns match labels, filter text or insertion and invalid patterns are ignored', () => {
  assert.equal(isMathCompletion(item('customMath{$1}'), [], ['[', '^customMath']), true);
  assert.equal(isMathCompletion({ ...item('customMath{$1}', 'shown'), filterText: 'omt-custom' }, [], ['^omt-custom$']), true);
  assert.equal(isMathCompletion(item('section{$1}'), [], ['[']), false);
});

test('math completion: context filtering precedes ranking and the 300-item cap', () => {
  const prose = Array.from({ length: 450 }, (_, n) => item('section{$1}', `zzQ${String(n).padStart(3, '0')}`));
  const math = item('frac{$1}{$2}', 'zzQfrac');
  assert.deepEqual(filterCompletions(filterMathCompletions([...prose, math]), 'zzQ'), [math]);
});
