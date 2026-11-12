import { contextBridge, ipcRenderer } from 'electron';
import type { Bridge, ToRenderer } from './messages.ts';

const bridge: Bridge = {
  send: (message) => ipcRenderer.send('jarvis', message),
  onMessage: (handler) => ipcRenderer.on('jarvis', (_event, message: ToRenderer) => handler(message)),
};
contextBridge.exposeInMainWorld('jarvis', bridge);
