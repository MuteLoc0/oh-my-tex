import * as vscode from 'vscode';
import { parse } from 'jsonc-parser';
import { LineIndex, toLF } from '../core/eol.ts';
import { filterCompletions } from '../core/completionFilter.ts';
import { filterMathCompletions } from '../core/mathCompletionFilter.ts';
import type { CompletionItemDTO, WebMessage } from '../shared/protocol.ts';
import type { Session } from './session.ts';
import { log } from './log.ts';

type CompleteRequest = Extract<WebMessage, { t: 'complete' }>;
type Candidate = Omit<CompletionItemDTO, 'i'> & { hostCommand?: vscode.Command };
interface Registry { sequence: number; disposed: boolean; seen: Set<string>; requests: Map<string, Map<number, vscode.Command>> }
const LIMIT = 300;

/** Query language providers, then fill gaps in editor snippets and document word suggestions. */
export class CompletionBridge {
  private registries = new WeakMap<Session, Registry>();
  private snippetDirectory?: vscode.Uri;

  constructor(globalStorageUri?: vscode.Uri) {
    // User[/profiles/id]/globalStorage/publisher.extension, including custom user-data directories.
    if (globalStorageUri) { this.snippetDirectory = vscode.Uri.joinPath(globalStorageUri, '..', '..', 'snippets'); }
  }

  async complete(session: Session, request: CompleteRequest): Promise<void> {
    let registry = this.registries.get(session);
    if (!registry) { registry = { sequence: 0, disposed: false, seen: new Set(), requests: new Map() }; this.registries.set(session, registry); }
    // Reusing a request must never replace capabilities associated with an earlier response.
    if (registry.seen.has(request.req) || registry.requests.has(request.req)) { return; }
    registry.seen.add(request.req);
    if (registry.seen.size > 512) { registry.seen.delete(registry.seen.values().next().value!); }
    const sequence = ++registry.sequence;
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
    let provider: vscode.CompletionList | undefined;
    try {
      provider = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', document.uri, position,
        request.trigger.kind === 'char' ? request.trigger.char : undefined, LIMIT);
    } catch (error) { log().warn(`completion provider failed: ${String(error)}`); }
    const [context, snippets] = await Promise.all([session.completionContext(), this.snippets(document)]);
    if (registry.disposed) { return; }
    if (document.version !== request.version || registry.sequence !== sequence) { await empty(true); return; }
    const candidates: Candidate[] = [];
    for (const item of provider?.items ?? []) {
      const converted = convertItem(item, document, index, fallbackRange, position);
      if (converted) { candidates.push(converted); }
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
    const items = filtered.slice(0, LIMIT).map((candidate, i): CompletionItemDTO => {
      const { hostCommand, ...dto } = candidate;
      if (hostCommand) { commands.set(i, hostCommand); }
      return { ...dto, i };
    });
    registry.requests.set(request.req, commands);
    while (registry.requests.size > 8) { registry.requests.delete(registry.requests.keys().next().value!); }
    await session.post({ t: 'completions', req: request.req, version: request.version, at: request.at,
      isIncomplete: !!provider?.isIncomplete || filtered.length > LIMIT, items });
  }

  async runCommand(session: Session, req: string, item: number): Promise<void> {
    const commands = this.registries.get(session)?.requests.get(req), command = commands?.get(item);
    if (!command) { return; }
    commands!.delete(item);
    try { await vscode.commands.executeCommand(command.command, ...(command.arguments ?? [])); }
    catch (error) { log().warn(`completion command failed: ${String(error)}`); }
  }

  dispose(session: Session) {
    const registry = this.registries.get(session);
    if (registry) { registry.disposed = true; registry.requests.clear(); }
    this.registries.delete(session);
  }

  private async snippets(document: vscode.TextDocument): Promise<StoredSnippet[]> {
    const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId });
    const placement = editor.get<string>('snippetSuggestions', 'inline');
    if (placement === 'none') { return []; }
    const files: vscode.Uri[] = [];
    const directory = async (uri: vscode.Uri, user: boolean) => {
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
          if (type !== vscode.FileType.File || (!name.endsWith('.code-snippets') && !(user && name === `${document.languageId}.json`))) { continue; }
          files.push(vscode.Uri.joinPath(uri, name));
        }
      } catch { /* Snippet directories are optional. */ }
    };
    await Promise.all([
      ...(this.snippetDirectory ? [directory(this.snippetDirectory, true)] : []),
      ...(vscode.workspace.workspaceFolders ?? []).map(folder => directory(vscode.Uri.joinPath(folder.uri, '.vscode'), false)),
    ]);
    for (const extension of vscode.extensions.all) {
      const contributions = extension.packageJSON.contributes?.snippets as { language?: string; path?: string }[] | undefined;
      for (const snippet of contributions ?? []) {
        if (snippet.language === document.languageId && typeof snippet.path === 'string') { files.push(vscode.Uri.joinPath(extension.extensionUri, snippet.path)); }
      }
    }
    return (await Promise.all(files.map(async uri => {
      try {
        const data = parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as unknown;
        if (!data || typeof data !== 'object' || Array.isArray(data)) { return []; }
        const result: StoredSnippet[] = [];
        for (const [name, raw] of Object.entries(data)) {
          if (!raw || typeof raw !== 'object') { continue; }
          const item = raw as Record<string, unknown>;
          if (typeof item.scope === 'string' && !item.scope.split(',').map(s => s.trim()).includes(document.languageId)) { continue; }
          const body = typeof item.body === 'string' ? item.body : Array.isArray(item.body) && item.body.every(l => typeof l === 'string') ? item.body.join('\n') : undefined;
          const prefixes = typeof item.prefix === 'string' ? [item.prefix] : Array.isArray(item.prefix) ? item.prefix.filter(p => typeof p === 'string') as string[] : [];
          if (body === undefined) { continue; }
          for (const prefix of prefixes) {
            if (!prefix) { continue; }
            result.push({ name, prefix, body, description: typeof item.description === 'string' ? item.description : undefined,
              sortText: `${placement === 'top' ? '0' : placement === 'bottom' ? 'z' : '1'}${prefix}` });
          }
        }
        return result;
      } catch { return []; }
    }))).flat();
  }

  private words(document: vscode.TextDocument, text: string, query: string): string[] {
    const mode = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId }).get<string | boolean>('wordBasedSuggestions', 'matchingDocuments');
    if (mode === false || mode === 'off') { return []; }
    const documents = mode === 'currentDocument' ? [document] : vscode.workspace.textDocuments.filter(d => d === document || mode === 'allDocuments' || d.languageId === document.languageId);
    const words = new Set<string>();
    for (const doc of documents) {
      for (const match of (doc === document ? text : toLF(doc.getText())).matchAll(/[\p{L}_][\p{L}\p{N}_-]+/gu)) {
        if (match[0] !== query) { words.add(match[0]); }
      }
    }
    return [...words];
  }
}

interface StoredSnippet { prefix: string; name: string; body: string; description?: string; sortText?: string }
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
