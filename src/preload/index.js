import { contextBridge, ipcRenderer, webFrame } from 'electron'

contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  getPlatformInfo: () => ipcRenderer.invoke('app:platform-info'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  copyImageToClipboard: (dataUrl) => ipcRenderer.invoke('app:copy-image-to-clipboard', dataUrl),
  setZoomFactor: (factor) => webFrame.setZoomFactor(factor),
  consoleLog: (msg) => ipcRenderer.send('app:console-log', msg),
  consoleInfo: (msg) => ipcRenderer.send('app:console-info', msg),
  consoleError: (msg) => ipcRenderer.send('app:console-error', msg),
  consoleWarn: (msg) => ipcRenderer.send('app:console-warn', msg),
  checkUpdates: () => ipcRenderer.invoke('app:check-updates'),
  downloadAndInstall: (url) => ipcRenderer.invoke('app:download-and-install', url),
  updateAndRestart: (url) => ipcRenderer.invoke('app:update-and-relaunch', url),
  openSigninWindow: () => ipcRenderer.invoke('app:open-signin-window'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  checkInternet: () => ipcRenderer.invoke('app:check-internet'),
  sendMessage: (payload) => ipcRenderer.invoke('chat:send', payload),
  sendStream: (payload, onChunk, onReasoning) =>
    new Promise((resolve, reject) => {
      const channel = 'chat:stream-chunk'
      const reasonChannel = 'chat:stream-reasoning'
      const handler = (_event, chunk) => onChunk(chunk)
      const reasonHandler = (_event, chunk) => { if (onReasoning) onReasoning(chunk) }
      ipcRenderer.on(channel, handler)
      ipcRenderer.on(reasonChannel, reasonHandler)
      ipcRenderer
        .invoke('chat:send-stream', payload)
        .finally(() => {
          ipcRenderer.removeListener(channel, handler)
          ipcRenderer.removeListener(reasonChannel, reasonHandler)
        })
        .then((result) => {
          if (result?.ok === false) reject(new Error(result.error || 'Stream failed'))
          else resolve(result)
        })
        .catch(reject)
    }),
  stopStream: () => ipcRenderer.send('chat:stop-stream'),
  streamEndNotify: () => ipcRenderer.send('window:stream-end-notify'),
  fetchStream: (url, onChunk, onReasoning) =>
    new Promise((resolve, reject) => {
      const chunkChannel = 'chat:stream-chunk'
      const reasonChannel = 'chat:stream-reasoning'
      const chunkHandler = (_event, chunk) => onChunk(chunk)
      const reasonHandler = (_event, chunk) => onReasoning?.(chunk)
      ipcRenderer.on(chunkChannel, chunkHandler)
      ipcRenderer.on(reasonChannel, reasonHandler)
      ipcRenderer.invoke('web:fetch-stream', { url }).finally(() => {
        ipcRenderer.removeListener(chunkChannel, chunkHandler)
        ipcRenderer.removeListener(reasonChannel, reasonHandler)
      }).then((result) => {
        if (result?.ok === false) reject(new Error(result.error || 'Fetch stream failed'))
        else resolve(result)
      }).catch(reject)
    }),
  uploadFile: () => ipcRenderer.invoke('file:upload'),
  captureScreenshot: () => ipcRenderer.invoke('app:capture'),
  themeShot: () => ipcRenderer.invoke('window:theme-shot'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:maximize-toggle'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  unmaximize: () => ipcRenderer.invoke('window:unmaximize'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  getWindowState: () => ipcRenderer.invoke('window:get-state'),
  saveWindowState: (state) => ipcRenderer.invoke('window:save-state', state),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  onMaximizeChange: (cb) => ipcRenderer.on('window:maximized', (_event, maximized) => cb(maximized)),
  onNewChatTask: (cb) => ipcRenderer.on('task:new-chat', () => cb()),
  onShowSettingsTask: (cb) => ipcRenderer.on('task:show-settings', () => cb()),
  onShowModelMenuTask: (cb) => ipcRenderer.on('task:show-model-menu', () => cb()),
  onShowReleaseNotesTask: (cb) => ipcRenderer.on('task:show-release-notes', () => cb()),
  onSetApiKeyTask: (cb) => ipcRenderer.on('task:set-apikey', (_event, key) => cb(key)),
  onIpcTask: (cb) => ipcRenderer.on('task:ipc', (_event, command) => cb(command)),
  onViewLogsTask: (cb) => ipcRenderer.on('task:view-logs', () => cb()),
  openDevTools: () => ipcRenderer.invoke('window:open-devtools'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  terminalCreate: (opts) => ipcRenderer.invoke('terminal:create', opts),
  terminalWrite: (id, text) => ipcRenderer.invoke('terminal:write', { id, text }),
  terminalComplete: (partial) => ipcRenderer.invoke('terminal:complete', { partial }),
  terminalKill: (id) => ipcRenderer.invoke('terminal:kill', { id }),
  onTerminalEvent: (cb) => ipcRenderer.on('terminal:event', (_event, payload) => cb(payload)),
  browserCreate: (opts) => ipcRenderer.invoke('panel-browser:create', opts || {}),
  browserNavigate: (id, url) => ipcRenderer.invoke('panel-browser:navigate', { id, url }),
  browserHistory: (id, dir) => ipcRenderer.invoke('panel-browser:history', { id, dir }),
  browserReload: (id, hard) => ipcRenderer.invoke('panel-browser:reload', { id, hard }),
  browserStop: (id) => ipcRenderer.invoke('panel-browser:stop', { id }),
  browserState: (id) => ipcRenderer.invoke('panel-browser:state', { id }),
  browserBounds: (id, bounds) => ipcRenderer.invoke('panel-browser:bounds', { id, bounds }),
  browserVisible: (id, visible) => ipcRenderer.invoke('panel-browser:visible', { id, visible }),
  browserKill: (id) => ipcRenderer.invoke('panel-browser:kill', { id }),
  onBrowserEvent: (cb) => ipcRenderer.on('panel-browser:event', (_event, payload) => cb(payload)),
  getNews: (limit) => ipcRenderer.invoke('news:get', limit),
  searchWebForAgent: (query) => ipcRenderer.invoke('agent:web-search', query),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', enabled),
  getStartup: () => ipcRenderer.invoke('startup:get'),
  setTheme: (theme) => ipcRenderer.invoke('app:set-theme', theme),
  getTheme: () => ipcRenderer.invoke('app:get-theme'),
  setCustomColors: (colors) => ipcRenderer.invoke('app:set-custom-colors', colors),
  getCustomColors: () => ipcRenderer.invoke('app:get-custom-colors'),
  setUiFont: (uiFont) => ipcRenderer.invoke('app:set-ui-font', uiFont),
  getUiFont: () => ipcRenderer.invoke('app:get-ui-font'),
  onUiFontChange: (cb) => ipcRenderer.on('app:ui-font-changed', (_event, uiFont) => cb(uiFont)),
  onThemeChange: (cb) => ipcRenderer.on('app:theme-changed', (_event, theme) => cb(theme)),
  onCustomColorsChange: (cb) => ipcRenderer.on('app:custom-colors-changed', (_event, colors) => cb(colors)),
  getPendingApiKey: () => ipcRenderer.invoke('app:get-pending-apikey'),
  getEnvConfig: () => ipcRenderer.invoke('app:get-env-config'),
  contextWindowBoost: (enabled) => ipcRenderer.invoke('app:context-window-boost', enabled),
  getContextWindowInfo: (model) => ipcRenderer.invoke('app:get-context-window-info', model),
  loadSessions: () => ipcRenderer.invoke('sessions:load'),
  saveSessionsFile: (sessions) => ipcRenderer.invoke('sessions:save', sessions),
  saveSessionsImmediate: (sessions) => ipcRenderer.invoke('sessions:save-immediate', sessions),
  getCredits: () => ipcRenderer.invoke('credits:get'),
  saveCredits: (credits) => ipcRenderer.invoke('credits:set', credits),
  flushCredits: (credits) => ipcRenderer.sendSync('credits:set-sync', credits),
  getUser: () => ipcRenderer.invoke('auth:get-user'),
  signIn: (provider) => ipcRenderer.invoke('auth:sign-in', provider),
  signOut: () => ipcRenderer.invoke('auth:sign-out'),
  getToken: () => ipcRenderer.invoke('auth:get-token'),
  setUser: (user) => ipcRenderer.send('auth:set-user', user),
  setAvatar: (picture) => ipcRenderer.invoke('auth:set-avatar', picture),
  uploadAvatar: () => ipcRenderer.invoke('auth:upload-avatar'),
  onAvatar: (cb) => ipcRenderer.on('auth:avatar', (_event, picture) => cb(picture)),
  onUser: (cb) => ipcRenderer.on('auth:user', (_event, user) => cb(user)),
  worktreeList: (opts) => ipcRenderer.invoke('worktrees:list', opts),
  worktreeCreate: (opts) => ipcRenderer.invoke('worktrees:create', opts),
  worktreeRemove: (opts) => ipcRenderer.invoke('worktrees:remove', opts),
  worktreePrune: (opts) => ipcRenderer.invoke('worktrees:prune', opts),
  worktreeInfo: (opts) => ipcRenderer.invoke('worktrees:info', opts),
  enumerateAudioDevices: () => ipcRenderer.invoke('voice:enumerate-devices'),
  transcribeAudio: (payload) => ipcRenderer.invoke('voice:transcribe', payload),
  memoryGet: () => ipcRenderer.invoke('memory:get'),
  memoryAdd: (entry) => ipcRenderer.invoke('memory:add', entry),
  memoryRemove: (id) => ipcRenderer.invoke('memory:remove', id),
  memoryClear: () => ipcRenderer.invoke('memory:clear'),
  memorySetContextWindow: (maxTokens) => ipcRenderer.invoke('memory:set-context-window', maxTokens),
  memorySetEnabled: (enabled) => ipcRenderer.invoke('memory:set-enabled', enabled),
  memorySetRetention: (retention) => ipcRenderer.invoke('memory:set-retention', retention),
  memoryPruneExpired: () => ipcRenderer.invoke('memory:prune-expired'),
  on: (channel, cb) => ipcRenderer.on(channel, (_event, ...args) => cb(...args))
})
