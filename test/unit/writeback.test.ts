import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../../src/core/writeback.ts';
import { buildIslands, restoreIslands, islandMacros } from '../../src/core/islands.ts';
import { tokenize } from '../../src/core/lexer.ts';
import { diffText } from '../../src/core/patch.ts';
import type { MacroDef } from '../../src/shared/types.ts';

/** A stand-in for MathLive: drops whitespace, braces single-token scripts, unbraces \frac digits. */
function fakeCanon(s: string): string {
  const t = tokenize(s).filter(x => x.kind !== 'space').map(x => x.value);
  const out: string[] = [];
  for (let i = 0; i < t.length; i++) {
    out.push(t[i]);
    if ((t[i] === '_' || t[i] === '^') && t[i + 1] && t[i + 1] !== '{') { out.push('{', t[i + 1], '}'); i++; }
  }
  return out.join('').replace(/\{(\{[^{}]*\})\}/g, '$1');
}
const run = (source: string, edit: (canonical: string) => string) => {
  const before = fakeCanon(source);
  return reconcile(source, before, edit(before), fakeCanon);
};

test('a single symbol change keeps the user spacing', () => {
  assert.deepEqual(run('E = m c^2', c => c.replace('m', 'M')), { view: 'E = M c^2', strategy: 'aligned' });
});

test('appending after unbraced scripts', () => {
  assert.deepEqual(run('\\sum_{i=1}^n a_i', c => c + '+c'), { view: '\\sum_{i=1}^n a_i+c', strategy: 'aligned' });
});

test('growing an unbraced script widens to the script group', () => {
  const r = run('x_i + y', c => c.replace('{i}', '{ij}'));
  assert.equal(r.view, 'x_{ij} + y');
  assert.equal(fakeCanon(r.view), 'x_{ij}+y');
});

test('no change, and whole-body fallback when nothing aligns', () => {
  assert.deepEqual(run('a + b', c => c), { view: 'a + b', strategy: 'none' });
  const r = reconcile('  p  ', 'p', 'q', s => s === 'q' ? 'Q' : 'other'); // candidates never verify
  assert.deepEqual(r, { view: '  q  ', strategy: 'body' });
});

test('deleting a token', () => {
  assert.equal(run('a + b + c', c => c.replace('+b', '')).view, 'a + c');
});

const macros = new Map<string, MacroDef>([
  ['ket', { name: 'ket', arity: 1, body: '\\left|#1\\right\\rangle' }],
  ['pair', { name: 'pair', arity: 2, body: '#1+#2', defaultArgument: 'x' }],
]);

test('islands: exact restore, swallowed separators, optional arguments, metadata', () => {
  const body = '\\ket{\\psi}b + \\pair{y} + \\pair[z] w \\label{eq:a} \\ket \\phi';
  const { view, islands } = buildIslands(body, macros);
  assert.equal(view, '\\OMTa b + \\OMTb + \\OMTc \\OMTd \\OMTe');
  assert.equal(restoreIslands(view, islands), body);
  assert.deepEqual(islands.map(i => [i.kind, i.text]), [['macro', '\\ket{\\psi}'], ['macro', '\\pair{y}'], ['macro', '\\pair[z] w'], ['meta', '\\label{eq:a}'], ['macro', '\\ket \\phi']]);
  assert.equal(islands[1].render, '{x}+{y}');
  assert.equal(islands[0].render, '\\left|{\\psi}\\right\\rangle');
  assert.deepEqual(Object.keys(islandMacros(islands)), ['OMTa', 'OMTb', 'OMTc', 'OMTd', 'OMTe']);
});

test('islands survive an edit elsewhere byte-for-byte', () => {
  const body = '\\ket{\\psi}+a';
  const { view, islands } = buildIslands(body, macros);
  const r = reconcile(view, fakeCanon(view), fakeCanon(view).replace(/a$/, 'b'), fakeCanon);
  assert.equal(restoreIslands(r.view, islands), '\\ket{\\psi}+b');
});

test('deleting a spaced island preserves all source trivia around the call', () => {
  const body = 'a + \\pair [z]  {w} \t+ b';
  const { view, islands } = buildIslands(body, macros);
  const before = fakeCanon(view), after = before.replace('\\OMTa', '');
  const result = reconcile(view, before, after, fakeCanon, islands);
  const restored = restoreIslands(result.view, islands);
  assert.equal(restored, 'a +  \t+ b');
  const patch = diffText(body, restored)!;
  assert.equal(body.slice(patch.from, patch.to), '\\pair [z]  {w}');
  assert.equal(patch.insert, '');
});

test('island deletion distinguishes projected separators from existing spaces before letters', () => {
  // Like a real TeX serializer, preserve the space needed between a control word and a letter.
  const canon = (source: string) => tokenize(source).filter(t => t.kind !== 'space').reduce((out, token) =>
    out + (/\\[a-zA-Z]+$/.test(out) && /^[a-zA-Z]/.test(token.value) ? ' ' : '') + token.value, '');
  for (const gap of ['', ' ']) {
    const body = `a + \\pair[z]{w}${gap}b`;
    const { view, islands } = buildIslands(body, macros);
    assert.equal(islands[0].swallow, !gap);
    const result = reconcile(view, canon(view), 'a+b', canon, islands);
    const restored = restoreIslands(result.view, islands);
    assert.equal(restored, `a + ${gap}b`);
    const patch = diffText(body, restored)!;
    assert.equal(body.slice(patch.from, patch.to), '\\pair[z]{w}');
    assert.equal(patch.insert, '');
  }
});

test('unknown commands become chips with their groups', () => {
  const { view, islands } = buildIslands('\\foo{a}[b] + \\bar', new Map(), new Set(['foo']));
  assert.equal(view, '\\OMTa + \\bar');
  assert.equal(islands[0].text, '\\foo{a}[b]');
});

test('never leaves an argument-taking command bare', () => {
  // MathLive accepts \boldsymbol{} and the bare command alike; TeX does not.
  const canon = (s: string) => s.replace(/\s+/g, '').replace(/\\boldsymbol\{\}|\\boldsymbol$/, '\\bm{}');
  const r = reconcile('\\boldsymbol{\\alpha}', '\\boldsymbol{\\alpha}', '\\boldsymbol{}', canon);
  assert.equal(r.view, '\\boldsymbol{}');
});

test('an insertion at the end attaches to the last token, not after a newline', () => {
  const canon = (s: string) => s.replace(/\s+/g, '');
  assert.equal(reconcile('a + b\n', 'a+b', 'a+b+e', canon).view, 'a + b+e\n');
});

test('a non-idempotent style serializer accepts its first matching serialization', () => {
  const canon = (s: string) => `{${s.replace(/\s+/g, '')}}`;
  const source = '\\textstyle a + b\n';
  const before = canon(source), after = canon(source.trimEnd() + '+q');
  assert.deepEqual(reconcile(source, before, after, canon), { view: '\\textstyle a + b+q\n', strategy: 'aligned' });
});

test('token diff ignores unrelated serializer regrouping and retains original bytes', () => {
  const canon = (s: string) => s.replace(/[\s{}]/g, '');
  const result = reconcile(' a + b\n', '{a}+{b}', '{{a}}+{{b}}+q', canon);
  assert.deepEqual(result, { view: ' a + b+q\n', strategy: 'aligned' });
  assert.deepEqual(diffText(' a + b\n', result.view), { from: 6, to: 6, insert: '+q' });
});

test('relaxed group alignment still verifies script semantics', () => {
  const result = run('x_i + y', c => c.replace('{i}', '{ij}'));
  assert.equal(result.view, 'x_{ij} + y');
  assert.equal(fakeCanon(result.view), 'x_{ij}+y');
});
