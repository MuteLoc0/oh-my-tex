import * as vscode from 'vscode';
import { SerialQueue } from '../core/serial.ts';
import { log } from './log.ts';

const WORKSHOP = 'James-Yu.latex-workshop';
type WorkshopExtension = Pick<vscode.Extension<unknown>, 'activate'>;

/** Workshop 10.19 captures activeTextEditor synchronously for SyncTeX and build.
 * Its public API exposes no silent root refresh, so priming activates the root's
 * native editor; an explicit syncRoot uses view(), which awaits root.find(). */
export class WorkshopBridge {
  private remoteAvailable = false;
  private readonly resolve: () => WorkshopExtension | undefined;
  private readonly commands: () => Thenable<string[]>;

  constructor(
    resolve: () => WorkshopExtension | undefined = () => vscode.extensions.getExtension(WORKSHOP),
    commands: () => Thenable<string[]> = () => vscode.commands.getCommands(true),
  ) { this.resolve = resolve; this.commands = commands; }

  /** Public commands remain visible/routable across UI and workspace hosts. */
  async refreshAvailability(): Promise<void> {
    try { this.remoteAvailable = (await this.commands()).includes('latex-workshop.build'); }
    catch (error) {
      this.remoteAvailable = false;
      log().warn(`Workshop command discovery failed: ${String(error)}`);
    }
  }
  private queue = new SerialQueue();
  private positioningDepth = 0;
  private focusDepth = 0;
  private positioned = new WeakMap<vscode.TextEditor, { version: number; selection: vscode.Selection }>();
  private saving = new Set<string>();
  private building = false;

  get positioning() { return this.positioningDepth > 0; }
  get available() { return !!this.resolve() || this.remoteAvailable; }
  isSaving(document: vscode.TextDocument) { return this.building || this.saving.has(document.uri.toString()); }
  hasFlushedSave(document: vscode.TextDocument) { return this.saving.has(document.uri.toString()); }

  /** Selection events may arrive repeatedly after showTextDocument resolves. */
  ignoresSelection(event: vscode.TextEditorSelectionChangeEvent): boolean {
    const own = this.positioned.get(event.textEditor), selection = event.selections[0];
    const user = event.kind === vscode.TextEditorSelectionChangeKind.Keyboard || event.kind === vscode.TextEditorSelectionChangeKind.Mouse;
    if (!user && own && selection && own.version === event.textEditor.document.version
      && selection.anchor.isEqual(own.selection.anchor) && selection.active.isEqual(own.selection.active)) { return true; }
    this.positioned.delete(event.textEditor);
    return this.positioning;
  }

  openNative(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel) {
    return this.run(() => this.showNative(document, selection, panel));
  }

  synctex(document: vscode.TextDocument, selection: vscode.Selection, panel: vscode.WebviewPanel, root?: string) {
    const version = document.version;
    return this.run(async () => {
      if (!await this.activate()) { return; }
      try {
        await this.primeRoot(document, panel, root);
        this.checkVersion(document, version);
        await this.showNative(document, selection, panel);
        this.checkActive(document, version);
        await vscode.commands.executeCommand('latex-workshop.synctex');
      } finally {
        if (this.config(document).get('workshop.returnToVisualEditor', true)) { this.restore(panel); }
      }
    });
  }

  /** Explicit build saves with Workshop's public saveWithoutBuilding command.
   * This suppresses its native auto-build, avoiding two builds for one request. */
  build(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel, root?: string) {
    return this.run(async () => {
      if (!await this.activate()) { return; }
      try {
        await this.primeRoot(document, panel, root);
        await this.showNative(document, selection, panel);
        this.saving.add(document.uri.toString());
        try { await vscode.commands.executeCommand('latex-workshop.saveWithoutBuilding'); }
        finally { this.saving.delete(document.uri.toString()); }
        if (document.isDirty) { throw new Error('The source could not be saved; build was cancelled.'); }
        this.checkActive(document);
        this.building = true;
        try { await vscode.commands.executeCommand('latex-workshop.build'); }
        finally { this.building = false; }
      } finally { this.restore(panel); }
    });
  }

  /** Keep a real source editor active during the onDidSave event. Workshop owns
   * the automatic build (including exclusions and interval throttling). */
  save(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel, root?: string) {
    return this.run(async () => {
      try {
        if (this.wantsBuildOnSave(document) && await this.activate()) {
          await this.primeRoot(document, panel, root);
          await this.showNative(document, selection, panel);
        }
        this.saving.add(document.uri.toString());
        try { if (!await document.save()) { throw new Error('The source could not be saved.'); } }
        finally { this.saving.delete(document.uri.toString()); }
      } finally { this.restore(panel); }
    });
  }

  /** onWillSave also covers workbench Save, Save All, and automatic saves. */
  prepareSave(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel, root?: string) {
    // showTextDocument and Workshop build/saveAll can themselves trigger saves.
    // Waiting behind the command that is awaiting that save would deadlock.
    if (this.focusDepth > 0) { return Promise.resolve(); }
    return this.run(async () => {
      if (this.isSaving(document) || !this.wantsBuildOnSave(document) || !await this.activate()) { return; }
      await this.primeRoot(document, panel, root);
      await this.showNative(document, selection, panel);
    });
  }

  view(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel, root?: string) {
    return this.run(async () => {
      if (!await this.activate()) { return; }
      await this.primeRoot(document, panel, root);
      await this.showNative(document, selection, panel);
      this.checkActive(document);
      await vscode.commands.executeCommand('latex-workshop.view');
    });
  }

  /** Workshop has no public root-only command. Viewing the selected root is the
   * non-destructive public command that waits for its real root discovery. */
  syncRoot(document: vscode.TextDocument, panel: vscode.WebviewPanel, root: string) {
    return this.run(async () => {
      if (!await this.activate()) { return; }
      const rootDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(root));
      await this.showNative(rootDocument, undefined, panel);
      this.checkActive(rootDocument);
      await vscode.commands.executeCommand('latex-workshop.view');
    });
  }

  wantsBuildOnSave(document: vscode.TextDocument): boolean {
    return this.available && vscode.workspace.getConfiguration('latex-workshop', document.uri).get('latex.autoBuild.run') === 'onSave';
  }

  report(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    log().error(`Workshop bridge: ${message}`);
    void vscode.window.showErrorMessage(`Oh My TeX: ${message}`);
  }

  private run<T>(action: () => Promise<T>): Promise<T> {
    return this.queue.run('focus', async () => {
      this.focusDepth++;
      try { return await action(); } finally { this.focusDepth--; }
    });
  }

  private config(document: vscode.TextDocument) { return vscode.workspace.getConfiguration('oh-my-tex', document.uri); }

  private async primeRoot(document: vscode.TextDocument, panel: vscode.WebviewPanel, root?: string) {
    if (!root || root === document.uri.toString() || !this.config(document).get('workshop.primeRoot', true)) { return; }
    const rootDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(root));
    await this.showNative(rootDocument, undefined, panel);
  }

  private async showNative(document: vscode.TextDocument, selection: vscode.Selection | undefined, panel: vscode.WebviewPanel) {
    // Resolve relative to the visual panel, not the currently active root tab.
    // Reusing one adjacent group prevents priming from creating a third group.
    const beside = panel.viewColumn && panel.viewColumn < vscode.ViewColumn.Nine
      ? panel.viewColumn + 1 : vscode.ViewColumn.Beside;
    const column = this.config(document).get<string>('workshop.nativeEditorColumn', 'beside') === 'same'
      ? panel.viewColumn : beside;
    this.positioningDepth++;
    try {
      const editor = await vscode.window.showTextDocument(document, { viewColumn: column, preview: false, preserveFocus: false, selection });
      if (selection) {
        // showTextDocument's Range option normalizes backwards selections.
        this.positioned.set(editor, { version: document.version, selection });
        editor.selection = selection;
        editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      this.checkActive(document);
      return editor;
    } finally { this.positioningDepth--; }
  }

  private checkVersion(document: vscode.TextDocument, version: number) {
    if (document.version !== version) { throw new Error('The source changed while positioning; retry at the current cursor.'); }
  }
  private checkActive(document: vscode.TextDocument, version = document.version) {
    this.checkVersion(document, version);
    if (vscode.window.activeTextEditor?.document.uri.toString() !== document.uri.toString()) {
      throw new Error('The native source editor did not become active; Workshop command was cancelled.');
    }
  }
  private restore(panel: vscode.WebviewPanel) { try { panel.reveal(panel.viewColumn, false); } catch { /* Panel was closed while a command ran. */ } }

  private async activate(): Promise<boolean> {
    const extension = this.resolve();
    if (extension) { await extension.activate(); return true; }
    await this.refreshAvailability();
    // executeCommand activates the remote provider before dispatching its
    // contributed command. Never access exports across extension hosts.
    if (this.remoteAvailable) { return true; }
    void vscode.window.showInformationMessage('Oh My TeX: install and enable LaTeX Workshop in this workspace (on the SSH host for remote files).');
    return false;
  }
}
