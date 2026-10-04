import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RENDER_COMPAT, renderDefinitions } from '../../src/core/renderCompat.ts';
import { buildIslands, expandBody, restoreIslands } from '../../src/core/islands.ts';
import type { MacroDef } from '../../src/shared/types.ts';

const definitions = (project: readonly MacroDef[] = [], overrides: readonly MacroDef[] = [], known: readonly string[] = []) =>
  new Map(renderDefinitions(project, overrides, name => known.includes(name)).map(macro => [macro.name, macro]));

test('unicode-math compatibility expands each supported symbol family', () => {
  const targets = {
    symbfit: 'mathbfit', symit: 'mathit', symbf: 'mathbf', symup: 'mathrm', symrm: 'mathrm',
    symsf: 'mathsf', symtt: 'mathtt', symcal: 'mathcal', symscr: 'mathscr', symfrak: 'mathfrak', symbb: 'mathbb',
    symbfup: 'mathbf', mathbfup: 'mathbf', mathup: 'mathrm', mathsfup: 'mathsf',
  };
  for (const [name, target] of Object.entries(targets)) {
    const { def, args } = RENDER_COMPAT[name];
    assert.equal(args, 1, name);
    assert.equal(expandBody(def, ['x+\\alpha']), `\\${target}{{x+\\alpha}}`, name);
  }
  assert.equal(expandBody(RENDER_COMPAT.mathbfsfup.def, ['x']), '\\mathsf{\\bm{{x}}}');
  assert.equal(expandBody(RENDER_COMPAT.symbffrak.def, ['g']), '\\mathfrak{\\bm{{g}}}');
});

test('package compatibility consumes its declared arguments and expands display approximations', () => {
  const cases: [string, string[], string][] = [
    ['bm', ['p'], '\\boldsymbol{{p}}'],
    ['dots', [], '\\ldots'],
    ['slashed', ['p'], '\\cancel{{p}}'],
    ['cancelto', ['0', 'x'], '\\overset{{0}}{\\cancel{{x}}}'],
    ['dv', ['f', 'x'], '\\frac{\\mathrm{d}{f}}{\\mathrm{d}{x}}'],
    ['pdv', ['f', 'x'], '\\frac{\\partial{f}}{\\partial{x}}'],
    ['abs', ['x'], '\\left|{x}\\right|'],
    ['norm', ['x'], '\\left\\lVert{x}\\right\\rVert'],
    ['qty', ['x'], '\\left({x}\\right)'],
    ['bra', ['x'], '\\left\\langle{x}\\right|'],
    ['ket', ['x'], '\\left|{x}\\right\\rangle'],
    ['braket', ['x|y'], '\\left\\langle{x|y}\\right\\rangle'],
  ];
  for (const [name, args, expected] of cases) {
    assert.equal(RENDER_COMPAT[name].args, args.length, name);
    assert.equal(expandBody(RENDER_COMPAT[name].def, args), expected, name);
  }
  for (const [name, macro] of Object.entries(RENDER_COMPAT)) {
    assert.ok(Number.isInteger(macro.args) && macro.args >= 0 && macro.args <= 9, name);
    for (const parameter of macro.def.matchAll(/#([1-9])/g)) {
      assert.ok(Number(parameter[1]) <= macro.args, name);
    }
  }
});

test('engine commands suppress compatibility injection while project definitions and overrides take priority', () => {
  const project: MacroDef[] = [{ name: 'abs', arity: 1, body: '#1+1' }, { name: 'bm', arity: 1, body: '\\symbfit{#1}' }];
  const overrides: MacroDef[] = [{ name: 'abs', arity: 1, body: '\\sqrt{#1}' }, { name: 'dots', arity: 0, body: '\\cdots' }];
  const merged = definitions(project, overrides, ['bm', 'bra', 'ket', 'braket', 'dots']);
  assert.equal(merged.has('bra'), false);
  assert.equal(merged.has('ket'), false);
  assert.equal(merged.has('braket'), false);
  assert.equal(merged.get('bm')!.body, '\\symbfit{#1}');
  assert.equal(merged.get('abs')!.body, '\\sqrt{#1}');
  assert.equal(merged.get('dots')!.body, '\\cdots');
  assert.deepEqual(merged.get('slashed'), { name: 'slashed', arity: 1, body: RENDER_COMPAT.slashed.def });
});

test('render overrides preserve project call semantics, operator metadata and source locations without mutation', () => {
  const original: MacroDef = { name: 'pair', arity: 2, defaultArgument: 'd', body: '#1+#2',
    operator: true, source: { uri: 'file:///main.tex', from: 2, to: 40 } };
  const override: MacroDef = { name: 'pair', arity: 1, defaultArgument: 'ignored', body: '#2-#1',
    operator: false, source: { uri: 'file:///settings.json', from: 0, to: 9 } };
  const snapshot = JSON.stringify([original, override]);
  const result = definitions([original], [override]).get('pair')!;
  assert.deepEqual(result, { ...original, body: '#2-#1' });
  assert.notEqual(result, original);
  assert.equal(JSON.stringify([original, override]), snapshot);
  assert.deepEqual(definitions([original]).get('pair'), original);
});

test('display compatibility islands always restore exact source calls after unrelated edits', () => {
  const source = 'a+\\slashed  {p}b+\\cancelto{0}{ x + y }+\\dv f x+\\abs{\\alpha}';
  const { view, islands } = buildIslands(source, definitions());
  assert.deepEqual(islands.map(island => island.name), ['slashed', 'cancelto', 'dv', 'abs']);
  assert.equal(islands[0].render, '\\cancel{{p}}');
  assert.equal(islands[0].swallow, true);
  assert.equal(islands[1].render, '\\overset{{0}}{\\cancel{{ x + y }}}');
  assert.equal(restoreIslands(view, islands), source);
  assert.equal(restoreIslands(view.replace(/^a/, 'z'), islands), source.replace(/^a/, 'z'));
});

test('an override uses the original optional argument parser and restores the unchanged invocation', () => {
  const project: MacroDef[] = [{ name: 'pair', arity: 2, defaultArgument: 'd', body: '#1+#2' }];
  const overrides: MacroDef[] = [{ name: 'pair', arity: 1, body: '\\frac{#2}{#1}' }];
  for (const [source, render] of [['\\pair  {w}', '\\frac{{w}}{{d}}'], ['\\pair[z] {w}', '\\frac{{w}}{{z}}']]) {
    const { view, islands } = buildIslands(source, definitions(project, overrides));
    assert.equal(islands[0].render, render);
    assert.equal(islands[0].args.length, 2);
    assert.equal(restoreIslands(view, islands), source);
  }
});
