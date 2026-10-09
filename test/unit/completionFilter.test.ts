import { test } from 'node:test';
import assert from 'node:assert/strict';
import { completionScore, filterCompletions, isLatexCommandPrefix, isWordCompletion } from '../../src/core/completionFilter.ts';

test('completion: LaTeX backslash and case do not hide provider labels', () => {
  assert.notEqual(completionScore('\\Use', 'usepackage'), null);
  assert.equal(completionScore('\\use', 'usepackage'), completionScore('use', '\\usepackage'));
  assert.equal(completionScore('use', 'section'), null);
  assert.deepEqual(filterCompletions([{ label: '\\usepackage' }, { label: 'use' }, { label: 'section' }], '\\use').map(item => item.label), ['use', '\\usepackage']);
});

test('completion: TeX command casing outranks provider sorting and preselection', () => {
  const items = [{ label: '\\psi', sortText: '00', preselect: true }, { label: '\\Psi', sortText: '99' }];
  assert.deepEqual(filterCompletions(items, '\\Psi').map(item => item.label), ['\\Psi', '\\psi']);
  assert.deepEqual(filterCompletions(items, '\\P').map(item => item.label), ['\\Psi', '\\psi']);
  assert.deepEqual(filterCompletions(items, '\\psi').map(item => item.label), ['\\psi', '\\Psi']);
});

test('completion: command context distinguishes control sequences from escaped line breaks', () => {
  for (const before of ['\\', '\\Psi', 'body \\equa', '\\begin{equation}\n\\a', '\\\\\\a']) {
    assert.equal(isLatexCommandPrefix(before), true, before);
  }
  for (const before of ['word', '\\Psi ', '\\\\', '\\\\a', '\\usepackage{ams']) {
    assert.equal(isLatexCommandPrefix(before), false, before);
  }
  assert.equal(isWordCompletion({ source: 'word' }), true);
  assert.equal(isWordCompletion({ source: 'provider', kind: 0 }), true);
  assert.equal(isWordCompletion({ source: 'template', kind: 0 }), false);
  assert.equal(isWordCompletion({ source: 'provider', kind: 2 }), false);
});

test('completion: exact matches outrank prefixes, which outrank compact fuzzy hits', () => {
  const score = (candidate: string) => completionScore('use', candidate)!;
  assert.ok(score('use') > score('usepackage'));
  assert.ok(score('usepackage') > score('unused_section'));
  assert.ok(completionScore('fr', 'frac')! > completionScore('fr', 'far_right')!);
  assert.equal(completionScore('fra', 'far'), null);
});

test('completion: filterText, provider sort order, preselect and stable ties', () => {
  const items = [
    { label: 'shown label', filterText: '\\usepackage', sortText: '02' },
    { label: 'alternate', filterText: 'usepackage', sortText: '01' },
    { label: 'selected', filterText: 'usepackage', preselect: true, sortText: '99' },
    { label: 'unrelated', filterText: 'section' },
  ];
  assert.deepEqual(filterCompletions(items, 'use').map(item => item.label), ['selected', 'alternate', 'shown label']);
  assert.equal(items[0].label, 'shown label');
  const twins = [{ label: 'same', id: 1 }, { label: 'same', id: 2 }];
  assert.deepEqual(filterCompletions(twins, '').map(item => item.id), [1, 2]);
});

test('completion: caps provider lists and handles empty prefixes and limits', () => {
  const items = Array.from({ length: 350 }, (_, n) => ({ label: `command${n}`, sortText: String(n).padStart(3, '0') }));
  assert.equal(filterCompletions(items, '\\').length, 300);
  assert.deepEqual(filterCompletions(items, '', 2).map(item => item.label), ['command0', 'command1']);
  assert.deepEqual(filterCompletions(items, '', 0), []);
  assert.deepEqual(filterCompletions(items, '', -1), []);
});
