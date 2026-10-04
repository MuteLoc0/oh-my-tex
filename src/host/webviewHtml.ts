import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', ...path)).toString();
  const nonce = randomBytes(16).toString('hex');
  const csp = [
    `default-src 'none'`,
    `script-src 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    `connect-src ${webview.cspSource}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
  ].join('; ');
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${asset('webview.css')}">
</head><body data-fonts="${asset('fonts')}" data-onig-wasm="${asset('onig.wasm')}"><div id="editor"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script></body></html>`;
}
