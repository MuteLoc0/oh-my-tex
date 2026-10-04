import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;
export function log(): vscode.LogOutputChannel {
  channel ??= vscode.window.createOutputChannel('Oh My TeX', { log: true });
  return channel;
}
