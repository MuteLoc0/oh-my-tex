import type { Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { CompletionItemDTO, HostMessage, WebMessage } from '../../shared/protocol.ts';
import type { SyncClient } from '../sync.ts';

interface Intent {
  resolution: string; req: string; item: number; at: number; version?: number; doc: Text; view: EditorView;
  current: () => boolean; accept: (value: CompletionItemDTO | undefined, version: number) => void;
}
let nextResolution = 0;

/** Resolve only an explicit acceptance, without blocking typing or applying
 * delayed edits after the document, caret, focus or selected item changes. */
export class CompletionResolver {
  private intent?: Intent;
  private readonly sync: SyncClient;
  private readonly post: (message: WebMessage) => void;
  constructor(sync: SyncClient, post: (message: WebMessage) => void) { this.sync = sync; this.post = post; }
  get pending(): boolean { return !!this.intent; }

  start(req: string, item: number, view: EditorView, at: number, current: () => boolean,
    accept: Intent['accept']): void {
    this.cancel();
    const intent: Intent = { resolution: `resolve-${++nextResolution}`, req, item, view, at, doc: view.state.doc, current, accept };
    this.intent = intent;
    void this.sync.flush().then(() => {
      if (this.intent !== intent) { return; }
      if (!this.current(intent)) { this.cancel(); return; }
      const version = this.sync.version;
      intent.version = version;
      this.post({ t: 'resolveCompletion', resolution: intent.resolution, req, item, at, version });
    });
  }

  receive(message: Extract<HostMessage, { t: 'completionResolved' }>): void {
    const intent = this.intent;
    if (!intent || message.resolution !== intent.resolution || message.req !== intent.req || message.item !== intent.item
      || message.version !== intent.version || message.at !== intent.at) { return; }
    this.cancel();
    if (this.sync.version !== message.version || !this.current(intent)) { return; }
    intent.accept(message.value?.i === intent.item ? message.value : undefined, message.version);
  }

  cancel(): void { this.intent = undefined; }
  private current(intent: Intent): boolean {
    return intent.current() && this.sync.matches(intent.view.state) && intent.doc.eq(intent.view.state.doc);
  }
}
