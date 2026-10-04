import { MathfieldElement } from 'mathlive';

declare global { interface Window { runCorpus(lines: string[]): unknown; runIslands(): unknown } }

MathfieldElement.soundsDirectory = null;
const field = new MathfieldElement();
document.body.append(field);

const norm = (s: string) => s.replace(/\s+/g, '');

window.runCorpus = (lines: string[]) => lines.map(src => {
  // A fresh field per formula: setValue inherits the previous insertion mode.
  const field = new MathfieldElement();
  document.body.append(field);
  field.setValue(src, { silenceNotifications: true });
  const ser = field.getValue('latex-without-placeholders');
  const errors = field.errors.map(e => `${e.code}:${e.arg ?? ''}`);
  field.mode = 'math';
  field.setValue(ser, { silenceNotifications: true });
  const again = field.getValue('latex-without-placeholders');
  field.remove();
  return { src, ser, errors, canonical: ser === src, wsOnly: ser !== src && norm(ser) === norm(src), idempotent: again === ser };
});

window.runIslands = () => {
  field.macros = { ...field.macros,
    OMTa: { def: '\\left|\\psi\\right\\rangle', args: 0, captureSelection: true, expand: false },
    OMTb: { def: '', args: 0, captureSelection: true, expand: false },
    norm: { def: '\\left\\lVert#1\\right\\rVert', args: 1, captureSelection: false, expand: false },
  } as typeof field.macros;
  const out: Record<string, unknown> = {};
  for (const src of ['\\OMTa+x', 'x\\OMTb', '\\begin{aligned}a&=b\\OMTb\\\\c&=d\\end{aligned}', '\\norm{x}+1', 'a\\OMTa b']) {
    field.setValue(src, { silenceNotifications: true });
    out[src] = { latex: field.getValue('latex'), noPh: field.getValue('latex-without-placeholders'), expanded: field.getValue('latex-expanded') };
  }
  // Placeholders from templates must not appear in latex-without-placeholders.
  field.setValue('', { silenceNotifications: true });
  field.insert('\\frac{#?}{#?}');
  out.template = { latex: field.getValue('latex'), noPh: field.getValue('latex-without-placeholders') };
  // Prompts inside a macro definition (S5 preview).
  field.macros = { ...field.macros, pr: { def: '\\left\\lVert\\placeholder[a1]{x}\\right\\rVert', args: 0, captureSelection: false, expand: false } } as typeof field.macros;
  field.setValue('\\placeholder[p1]{y}+1', { silenceNotifications: true });
  out.prompt = { latex: field.getValue('latex'), prompts: field.getPrompts(), value: field.getPromptValue('p1') };
  return out;
};

import { reconcile } from '../../../src/core/writeback.ts';
import { diffText } from '../../../src/core/patch.ts';

declare global { interface Window { runWriteback(lines: string[]): unknown } }

const hidden = new MathfieldElement();
hidden.style.display = 'none';
document.body.append(hidden);
const canon = (s: string) => {
  hidden.setValue(s, { silenceNotifications: true, mode: 'math' });
  return hidden.errors.length ? undefined : hidden.getValue('latex-without-placeholders');
};

window.runWriteback = (lines: string[]) => {
  const out: unknown[] = [];
  for (const src of lines) {
    for (const edit of ['append', 'prepend', 'replaceFirst', 'deleteLast']) {
      const field = new MathfieldElement();
      document.body.append(field);
      field.setValue(src, { silenceNotifications: true });
      const before = field.getValue('latex-without-placeholders');
      if (edit === 'append') { field.position = field.lastOffset; field.insert('+z'); }
      if (edit === 'prepend') { field.position = 0; field.insert('q='); }
      if (edit === 'replaceFirst') { field.selection = { ranges: [[0, 1]] }; field.insert('w'); }
      if (edit === 'deleteLast') { field.position = field.lastOffset; field.executeCommand('deleteBackward'); }
      const after = field.getValue('latex-without-placeholders');
      field.remove();
      const r = reconcile(src, before, after, canon);
      const ok = canon(r.view) === canon(after);
      const d = diffText(src, r.view);
      out.push({ src, edit, after, view: r.view, strategy: r.strategy, ok, patch: d ? src.slice(d.from, d.to) + ' -> ' + d.insert : '' });
    }
  }
  return out;
};
