import { EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { openSearchPanel } from '@codemirror/search';
import { PROTOCOL_VERSION, type HostMessage } from '../shared/protocol.ts';
import { applySettingsAppearance, baseExtensions, settingsCompartment, settingsExtensions } from './editor/setup.ts';
import { configureTextMate } from './editor/textmate.ts';
import { logToHost, onHostMessage, post } from './bridge.ts';
import { SyncClient } from './sync.ts';
import { editKind, remoteEdit } from './editor/annotations.ts';
import { ProseCompletion } from './completion/proseCompletion.ts';
import { MathCompletion } from './completion/mathCompletion.ts';
import { snippetExtensions } from './snippet/snippetSession.ts';
import { activeFormulaCursor, closeActiveFormula, flushFormulaInput, formulaExtensions, setInlineShortcuts, setMacroContext, setMathCompletion, toggleSourceMode } from './editor/formulas.ts';
import { initMathLive } from './formula/mathlive.ts';
import { macroContext } from './formula/projection.ts';
import 'mathlive/fonts.css';
import 'mathlive/static.css';
import './style.css';

initMathLive(document.body.dataset.fonts ?? '');

/** Marks transactions that mirror the document rather than user input. */
const remote = remoteEdit;

let lastEditPos = -1;
let historyRequested = false;
let latestContextVersion = -1;
let pendingReveal: { anchor: number; head: number; focus: boolean } | undefined;

const sync = new SyncClient({
  post,
  log: message => logToHost('warn', message),
  applyRemote(changes) {
    const tr: TransactionSpec = { changes, annotations: [remote.of(true)] };
    if (historyRequested) {
      // Put the caret where VS Code's undo/redo changed the text, as a native editor would.
      let end = -1;
      changes.iterChangedRanges((_fA, _tA, _fB, toB) => { end = Math.max(end, toB); });
      if (end >= 0) { tr.selection = { anchor: end }; tr.scrollIntoView = true; }
      historyRequested = false;
    }
    view.dispatch(tr);
  },
  replaceAll(text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: remote.of(true) });
  },
});

const completion = new ProseCompletion(sync, post);
const mathCompletion = new MathCompletion(sync, post);
setMathCompletion(mathCompletion);

function isBoundary(tr: Transaction): boolean {
  if (sync.composing || view.composing) { return false; }
  if (tr.annotation(editKind) || !tr.isUserEvent('input.type') && !tr.isUserEvent('delete')) { return true; }
  let boundary = false;
  tr.changes.iterChanges((fromA, _toA, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (/[\s.,;:!?(){}[\]$\\]/.test(text) || inserted.lines > 1) { boundary = true; }
    if (lastEditPos >= 0 && Math.abs(fromA - lastEditPos) > 1) { boundary = true; }
    lastEditPos = fromA + text.length;
  });
  return boundary;
}

let selectionTimer: ReturnType<typeof setTimeout> | undefined;
function emitSelection() {
  clearTimeout(selectionTimer);
  if (!sync.matches(view.state)) { return; }
  const at = mathCompletion.sourceCursor ?? activeFormulaCursor();
  const { anchor, head } = at === undefined ? view.state.selection.main : { anchor: at, head: at };
  post({ t: 'selection', version: sync.version, anchor, head });
}
function reportSelection() {
  clearTimeout(selectionTimer);
  selectionTimer = setTimeout(emitSelection, 120);
}
document.addEventListener('omt-math-selection', reportSelection);

const view = new EditorView({
  parent: document.getElementById('editor')!,
  state: EditorState.create({
    extensions: baseExtensions([
      completion.extensions(),
      snippetExtensions(),
      formulaExtensions(),
      EditorView.updateListener.of(update => {
        if (pendingReveal && update.docChanged) {
          pendingReveal.anchor = update.changes.mapPos(pendingReveal.anchor, 1);
          pendingReveal.head = update.changes.mapPos(pendingReveal.head, 1);
        }
        for (const tr of update.transactions) {
          if (!tr.docChanged || tr.annotation(remote)) { continue; }
          sync.local(tr.changes, tr.annotation(editKind) ?? 'type', isBoundary(tr));
        }
        if (update.selectionSet || update.docChanged) { reportSelection(); }
        if (update.selectionSet && !update.docChanged && !sync.composing && !view.composing) {
          // A caret jump ends the current typing batch.
          const head = update.state.selection.main.head;
          if (lastEditPos >= 0 && head !== lastEditPos) { lastEditPos = -1; sync.send(); }
        }
        completion.update(update);
        mathCompletion.update(update);
      }),
    ]),
  }),
});
completion.attach(view);
mathCompletion.attach(view);

// Observe composition before either CodeMirror or MathLive mutates its model.
// The commit's final DOM/input notification can arrive just after compositionend.
const editorComposition = (event: Event) => event.target instanceof Node
  && (view.dom.contains(event.target) || event.target instanceof Element && !!event.target.closest('.omt-macro-args'));
document.addEventListener('compositionstart', event => {
  if (!editorComposition(event)) { return; }
  sync.beginComposition();
  completion.close();
}, { capture: true });
document.addEventListener('compositionend', event => {
  if (editorComposition(event)) { sync.endComposition(); }
}, { capture: true });
document.addEventListener('omt-composition-cancel', event => {
  if (editorComposition(event)) { sync.endComposition(); }
}, { capture: true });

async function runHistory(redo: boolean) {
  await flushForAction();
  historyRequested = true;
  post({ t: redo ? 'redo' : 'undo' });
}

async function flushForAction(stabilize = true) {
  await sync.waitForComposition();
  // Accepted input can still be queued while MathLive transfers focus to an
  // argument field. Drain it before collecting the field model or saving.
  await mathCompletion.settleFocus();
  // A command prefix is temporary source, never a saved document or SyncTeX target.
  if (stabilize) { mathCompletion.cancel(false); completion.close(); }
  // MathLive batches input notifications. Capture the actual field model before
  // a save/navigation command can run ahead of the notification from the last key.
  flushFormulaInput();
  await sync.flush();
  emitSelection();
}
async function documentAction(t: 'save' | 'synctex' | 'build' | 'view' | 'syncRoot' | 'openNative') {
  await flushForAction(); post({ t });
}
async function find() {
  await sync.waitForComposition();
  await mathCompletion.settleFocus();
  mathCompletion.cancel(false); completion.close();
  flushFormulaInput();
  const at = activeFormulaCursor();
  closeActiveFormula();
  if (at !== undefined) { view.dispatch({ selection: { anchor: at } }); }
  openSearchPanel(view);
}
function run(action: Promise<unknown>) { void action.catch(error => logToHost('error', String(error))); }

async function reveal(message: Extract<HostMessage, { t: 'reveal' }>) {
  if (message.version !== undefined && message.version !== sync.version) { return; }
  const target = pendingReveal = {
    anchor: sync.localOffset(message.anchor), head: sync.localOffset(message.head), focus: message.focus,
  };
  await flushForAction();
  if (pendingReveal !== target) { return; }
  pendingReveal = undefined;
  closeActiveFormula();
  const len = view.state.doc.length;
  view.dispatch({ selection: { anchor: Math.max(0, Math.min(target.anchor, len)), head: Math.max(0, Math.min(target.head, len)) }, scrollIntoView: true });
  if (target.focus) { view.focus(); }
}

/**
 * VS Code forwards webview keydowns to the workbench. Handle the ones that must see our
 * pending batch first, and stop them before the workbench runs them a second time.
 */
window.addEventListener('keydown', event => {
  const mod = event.metaKey || event.ctrlKey, key = event.key.toLowerCase();
  if (!mod || event.isComposing) { return; }
  let handled = true;
  if (event.altKey) {
    if (key === 'm' && event.shiftKey) { completion.close(); toggleSourceMode(view); }
    else if (key === 'j' && !event.shiftKey) { run(documentAction('synctex')); }
    else if (key === 'b' && !event.shiftKey) { run(documentAction('build')); }
    else if (key === 'v' && !event.shiftKey) { run(documentAction('view')); }
    else { handled = false; }
  }
  else if (key === 'z' && !event.shiftKey) { run(runHistory(false)); }
  else if (key === 'z' && event.shiftKey || key === 'y' && !event.shiftKey) { run(runHistory(true)); }
  else if (key === 's' && !event.shiftKey) { run(documentAction('save')); }
  else if (key === 'f' && !event.shiftKey) { run(find()); }
  else { handled = false; }
  if (handled) { event.preventDefault(); event.stopImmediatePropagation(); }
}, true);

onHostMessage((message: HostMessage) => {
  switch (message.t) {
    case 'init':
      if (message.proto !== PROTOCOL_VERSION) { logToHost('error', `protocol mismatch ${message.proto}`); return; }
      pendingReveal = undefined;
      applySettingsAppearance(message.settings);
      setInlineShortcuts(message.settings.inlineShortcuts, message.settings.inlineShortcutOverrides);
      mathCompletion.configure(message.settings);
      completion.configure(message.settings, message.uri);
      sync.init(message.version, message.text);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: message.text },
        annotations: remote.of(true),
        effects: settingsCompartment.reconfigure(settingsExtensions(message.settings)),
      });
      configureTextMate(view, message.settings);
      document.body.dataset.ready = 'true';
      break;
    case 'settings':
      applySettingsAppearance(message.settings);
      setInlineShortcuts(message.settings.inlineShortcuts, message.settings.inlineShortcutOverrides);
      mathCompletion.configure(message.settings);
      completion.configure(message.settings);
      view.dispatch({ effects: settingsCompartment.reconfigure(settingsExtensions(message.settings)) });
      configureTextMate(view, message.settings);
      break;
    case 'context':
      if (message.contextVersion <= latestContextVersion) { break; }
      latestContextVersion = message.contextVersion;
      // A new macro definition recreates active fields. Keep the IME sink alive
      // until its final input has reached the source, and apply only the latest reply.
      if (sync.composing) {
        run(sync.waitForComposition().then(() => {
          if (message.contextVersion === latestContextVersion) {
            setMacroContext(view, macroContext(message.contextVersion, message.macros, message.renderMacros));
          }
        }));
      } else {
        setMacroContext(view, macroContext(message.contextVersion, message.macros, message.renderMacros));
      }
      break;
    case 'completions': completion.receive(message); mathCompletion.receive(message); break;
    case 'completionResolved': completion.receiveResolved(message); mathCompletion.receiveResolved(message); break;
    case 'docChanged': sync.docChanged(message.version, message.changes, message.originTxn); reportSelection(); break;
    case 'txnResult': sync.txnResult(message.txn, message.ok, message.reason); break;
    case 'reset': pendingReveal = undefined; mathCompletion.cancel(false); sync.reset(message.version, message.text); break;
    case 'command':
      if (message.name === 'flush') {
        run(flushForAction(message.stabilize ?? false).then(() => post({ t: 'flushed', req: message.req!, ok: true }), error => {
          post({ t: 'flushed', req: message.req!, ok: false }); throw error;
        }));
      }
      if (message.name === 'toggleSource') { completion.close(); toggleSourceMode(view); }
      if (message.name === 'find') { run(find()); }
      break;
    case 'reveal': run(reveal(message)); break;
  }
});

// Hooks for the browser test harness (there is no harness in VS Code).
if ((window as unknown as { __posted?: unknown }).__posted) {
  (window as unknown as { __omt: unknown }).__omt = {
    setCaret: (pos: number) => { view.focus(); view.dispatch({ selection: { anchor: pos } }); },
    setSelection: (anchor: number, head: number) => { view.focus(); view.dispatch({ selection: { anchor, head } }); },
    caret: () => view.state.selection.main.head,
    selection: () => { const { anchor, head } = view.state.selection.main; return { anchor, head }; },
    text: () => view.state.doc.toString(),
  };
}

post({ t: 'ready', proto: PROTOCOL_VERSION });
view.focus();
