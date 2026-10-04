import type { HostMessage, WebMessage } from '../shared/protocol.ts';

interface VsCodeApi { postMessage(message: WebMessage): void; getState(): unknown; setState(state: unknown): void }
declare function acquireVsCodeApi(): VsCodeApi;

const api = acquireVsCodeApi();
export const post = (message: WebMessage) => api.postMessage(message);
export function onHostMessage(handler: (message: HostMessage) => void) {
  window.addEventListener('message', (event: MessageEvent<HostMessage>) => handler(event.data));
}
export const logToHost = (level: 'info' | 'warn' | 'error', message: string) => post({ t: 'log', level, message });
