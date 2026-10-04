import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = path.resolve(process.env.OMT_TESTBENCH_RUN ?? path.join(repo, 'out/testbench-v1-ui'));
const baseline = JSON.parse(await fs.readFile(path.join(directory, 'baseline.json'), 'utf8'));
let checked = 0;
const failures = [];
for (const [name, expected] of Object.entries(baseline.hashes)) {
  try {
    const actual = createHash('sha256').update(await fs.readFile(path.join(baseline.source, name))).digest('hex');
    if (actual !== expected) { failures.push(`${name}: changed`); }
    checked++;
  } catch (error) { failures.push(`${name}: ${error.code ?? String(error)}`); }
}
console.log(JSON.stringify({ source: baseline.source, checked, failures }, null, 2));
if (failures.length) { process.exitCode = 1; }
