import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  version: '1.139.1',
  files: 'dist/test/**/*.test.js',
  workspaceFolder: './test/fixtures/workspace',
  launchArgs: ['--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  mocha: { timeout: 30000 },
});
