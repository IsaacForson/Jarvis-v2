import { contextBridge, ipcRenderer } from 'electron';
import type { SetupAction, SetupState } from './setup.ts';

export type SetupBridge = {
  act(action: SetupAction): void;
  saveKeys(nvidia: string, groq: string): void;
  finish(startAtLogin: boolean): void;
  onState(handler: (state: SetupState) => void): void;
};

const bridge: SetupBridge = {
  act: (action) => ipcRenderer.send('setup-act', action),
  saveKeys: (nvidia, groq) => ipcRenderer.send('setup-keys', nvidia, groq),
  finish: (startAtLogin) => ipcRenderer.send('setup-finish', startAtLogin),
  onState: (handler) => ipcRenderer.on('setup-state', (_event, state: SetupState) => handler(state)),
};
contextBridge.exposeInMainWorld('setup', bridge);
