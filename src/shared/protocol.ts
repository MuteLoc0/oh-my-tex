import type { Change, EditorSettings, Patch, ProjectContext } from './types.ts';

export const PROTOCOL_VERSION = 1;

export interface CompletionItemDTO {
  i: number;                         // index into the host's per-request registry
  label: string; detail?: string; description?: string; doc?: string; kind?: number;
  filterText?: string; sortText?: string; preselect?: boolean;
  insert: { snippet: boolean; value: string };
  range: { insFrom: number; insTo: number; repFrom: number; repTo: number };
  extraEdits?: Change[];
  command?: 'triggerSuggest' | 'host';
  source?: 'provider' | 'macro' | 'template' | 'snippet' | 'word';
}

export type HostMessage =
  | { t: 'init'; proto: number; uri: string; version: number; text: string; settings: EditorSettings }
  | { t: 'docChanged'; version: number; changes: Change[]; originTxn?: string }
  | { t: 'reset'; version: number; text: string }
  | { t: 'txnResult'; txn: string; ok: boolean; reason?: string }
  | ({ t: 'context' } & ProjectContext)
  | { t: 'completions'; req: string; version: number; at: number; isIncomplete: boolean; items: CompletionItemDTO[] }
  | { t: 'reveal'; anchor: number; head: number; focus: boolean; version?: number }
  | { t: 'settings'; settings: EditorSettings }
  | { t: 'command'; name: 'toggleSource' | 'flush' | 'find'; req?: string; stabilize?: boolean };

export type WebMessage =
  | { t: 'ready'; proto: number }
  | { t: 'edit'; txn: string; baseVersion: number; patches: Patch[]; kind: string }
  | { t: 'complete'; req: string; version: number; at: number; trigger: { kind: 'invoke' | 'char' | 'incomplete'; char?: string }; ctx: 'prose' | 'math' }
  | { t: 'runItemCommand'; req: string; item: number }
  | { t: 'selection'; version: number; anchor: number; head: number }
  | { t: 'flushed'; req: string; ok?: boolean }
  | { t: 'undo' | 'redo' | 'save' | 'synctex' | 'build' | 'view' | 'syncRoot' | 'openNative' | 'resync' }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; message: string };

const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isReq = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 128;
const isTrigger = (v: unknown): boolean => {
  if (!v || typeof v !== 'object') { return false; }
  const trigger = v as Record<string, unknown>;
  return trigger.kind === 'char' ? isStr(trigger.char) && [...trigger.char].length === 1
    : (trigger.kind === 'invoke' || trigger.kind === 'incomplete') && trigger.char === undefined;
};

/** Webview content is untrusted: validate structure before the host acts on anything. */
export function isWebMessage(m: unknown): m is WebMessage {
  if (!m || typeof m !== 'object') { return false; }
  const msg = m as Record<string, unknown>;
  switch (msg.t) {
    case 'ready': return msg.proto === PROTOCOL_VERSION;
    case 'edit': return isStr(msg.txn) && isInt(msg.baseVersion) && Array.isArray(msg.patches) && isStr(msg.kind)
      && msg.patches.every(p => p && typeof p === 'object' && isInt(p.from) && isInt(p.to) && isStr(p.expected) && isStr(p.insert));
    case 'complete': return isReq(msg.req) && isInt(msg.version) && isInt(msg.at) && (msg.ctx === 'prose' || msg.ctx === 'math') && isTrigger(msg.trigger);
    case 'runItemCommand': return isReq(msg.req) && isInt(msg.item);
    case 'selection': return isInt(msg.version) && isInt(msg.anchor) && isInt(msg.head);
    case 'flushed': return isReq(msg.req) && (msg.ok === undefined || typeof msg.ok === 'boolean');
    case 'log': return isStr(msg.message) && ['info', 'warn', 'error'].includes(String(msg.level));
    case 'undo': case 'redo': case 'save': case 'synctex': case 'build': case 'view': case 'syncRoot': case 'openNative': case 'resync': return true;
    default: return false;
  }
}
