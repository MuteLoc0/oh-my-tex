import * as vscode from 'vscode';
import { parse } from 'jsonc-parser';

export interface StoredSnippet { prefix: string; name: string; body: string; description?: string; sortText?: string }
interface CacheEntry { generation: number; expiresAt: number; promise: Promise<StoredSnippet[]> }
const CACHE_TTL = 30_000;

/** Cache snippet files across completion requests, including requests already being read. */
export class SnippetStore implements vscode.Disposable {
  private readonly snippetDirectory?: vscode.Uri;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly workspaceWatchers: vscode.Disposable[] = [];
  private generation = 0;
  private disposed = false;

  constructor(globalStorageUri?: vscode.Uri) {
    // User[/profiles/id]/globalStorage/publisher.extension, including custom user-data directories.
    if (globalStorageUri) {
      this.snippetDirectory = vscode.Uri.joinPath(globalStorageUri, '..', '..', 'snippets');
      this.watch(this.snippetDirectory, '*.{json,code-snippets}', this.disposables);
      this.watch(vscode.Uri.joinPath(this.snippetDirectory, '..'), 'snippets', this.disposables);
    }
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('editor.snippetSuggestions')) { this.invalidate(); } }),
      vscode.extensions.onDidChange(() => this.invalidate()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.invalidate();
        this.refreshWorkspaceWatchers();
      }),
    );
    this.refreshWorkspaceWatchers();
  }

  get(document: vscode.TextDocument): Promise<StoredSnippet[]> {
    if (this.disposed) { return Promise.resolve([]); }
    const editor = vscode.workspace.getConfiguration('editor', { uri: document.uri, languageId: document.languageId });
    const placement = editor.get<string>('snippetSuggestions', 'inline');
    if (placement === 'none') { return Promise.resolve([]); }
    const key = JSON.stringify([document.languageId, placement]);
    const cached = this.cache.get(key);
    if (cached && cached.generation === this.generation && cached.expiresAt > Date.now()) { return cached.promise; }
    const entry: CacheEntry = { generation: this.generation, expiresAt: Number.POSITIVE_INFINITY, promise: Promise.resolve([]) };
    entry.promise = this.read(document.languageId, placement).then(snippets => {
      if (this.disposed) { return []; }
      if (entry.generation !== this.generation) { return this.get(document); }
      // Invalidated reads can finish, but must not restore a cache cleared by a newer event.
      if (!this.disposed && entry.generation === this.generation && this.cache.get(key) === entry) {
        entry.expiresAt = Date.now() + CACHE_TTL;
      }
      return snippets;
    }, () => {
      if (this.cache.get(key) === entry) { this.cache.delete(key); }
      return [];
    });
    this.cache.set(key, entry);
    return entry.promise;
  }

  dispose(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    this.invalidate();
    for (const disposable of this.workspaceWatchers.splice(0)) { disposable.dispose(); }
    for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
  }

  private invalidate(): void {
    this.generation++;
    this.cache.clear();
  }

  private refreshWorkspaceWatchers(): void {
    for (const disposable of this.workspaceWatchers.splice(0)) { disposable.dispose(); }
    if (this.disposed) { return; }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      this.watch(vscode.Uri.joinPath(folder.uri, '.vscode'), '*.{json,code-snippets}', this.workspaceWatchers);
      this.watch(folder.uri, '.vscode', this.workspaceWatchers);
    }
  }

  private watch(base: vscode.Uri, pattern: string, disposables: vscode.Disposable[]): void {
    try {
      // Narrow URI-based patterns avoid scanning remote workspaces and also watch optional directories.
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(base, pattern));
      disposables.push(watcher,
        watcher.onDidChange(() => this.invalidate()),
        watcher.onDidCreate(() => this.invalidate()),
        watcher.onDidDelete(() => this.invalidate()));
    } catch { /* Unsupported watcher providers are covered by the cache TTL. */ }
  }

  private async read(languageId: string, placement: string): Promise<StoredSnippet[]> {
    const files = new Map<string, vscode.Uri>();
    const add = (uri: vscode.Uri) => files.set(uri.toString(), uri);
    const directory = async (uri: vscode.Uri, user: boolean) => {
      try {
        for (const [name, type] of await vscode.workspace.fs.readDirectory(uri)) {
          if (type !== vscode.FileType.File || (!name.endsWith('.code-snippets') && !(user && name === `${languageId}.json`))) { continue; }
          add(vscode.Uri.joinPath(uri, name));
        }
      } catch { /* Missing optional directories are cached too. */ }
    };
    await Promise.all([
      ...(this.snippetDirectory ? [directory(this.snippetDirectory, true)] : []),
      ...(vscode.workspace.workspaceFolders ?? []).map(folder => directory(vscode.Uri.joinPath(folder.uri, '.vscode'), false)),
    ]);
    for (const extension of vscode.extensions.all) {
      const contributions = extension.packageJSON.contributes?.snippets as unknown;
      if (!Array.isArray(contributions)) { continue; }
      for (const snippet of contributions) {
        if (snippet && typeof snippet === 'object' && snippet.language === languageId && typeof snippet.path === 'string') {
          add(vscode.Uri.joinPath(extension.extensionUri, snippet.path));
        }
      }
    }
    return (await Promise.all([...files.values()].map(async uri => {
      try {
        const data = parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as unknown;
        if (!data || typeof data !== 'object' || Array.isArray(data)) { return []; }
        const result: StoredSnippet[] = [];
        for (const [name, raw] of Object.entries(data)) {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { continue; }
          const item = raw as Record<string, unknown>;
          if (typeof item.scope === 'string' && !item.scope.split(',').map(scope => scope.trim()).includes(languageId)) { continue; }
          const body = typeof item.body === 'string' ? item.body : Array.isArray(item.body) && item.body.every(line => typeof line === 'string') ? item.body.join('\n') : undefined;
          const prefixes = typeof item.prefix === 'string' ? [item.prefix] : Array.isArray(item.prefix) ? item.prefix.filter((prefix): prefix is string => typeof prefix === 'string') : [];
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
}
