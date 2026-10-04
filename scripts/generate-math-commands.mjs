import fs from 'node:fs/promises';
import vm from 'node:vm';

// Development-only extraction from the pinned distribution. The host imports only
// the generated data and never loads MathLive or its browser implementation.
const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await fs.readFile(new URL('node_modules/mathlive/package.json', root), 'utf8'));
if (pkg.version !== '0.110.0') { throw new Error(`Review command extraction for MathLive ${pkg.version}`); }
const source = await fs.readFile(new URL('node_modules/mathlive/mathlive.mjs', root), 'utf8');
const boundary = source.indexOf('// src/core/modes-math.ts');
if (boundary < 0) { throw new Error('MathLive definition boundary changed'); }
const context = vm.createContext({ console });
vm.runInContext(source.slice(0, boundary), context, { timeout: 5000 });
const commands = vm.runInContext(`
  Object.keys({...LATEX_COMMANDS, ...MATH_SYMBOLS})
    .filter(key => key.startsWith('\\\\') && getDefinition(key, 'math'))
    .map(key => key.slice(1)).concat(Object.keys(getMacros()))
`, context);
// The parser handles these without registering a command definition.
commands.push('left', 'right', 'mleft', 'mright', 'limits', 'nolimits', 'displaylimits');
const unique = [...new Set(commands)].sort();
const environments = vm.runInContext('Object.keys(ENVIRONMENTS).sort()', context);
const lines = [];
for (let at = 0; at < unique.length; at += 10) { lines.push(`  ${unique.slice(at, at + 10).map(value => JSON.stringify(value)).join(', ')},`); }
const output = `// Generated from MathLive ${pkg.version} by scripts/generate-math-commands.mjs.\n`
  + '// Regenerate and review this snapshot when upgrading the pinned dependency.\n'
  + `export const MATH_COMMANDS: ReadonlySet<string> = new Set([\n${lines.join('\n')}\n]);\n\n`
  + `export const MATH_ENVIRONMENTS: ReadonlySet<string> = new Set(${JSON.stringify(environments)});\n`;
await fs.writeFile(new URL('src/core/mathCommands.ts', root), output);
console.log(`Wrote ${unique.length} math commands and ${environments.length} environments for MathLive ${pkg.version}`);
