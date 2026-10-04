import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, groupAt, significant } from '../../src/core/lexer.ts';
import { applyPatches, diffText, validatePatches } from '../../src/core/patch.ts';
import { LineIndex, toLF } from '../../src/core/eol.ts';
import { SerialQueue } from '../../src/core/serial.ts';

test('lexer: commands, comments, verb, surrogates', () => {
  const t = tokenize('\\alpha%c\n\\verb|x$|𝔸 \\$');
  assert.deepEqual(t.map(x => [x.kind, x.value]), [['command', '\\alpha'], ['comment', '%c'], ['space', '\n'], ['verbatim', '\\verb|x$|'], ['char', '𝔸'], ['space', ' '], ['command', '\\$']]);
  const s = significant(tokenize('\\frac{a}{[b]}'));
  assert.equal(groupAt(s, 1)?.next, 4);
  assert.equal(groupAt(tokenize('[a{]}]'), 0, '[', ']')?.end, 6);
});

test('patch: validate expected text, overlap and placeholder leaks', () => {
  const text = 'E = mc^2';
  assert.equal(validatePatches(text, [{ from: 4, to: 5, expected: 'm', insert: 'M' }]), undefined);
  assert.equal(validatePatches(text, [{ from: 4, to: 5, expected: 'x', insert: 'M' }]), 'expectedMismatch');
  assert.equal(validatePatches(text, [{ from: 0, to: 3, expected: 'E =', insert: '' }, { from: 2, to: 4, expected: '= ', insert: '' }]), 'invalid or overlapping range');
  assert.equal(validatePatches(text, [{ from: 0, to: 0, expected: '', insert: '\\placeholder{}' }]), 'placeholder leak');
  assert.equal(applyPatches(text, [{ from: 4, to: 5, insert: 'M' }, { from: 0, to: 1, insert: 'F' }]), 'F = Mc^2');
});

test('diffText: minimal middle, surrogate safe', () => {
  assert.deepEqual(diffText('a+b', 'a+c'), { from: 2, to: 3, insert: 'c' });
  assert.deepEqual(diffText('xx', 'xxx'), { from: 2, to: 2, insert: 'x' });
  assert.equal(diffText('same', 'same'), undefined);
  // 𝔸 = d835 dd38, 𝔹 = d835 dd39: must not split the pair
  assert.deepEqual(diffText('𝔸', '𝔹'), { from: 0, to: 2, insert: '𝔹' });
});

test('eol: LF offsets <-> positions', () => {
  const index = new LineIndex(toLF('ab\r\ncd\r\n\r\nef'));
  assert.equal(index.text, 'ab\ncd\n\nef');
  assert.deepEqual(index.positionAt(4), { line: 1, character: 1 });
  assert.equal(index.offsetAt(3, 1), 8);
  assert.equal(index.offsetAt(0, 99), 2);
  assert.deepEqual(index.positionAt(index.text.length), { line: 3, character: 2 });
});

test('serial queue survives failures and reports idle', async () => {
  const q = new SerialQueue(), order: number[] = [];
  const a = q.run('d', async () => { await new Promise(r => setTimeout(r, 5)); order.push(1); throw new Error('x'); });
  const b = q.run('d', async () => { order.push(2); return 7; });
  await assert.rejects(a);
  assert.equal(await b, 7);
  await q.idle('d');
  assert.deepEqual(order, [1, 2]);
});
