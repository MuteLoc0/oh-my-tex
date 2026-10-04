import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Load the real host bundle with no node_modules access and a minimal VS Code mock; activate it. */
export async function checkBundle(filename = path.resolve('dist/extension.js')) {
  const wasm = fs.readFileSync(path.join(path.dirname(filename), 'onig.wasm'));
  assert.deepEqual([...wasm.subarray(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], 'bundled Oniguruma WASM header');
  assert.ok(WebAssembly.validate(wasm), 'bundled Oniguruma is a valid WASM module');
  const commands = new Map(), providers = new Map(), calls = [];
  const disposable = () => ({ dispose() {} });
  const uri = { path: '/paper/main.tex', toString: () => 'file:///paper/main.tex' };
  class EventEmitter { event = () => disposable(); fire() {} dispose() {} }
  const vscode = {
    EventEmitter, ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    extensions: { onDidChange: disposable },
    workspace: { onDidChangeTextDocument: disposable, onDidChangeConfiguration: disposable, onWillSaveTextDocument: disposable, onDidSaveTextDocument: disposable, onDidOpenTextDocument: disposable, createFileSystemWatcher: () => ({ onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} }), getConfiguration: () => ({ get: (_k, d) => d }) },
    window: { onDidChangeActiveColorTheme: disposable, onDidChangeTextEditorSelection: disposable, activeTextEditor: { document: { uri } },
      registerCustomEditorProvider: (name, provider) => { providers.set(name, provider); return disposable(); } },
    commands: { registerCommand: (name, handler) => { commands.set(name, handler); return disposable(); }, executeCommand: async (...args) => { calls.push(args); } },
  };
  const module = { exports: {} };
  const allowed = new Set(['node:crypto', 'node:path', 'crypto', 'path']);
  const sandbox = {
    module, exports: module.exports, Buffer, console, setTimeout, clearTimeout, TextDecoder, TextEncoder, URL,
    require(name) {
      if (name === 'vscode') { return vscode; }
      if (allowed.has(name)) { return require(name); }
      throw new Error(`bundle has an unresolved runtime dependency: ${name}`);
    },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), sandbox, { filename });
  const context = { subscriptions: [], extensionMode: 1, workspaceState: { get: (_k, d) => d, update: async () => {} } };
  await module.exports.activate(context);
  try {
    assert.ok(providers.has('oh-my-tex.visual'), 'custom editor registered');
    for (const name of ['toggleVisual', 'openSource', 'synctex', 'build', 'chooseRoot']) {
      assert.equal(typeof commands.get(`oh-my-tex.${name}`), 'function', name);
    }
    await commands.get('oh-my-tex.toggleVisual')();
    assert.deepEqual(calls[0], ['vscode.openWith', uri, 'oh-my-tex.visual']);
  } finally { context.subscriptions.forEach(item => item.dispose()); }
  console.log('check-bundle: host bundle activates against a mock VS Code API; Oniguruma WASM is valid');
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  checkBundle(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}
