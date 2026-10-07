import type { CompletionItemDTO } from '../../shared/protocol.ts';
import type { EditorView } from '@codemirror/view';

/** Text-only rendering: provider labels and Markdown never become webview HTML. */
export class CompletionPopup {
  readonly dom = document.createElement('div');
  private frame = 0;
  private view: EditorView;
  private pick: (index: number) => void;
  private owner?: HTMLElement;
  private signature = '';
  private rows: HTMLElement[] = [];
  private selected = -1;
  constructor(view: EditorView, pick: (index: number) => void) {
    this.view = view; this.pick = pick;
    this.dom.className = 'omt-completion'; this.dom.id = 'omt-completion';
    this.dom.setAttribute('role', 'listbox'); this.dom.setAttribute('aria-label', 'LaTeX completions');
    this.dom.hidden = true;
    this.dom.addEventListener('mousedown', e => e.preventDefault());
  }
  show(items: CompletionItemDTO[], selected: number, at: number, anchor?: { left: number; top: number; bottom: number }, owner: HTMLElement = this.view.contentDOM) {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!items.length) { this.hide(); return; }
      if (this.owner && this.owner !== owner) {
        this.owner.removeAttribute('aria-activedescendant'); this.owner.removeAttribute('aria-controls');
      }
      this.owner = owner;
      if (!this.dom.isConnected) { document.body.append(this.dom); }
      const signature = JSON.stringify(items.map(item => [item.label, item.description, item.detail, item.source, item.doc]));
      if (signature !== this.signature) {
        this.signature = signature; this.selected = -1; this.rows = [];
        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
          const row = document.createElement('div'); row.className = 'omt-completion-item'; row.id = `omt-completion-${index}`;
          row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(index === selected));
          const label = document.createElement('span'); label.className = 'omt-completion-label'; label.textContent = item.label;
          row.append(label);
          const detail = document.createElement('span'); detail.className = 'omt-completion-detail'; detail.textContent = item.description ?? item.detail ?? item.source ?? '';
          row.append(detail); row.title = [item.detail, item.doc].filter(Boolean).join('\n');
          row.addEventListener('click', () => this.pick(index)); fragment.append(row); this.rows.push(row);
        });
        this.dom.replaceChildren(fragment);
      }
      if (this.selected !== selected) {
        this.rows[this.selected]?.setAttribute('aria-selected', 'false');
        this.rows[selected]?.setAttribute('aria-selected', 'true'); this.selected = selected;
      }
      const coords = anchor ?? this.view.coordsAtPos(Math.min(at, this.view.state.doc.length));
      if (!coords) { this.hide(); return; }
      this.dom.hidden = false;
      const width = Math.min(560, window.innerWidth - 16);
      this.dom.style.width = `${width}px`;
      this.dom.style.left = `${Math.max(8, Math.min(coords.left, window.innerWidth - width - 8))}px`;
      const height = Math.min(this.dom.scrollHeight, 280);
      this.dom.style.top = `${coords.bottom + height + 4 < window.innerHeight ? coords.bottom + 4 : Math.max(4, coords.top - height - 4)}px`;
      this.dom.children[selected]?.scrollIntoView({ block: 'nearest' });
      owner.setAttribute('aria-autocomplete', 'list');
      owner.setAttribute('aria-controls', this.dom.id);
      owner.setAttribute('aria-activedescendant', `omt-completion-${selected}`);
    });
  }
  hide() {
    cancelAnimationFrame(this.frame); this.dom.hidden = true; this.dom.remove();
    this.signature = ''; this.rows = []; this.selected = -1; this.dom.replaceChildren();
    (this.owner ?? this.view.contentDOM).removeAttribute('aria-activedescendant');
    (this.owner ?? this.view.contentDOM).removeAttribute('aria-controls');
  }
  destroy() { this.hide(); this.dom.remove(); }
}
