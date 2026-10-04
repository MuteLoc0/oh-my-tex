import type { MathfieldElement } from 'mathlive';
import { containsCJK } from '../../core/mathText.ts';

/** Keep MathLive's intermediate selection deletion out of the source-owned widget. */
export function attachMathIME(field: MathfieldElement, signal: AbortSignal, committed: () => void = () => {}): { readonly composing: boolean; value(): string | undefined } {
  let composition = false;
  let held = false;
  let original: { value: string; selection: MathfieldElement['selection']; mode: MathfieldElement['mode'] } | undefined;
  let preview: HTMLSpanElement | undefined;
  const clearPreview = () => { preview?.remove(); preview = undefined; };
  const showPreview = (text: string) => {
    if (!text) { clearPreview(); return; }
    if (!preview) {
      preview = document.createElement('span'); preview.className = 'omt-ime-preview';
      preview.setAttribute('role', 'status'); preview.setAttribute('aria-label', '正在组合输入');
      preview.style.cssText = 'position:fixed;z-index:1000;pointer-events:none;padding:2px 4px;border-bottom:1px solid currentColor;background:var(--vscode-editorWidget-background,var(--vscode-editor-background));color:var(--vscode-editor-foreground);font:inherit;white-space:pre';
      document.body.append(preview);
    }
    preview.textContent = text;
    const bounds = field.getElementInfo(field.position)?.bounds ?? field.getBoundingClientRect();
    preview.style.left = `${Math.max(4, Math.min(bounds.right, window.innerWidth - preview.offsetWidth - 4))}px`;
    preview.style.top = `${Math.max(4, Math.min(bounds.top, window.innerHeight - preview.offsetHeight - 4))}px`;
  };
  signal.addEventListener('abort', () => {
    clearPreview();
    if (composition) {
      // Disposal can detach the native sink before its browser end event reaches
      // document. Release the source sync hold while the field is still mounted.
      field.dispatchEvent(new CustomEvent('omt-composition-cancel', { bubbles: true, composed: true }));
    }
  }, { once: true });
  const switchToText = () => {
    if (field.mode !== 'text') { field.executeCommand(['switchMode', 'text']); }
  };
  const clearSink = () => {
    const sink = field.shadowRoot?.querySelector<HTMLElement>('[part="keyboard-sink"]');
    if (sink) { sink.textContent = ''; }
  };
  const insertText = (text: string, mode: MathfieldElement['mode']) => {
    held = true;
    switchToText();
    // Explicit insertion mode avoids MathLive re-inferring math mode from the
    // left atom after it deletes a text selection or removes a composition atom.
    field.insert(text, { mode: 'text', insertionMode: 'replaceSelection', selectionMode: 'after', silenceNotifications: true });
    if (mode !== 'text') { field.executeCommand(['switchMode', mode]); }
    held = false;
    committed();
  };
  field.addEventListener('compositionstart', event => {
    if (!event.isTrusted) { return; }
    original = { value: field.getValue('latex'), selection: field.selection, mode: field.mode };
    composition = true; held = true;
    switchToText();
    // MathLive otherwise deletes a selected formula immediately. Writing that
    // temporary empty model would remove the widget and its native IME sink.
    event.stopImmediatePropagation();
  }, { capture: true, signal });
  field.addEventListener('compositionupdate', event => {
    if (composition && event.isTrusted) {
      showPreview((event as CompositionEvent).data);
      event.stopImmediatePropagation();
    }
  }, { capture: true, signal });
  field.addEventListener('compositionend', event => {
    // Chromium's CDP commit delivers an untrusted compositionend even though
    // its start/update/input events are native. Require the active native start.
    if (!composition) { return; }
    event.stopImmediatePropagation();
    const text = (event as CompositionEvent).data, before = original!;
    composition = false;
    clearPreview();
    // The browser has finished its native composition before this event. Keep
    // only the committed text in the public MathLive model, as one source edit.
    clearSink();
    if (text) { insertText(text, before.mode); }
    else {
      field.setValue(before.value, { silenceNotifications: true });
      field.selection = before.selection;
      if (field.mode !== before.mode) { field.executeCommand(['switchMode', before.mode]); }
      held = false;
    }
    original = undefined;
  }, { capture: true, signal });
  field.addEventListener('beforeinput', event => {
    const input = event as InputEvent;
    // Model notifications originate on the host. The application's legitimate
    // focus-handoff replay originates on the sink and still needs text atoms.
    if (!input.isTrusted && event.composedPath()[0] === field) { return; }
    if (composition) { input.stopImmediatePropagation(); return; }
    if (!input.data || !containsCJK(input.data)) { return; }
    input.preventDefault(); input.stopImmediatePropagation();
    const mode = field.mode;
    insertText(input.data, mode);
    clearSink();
  }, { capture: true, signal });
  field.addEventListener('input', event => {
    if (composition && event.isTrusted) { event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  field.addEventListener('keydown', event => {
    // Leave native candidate navigation/cancellation to the browser. MathLive's
    // own delegate did not receive compositionstart and must not handle these.
    if (composition || event.isComposing) { event.stopImmediatePropagation(); }
  }, { capture: true, signal });
  return { get composing() { return held; }, value: () => held ? original?.value : undefined };
}
