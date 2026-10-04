import { groupAt, tokenize, type Token } from './lexer.ts';
import type { MacroDef } from '../shared/types.ts';

export interface Definition extends MacroDef { command: string; at: number }
export interface Include { path: string; at: number; command: string }
export interface FileFacts { definitions: Definition[]; includes: Include[]; magicRoot?: string; isRoot: boolean; diagnostics: string[] }

const DEFINERS = new Set(['\\newcommand', '\\renewcommand', '\\providecommand', '\\DeclareMathOperator', '\\DeclareRobustCommand']);
const INCLUDERS = new Set(['\\input', '\\include', '\\subfile', '\\subfileinclude', '\\import', '\\subimport', '\\InputIfFileExists']);
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment']);

/** Collect macro definitions, file inclusions and root markers from one file. Best effort, never throws. */
export function parseFile(text: string, uri: string): FileFacts {
  const facts: FileFacts = { definitions: [], includes: [], isRoot: /^[ \t]*\\documentclass\b/m.test(text), diagnostics: [] };
  const magic = text.match(/^[ \t]*%[ \t]*!TeX[ \t]+root[ \t]*=[ \t]*(.+?)[ \t]*$/im);
  if (magic) { facts.magicRoot = magic[1]; }
  const tokens = tokenize(text).filter(t => t.kind !== 'space' && t.kind !== 'comment');
  const slice = (g: { from: number; to: number }) => text.slice(g.from, g.to);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.value === '\\begin') {
      const g = groupAt(tokens, i + 1);
      if (g && VERBATIM_ENVS.has(slice(g))) {
        const close = `\\end{${slice(g)}}`, stop = text.indexOf(close, g.end);
        const to = stop < 0 ? text.length : stop + close.length;
        while (i + 1 < tokens.length && tokens[i + 1].from < to) { i++; }
      }
      continue;
    }
    if (DEFINERS.has(t.value)) {
      const parsed = parseNewcommand(tokens, text, i, uri);
      if (parsed) { facts.definitions.push(parsed.def); i = parsed.next - 1; }
      else { facts.diagnostics.push(`unrecognised ${t.value} at ${t.from}`); }
      continue;
    }
    if (t.value === '\\def' || t.value === '\\gdef') {
      const parsed = parseDef(tokens, text, i, uri);
      if (parsed) { facts.definitions.push(parsed.def); i = parsed.next - 1; }
      continue;
    }
    if (INCLUDERS.has(t.value)) {
      let p = i + 1;
      if (tokens[p]?.value === '*') { p++; }
      // \import{dir}{file} and \subimport{dir}{file}
      let dir = '';
      if (t.value === '\\import' || t.value === '\\subimport') {
        const d = groupAt(tokens, p);
        if (!d) { continue; }
        dir = slice(d).trim(); p = d.next;
      }
      const g = groupAt(tokens, p);
      if (g) {
        const path = slice(g).trim();
        if (/^[^\\#%{}$]+$/.test(path)) { facts.includes.push({ path: dir ? joinPath(dir, path) : path, at: t.from, command: t.value }); }
        else { facts.diagnostics.push(`dynamic ${t.value} at ${t.from}`); }
      } else if (t.value === '\\input' && tokens[p]?.kind === 'char') {
        // \input file (TeX primitive syntax) — the name runs to the next whitespace.
        const m = text.slice(tokens[p].from).match(/^[^\s{}%\\]+/);
        if (m) { facts.includes.push({ path: m[0], at: t.from, command: t.value }); }
      }
    }
  }
  return facts;
}

function joinPath(dir: string, file: string) { return dir.endsWith('/') ? dir + file : `${dir}/${file}`; }

function parseNewcommand(tokens: Token[], text: string, i: number, uri: string): { def: Definition; next: number } | undefined {
  const command = tokens[i].value;
  let p = i + 1;
  if (tokens[p]?.value === '*') { p++; }
  let name: string | undefined;
  const nameGroup = groupAt(tokens, p);
  if (nameGroup) { name = text.slice(nameGroup.from, nameGroup.to).trim(); p = nameGroup.next; }
  else if (tokens[p]?.kind === 'command') { name = tokens[p].value; p++; }
  if (!name || !/^\\[a-zA-Z@]+$/.test(name)) { return undefined; }
  const operator = command === '\\DeclareMathOperator';
  let arity = 0, defaultArgument: string | undefined;
  if (!operator) {
    const count = groupAt(tokens, p, '[', ']');
    if (count) {
      arity = Number(text.slice(count.from, count.to).trim()); p = count.next;
      const optional = groupAt(tokens, p, '[', ']');
      if (optional) { defaultArgument = text.slice(optional.from, optional.to); p = optional.next; }
    }
  }
  const body = groupAt(tokens, p);
  if (!body || !Number.isInteger(arity) || arity < 0 || arity > 9 || defaultArgument !== undefined && arity < 1) { return undefined; }
  const def: Definition = {
    name: name.slice(1), arity, body: text.slice(body.from, body.to), command, at: tokens[i].from,
    source: { uri, from: tokens[i].from, to: body.end },
  };
  if (defaultArgument !== undefined) { def.defaultArgument = defaultArgument; }
  if (operator) { def.operator = true; }
  return { def, next: body.next };
}

/** \def\name{body} and \def\name#1#2{body}; delimited parameter texts are not supported. */
function parseDef(tokens: Token[], text: string, i: number, uri: string): { def: Definition; next: number } | undefined {
  const name = tokens[i + 1];
  if (name?.kind !== 'command' || !/^\\[a-zA-Z@]+$/.test(name.value)) { return undefined; }
  let p = i + 2, arity = 0;
  while (tokens[p]?.value === '#' && tokens[p + 1]?.value === String(arity + 1)) { arity++; p += 2; }
  const body = groupAt(tokens, p);
  if (!body) { return undefined; }
  return { def: { name: name.value.slice(1), arity, body: text.slice(body.from, body.to), command: tokens[i].value, at: tokens[i].from, source: { uri, from: tokens[i].from, to: body.end } }, next: body.next };
}
