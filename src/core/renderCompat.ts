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
  bra: { def: '\\mathinner{\\langle{#1}|}', args: 1 },
  ket: { def: '\\mathinner{|{#1}\\rangle}', args: 1 },
  braket: { def: '\\mathinner{\\langle{#1}\\rangle}', args: 1 },
};

// MathLive's native braket-package macros expose their expanded atoms for editing,
// but serialize the original argument string. Editing x to y can therefore show y
// while getValue() still returns \\bra{x}. Give these calls source-owned arguments,
// using their native display definitions so existing delimiter sizing is retained.
const SOURCE_ARGUMENTS = new Set(['bra', 'ket', 'braket']);

/**
 * Definitions used for display, with precedence overrides > project > compatibility.
 * The engine's own commands win over compatibility entries except macros whose
 * editable arguments cannot round-trip through the engine. A render override
 * changes an existing project definition's body without changing how its source calls
 * are parsed, located or edited.
 */
export function renderDefinitions(
  project: readonly MacroDef[], overrides: readonly MacroDef[], knowsCommand: (name: string) => boolean,
): MacroDef[] {
  const result = new Map<string, MacroDef>();
  for (const [name, compat] of Object.entries(RENDER_COMPAT)) {
    if (SOURCE_ARGUMENTS.has(name) || !knowsCommand(name)) { result.set(name, { name, body: compat.def, arity: compat.args }); }
  }
  const originals = new Map(project.map(macro => [macro.name, macro]));
  for (const name of SOURCE_ARGUMENTS) {
    if (!originals.has(name)) { originals.set(name, result.get(name)!); }
  }
  for (const macro of project) { result.set(macro.name, { ...macro }); }
  for (const override of overrides) {
    const original = originals.get(override.name);
    result.set(override.name, original ? { ...original, body: override.body } : { ...override });
  }
  return [...result.values()];
}
