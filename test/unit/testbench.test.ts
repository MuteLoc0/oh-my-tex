import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFile, type FileFacts } from '../../src/core/macroParser.ts';
import { indexProject, type Project, type ProjectReader } from '../../src/core/projectGraph.ts';
import { filterCompletions } from '../../src/core/completionFilter.ts';
import { filterMathCompletions } from '../../src/core/mathCompletionFilter.ts';

// The user's real project lives beside this repository, not in its committed fixtures.
// Other checkouts can explicitly opt in with OMT_TESTBENCH_ROOT=/path/to/note.
const directory = process.env.OMT_TESTBENCH_ROOT
  ? path.resolve(process.env.OMT_TESTBENCH_ROOT)
  : fileURLToPath(new URL('../../../test/testbench-v1/note/', import.meta.url));
const root = pathToFileURL(path.join(directory, 'main.tex')).href;
const names = ['eu', 'ramuno', 'dbar', 'dif', 'bm', 'varPi', 'varPhi', 'varLambda', 'calL', 'calH', 'calF', 'calZ', 'calS'];
const included = ['finite-temp-field-the.tex', 'NJL-model.tex', 'quantum-inf.tex', 'chiral-qft.tex'];
const excluded = ['NJL-model-eng.tex', 'concurrence.tex', 'appendix01-noethers-theorem.tex'];
const reader: ProjectReader = {
  read: async uri => {
    try { return await readFile(fileURLToPath(uri), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; }
      throw error;
    }
  },
  resolve: (parent, filename) => pathToFileURL(path.resolve(path.dirname(fileURLToPath(parent)), filename)).href,
};

describe('testbench-v1: real main.tex project and completion context', {
  skip: existsSync(fileURLToPath(root)) ? false : `Local fixture unavailable: ${directory}; set OMT_TESTBENCH_ROOT to its note directory`,
}, () => {
  let source: string;
  let facts: FileFacts;
  let project: Project;

  before(async () => {
    source = await readFile(fileURLToPath(root), 'utf8');
    facts = parseFile(source, root);
    project = await indexProject(root, reader);
  });

  test('parses all 13 real declarations, including starred commands and renewcommand', () => {
    assert.equal(facts.isRoot, true);
    assert.equal(facts.magicRoot, undefined);
    assert.deepEqual(facts.diagnostics, []);
    assert.deepEqual(facts.definitions.map(definition => definition.name), names);
    assert.deepEqual(facts.definitions.filter(definition => definition.command === '\\renewcommand').map(definition => definition.name),
      ['varPi', 'varPhi', 'varLambda']);
    assert.deepEqual(facts.definitions.filter(definition => definition.arity > 0).map(definition => [definition.name, definition.arity, definition.body]),
      [['bm', 1, '\\symbfit{#1}']]);
    assert.equal(facts.definitions.find(definition => definition.name === 'dif')?.body, '\\mathop{}\\!\\mathrm{d}',
      'the commented-out alternative must not override the live definition');
    for (const definition of facts.definitions) {
      assert.equal(definition.source?.uri, root);
      assert.equal(definition.source?.from, definition.at);
      assert.match(source.slice(definition.source!.from, definition.source!.to),
        new RegExp(`^\\\\(?:newcommand|renewcommand)\\*?\\{\\\\${definition.name}\\}`));
    }
  });

  test('walks exactly the four live chapter inputs in source order without missing-file diagnostics', () => {
    assert.deepEqual(facts.includes.map(include => include.path), included.map(filename => `chapters/${filename}`));
    assert.deepEqual(project.files.map(uri => path.relative(directory, fileURLToPath(uri))),
      ['main.tex', ...included.map(filename => `chapters/${filename}`)]);
    assert.deepEqual(project.macros.map(macro => macro.name), names);
    assert.deepEqual(project.diagnostics, []);
    for (const macro of project.macros) { assert.equal(macro.source?.uri, root); }
  });

  test('all real chapters lack root markers and declarations; only live inputs belong to main.tex', async () => {
    const chapterDirectory = path.join(directory, 'chapters');
    const chapters = (await readdir(chapterDirectory)).filter(filename => filename.endsWith('.tex')).sort();
    assert.deepEqual(chapters, [...included, ...excluded].sort());
    for (const filename of chapters) {
      const uri = pathToFileURL(path.join(chapterDirectory, filename)).href;
      const chapter = parseFile((await reader.read(uri))!, uri);
      assert.equal(chapter.magicRoot, undefined, `${filename}: root is discovered through the project graph`);
      assert.equal(chapter.isRoot, false, filename);
      assert.deepEqual(chapter.definitions, [], filename);
      assert.equal(project.files.includes(uri), included.includes(filename), `${filename}: inclusion membership`);
      if (excluded.includes(filename)) {
        const standalone = await indexProject(uri, reader);
        assert.deepEqual(standalone.macros, [], `${filename}: no automatic main.tex macro inheritance as a standalone root`);
      }
    }
  });

  test('real project macros survive prose ranking and math filtering, including provider-origin candidates', () => {
    const macros = project.macros.map(macro => ({
      label: `\\${macro.name}`, filterText: macro.name,
      insert: { value: `${macro.name}${macro.arity ? '{$1}' : ''}` }, source: 'provider',
    }));
    const prose = { label: '\\section', insert: { value: 'section{${1:Title}}' }, source: 'provider' };
    const candidates = [...macros, prose];
    assert.deepEqual(filterMathCompletions(candidates, project.macros).map(item => item.label), macros.map(item => item.label));
    assert.equal(filterCompletions(candidates, '\\').length, names.length + 1,
      'prose completion keeps both project commands and ordinary prose commands');
    for (const macro of macros) {
      const prefix = macro.label.slice(0, -1);
      assert.ok(filterCompletions(candidates, prefix).some(item => item.label === macro.label), `${macro.label}: prose prefix`);
      assert.ok(filterCompletions(filterMathCompletions(candidates, project.macros), prefix)
        .some(item => item.label === macro.label), `${macro.label}: math prefix`);
    }
    assert.deepEqual(filterCompletions(filterMathCompletions(candidates, project.macros), '\\cal').map(item => item.label).sort(),
      ['\\calF', '\\calH', '\\calL', '\\calS', '\\calZ']);
  });
});
