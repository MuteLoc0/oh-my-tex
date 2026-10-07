import * as vscode from 'vscode';
import { posix } from 'node:path';
import { indexProject, ProjectIndexInvalidatedError, type Project, type ProjectReader } from '../core/projectGraph.ts';
import { parseFile, type FileFacts } from '../core/macroParser.ts';
import { normalizeRenderMacros, normalizeTemplates, normalizeUserMacros } from '../core/templates.ts';
import type { MacroDef, ProjectContext } from '../shared/types.ts';
import { log } from './log.ts';

export type { ProjectContext } from '../shared/types.ts';

/** Bound remote file requests while preserving the discovery order. */
async function mapConcurrent<T, R>(items: readonly T[], limit: number, visit: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const at = next++;
      if (at >= items.length) { return; }
      results[at] = await visit(items[at]!);
    }
  }));
  return results;
}

/** Project-wide macro context per document, preferring unsaved editor contents. */
export class ProjectIndex implements vscode.Disposable {
  private emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;
  private contextVersion = 0;
  private generation = 0;
  private disposed = false;
  private facts = new Map<string, FileFacts | undefined>();
  private projects = new Map<string, Promise<Project>>();
  private roots = new Map<string, { generation: number; version: number; pending: Promise<string> }>();
  private candidates = new Map<string, Promise<string[]>>();
  private workspaceFiles = new Map<string, Promise<vscode.Uri[]>>();
  private timer?: ReturnType<typeof setTimeout>;
  private warnedRootConflicts = new Set<string>();
  private disposables: vscode.Disposable[] = [];

  readonly reader: ProjectReader = {
    read: async uri => {
      const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === uri);
      if (open) { return open.getText(); }
      try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(uri))).toString('utf8'); }
      catch { return undefined; }
    },
    resolve: (parent, path) => {
      const uri = vscode.Uri.parse(parent);
      return uri.with({ path: posix.resolve(posix.dirname(uri.path), path) }).toString();
    },
  };

  private state: vscode.Memento;

  constructor(state: vscode.Memento) {
    this.state = state;
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{tex,sty,cls}');
    const touched = (uri: vscode.Uri) => this.invalidate(uri.toString());
    const membershipChanged = (uri: vscode.Uri) => { this.workspaceFiles.clear(); touched(uri); };
    this.disposables.push(watcher, watcher.onDidChange(touched), watcher.onDidCreate(membershipChanged), watcher.onDidDelete(membershipChanged),
      vscode.workspace.onDidChangeTextDocument(e => {
        // Letters can complete a root marker, macro name or include path too.
        if (e.document.languageId === 'latex' && e.contentChanges.length) { touched(e.document.uri); }
      }),
      vscode.workspace.onDidOpenTextDocument(document => {
        if (document.languageId !== 'latex') { return; }
        const uri = document.uri.toString();
        this.roots.delete(uri);
        if (this.facts.has(uri)) { touched(document.uri); }
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document.languageId !== 'latex') { return; }
        const uri = document.uri.toString();
        this.roots.delete(uri);
        // A clean buffer and its saved file have the same cached facts.
        if (document.isDirty && this.facts.has(uri)) { touched(document.uri); }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.workspaceFiles.clear(); this.invalidate(); }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('oh-my-tex')) { this.invalidate(); } }),
    );
  }

  /** Invalidate immediately; debounce only the notifications to visible editors. */
  invalidate(uri?: string) {
    if (this.disposed) { return; }
    this.generation++;
    if (uri) { this.facts.delete(uri); } else { this.facts.clear(); }
    this.projects.clear();
    this.roots.clear();
    this.candidates.clear();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      for (const d of vscode.workspace.textDocuments) { if (d.languageId === 'latex') { this.emitter.fire(d.uri.toString()); } }
    }, 400);
  }

  async chooseRoot(document: vscode.TextDocument) {
    const file = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { LaTeX: ['tex'] }, title: 'Choose the root document' }))?.[0];
    if (!file) { return; }
    await this.state.update(`root:${document.uri.toString()}`, file.toString());
    this.invalidate();
  }

  async context(document: vscode.TextDocument): Promise<ProjectContext> {
    // Allocate before awaiting: a late reply keeps its old sequence number.
    const contextVersion = ++this.contextVersion;
    for (;;) {
      if (this.disposed) { throw new ProjectIndexInvalidatedError(); }
      const generation = this.generation;
      const config = vscode.workspace.getConfiguration('oh-my-tex', document.uri);
      const user = normalizeUserMacros(config.get('macros', {}));
      const renderMacros = normalizeRenderMacros(config.get('renderMacros', {}));
      const templates = normalizeTemplates(config.get('templates', []));
      let project: Project | undefined;
      try { project = await this.project(document); }
      catch (error) {
        if (generation !== this.generation || error instanceof ProjectIndexInvalidatedError) { continue; }
        log().error(`project index failed: ${String(error)}`);
      }
      // Definitions/configuration changed while root discovery or file reads were pending.
      if (generation !== this.generation) { continue; }
      const byName = new Map<string, MacroDef>();
      for (const m of project?.macros ?? []) { byName.set(m.name, m); }
      for (const m of user) { if (!byName.has(m.name)) { byName.set(m.name, m); } }
      return { contextVersion, macros: [...byName.values()], renderMacros, templates, diagnostics: project?.diagnostics ?? [] };
    }
  }

  async rootOf(document: vscode.TextDocument): Promise<string> {
    for (;;) {
      if (this.disposed) { throw new ProjectIndexInvalidatedError(); }
      const generation = this.generation;
      const version = document.version;
      try {
        const root = await this.resolveRoot(document);
        if (generation === this.generation && version === document.version) { return root; }
      } catch (error) {
        if (generation === this.generation && !(error instanceof ProjectIndexInvalidatedError)) { throw error; }
      }
    }
  }

  private resolveRoot(document: vscode.TextDocument): Promise<string> {
    const uri = document.uri.toString();
    const generation = this.generation, version = document.version;
    const cached = this.roots.get(uri);
    if (cached?.generation === generation && cached.version === version) { return cached.pending; }
    const pending = this.discoverRoot(document, generation);
    this.roots.set(uri, { generation, version, pending });
    void pending.catch(() => { if (this.roots.get(uri)?.pending === pending) { this.roots.delete(uri); } });
    return pending;
  }

  private async discoverRoot(document: vscode.TextDocument, generation: number): Promise<string> {
    const uri = document.uri.toString();
    const chosen = this.state.get<string>(`root:${uri}`);
    const facts = parseFile(document.getText(), uri);
    if (facts.magicRoot) {
      const root = this.reader.resolve(uri, facts.magicRoot);
      if (chosen && chosen !== root && !this.warnedRootConflicts.has(uri)) {
        this.warnedRootConflicts.add(uri);
        void vscode.window.showInformationMessage(`Oh My TeX: % !TeX root points to ${facts.magicRoot} and takes priority over the saved root selection.`);
      }
      return root;
    }
    if (chosen) { return chosen; }
    if (facts.isRoot) { return uri; }
    // A unique root in the workspace that includes this file.
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) { return uri; }
    const candidates = await this.rootCandidates(folder, generation);
    this.checkGeneration(generation);
    const matches = await mapConcurrent(candidates, 4, async root => {
      this.checkGeneration(generation);
      const project = await this.indexed(root);
      this.checkGeneration(generation);
      return project.files.includes(uri) ? root : undefined;
    });
    const roots = matches.filter((root): root is string => root !== undefined);
    return roots.length === 1 ? roots[0] : uri;
  }

  private rootCandidates(folder: vscode.WorkspaceFolder, generation: number): Promise<string[]> {
    const key = folder.uri.toString();
    let pending = this.candidates.get(key);
    if (!pending) {
      pending = this.discoverCandidates(folder, generation);
      this.candidates.set(key, pending);
      const request = pending;
      void request.catch(() => { if (this.candidates.get(key) === request) { this.candidates.delete(key); } });
    }
    return pending;
  }

  private async discoverCandidates(folder: vscode.WorkspaceFolder, generation: number): Promise<string[]> {
    const key = folder.uri.toString();
    let files = this.workspaceFiles.get(key);
    if (!files) {
      files = Promise.resolve(vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.tex'), '**/{node_modules,.git,out,dist}/**', 300));
      this.workspaceFiles.set(key, files);
      const request = files;
      void request.catch(() => { if (this.workspaceFiles.get(key) === request) { this.workspaceFiles.delete(key); } });
    }
    const candidates = await mapConcurrent(await files, 8, async file => {
      this.checkGeneration(generation);
      const uri = file.toString();
      if (!this.facts.has(uri)) {
        const text = await this.reader.read(uri);
        this.checkGeneration(generation);
        this.facts.set(uri, text === undefined ? undefined : parseFile(text, uri));
      }
      return this.facts.get(uri)?.isRoot ? uri : undefined;
    });
    this.checkGeneration(generation);
    return candidates.filter((uri): uri is string => uri !== undefined);
  }

  private checkGeneration(generation: number) {
    if (this.disposed || generation !== this.generation) { throw new ProjectIndexInvalidatedError(); }
  }

  private async project(document: vscode.TextDocument): Promise<Project> {
    return this.indexed(await this.rootOf(document));
  }

  private indexed(root: string): Promise<Project> {
    let pending = this.projects.get(root);
    if (!pending) {
      const generation = this.generation;
      pending = indexProject(root, this.reader, this.facts, () => !this.disposed && generation === this.generation);
      this.projects.set(root, pending);
    }
    return pending;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.roots.clear(); this.candidates.clear(); this.workspaceFiles.clear(); this.projects.clear(); this.facts.clear();
    this.emitter.dispose(); this.disposables.forEach(d => d.dispose());
  }
}
