import { MathfieldElement } from 'mathlive';
import { buildIslands, islandMacros, restoreIslands } from '../../../src/core/islands.ts';

declare global {
  interface Window {
    runMacroArgsSpike(): Promise<unknown>;
  }
}

MathfieldElement.soundsDirectory = null;
MathfieldElement.fontsDirectory = '/fonts';

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function createField() {
  const field = new MathfieldElement();
  field.style.cssText = 'display:block;width:700px;margin:20px;font-size:24px';
  document.body.append(field);
  field.mathVirtualKeyboardPolicy = 'manual';
  field.popoverPolicy = 'off';
  return field;
}

const snapshot = (field: MathfieldElement) => ({
  latex: field.getValue('latex'),
  noPh: field.getValue('latex-without-placeholders'),
  expanded: field.getValue('latex-expanded'),
  prompts: field.getPrompts(),
  promptAtoms: Array.from({ length: field.lastOffset + 1 }, (_, offset) => field.getElementInfo(offset)?.latex)
    .filter(latex => latex?.startsWith('\\placeholder[')),
  position: field.position,
  lastOffset: field.lastOffset,
  errors: field.errors,
});

window.runMacroArgsSpike = async () => {
  const out: Record<string, unknown> = {};
  for (const captureSelection of [false, true]) {
    const field = createField();
    field.macros = { ...field.macros,
      OMTa: { def: '\\left\\lVert\\placeholder[omt-a-0]{x}\\right\\rVert', args: 0, captureSelection, expand: false },
      OMTb: { def: '\\placeholder[omt-b-0]{x}+\\placeholder[omt-b-0]{x}', args: 0, captureSelection, expand: false },
    };
    field.setValue('\\OMTa+\\OMTb', { silenceNotifications: true, mode: 'math' });
    await frame();
    const before = snapshot(field);
    const prompts = field.getPrompts();
    const valuesBefore = prompts.map(id => [id, field.getPromptValue(id)]);
    field.setPromptValue('omt-a-0', 'y', { silenceNotifications: true, mode: 'math' });
    field.setPromptValue('omt-b-0', 'y', { silenceNotifications: true, mode: 'math' });
    await frame();
    out[`prompts-capture-${captureSelection}`] = {
      before, valuesBefore, after: snapshot(field),
      valuesAfter: prompts.map(id => [id, field.getPromptValue(id)]),
    };
    field.remove();
  }

  {
    const macros = new Map([['dup', { name: 'dup', arity: 1, body: '#1+#1' }]]);
    let source = '\\dup{x}+a';
    const main = createField(), argument = createField();
    const before = buildIslands(source, macros);
    main.macros = { ...main.macros, ...islandMacros(before.islands) };
    main.setValue(before.view, { silenceNotifications: true, mode: 'math' });
    argument.setValue('x', { silenceNotifications: true, mode: 'math' });
    argument.selection = { ranges: [[0, argument.lastOffset]] };
    argument.insert('y', { silenceNotifications: true, mode: 'math' });
    const value = argument.getValue('latex-without-placeholders');
    const arg = before.islands[0].args[0];
    source = source.slice(0, arg.from) + value + source.slice(arg.to);
    const after = buildIslands(source, macros);
    main.macros = { ...main.macros, ...islandMacros(after.islands) };
    main.setValue(after.view, { silenceNotifications: true, mode: 'math' });
    await frame();
    out.floatingArgument = {
      source, field: snapshot(main), argument: value,
      restored: restoreIslands(main.getValue('latex-without-placeholders'), after.islands),
      rendered: after.islands[0].render,
      expandedAtoms: Array.from({ length: main.lastOffset + 1 }, (_, offset) => main.getElementInfo(offset)?.latex),
    };
    main.remove(); argument.remove();
  }

  for (const [name, source] of Object.entries({
    inline: 'q+\\OMTa+\\OMTb+r',
    fraction: '\\frac{\\OMTa+u}{\\OMTb}+v',
    script: 'a^{\\OMTa}+b_{\\OMTb}',
    aligned: '\\begin{aligned}a&=\\OMTa\\\\b&=\\OMTb\\end{aligned}',
  })) {
    const field = createField();
    field.macros = { ...field.macros,
      OMTa: { def: '\\left\\lVert x\\right\\rVert', args: 0, captureSelection: true, expand: false },
      OMTb: { def: 'x+x', args: 0, captureSelection: true, expand: false },
    };
    field.setValue(source, { silenceNotifications: true, mode: 'math' });
    await frame();
    const offsets = Array.from({ length: field.lastOffset + 1 }, (_, offset) => {
      const info = field.getElementInfo(offset);
      const b = info?.bounds;
      return { offset, latex: info?.latex, depth: info?.depth,
        bounds: b ? { left: b.left, right: b.right, top: b.top, bottom: b.bottom } : null };
    });
    const islands = offsets.filter(item => /^\\OMT[a-z]+$/.test(item.latex ?? ''));
    const hits = islands.flatMap(item => {
      if (!item.bounds) { return []; }
      const b = item.bounds;
      return [0.1, 0.5, 0.9].map(fraction => {
        const offset = field.getOffsetFromPoint(b.left + (b.right - b.left) * fraction, (b.top + b.bottom) / 2);
        return { token: item.latex, fraction, offset, latex: field.getElementInfo(offset)?.latex,
          nextLatex: field.getElementInfo(offset + 1)?.latex };
      });
    });
    const movements = [];
    field.position = 0;
    for (let n = 0; n < field.lastOffset + 3; n++) {
      const position = field.position;
      movements.push({ position, latex: field.getElementInfo(position)?.latex,
        prefix: field.getValue(0, position, 'latex-without-placeholders'),
        nextIslandRange: islands.find(item => item.offset > position) ? field.getValue(position, islands.find(item => item.offset > position)!.offset, 'latex-without-placeholders') : undefined,
        nextLatex: field.getElementInfo(position + 1)?.latex });
      field.executeCommand('moveToNextChar');
      if (field.position === position) { break; }
    }
    const deletions = islands.map(item => {
      field.setValue(source, { silenceNotifications: true, mode: 'math' });
      field.position = item.offset;
      field.executeCommand('deleteBackward');
      return { token: item.latex, offset: item.offset, after: field.getValue('latex-without-placeholders') };
    });
    out[name] = { source, offsets, hits, movements, deletions };
    field.remove();
  }
  return out;
};
