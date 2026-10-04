import * as esbuild from 'esbuild';
import fs from 'node:fs/promises';
import { checkBundle } from './scripts/check-bundle.mjs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const tests = process.argv.includes('--tests');
const common = { bundle: true, minify: production, sourcemap: !production, logLevel: 'info' };

async function main() {
  if (tests) {
    // Integration tests run inside VS Code's Electron, which does not strip TypeScript types.
    const entryPoints = (await fs.readdir('test/integration')).filter(f => f.endsWith('.ts')).map(f => `test/integration/${f}`);
    await esbuild.build({ ...common, entryPoints, outdir: 'dist/test', platform: 'node', format: 'cjs', external: ['vscode', 'mocha'],
      alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' } });
    return;
  }
  await fs.rm('dist', { recursive: true, force: true });
  await fs.mkdir('dist', { recursive: true });
  // Shared by math fields (fontsDirectory) and static markup (mathlive-fonts.css, url(fonts/...)).
  await fs.cp('node_modules/mathlive/fonts', 'dist/fonts', { recursive: true });
  await fs.copyFile('node_modules/vscode-oniguruma/release/onig.wasm', 'dist/onig.wasm');
  await fs.mkdir('dist/licenses', { recursive: true });
  await Promise.all([
    fs.copyFile('node_modules/vscode-textmate/LICENSE.md', 'dist/licenses/vscode-textmate-LICENSE.md'),
    fs.copyFile('node_modules/vscode-oniguruma/LICENSE.txt', 'dist/licenses/vscode-oniguruma-LICENSE.txt'),
    fs.copyFile('node_modules/vscode-oniguruma/NOTICES.txt', 'dist/licenses/vscode-oniguruma-NOTICES.txt'),
  ]);
  const contexts = await Promise.all([
    esbuild.context({
      ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', external: ['vscode'],
      // The UMD entry hides its internal modules from static bundling.
      alias: { 'jsonc-parser': 'jsonc-parser/lib/esm/main.js' },
      plugins: [{ name: 'check-bundle', setup(build) { build.onEnd(async result => { if (!result.errors.length) { await checkBundle(); } }); } }],
    }),
    esbuild.context({ ...common, entryPoints: ['src/webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', external: ['*.woff2'] }),
  ]);
  if (watch) { await Promise.all(contexts.map(c => c.watch())); return; }
  await Promise.all(contexts.map(c => c.rebuild()));
  await Promise.all(contexts.map(c => c.dispose()));
}
main().catch(error => { console.error(error); process.exit(1); });
