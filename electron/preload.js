/**
 * Preload — window buttons bridge (fix 563).
 *
 * contextIsolation enabled, nodeIntegration disabled: renderer receives
 * ONLY three window management methods through contextBridge, no direct
 * access to Node/IPC.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('h3desktop', {
  minimize: () => ipcRenderer.send('h3:window-minimize'),
  maximizeToggle: () => ipcRenderer.send('h3:window-maximize-toggle'),
  close: () => ipcRenderer.send('h3:window-close'),
  // (fix 567) "Console" panel: output buffer of all application processes.
  console: {
    /** Full accumulated log (ring buffer ~2 MB). */
    get: () => ipcRenderer.invoke('h3:console-get'),
    /** Subscribe to additions; returns unsubscribe callback.
     *  (fix 588) Batch — list of OPERATIONS ['a'|'r', text]: 'a' — append
     *  text, 'r' — write text from beginning of last line (terminal
     *  \r emulation for ComfyUI/tqdm progress bars). Order matters. */
    onAppend: (cb) => {
      const handler = (_e, ops) => cb(ops)
      ipcRenderer.on('h3:console-append', handler)
      return () => ipcRenderer.removeListener('h3:console-append', handler)
    },
    /** Native "Save As" dialog -> .txt file. */
    save: (text) => ipcRenderer.invoke('h3:console-save', text),
  },
})
