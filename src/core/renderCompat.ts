import type { MacroDef } from '../shared/types.ts';

/** Display approximations only: the source command and its arguments remain authoritative. */
export const RENDER_COMPAT: Record<string, { def: string; args: number }> = {
  // unicode-math's symbol families, and the corresponding legacy math aliases.
  symbfit: { def: '\\mathbfit{#1}', args: 1 },
  symit: { def: '\\mathit{#1}', args: 1 },
  symbf: { def: '\\mathbf{#1}', args: 1 },
  symup: { def: '\\mathrm{#1}', args: 1 },
  symrm: { def: '\\mathrm{#1}', args: 1 },
  symsf: { def: '\\mathsf{#1}', args: 1 },
  symtt: { def: '\\mathtt{#1}', args: 1 },
  symcal: { def: '\\mathcal{#1}', args: 1 },
  symscr: { def: '\\mathscr{#1}', args: 1 },
  symfrak: { def: '\\mathfrak{#1}', args: 1 },
  symbb: { def: '\\mathbb{#1}', args: 1 },
  symbfup: { def: '\\mathbf{#1}', args: 1 },
  mathbfup: { def: '\\mathbf{#1}', args: 1 },
  mathup: { def: '\\mathrm{#1}', args: 1 },
  mathsfup: { def: '\\mathsf{#1}', args: 1 },
  symbfsf: { def: '\\mathsf{\\bm{#1}}', args: 1 },
  symbfsfup: { def: '\\mathsf{\\bm{#1}}', args: 1 },
  mathbfsf: { def: '\\mathsf{\\bm{#1}}', args: 1 },
  mathbfsfup: { def: '\\mathsf{\\bm{#1}}', args: 1 },
  symbfcal: { def: '\\mathcal{\\bm{#1}}', args: 1 },
  symbfscr: { def: '\\mathscr{\\bm{#1}}', args: 1 },
  symbffrak: { def: '\\mathfrak{\\bm{#1}}', args: 1 },
  mathbfcal: { def: '\\mathcal{\\bm{#1}}', args: 1 },
  mathbfscr: { def: '\\mathscr{\\bm{#1}}', args: 1 },
  mathbffrak: { def: '\\mathfrak{\\bm{#1}}', args: 1 },

  // Common package commands. Physics commands use their basic braced forms;
  // package-specific stars, derivative orders and delimiter syntax need source editing.
  bm: { def: '\\boldsymbol{#1}', args: 1 },
  dots: { def: '\\ldots', args: 0 },
  slashed: { def: '\\cancel{#1}', args: 1 },
  cancelto: { def: '\\overset{#1}{\\cancel{#2}}', args: 2 },
  dv: { def: '\\frac{\\mathrm{d}#1}{\\mathrm{d}#2}', args: 2 },
  pdv: { def: '\\frac{\\partial#1}{\\partial#2}', args: 2 },
  abs: { def: '\\left|#1\\right|', args: 1 },
  norm: { def: '\\left\\lVert#1\\right\\rVert', args: 1 },
  qty: { def: '\\left(#1\\right)', args: 1 },
  bra: { def: '\\left\\langle#1\\right|', args: 1 },
  ket: { def: '\\left|#1\\right\\rangle', args: 1 },
  braket: { def: '\\left\\langle#1\\right\\rangle', args: 1 },
};

/**
 * Definitions used for display, with precedence overrides > project > compatibility.
 * The engine's own commands win over compatibility entries only. A render override
 * changes an existing project definition's body without changing how its source calls
 * are parsed, located or edited.
 */
export function renderDefinitions(
  project: readonly MacroDef[], overrides: readonly MacroDef[], knowsCommand: (name: string) => boolean,
): MacroDef[] {
  const result = new Map<string, MacroDef>();
  for (const [name, compat] of Object.entries(RENDER_COMPAT)) {
    if (!knowsCommand(name)) { result.set(name, { name, body: compat.def, arity: compat.args }); }
  }
  const originals = new Map(project.map(macro => [macro.name, macro]));
  for (const macro of project) { result.set(macro.name, { ...macro }); }
  for (const override of overrides) {
    const original = originals.get(override.name);
    result.set(override.name, original ? { ...original, body: override.body } : { ...override });
  }
  return [...result.values()];
}
