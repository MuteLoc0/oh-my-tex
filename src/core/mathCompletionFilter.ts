import { MATH_COMMANDS, MATH_ENVIRONMENTS } from './mathCommands.ts';
import type { MacroDef } from '../shared/types.ts';

interface MathCandidate {
  label: string;
  filterText?: string;
  insert: { value: string };
  source?: string;
}

function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap(pattern => {
    try { return [new RegExp(pattern)]; } catch { return []; }
  });
}

function allowed(item: MathCandidate, macros: readonly MacroDef[], patterns: readonly RegExp[]): boolean {
  if (item.source === 'template' || item.source === 'macro') { return true; }
  if (patterns.some(pattern => [item.label, item.filterText ?? '', item.insert.value].some(value => pattern.test(value)))) { return true; }
  const body = item.insert.value.trimStart();
  // Providers commonly omit the backslash because their replacement range starts
  // after the backslash already in the document. Prefer the inserted command over
  // labels, which may contain display-only descriptions or misleading aliases.
  const first = body.match(/^\\?([a-zA-Z@]+\*?)/) ?? body.match(/\\([a-zA-Z@]+\*?|[^a-zA-Z@])/);
  if (!first) { return false; }
  const command = first[1];
  if (command === 'begin' || command === 'end') {
    const environment = body.slice(first.index! + first[0].length).match(/^\s*\{([^}]+)\}/)?.[1];
    return !!environment && MATH_ENVIRONMENTS.has(environment);
  }
  return MATH_COMMANDS.has(command) || macros.some(macro => macro.name === command.replace(/\*$/, ''));
}

/** Keep MathLive commands, project macros, templates and explicitly allowed items. */
export function isMathCompletion(item: MathCandidate, macros: readonly MacroDef[] = [], allowPatterns: readonly string[] = []): boolean {
  return allowed(item, macros, compilePatterns(allowPatterns));
}

/** Run before fuzzy ranking and the response limit so prose items do not consume slots. */
export function filterMathCompletions<T extends MathCandidate>(items: readonly T[], macros: readonly MacroDef[] = [], allowPatterns: readonly string[] = []): T[] {
  const patterns = compilePatterns(allowPatterns);
  return items.filter(item => allowed(item, macros, patterns));
}
