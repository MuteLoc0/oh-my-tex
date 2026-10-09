import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSnippet } from '../../src/core/snippet.ts';
import { environmentBody, withEnvironmentSelection } from '../../src/core/environmentCompletion.ts';

test('environment completion: fills a body slot while keeping environment-name mirrors and labels', () => {
  const snippet = '\\begin{${1:equation}}\n\\label{${2:eq:}}\n  ${3:body}\n\\end{$1}$0';
  const original = parseSnippet(snippet);
  const selected = 'x=1\n  y=2';
  const result = withEnvironmentSelection(original, selected);
  assert.equal(result.text, '\\begin{equation}\n\\label{eq:}\n  x=1\n  y=2\n\\end{equation}');
  assert.equal(result.tabstops.find(stop => stop.index === 3)!.to - result.tabstops.find(stop => stop.index === 3)!.from, selected.length);
  assert.deepEqual(result.tabstops.filter(stop => stop.index === 1).map(stop => result.text.slice(stop.from, stop.to)), ['equation', 'equation']);
  assert.equal(original.text.includes('body'), true);
});

test('environment completion: content becomes editable for a plain empty environment', () => {
  const result = withEnvironmentSelection({ text: 'begin{equation}\n  \n\\end{equation}', tabstops: [] }, 'a\nb');
  assert.equal(result.text, 'begin{equation}\n  a\nb\n\\end{equation}');
  assert.equal(result.text.slice(result.tabstops[0]!.from, result.tabstops[0]!.to), 'a\nb');
});

test('environment completion: fills the final content cursor and ignores incomplete or mismatched shells', () => {
  const result = withEnvironmentSelection(parseSnippet('\\begin{equation}\n$0\n\\end{equation}'), 'x');
  assert.equal(result.text, '\\begin{equation}\nx\n\\end{equation}');
  assert.equal(result.text.slice(result.tabstops[0]!.from, result.tabstops[0]!.to), 'x');
  assert.equal(environmentBody('\\begin{equation}'), undefined);
  assert.equal(environmentBody('\\begin{equation}\\end{align}'), undefined);
  assert.equal(environmentBody('\\textbf{}'), undefined);
});

test('environment completion: the adjacent final cursor follows the filled content and nested defaults disappear', () => {
  const result = withEnvironmentSelection(parseSnippet('\\begin{equation}\n${1:old ${2:body}}$0\n\\end{equation}'), 'longer selected content');
  const content = result.tabstops.find(stop => stop.index === 1)!;
  const final = result.tabstops.find(stop => stop.index === 0)!;
  assert.equal(result.text.slice(content.from, content.to), 'longer selected content');
  assert.equal(final.from, content.to);
  assert.equal(final.to, final.from);
  assert.equal(result.tabstops.some(stop => stop.index === 2), false);
});
