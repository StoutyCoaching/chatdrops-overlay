const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  toggleClickThrough: () => ipcRenderer.invoke('toggle-clickthrough'),
  setLockShortcut: (accelerator) => ipcRenderer.invoke('set-lock-shortcut', accelerator),
  setClearChatShortcut: (accelerator) => ipcRenderer.invoke('set-clear-chat-shortcut', accelerator),
  quit: () => ipcRenderer.invoke('quit-app'),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', cb),
  onClearChat: (cb) => ipcRenderer.on('clear-chat', cb),
  onClickThroughChanged: (cb) => ipcRenderer.on('clickthrough-changed', (_e, state) => cb(state)),
  onWindowFocusChanged: (cb) => ipcRenderer.on('window-focus-changed', (_e, focused) => cb(focused)),
  onStreamlabsEvent: (cb) => ipcRenderer.on('streamlabs-event', (_e, data) => cb(data)),
  onStreamlabsStatus: (cb) => ipcRenderer.on('streamlabs-status', (_e, data) => cb(data)),
  onNanodropsData: (cb) => ipcRenderer.on('nanodrops-data', (_e, data) => cb(data)),
  onNanodropsStatus: (cb) => ipcRenderer.on('nanodrops-status', (_e, data) => cb(data)),
  reconnectStreamlabs: () => ipcRenderer.invoke('reconnect-streamlabs')
});
