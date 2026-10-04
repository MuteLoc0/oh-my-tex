import { ChangeSet, Text, type EditorState } from '@codemirror/state';
import type { Change, Patch } from '../shared/types.ts';
import type { WebMessage } from '../shared/protocol.ts';

export interface SyncHost {
  post(message: WebMessage): void;
  /** Apply a host change (already rebased over local work) to the editor without re-reporting it. */
  applyRemote(changes: ChangeSet): void;
  replaceAll(text: string): void;
  log(message: string): void;
}

let txnCounter = 0;
const session = Math.random().toString(36).slice(2, 8);
interface Batch { changes: ChangeSet; kind: string }

/**
 * Optimistic client for the TextDocument. `base` is the last confirmed document text,
 * `inflight` is at most one transaction relative to `base`; queued IME boundaries
 * and `pending` are relative to the preceding local batches.
 * Remote changes are rebased over local work exactly like @codemirror/collab.
 */
export class SyncClient {
  version = -1;
  private base = Text.empty;
  private inflight?: Batch & { txn: string; doomed: boolean };
  /** Explicit IME boundaries waiting behind an outstanding host transaction. */
  private queued: Batch[] = [];
  private pending = ChangeSet.empty(0);
  private timer?: ReturnType<typeof setTimeout>;
  private compositionTimer?: ReturnType<typeof setTimeout>;
  private compositionHeld = false;
  private compositionWaiters: (() => void)[] = [];
  private flushWaiters: (() => void)[] = [];
  private kind = 'type';

  private host: SyncHost;
  private idleMs: number;
  constructor(host: SyncHost, idleMs = 300) { this.host = host; this.idleMs = idleMs; }

  get synced() { return !this.inflight && !this.queued.length && this.pending.empty; }
  /** Includes the short browser commit window after compositionend. */
  get composing() { return this.compositionHeld; }
  get confirmedText() { return this.base; }
  /** Map a host offset through local edits that have not been acknowledged yet. */
  localOffset(offset: number, assoc = 1): number {
    const changes = this.localChanges();
    return changes.mapPos(Math.max(0, Math.min(offset, this.base.length)), assoc);
  }

  init(version: number, text: string) {
    clearTimeout(this.timer);
    clearTimeout(this.compositionTimer);
    this.compositionHeld = false;
    this.releaseCompositionWaiters();
    this.version = version;
    this.base = Text.of(text.split('\n'));
    this.inflight = undefined;
    this.queued = [];
    this.pending = ChangeSet.empty(this.base.length);
    this.kind = 'type';
    this.notifyFlushed();
  }

  /** Record a local edit. `boundary` sends right away (word boundary, caret jump, completion, math). */
  local(changes: ChangeSet, kind: string, boundary: boolean) {
    this.pending = this.pending.compose(changes);
    if (kind !== 'type') { this.kind = kind; }
    clearTimeout(this.timer);
    if (this.compositionHeld) { this.kind = 'composition'; return; }
    if (boundary) { this.send(); } else { this.timer = setTimeout(() => this.send(), this.idleMs); }
  }

  /** Separate the preceding typing batch, then keep every IME revision in one host edit. */
  beginComposition() {
    clearTimeout(this.compositionTimer);
    if (!this.compositionHeld) { this.queuePending(); this.send(); }
    this.compositionHeld = true;
    clearTimeout(this.timer);
  }

  endComposition(graceMs = 50) {
    if (!this.compositionHeld) { return; }
    clearTimeout(this.compositionTimer);
    this.compositionTimer = setTimeout(() => {
      this.compositionHeld = false;
      this.compositionTimer = undefined;
      this.queuePending();
      this.send();
      this.releaseCompositionWaiters();
    }, graceMs);
  }

  /** Commands must wait before inspecting a field whose committed input is still queued. */
  waitForComposition(): Promise<void> {
    if (!this.compositionHeld) { return Promise.resolve(); }
    return new Promise(resolve => this.compositionWaiters.push(resolve));
  }

  flush(): Promise<void> {
    this.send();
    return new Promise(resolve => { this.flushWaiters.push(resolve); this.notifyFlushed(); });
  }

  send() {
    clearTimeout(this.timer);
    if (this.compositionHeld) { return; }
    if (this.inflight || !this.queued.length && this.pending.empty) { this.notifyFlushed(); return; }
    const queued = this.queued.shift();
    const batch = queued ?? { changes: this.pending, kind: this.kind };
    if (!queued) {
      this.pending = ChangeSet.empty(this.pending.newLength);
      this.kind = 'type';
    }
    const patches: Patch[] = [];
    batch.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      patches.push({ from: fromA, to: toA, expected: this.base.sliceString(fromA, toA), insert: inserted.toString() });
    });
    const txn = `${session}-${++txnCounter}`;
    this.inflight = { txn, ...batch, doomed: false };
    this.host.post({ t: 'edit', txn, baseVersion: this.version, patches, kind: batch.kind });
  }

  docChanged(version: number, changes: Change[], originTxn?: string) {
    if (version !== this.version + 1 && version !== this.version) {
      this.host.log(`version gap ${this.version} -> ${version}; resyncing`);
      this.host.post({ t: 'resync' });
      return;
    }
    const remote = ChangeSet.of(changes.map(c => ({ from: c.from, to: c.to, insert: c.insert })), this.base.length);
    const inflight = this.inflight;
    if (inflight && !inflight.doomed && originTxn === inflight.txn && inflight.changes.apply(this.base).eq(remote.apply(this.base))) {
      this.base = inflight.changes.apply(this.base);
      this.version = version;
      this.inflight = undefined;
      this.send();
      return;
    }
    // A foreign change: rebase all unconfirmed local work over it. Any inflight txn will be rejected as stale.
    const local = this.localChanges();
    const rebasedRemote = remote.map(local, true);
    const batches = [...(inflight && !inflight.doomed ? [inflight] : []), ...this.queued, { changes: this.pending, kind: this.kind }];
    let over = remote;
    const rebased = batches.map(batch => {
      const changes = batch.changes.map(over);
      over = over.map(batch.changes, true);
      return { changes, kind: batch.kind };
    });
    this.base = remote.apply(this.base);
    this.version = version;
    if (this.compositionHeld || this.queued.length || rebased.some(batch => batch.kind === 'composition' && !batch.changes.empty)) {
      this.pending = rebased.pop()!.changes;
      this.queued = rebased.filter(batch => !batch.changes.empty);
    } else {
      // Ordinary typing keeps its original single-retry behavior.
      this.pending = local.map(remote);
      this.queued = [];
      this.kind = batches.find(batch => batch.kind !== 'type')?.kind ?? 'type';
    }
    if (inflight) { inflight.doomed = true; }
    this.host.applyRemote(rebasedRemote);
    if (!inflight) { this.send(); }
  }

  txnResult(txn: string, ok: boolean, reason?: string) {
    const inflight = this.inflight;
    if (!inflight || inflight.txn !== txn) { return; }
    this.inflight = undefined;
    if (inflight.doomed) { this.send(); return; }
    if (ok) {
      // Applied without a document change event (a no-op edit).
      this.base = inflight.changes.apply(this.base);
      this.send();
      return;
    }
    this.host.log(`transaction rejected (${reason}); resyncing`);
    this.host.post({ t: 'resync' });
  }

  reset(version: number, text: string) {
    this.init(version, text);
    this.host.replaceAll(text);
  }

  /** True when `state` has no unconfirmed edits, so its offsets equal document offsets. */
  matches(state: EditorState) { return !this.compositionHeld && this.synced && state.doc.length === this.base.length; }

  private queuePending() {
    if (this.pending.empty) { this.kind = 'type'; return; }
    this.queued.push({ changes: this.pending, kind: this.kind });
    this.pending = ChangeSet.empty(this.pending.newLength);
    this.kind = 'type';
  }

  private localChanges() {
    let changes = this.inflight && !this.inflight.doomed ? this.inflight.changes : ChangeSet.empty(this.base.length);
    for (const batch of this.queued) { changes = changes.compose(batch.changes); }
    return changes.compose(this.pending);
  }

  private releaseCompositionWaiters() {
    const waiters = this.compositionWaiters; this.compositionWaiters = [];
    waiters.forEach(resolve => resolve());
  }

  private notifyFlushed() {
    if (this.compositionHeld || !this.synced) { return; }
    const waiters = this.flushWaiters; this.flushWaiters = [];
    waiters.forEach(w => w());
  }
}
