import type { MacroDef, Template } from '../shared/types.ts';

/** `oh-my-tex.macros`: { "\\R": "\\mathbb{R}", "\\norm": { "args": 1, "def": "...", "default": "..." } } */
export function normalizeUserMacros(value: unknown): MacroDef[] {
  if (!value || typeof value !== 'object') { return []; }
  const result: MacroDef[] = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const name = key.replace(/^\\/, '');
    if (!/^[a-zA-Z@]+$/.test(name)) { continue; }
    if (typeof raw === 'string') { result.push({ name, arity: 0, body: raw }); continue; }
    if (!raw || typeof raw !== 'object') { continue; }
    const r = raw as Record<string, unknown>;
    const arity = Number(r.args ?? 0);
    if (typeof r.def !== 'string' || !Number.isInteger(arity) || arity < 0 || arity > 9) { continue; }
    const def: MacroDef = { name, arity, body: r.def };
    if (typeof r.default === 'string' && arity > 0) { def.defaultArgument = r.default; }
    result.push(def);
  }
  return result;
}

/** `oh-my-tex.renderMacros` uses the macro format, but is kept out of completion context. */
export function normalizeRenderMacros(value: unknown): MacroDef[] {
  return normalizeUserMacros(value);
}

export function normalizeTemplates(value: unknown): Template[] {
  if (!Array.isArray(value)) { return []; }
  return value.flatMap(raw => {
    if (!raw || typeof raw !== 'object') { return []; }
    const r = raw as Record<string, unknown>;
    if (typeof r.prefix !== 'string' || typeof r.body !== 'string' || !r.prefix) { return []; }
    const context = r.context === 'prose' || r.context === 'both' ? r.context : 'math';
    return [{ prefix: r.prefix, label: typeof r.label === 'string' ? r.label : r.prefix, body: r.body, context }];
  });
}
