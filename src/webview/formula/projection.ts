import { buildIslands, expandBody, islandMacros, restoreIslands, type Island } from '../../core/islands.ts';
import type { FormulaSpan } from '../../core/formulaScanner.ts';
import type { MacroDef } from '../../shared/types.ts';
import { displayMacros, projectMacros, unknownCommands, type MacroDictionary } from './mathlive.ts';

/** How one formula body is shown in a math field, and how to turn field text back into body source. */
export interface Projection {
  /** Body source in island space, wrapped in the projection environment when there is one. */
  view: string;
  islands: Island[];
  macros: MacroDictionary;
  /** Inverse: field/view text → body source, or undefined if the wrapper environment was destroyed. */
  restore(view: string): string | undefined;
}

export interface MacroContext {
  version: number;
  defs: Map<string, MacroDef>;
  dictionary: MacroDictionary;
  /** Source definitions alone determine completion eligibility. */
  completionDefs: MacroDef[];
}

export function macroContext(version: number, macros: readonly MacroDef[], renderMacros: readonly MacroDef[] = []): MacroContext {
  const rendered = displayMacros(macros, renderMacros);
  return { version, defs: new Map(rendered.map(m => [m.name, m])), dictionary: projectMacros(rendered), completionDefs: [...macros] };
}

export function project(span: FormulaSpan, body: string, context: MacroContext): Projection {
  const open = span.wrapper ? `\\begin{${span.wrapper}}` : '', close = span.wrapper ? `\\end{${span.wrapper}}` : '';
  // Validate in the environment the body is shown in: \\ and & are only legal inside it.
  const unknown = unknownCommands(open + body + close, context.dictionary);
  // Macros whose definitions MathLive cannot render are chips too.
  for (const [name, def] of context.defs) {
    // Group probes just like real arguments. A bare x after \\lVert would become
    // \\lVertx and incorrectly turn a supported norm macro into an unknown chip.
    if (body.includes(`\\${name}`) && unknownCommands(expandBody(def.body, Array(def.arity).fill('x')), context.dictionary).size) { unknown.add(name); }
  }
  const { view: inner, islands } = buildIslands(body, context.defs, unknown);
  return {
    view: open + inner + close,
    islands,
    macros: { ...context.dictionary, ...islandMacros(islands) },
    restore(view: string) {
      let text = view;
      if (span.wrapper) {
        const trimmed = text.trim();
        if (!trimmed.startsWith(open) || !trimmed.endsWith(close)) { return undefined; }
        text = text.slice(text.indexOf(open) + open.length, text.lastIndexOf(close));
      }
      return restoreIslands(text, islands);
    },
  };
}
