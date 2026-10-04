import { parseFile, type FileFacts } from './macroParser.ts';
import type { MacroDef } from '../shared/types.ts';

export interface ProjectReader {
  read(uri: string): Promise<string | undefined>;
  /** Resolve `path` (as written in a TeX file) relative to the directory of `parent`. */
  resolve(parent: string, path: string): string;
}

export interface Project { root: string; files: string[]; macros: MacroDef[]; diagnostics: string[] }

const MAX_FILES = 400;

/** An invalidated walk must neither refill the facts cache nor publish its result. */
export class ProjectIndexInvalidatedError extends Error {
  constructor() { super('Project index was invalidated'); }
}

/**
 * Walk the include graph from `root` in TeX reading order and collect macro definitions.
 * Later \renewcommand/\def win; \providecommand never overrides. Unreadable or cyclic
 * inputs are reported, not fatal.
 */
export async function indexProject(root: string, reader: ProjectReader, cache = new Map<string, FileFacts | undefined>(), isCurrent = () => true): Promise<Project> {
  const project: Project = { root, files: [], macros: [], diagnostics: [] };
  const table = new Map<string, MacroDef>();
  const active = new Set<string>();
  const checkGeneration = () => { if (!isCurrent()) { throw new ProjectIndexInvalidatedError(); } };
  async function facts(uri: string) {
    checkGeneration();
    if (!cache.has(uri)) {
      const text = await reader.read(uri);
      checkGeneration();
      cache.set(uri, text === undefined ? undefined : parseFile(text, uri));
    }
    return cache.get(uri);
  }
  async function visit(uri: string) {
    if (active.has(uri)) { project.diagnostics.push(`include cycle at ${uri}`); return; }
    if (project.files.length >= MAX_FILES) { project.diagnostics.push('too many included files'); return; }
    const f = await facts(uri);
    checkGeneration();
    if (!f) { project.diagnostics.push(`cannot read ${uri}`); return; }
    active.add(uri);
    if (!project.files.includes(uri)) { project.files.push(uri); }
    // Interleave definitions and includes in source order.
    const events = [...f.definitions.map(d => ({ at: d.at, def: d })), ...f.includes.map(inc => ({ at: inc.at, inc }))].sort((a, b) => a.at - b.at);
    for (const e of events) {
      if ('def' in e && e.def) {
        const { command, at: _at, ...def } = e.def;
        if (command === '\\providecommand' && table.has(def.name)) { continue; }
        table.set(def.name, def);
      } else if ('inc' in e && e.inc) {
        const path = /\.[a-z]+$/i.test(e.inc.path) ? e.inc.path : `${e.inc.path}.tex`;
        await visit(reader.resolve(root, path));
      }
    }
    active.delete(uri);
  }
  await visit(root);
  checkGeneration();
  project.macros = [...table.values()];
  return project;
}
