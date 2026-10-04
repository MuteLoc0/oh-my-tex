import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../../src/core/macroParser.ts';
import { indexProject, ProjectIndexInvalidatedError, type ProjectReader } from '../../src/core/projectGraph.ts';
import type { FileFacts } from '../../src/core/macroParser.ts';
import { normalizeTemplates, normalizeUserMacros } from '../../src/core/templates.ts';

test('definitions: newcommand variants, operators, def', () => {
  const f = parseFile(String.raw`\newcommand{\ket}[1]{\left|#1\right\rangle}
\newcommand*\R{\mathbb{R}}
\providecommand{\pair}[2][x]{#1+#2}
\DeclareMathOperator*{\argmax}{arg\,max}
\def\half{\frac12}
\def\sq#1{#1^2}
% \newcommand{\hidden}{x}`, 'file:///m.tex');
  assert.deepEqual(f.definitions.map(d => [d.name, d.arity, d.body, d.defaultArgument ?? null, !!d.operator]), [
    ['ket', 1, '\\left|#1\\right\\rangle', null, false],
    ['R', 0, '\\mathbb{R}', null, false],
    ['pair', 2, '#1+#2', 'x', false],
    ['argmax', 0, 'arg\\,max', null, true],
    ['half', 0, '\\frac12', null, false],
    ['sq', 1, '#1^2', null, false],
  ]);
});

test('includes and root markers', () => {
  const f = parseFile('% !TeX root = ../main.tex\n\\input{a}\\include{b/c}\\input d.tex \\subimport{s/}{t}\\input{\\x}', 'file:///p/x.tex');
  assert.equal(f.magicRoot, '../main.tex');
  assert.equal(f.isRoot, false);
  assert.deepEqual(f.includes.map(i => i.path), ['a', 'b/c', 'd.tex', 's/t']);
  assert.equal(f.diagnostics.length, 1);
});

test('project graph: order, overrides, providecommand, cycles, missing', async () => {
  const files: Record<string, string> = {
    'file:///p/main.tex': '\\documentclass{article}\\newcommand{\\a}{1}\\input{defs}\\renewcommand{\\a}{3}\\input{loop}\\input{missing}',
    'file:///p/defs.tex': '\\renewcommand{\\a}{2}\\providecommand{\\b}{B}\\providecommand{\\a}{no}',
    'file:///p/loop.tex': '\\input{main}',
  };
  const reader: ProjectReader = { read: async uri => files[uri], resolve: (_p, path) => `file:///p/${path}` };
  const project = await indexProject('file:///p/main.tex', reader);
  assert.deepEqual(project.files, ['file:///p/main.tex', 'file:///p/defs.tex', 'file:///p/loop.tex']);
  assert.deepEqual(project.macros.map(m => [m.name, m.body]), [['a', '3'], ['b', 'B']]);
  assert.equal(project.diagnostics.length, 2);
});

test('user macros and templates are normalised', () => {
  assert.deepEqual(normalizeUserMacros({ '\\R': '\\mathbb{R}', norm: { args: 1, def: '\\|#1\\|' }, 'bad name': 'x', '\\z': { args: 12, def: '' } }),
    [{ name: 'R', arity: 0, body: '\\mathbb{R}' }, { name: 'norm', arity: 1, body: '\\|#1\\|' }]);
  assert.deepEqual(normalizeTemplates([{ prefix: '\\sumn', body: '\\sum_{$1}' }, { body: 'x' }]), [{ prefix: '\\sumn', label: '\\sumn', body: '\\sum_{$1}', context: 'math' }]);
});

test('an invalidated in-flight read cannot replace facts cached by the next generation', async () => {
  const uri = 'file:///p/main.tex', cache = new Map<string, FileFacts | undefined>();
  let generation = 0, reads = 0;
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const reader: ProjectReader = {
    read: async () => {
      if (++reads === 1) { entered(); await blocked; return '\\newcommand{\\value}{old}'; }
      return '\\newcommand{\\value}{fresh}';
    },
    resolve: (_parent, path) => path,
  };
  const firstGeneration = generation;
  const stale = indexProject(uri, reader, cache, () => generation === firstGeneration);
  const rejected = assert.rejects(stale, ProjectIndexInvalidatedError);
  await started;
  generation++;
  cache.clear();
  const currentGeneration = generation;
  const current = await indexProject(uri, reader, cache, () => generation === currentGeneration);
  release();
  await rejected;
  assert.equal(current.macros[0].body, 'fresh');
  assert.equal(cache.get(uri)?.definitions[0].body, 'fresh');
  assert.equal((await indexProject(uri, reader, cache)).macros[0].body, 'fresh');
  assert.equal(reads, 2);
});
