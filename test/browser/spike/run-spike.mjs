import { chromium } from '@playwright/test';
import fs from 'node:fs';

const lines = fs.readFileSync('test/fixtures/corpus/formulas.txt', 'utf8').split('\n').filter(Boolean);
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', e => console.error('pageerror', e));
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ path: 'out/spike.js' });
const results = await page.evaluate(lines => window.runCorpus(lines), lines);
const count = f => results.filter(f).length;
console.log(`total ${results.length}`);
console.log(`errors ${count(r => r.errors.length)}  canonical ${count(r => r.canonical)}  whitespace-only diff ${count(r => r.wsOnly)}  other diff ${count(r => !r.canonical && !r.wsOnly)}  non-idempotent ${count(r => !r.idempotent)}`);
for (const r of results.filter(r => r.errors.length)) { console.log('ERR ', r.errors.join(','), '|', r.src); }
for (const r of results.filter(r => !r.canonical && !r.wsOnly)) { console.log('DIFF', r.src, ' => ', r.ser); }
for (const r of results.filter(r => !r.idempotent)) { console.log('NONIDEM', r.src); }
console.log(JSON.stringify(await page.evaluate(() => window.runIslands()), null, 1));
await browser.close();

{
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ path: 'out/spike.js' });
  const res = await page.evaluate(lines => window.runWriteback(lines), lines);
  const by = {};
  for (const r of res) { by[r.strategy] = (by[r.strategy] ?? 0) + 1; }
  console.log('writeback', res.length, 'edits; verified', res.filter(r => r.ok).length, 'strategies', JSON.stringify(by));
  for (const r of res.filter(r => !r.ok)) { console.log('FAIL', r.strategy, r.edit, r.src, '| after', r.after, '=>', r.view); }
  for (const r of res.filter(r => r.strategy !== 'aligned' && r.strategy !== 'none').slice(0, 40)) { console.log(r.strategy.toUpperCase(), r.edit, '|', r.src, '|', r.patch); }
  await browser.close();
}
