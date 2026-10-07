import * as vscode from 'vscode';
import { LineIndex, toLF } from '../core/eol.ts';
import { filterCompletions } from '../core/completionFilter.ts';
import { filterMathCompletions } from '../core/mathCompletionFilter.ts';
import type { CompletionItemDTO, WebMessage } from '../shared/protocol.ts';
import type { Session } from './session.ts';
import { log } from './log.ts';
import { SnippetStore } from './snippetStore.ts';

type CompleteRequest = Extract<WebMessage, { t: 'complete' }>;
type ProviderItem = { index: number; identity: string; version: number; at: number; trigger: CompleteRequest['trigger']; resolution?: string; consumed?: boolean };
type Candidate = Omit<CompletionItemDTO, 'i'> & { hostCommand?: vscode.Command; provider?: ProviderItem };
interface Registry {
  sequence: number; disposed: boolean; active?: string; seen: Set<string>;
  requests: Map<string, Map<number, vscode.Command>>; providers: Map<string, Map<number, ProviderItem>>;
}
const LIMIT = 300;

/** Query language providers, then fill gaps in editor snippets and document word suggestions. */
export class CompletionBridge implements vscode.Disposable {
  private registries = new WeakMap<Session, Registry>();
  private readonly snippets: SnippetStore;
  private readonly wordCache = new WeakMap<vscode.TextDocument, { version: number; words: string[] }>();
  private disposed = false;

  constructor(globalStorageUri?: vscode.Uri) {
    this.snippets = new SnippetStore(globalStorageUri);
  }

  async complete(session: Session, request: CompleteRequest): Promise<void> {
    if (this.disposed) { return; }
    let registry = this.registries.get(session);
    if (!registry) { registry = { sequence: 0, disposed: false, seen: new Set(), requests: new Map(), providers: new Map() }; this.registries.set(session, registry); }
    // Reusing a request must never replace capabilities associated with an earlier response.
    if (registry.seen.has(request.req) || registry.requests.has(request.req)) { return; }
    registry.seen.add(request.req);
    if (registry.seen.size > 512) { registry.seen.delete(registry.seen.values().next().value!); }
    const sequence = ++registry.sequence;
    registry.active = request.req;
    const document = session.document, text = toLF(document.getText()), index = new LineIndex(text);
    const empty = (incomplete: boolean) => session.post({ t: 'completions', req: request.req, version: document.version, at: request.at, isIncomplete: incomplete, items: [] });
    if (request.version !== document.version) { await empty(true); return; }
    if (request.at > text.length) { await empty(false); return; }
    const p = index.positionAt(request.at), position = new vscode.Position(p.line, p.character);
    const word = document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
    const wordFrom = index.offsetAt(word.start.line, word.start.character), wordTo = index.offsetAt(word.end.line, word.end.character);
    const fallbackRange = { insFrom: wordFrom, insTo: request.at, repFrom: wordFrom, repTo: wordTo };
    const query = text.slice(wordFrom, request.at);
    const beforeSlash = wordFrom > 0 && text[wordFrom - 1] === '\\';
    // List first; provider details are fetched only for the accepted item.
    // Start independent remote work together rather than adding its round trips.
    const [provider, context, snippets] = await Promise.all([
      this.query(document, position, request.trigger, 0), session.completionContext(), this.snippets.get(document),
    ]);
    if (this.disposed || registry.disposed || registry.sequence !== sequence) { return; }
    if (document.version !== request.version || registry.sequence !== sequence) { await empty(true); return; }
    const candidates: Candidate[] = [];
    for (const [providerIndex, item] of (provider?.items ?? []).entries()) {
      const converted = convertItem(item, document, index, fallbackRange, position);
      if (converted) {
        converted.needsResolve = true;
        converted.provider = { index: providerIndex, identity: itemIdentity(converted), version: request.version, at: request.at, trigger: request.trigger };
        candidates.push(converted);
      }
    }
    for (const macro of context.macros) {
      const name = `\\${macro.name}`;
      if (candidates.some(c => c.label === name || c.label === macro.name)) { continue; }
      let body = `${beforeSlash ? '' : '\\'}${macro.name}`, tab = 1;
      if (macro.defaultArgument !== undefined) { body += `[\${${tab++}:${escapeSnippet(macro.defaultArgument)}}]`; }
      for (let a = macro.defaultArgument !== undefined ? 1 : 0; a < macro.arity; a++) { body += `{$${tab++}}`; }
      candidates.push({ label: name, filterText: macro.name, detail: 'Project macro', doc: macro.body, kind: vscode.CompletionItemKind.Function,
        insert: { snippet: true, value: body }, range: fallbackRange, source: 'macro' });
    }
    for (const template of context.templates) {
      if (template.context !== 'both' && template.context !== request.ctx) { continue; }
      const range = beforeSlash && template.prefix.startsWith('\\') ? { ...fallbackRange, insFrom: wordFrom - 1, repFrom: wordFrom - 1 } : fallbackRange;
      candidates.push({ label: template.prefix, filterText: template.prefix.replace(/^\\/, ''), detail: template.label,
        insert: { snippet: true, value: toLF(template.body) }, range, kind: vscode.CompletionItemKind.Snippet, source: 'template' });
    }
    for (const snippet of snippets) {
      const range = beforeSlash && snippet.prefix.startsWith('\\') ? { ...fallbackRange, insFrom: wordFrom - 1, repFrom: wordFrom - 1 } : fallbackRange;
      candidates.push({ label: snippet.prefix, filterText: snippet.prefix.replace(/^\\/, ''), detail: snippet.name, doc: snippet.description,
        insert: { snippet: true, value: toLF(snippet.body) }, range, kind: vscode.CompletionItemKind.Snippet, source: 'snippet', sortText: snippet.sortText });
    }
    candidates.push(...this.words(document, text, query).map(word => ({ label: word, insert: { snippet: false, value: word }, range: fallbackRange,
      kind: vscode.CompletionItemKind.Text, source: 'word' as const })));
    const seen = new Set<string>();
    const unique = candidates.filter(c => {
      const key = JSON.stringify([c.label, c.insert, c.range, c.extraEdits]);
      if (seen.has(key)) { return false; } seen.add(key); return true;
    });
    const rawPatterns = vscode.workspace.getConfiguration('oh-my-tex', document.uri).get<unknown>('math.completionAllowPatterns', []);
    const patterns = Array.isArray(rawPatterns) ? rawPatterns.filter((pattern): pattern is string => typeof pattern === 'string') : [];
    const contextual = request.ctx === 'math' ? filterMathCompletions(unique, context.macros, patterns) : unique;
    const filtered = filterCompletions(contextual, query, LIMIT + 1);
    const commands = new Map<number, vscode.Command>();
    const providers = new Map<number, ProviderItem>();
    const items = filtered.slice(0, LIMIT).map((candidate, i): CompletionItemDTO => {
      const { hostCommand, provider: providerItem, ...dto } = candidate;
      if (hostCommand) { commands.set(i, hostCommand); }
      if (providerItem) { providers.set(i, providerItem); }
      return { ...dto, i };
    });
    registry.requests.set(request.req, commands);
    registry.providers.set(request.req, providers);
    while (registry.requests.size > 8) {
      const expired = registry.requests.keys().next().value!;
      registry.requests.delete(expired); registry.providers.delete(expired);
    }
    await session.post({ t: 'completions', req: request.req, version: request.version, at: request.at,
      isIncomplete: !!provider?.isIncomplete || filtered.length > LIMIT, items });
  }

  /** Public VS Code APIs cannot resolve a retained item. Re-query the confirmed
   * document, match its immutable identity, then resolve through its raw index.
   * Never apply an unresolved item or guess when multiple providers collide. */
  async resolve(session: Session, request: Extract<WebMessage, { t: 'resolveCompletion' }>): Promise<void> {
    const registry = this.registries.get(session), entry = registry?.providers.get(request.req)?.get(request.item);
    const commands = registry?.requests.get(request.req), document = session.document;
    let value: CompletionItemDTO | undefined;
    if (entry) { entry.resolution = request.resolution; }
    const current = () => !this.disposed && !!registry && !registry.disposed && registry.active === request.req
      && !!entry && entry.resolution === request.resolution && !entry.consumed
      && registry.requests.get(request.req) === commands && document.version === request.version;
    try {
      const text = toLF(document.getText());
      if (entry && commands && current() && request.at <= text.length) {
        const index = new LineIndex(text), p = index.positionAt(request.at), position = new vscode.Position(p.line, p.character);
        const word = document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
        const range = { insFrom: index.offsetAt(word.start.line, word.start.character), insTo: request.at,
          repFrom: index.offsetAt(word.start.line, word.start.character), repTo: index.offsetAt(word.end.line, word.end.character) };
        const matches = (list: vscode.CompletionList | undefined) => (list?.items ?? []).flatMap((item, rawIndex) => {
          const candidate = convertItem(item, document, index, range, position);
          return candidate && itemIdentity(candidate) === entry.identity ? [{ candidate, rawIndex }] : [];
        });
        let rawIndex = entry.index;
        const trigger: CompleteRequest['trigger'] = entry.version === request.version && entry.at === request.at ? entry.trigger : { kind: 'invoke' };
        if (entry.version !== request.version || entry.at !== request.at) {
          const preview = await this.query(document, position, trigger, 0);
          if (!current()) { return; }
          const found = matches(preview);
          if (found.length !== 1) { return; }
          rawIndex = found[0]!.rawIndex;
        }
        const resolved = await this.query(document, position, trigger, rawIndex + 1);
        if (!current()) { return; }
        const found = matches(resolved);
        if (found.length === 1 && found[0]!.rawIndex <= rawIndex) {
          const { hostCommand, provider: _provider, ...dto } = found[0]!.candidate;
          commands.delete(request.item);
          if (hostCommand) { commands.set(request.item, hostCommand); }
          value = { ...dto, i: request.item };
        }
      }
    } finally {
      await session.post({ t: 'completionResolved', resolution: request.resolution, req: request.req, item: request.item, version: request.version, at: request.at, value });
    }
  }

  cancel(session: Session, req: string): void {
    const registry = this.registries.get(session);
    if (registry?.active === req) { registry.sequence++; registry.active = undefined; }
  }

  private async query(document: vscode.TextDocument, position: vscode.Position, trigger: CompleteRequest['trigger'], resolveCount: number) {
    try {
      return await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position,
        trigger.kind === 'char' ? trigger.char : undefined, resolveCount);
    } catch (error) { log().warn(`completion provider failed: ${String(error)}`); return undefined; }
  }

  async runCommand(session: Session, req: string, item: number): Promise<void> {
    const registry = this.registries.get(session), commands = registry?.requests.get(req), command = commands?.get(item);
    if (!command) { return; }
    commands!.delete(item);
    const provider = registry?.providers.get(req)?.get(item);
    if (provider) { provider.consumed = true; }
    try { await vscode.commands.executeCommand(command.command, ...(command.arguments ?? [])); }
    catch (error) { log().warn(`completion command failed: ${String(error)}`); }
  }

  dispose(session?: Session): void {
    if (!session) { this.disposed = true; this.snippets.dispose(); return; }
    const registry = this.registries.get(session);
    if (registry) { registry.disposed = true; registry.requests.clear(); registry.providers.clear(); }
    this.registries.delete(session);
  }

  private words(document: vscode.TextDocument, text: string, query: string): string[] {
    const mode = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId }).get<string | boolean>('wordBasedSuggestions', 'matchingDocuments');
    if (mode === false || mode === 'off') { return []; }
    const documents = mode === 'currentDocument' ? [document] : vscode.workspace.textDocuments.filter(d => d === document || mode === 'allDocuments' || d.languageId === document.languageId);
    const words = new Set<string>();
    for (const doc of documents) {
      let cached = this.wordCache.get(doc);
      if (!cached || cached.version !== doc.version) {
        const source = doc === document ? text : toLF(doc.getText());
        cached = { version: doc.version, words: [...new Set([...source.matchAll(/[\p{L}_][\p{L}\p{N}_-]+/gu)].map(match => match[0]))] };
        this.wordCache.set(doc, cached);
      }
      for (const word of cached.words) { if (word !== query) { words.add(word); } }
    }
    return [...words];
  }
}

/** Resolution may add documentation, commands and extra edits, but cannot
 * change the item's primary insertion/filter identity. Ranges are re-derived
 * from the newly confirmed document when the prefix has changed. */
function itemIdentity(item: Candidate): string {
  return JSON.stringify([item.label, item.kind, item.filterText, item.sortText, item.insert]);
}

const escapeSnippet = (text: string) => text.replace(/[\\$}]/g, '\\$&');

function convertItem(item: vscode.CompletionItem, document: vscode.TextDocument, index: LineIndex, fallback: CompletionItemDTO['range'], position: vscode.Position): Candidate | undefined {
  const label = typeof item.label === 'string' ? item.label : item.label.label;
  const input = item.textEdit?.newText ?? item.insertText ?? label;
  const insert = input instanceof vscode.SnippetString ? { snippet: true, value: toLF(input.value) } : { snippet: false, value: toLF(input) };
  const supplied = item.textEdit?.range ?? item.range;
  const offsetRange = (range: vscode.Range) => {
    for (const point of [range.start, range.end]) {
      if (point.line < 0 || point.line >= document.lineCount || point.character < 0 || point.character > document.lineAt(point.line).text.length) { return undefined; }
    }
    return { from: index.offsetAt(range.start.line, range.start.character), to: index.offsetAt(range.end.line, range.end.character) };
  };
  let range = fallback;
  if (supplied) {
    const inserting = supplied instanceof vscode.Range ? supplied : supplied.inserting;
    const replacing = supplied instanceof vscode.Range ? supplied : supplied.replacing;
    const ins = offsetRange(inserting), rep = offsetRange(replacing);
    if (!ins || !rep || !inserting.contains(position) || !replacing.contains(position)) { return undefined; }
    range = { insFrom: ins.from, insTo: ins.to, repFrom: rep.from, repTo: rep.to };
  }
  const extraEdits = [];
  for (const edit of item.additionalTextEdits ?? []) {
    const converted = offsetRange(edit.range);
    if (!converted) { return undefined; }
    extraEdits.push({ ...converted, insert: toLF(edit.newText) });
  }
  return {
    label, detail: item.detail, description: typeof item.label === 'string' ? undefined : item.label.description,
    doc: typeof item.documentation === 'string' ? item.documentation : item.documentation?.value,
    kind: item.kind, filterText: item.filterText, sortText: item.sortText, preselect: item.preselect, insert, range,
    extraEdits: extraEdits.length ? extraEdits : undefined, source: 'provider',
    command: item.command ? item.command.command === 'editor.action.triggerSuggest' ? 'triggerSuggest' : 'host' : undefined,
    hostCommand: item.command?.command !== 'editor.action.triggerSuggest' ? item.command : undefined,
  };
}
