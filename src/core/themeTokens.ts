import type { EditorSettings, TextMateThemeRule } from '../shared/types.ts';

export type ThemeRule = TextMateThemeRule;
const targets = {
  command: ['keyword', 'keyword.control', 'support.function', 'storage.type', 'entity.name.function'],
  comment: ['comment', 'comment.line', 'comment.block', 'comment.line.percentage'],
  bracket: ['punctuation.definition', 'punctuation.section', 'punctuation'],
  math: ['constant.character', 'keyword.operator', 'constant.numeric', 'variable.other', 'string.other.math'],
};

/** A finite scope-to-category approximation, not a TextMate engine. LaTeX-specific scopes win. */
export function tokenColors(rules: ThemeRule[]): Pick<EditorSettings['tokens'], 'command' | 'comment' | 'bracket' | 'math'> {
  const result: Pick<EditorSettings['tokens'], 'command' | 'comment' | 'bracket' | 'math'> = {};
  for (const [name, scopes] of Object.entries(targets)) {
    let score = -1;
    for (const rule of rules) {
      const color = rule?.settings?.foreground;
      if (typeof color !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)) { continue; }
      const selectors = (Array.isArray(rule.scope) ? rule.scope : typeof rule.scope === 'string' ? [rule.scope] : [])
        .filter((scope): scope is string => typeof scope === 'string').flatMap(scope => scope.split(','));
      for (const selector of selectors) {
        // Descendant selectors occur in real themes. Ignore expressions we cannot safely approximate.
        const parts = selector.trim().split(/\s+/);
        if (!parts.length || parts.some(part => /[^\w.*-]/.test(part) || part === '-')) { continue; }
        const leaf = parts.at(-1)!;
        const context = parts.slice(0, -1);
        if (context.some(part => !/\.(?:tex|latex)(?:\.|$)/.test(part))) { continue; }
        const language = /\.(?:tex|latex)(?:\.|$)/.test(leaf) || context.length > 0;
        const category = leaf.replace(/\.(?:tex|latex)(?:\..*)?$/, '');
        const match = scopes.findIndex(scope => category === scope || language && category.startsWith(`${scope}.`));
        if (match < 0) { continue; }
        // Most Workshop commands use support.function. An entity.name.function
        // rule for declared names should not color every command in the fallback.
        const commandPreference = name === 'command' && category.startsWith('support.function') ? 1_000 : 0;
        const weight = (language ? 10_000 : 0) + commandPreference + category.split('.').length * 100 + context.length * 10 - match;
        if (weight >= score) { result[name as keyof typeof result] = color; score = weight; }
      }
    }
  }
  return result;
}

const tokenGroups = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

/** VS Code recognizes a leading and/or trailing wildcard in a theme name. */
export function themeScopeMatches(key: string, themeName?: string): boolean {
  if (!themeName || !key.startsWith('[') || !key.endsWith(']')) { return false; }
  return [...key.matchAll(/\[([^\]]+)\]/g)].some(([, pattern]) => {
    if (pattern === themeName) { return true; }
    if (pattern!.startsWith('*') && pattern!.endsWith('*')) { return themeName.includes(pattern!.slice(1, -1)); }
    if (pattern!.endsWith('*')) { return themeName.startsWith(pattern!.slice(0, -1)); }
    return pattern!.startsWith('*') && themeName.endsWith(pattern!.slice(1));
  });
}

/** Merge matching theme groups before expanding their shorthand and rules. */
export function themeScopedCustomizations(value: Record<string, unknown>, themeName?: string): Record<string, unknown> {
  const scoped: Record<string, unknown> = {};
  for (const [key, custom] of Object.entries(value)) {
    if (!themeScopeMatches(key, themeName) || !custom || typeof custom !== 'object' || Array.isArray(custom)) { continue; }
    for (const [setting, replacement] of Object.entries(custom)) {
      const previous = scoped[setting];
      if (Array.isArray(previous) && Array.isArray(replacement)) { scoped[setting] = [...previous, ...replacement]; }
      else if (replacement) { scoped[setting] = replacement; }
    }
  }
  return scoped;
}

/** Extract complete global and matching theme token customizations. */
export function customizationRules(value: unknown, themeName?: string): ThemeRule[] {
  const rules: ThemeRule[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) { return rules; }
  const append = (custom: Record<string, unknown>) => {
    for (const [setting, scopes] of Object.entries(tokenGroups)) {
      const value = custom[setting];
      const settings = typeof value === 'string' ? { foreground: value }
        : value && typeof value === 'object' && !Array.isArray(value) ? value as ThemeRule['settings'] : undefined;
      if (settings) { for (const scope of scopes) { rules.push({ scope, settings }); } }
    }
    // Specific rules follow shorthands, including rules that clear fontStyle.
    if (Array.isArray(custom.textMateRules)) {
      rules.push(...custom.textMateRules.filter((rule): rule is ThemeRule =>
        !!rule && typeof rule === 'object' && !!rule.scope && !!rule.settings));
    }
  };
  const custom = value as Record<string, unknown>;
  append(custom);
  append(themeScopedCustomizations(custom, themeName));
  return rules;
}

/** VS Code uses 0 for automatic height and values below 8 as font-size multiples. */
export function editorLineHeight(fontSize: number, configured: number): number {
  if (!Number.isFinite(configured) || configured <= 0) { return Math.round(fontSize * 1.5); }
  return configured < 8 ? fontSize * configured : configured;
}
