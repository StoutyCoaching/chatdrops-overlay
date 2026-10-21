const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  toggleClickThrough: () => ipcRenderer.invoke('toggle-clickthrough'),
  setLockShortcut: (accelerator) => ipcRenderer.invoke('set-lock-shortcut', accelerator),
  setClearChatShortcut: (accelerator) => ipcRenderer.invoke('set-clear-chat-shortcut', accelerator),
  setBookmarkShortcut: (accelerator) => ipcRenderer.invoke('set-bookmark-shortcut', accelerator),
  setToggleVisibilityShortcut: (accelerator) => ipcRenderer.invoke('set-toggle-visibility-shortcut', accelerator),
  chooseBookmarkFolder: () => ipcRenderer.invoke('choose-bookmark-folder'),
  notifyLiveState: (anyLive) => ipcRenderer.send('bookmark-live-state', anyLive),
  appendBookmark: (label) => ipcRenderer.invoke('append-bookmark', label),
  onBookmarkRequested: (cb) => ipcRenderer.on('bookmark-requested', cb),
  quit: () => ipcRenderer.invoke('quit-app'),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', cb),
  onClearChat: (cb) => ipcRenderer.on('clear-chat', cb),
  setSettingsPanelOpen: (open) => ipcRenderer.send('settings-panel-open', !!open),
  onResizeModeChanged: (cb) => ipcRenderer.on('resize-mode-changed', (_e, on) => cb(on)),
  onClickThroughChanged: (cb) => ipcRenderer.on('clickthrough-changed', (_e, state) => cb(state)),
  onWindowFocusChanged: (cb) => ipcRenderer.on('window-focus-changed', (_e, focused) => cb(focused)),
  onStreamlabsEvent: (cb) => ipcRenderer.on('streamlabs-event', (_e, data) => cb(data)),
  onStreamlabsStatus: (cb) => ipcRenderer.on('streamlabs-status', (_e, data) => cb(data)),
  onNanodropsData: (cb) => ipcRenderer.on('nanodrops-data', (_e, data) => cb(data)),
  onNanodropsStatus: (cb) => ipcRenderer.on('nanodrops-status', (_e, data) => cb(data)),
  reconnectStreamlabs: () => ipcRenderer.invoke('reconnect-streamlabs'),
  // Called once the renderer has registered all its listeners, so main can
  // replay any status it sent earlier, while the page was still loading.
  kickChatStart: (target) => ipcRenderer.invoke('kick-chat-start', target),
  kickChatStop: () => ipcRenderer.invoke('kick-chat-stop'),
  onKickChatEvent: (cb) => ipcRenderer.on('kick-chat-event', (_e, evt) => cb(evt)),
  onKickChatStatus: (cb) => ipcRenderer.on('kick-chat-status', (_e, data) => cb(data)),
  rendererReady: () => ipcRenderer.invoke('renderer-ready')
});
