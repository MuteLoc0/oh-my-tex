import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChangeSet, Text } from '@codemirror/state';
import { SyncClient } from '../../src/webview/sync.ts';
import { applyPatches, validatePatches } from '../../src/core/patch.ts';
import type { WebMessage } from '../../src/shared/protocol.ts';

/** A fake host + editor pair: the host applies edits like DocumentSync, the editor applies remote changes. */
function setup(initial: string) {
  const host = { text: initial, version: 1 };
  let editor = Text.of(initial.split('\n'));
  const outbox: WebMessage[] = [];
  const client = new SyncClient({
    post: m => outbox.push(m),
    applyRemote: changes => { editor = changes.apply(editor); },
    replaceAll: text => { editor = Text.of(text.split('\n')); },
    log: () => {},
  }, 10_000);
  client.init(host.version, initial);
  const type = (from: number, to: number, insert: string, boundary = true) => {
    const changes = ChangeSet.of({ from, to, insert }, editor.length);
    editor = changes.apply(editor);
    client.local(changes, 'type', boundary);
  };
  /** Process one queued edit on the host, delivering docChanged + txnResult like the real session. */
  const hostStep = () => {
    const m = outbox.shift();
    if (!m || m.t !== 'edit') { return m; }
    const reason = m.baseVersion !== host.version ? 'stale' : validatePatches(host.text, m.patches);
    if (!reason) {
      host.text = applyPatches(host.text, m.patches); host.version++;
      client.docChanged(host.version, m.patches.map(({ from, to, insert }) => ({ from, to, insert })), m.txn);
    }
    client.txnResult(m.txn, !reason, reason);
    return m;
  };
  const remote = (from: number, to: number, insert: string) => {
    host.text = applyPatches(host.text, [{ from, to, insert }]); host.version++;
    client.docChanged(host.version, [{ from, to, insert }]);
  };
  return { host, client, outbox, type, hostStep, remote, editor: () => editor.toString() };
}

test('local edits are confirmed in order', () => {
  const s = setup('hello');
  s.type(5, 5, ' world');
  s.type(0, 1, 'H');      // queued while the first is in flight
  assert.equal(s.outbox.length, 1);
  s.hostStep(); s.hostStep();
  assert.equal(s.host.text, 'Hello world');
  assert.equal(s.editor(), 'Hello world');
  assert.ok(s.client.synced);
});

test('a foreign change while an edit is in flight is rebased, the edit resent', () => {
  const s = setup('abc');
  s.type(3, 3, 'X');           // in flight: abcX
  s.remote(0, 0, '>');         // native editor typed first: >abc
  assert.equal(s.editor(), '>abcX');
  const first = s.hostStep();  // rejected as stale
  assert.equal(first?.t, 'edit');
  s.hostStep();                // resent and applied
  assert.equal(s.host.text, '>abcX');
  assert.equal(s.editor(), '>abcX');
  assert.ok(s.client.synced);
});

test('batched typing stays pending until flushed', async () => {
  const s = setup('');
  s.type(0, 0, 'a', false); s.type(1, 1, 'b', false);
  assert.equal(s.outbox.length, 0);
  const flushed = s.client.flush();
  assert.equal(s.outbox.length, 1);
  s.hostStep();
  await flushed;
  assert.equal(s.host.text, 'ab');
});

test('host coordinates map through pending, inflight and rebased edits', () => {
  const s = setup('abc');
  s.type(0, 0, 'X', false);
  assert.equal(s.client.localOffset(2), 3);
  s.client.send();
  s.type(1, 1, 'Y', false);
  assert.equal(s.client.localOffset(2), 4);
  s.remote(0, 0, '>');
  assert.equal(s.editor(), '>XYabc');
  assert.equal(s.client.localOffset(3), 5);
  s.hostStep(); s.hostStep();
  assert.equal(s.client.localOffset(5), 5);
});

test('composition revisions ignore boundaries, idle and flush until one atomic commit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup('prefix ');
  s.client.beginComposition();
  s.type(7, 7, 'gong.', true);
  t.mock.timers.tick(20_000);
  assert.equal(s.outbox.length, 0, 'a composition must not start an idle send');
  s.type(7, 12, '公式中文', true);
  let done = false;
  const flushed = s.client.flush().then(() => { done = true; });
  s.client.send();
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(s.outbox.length, 0);
  s.client.endComposition();
  t.mock.timers.tick(49);
  assert.equal(s.outbox.length, 0, 'the final input notification is still protected');
  t.mock.timers.tick(1);
  assert.equal(s.outbox.length, 1);
  const edit = s.hostStep();
  assert.equal(edit?.t, 'edit');
  if (edit?.t === 'edit') {
    assert.equal(edit.kind, 'composition');
    assert.deepEqual(edit.patches, [{ from: 7, to: 7, expected: '', insert: '公式中文' }]);
  }
  await flushed;
  assert.equal(done, true);
  assert.equal(s.host.text, 'prefix 公式中文');
});

test('a composition holds acknowledgement-triggered sends and restarts the commit grace period', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup('');
  s.type(0, 0, 'x');
  s.client.beginComposition();
  s.type(1, 1, '中');
  s.hostStep();
  assert.equal(s.outbox.length, 0, 'acknowledging prior input cannot flush an IME revision');
  s.client.endComposition();
  t.mock.timers.tick(30);
  s.client.beginComposition();
  s.type(1, 2, '中文');
  t.mock.timers.tick(100);
  assert.equal(s.outbox.length, 0);
  let released = false;
  const settled = s.client.waitForComposition().then(() => { released = true; });
  s.client.endComposition();
  t.mock.timers.tick(50);
  await settled;
  assert.equal(released, true);
  s.hostStep();
  assert.equal(s.host.text, 'x中文');
  assert.ok(s.client.synced);
});

test('a delayed acknowledgement keeps preceding pending text outside the composition transaction', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup('');
  s.type(0, 0, 'a'); // outstanding host transaction
  s.type(1, 1, 'b', false); // preceding text still pending
  s.client.beginComposition();
  s.type(2, 2, 'gong');
  s.type(2, 6, '中文');
  s.hostStep(); // acknowledge a during composition
  assert.equal(s.host.text, 'a');
  assert.equal(s.outbox.length, 0);
  s.client.endComposition();
  t.mock.timers.tick(50);
  const preceding = s.hostStep();
  assert.equal(s.host.text, 'ab');
  assert.equal(preceding?.t === 'edit' && preceding.kind, 'type');
  const composition = s.hostStep();
  assert.equal(composition?.t, 'edit');
  if (composition?.t === 'edit') {
    assert.equal(composition.kind, 'composition');
    assert.deepEqual(composition.patches, [{ from: 2, to: 2, expected: '', insert: '中文' }]);
  }
  assert.equal(s.host.text, 'ab中文');
  assert.ok(s.client.synced);
});

test('foreign edits rebase IME batch boundaries without merging a preceding word', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = setup('');
  s.type(0, 0, 'a');
  s.type(1, 1, 'b', false);
  s.client.beginComposition();
  s.remote(0, 0, '>'); // before any IME revision is recorded
  s.type(3, 3, '中');
  s.client.endComposition();
  t.mock.timers.tick(50);
  s.hostStep(); // stale a
  s.hostStep(); // rebased a
  s.hostStep(); // preceding b
  const composition = s.hostStep();
  if (composition?.t !== 'edit') { assert.fail('missing isolated composition transaction'); }
  assert.deepEqual(composition.patches, [{ from: 3, to: 3, expected: '', insert: '中' }]);
  assert.equal(s.host.text, '>ab中');
  assert.equal(s.editor(), '>ab中');
  assert.ok(s.client.synced);
});
