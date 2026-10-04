import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

await build({ entryPoints: ['test/browser/spike/macro-args-spike.ts'], outfile: 'out/macro-args-spike.js', bundle: true, platform: 'browser', format: 'iife', target: 'es2022' });
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><script src="/spike.js"></script></body></html>'); return; }
  const file = pathname === '/spike.js' ? 'out/macro-args-spike.js' : /^\/fonts\/[a-zA-Z0-9_.-]+$/.test(pathname) ? path.join('node_modules/mathlive', pathname) : undefined;
  if (!file) { res.writeHead(404); res.end(); return; }
  try { res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'font/woff2'); res.end(await fs.readFile(file)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  page.on('pageerror', error => console.error(error));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(() => window.runMacroArgsSpike());
  for (const capture of ['false', 'true']) {
    const prompt = result[`prompts-capture-${capture}`];
    assert.equal(prompt.after.noPh, prompt.before.noPh);
    assert.deepEqual(prompt.after.promptAtoms, ['\\placeholder[omt-a-0]{y}', '\\placeholder[omt-b-0]{y}', '\\placeholder[omt-b-0]{x}']);
  }
  assert.equal(result.floatingArgument.source, '\\dup{y}+a');
  assert.equal(result.floatingArgument.restored, '\\dup{y}+a');
  assert.equal(result.floatingArgument.rendered, '{y}+{y}');
  for (const name of ['inline', 'fraction', 'script', 'aligned']) {
    const sample = result[name];
    const islands = sample.offsets.filter(item => /^\\OMT[a-z]+$/.test(item.latex ?? ''));
    assert.equal(islands.length, 2);
    assert.ok(islands.every(item => item.bounds && item.bounds.right > item.bounds.left));
    assert.ok(sample.deletions.every(item => !item.after.includes(item.token)));
  }
  const report = JSON.stringify({ mathliveVersion: JSON.parse(await fs.readFile('node_modules/mathlive/package.json', 'utf8')).version, ...result }, null, 2);
  await fs.writeFile('out/macro-args-spike-result.json', report);
  console.log(report);
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
