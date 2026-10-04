import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(process.env.OMT_TESTBENCH_ROOT ?? path.join(repo, '..', 'test/testbench-v1/note'));
const target = path.resolve(process.env.OMT_TESTBENCH_RUN ?? path.join(repo, 'out/testbench-v1-ui'));
if (target === source || target.startsWith(source + path.sep)) {
  throw new Error('The test copy must be outside the original fixture.');
}
await fs.access(path.join(source, 'main.tex'));
try {
  await fs.access(target);
  throw new Error(`Test copy already exists: ${target}. Set OMT_TESTBENCH_RUN to a fresh directory.`);
} catch (error) {
  if (error.code !== 'ENOENT') { throw error; }
}
const hashes = {};
async function inventory(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) { await inventory(path.join(directory, entry.name), name); }
    else if (entry.isFile()) {
      hashes[name] = createHash('sha256').update(await fs.readFile(path.join(source, name))).digest('hex');
    }
  }
}
await inventory(source);
const note = path.join(target, 'note');
await fs.cp(source, note, { recursive: true });
await fs.mkdir(path.join(note, '.vscode'), { recursive: true });
await fs.writeFile(path.join(note, '.vscode/settings.json'), JSON.stringify({
  'latex-workshop.latex.autoBuild.run': 'never',
  'oh-my-tex.workshop.primeRoot': false,
  'oh-my-tex.macros': {},
  'editor.quickSuggestions': true,
  'editor.suggestOnTriggerCharacters': true,
}, null, 2) + '\n');
const probes = String.raw`% !TeX root = main.tex
% Oh My TeX testbench UI probes. Macros come ONLY from the copied main.tex.
% This file is deliberately not included in main.tex; do not compile it alone.

A01 eu: $\eu^x$.
A02 ramuno: $\ramuno x$.
A03 dbar: $\dbar x$.
A04 dif: $\dif x$.
A05 bm: $\bm{x}+a$.
A06 varPi: $\varPi$.
A07 varPhi: $\varPhi$.
A08 varLambda: $\varLambda$.
A09 calL: $\calL$.
A10 calH: $\calH$.
A11 calF: $\calF$.
A12 calZ: $\calZ$.
A13 calS: $\calS$.

P1 prose zero-argument completion:

P2 prose required-argument completion:

M1 formula project-macro completion: $a+$.

M2 formula required-argument completion: $b+$.

M3 formula Workshop fraction completion: $c+$.

M4 formula cancellation: $d+$.

I1 Chinese prose input:

I2 Chinese formula text input: $\text{中文}+x$.
`;
await fs.writeFile(path.join(note, 'omt-ui-probes.tex'), probes);
await fs.writeFile(path.join(target, 'baseline.json'), JSON.stringify({ source, note, created: new Date().toISOString(), hashes }, null, 2) + '\n');
await fs.writeFile(path.join(target, 'ui-results.md'), '# testbench-v1 UI results\n\nStatus: pending. No desktop UI test has run.\n\nRecord VS Code / Workshop versions, each case outcome, screenshots, actual source before/after, and original fixture checksum verification.\n');
console.log(JSON.stringify({ source, note, probes: path.join(note, 'omt-ui-probes.tex'), baseline: path.join(target, 'baseline.json'), files: Object.keys(hashes).length }, null, 2));
