import * as vscode from 'vscode';
import { posix } from 'node:path';
import { indexProject, ProjectIndexInvalidatedError, type Project, type ProjectReader } from '../core/projectGraph.ts';
import { parseFile, type FileFacts } from '../core/macroParser.ts';
import { normalizeRenderMacros, normalizeTemplates, normalizeUserMacros } from '../core/templates.ts';
import type { MacroDef, ProjectContext } from '../shared/types.ts';
import { log } from './log.ts';

export type { ProjectContext } from '../shared/types.ts';

/** Project-wide macro context per document, preferring unsaved editor contents. */
export class ProjectIndex implements vscode.Disposable {
  private emitter = new vscode.EventEmitter<string>();
  readonly onDidChange = this.emitter.event;
  private contextVersion = 0;
  private generation = 0;
  private facts = new Map<string, FileFacts | undefined>();
  private projects = new Map<string, Promise<Project>>();
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
    this.disposables.push(watcher, watcher.onDidChange(touched), watcher.onDidCreate(touched), watcher.onDidDelete(touched),
      vscode.workspace.onDidChangeTextDocument(e => {
        // Only definition-relevant edits matter; cheap check on the changed text.
        if (e.document.languageId === 'latex' && e.contentChanges.some(c => /\\|\{|\}|%/.test(c.text) || c.rangeLength > 0)) { touched(e.document.uri); }
      }),
      vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('oh-my-tex')) { this.invalidate(); } }),
    );
  }

  /** Invalidate immediately; debounce only the notifications to visible editors. */
  invalidate(uri?: string) {
    this.generation++;
    if (uri) { this.facts.delete(uri); } else { this.facts.clear(); }
    this.projects.clear();
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
      const generation = this.generation;
      try {
        const root = await this.resolveRoot(document);
        if (generation === this.generation) { return root; }
      } catch (error) {
        if (generation === this.generation && !(error instanceof ProjectIndexInvalidatedError)) { throw error; }
      }
    }
  }

  private async resolveRoot(document: vscode.TextDocument): Promise<string> {
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
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.tex'), '**/{node_modules,.git,out,dist}/**', 300);
    const roots: string[] = [];
    for (const file of files) {
      const text = await this.reader.read(file.toString());
      if (!text || !/^[ \t]*\\documentclass\b/m.test(text)) { continue; }
      const project = await this.indexed(file.toString());
      if (project.files.includes(uri)) { roots.push(file.toString()); }
    }
    return roots.length === 1 ? roots[0] : uri;
  }

  private async project(document: vscode.TextDocument): Promise<Project> {
    return this.indexed(await this.rootOf(document));
  }

  private indexed(root: string): Promise<Project> {
    let pending = this.projects.get(root);
    if (!pending) {
      const generation = this.generation;
      pending = indexProject(root, this.reader, this.facts, () => generation === this.generation);
      this.projects.set(root, pending);
    }
    return pending;
  }

  dispose() { clearTimeout(this.timer); this.emitter.dispose(); this.disposables.forEach(d => d.dispose()); }
}
