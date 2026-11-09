const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omnex', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  chat: (messages) => ipcRenderer.invoke('llm:chat', { messages }),
  testBrain: (target) => ipcRenderer.invoke('llm:test', { target })
});
