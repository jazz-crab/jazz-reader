'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * The renderer -> main bridge. Narrow APIs, nothing extra sticking out.
 * webUtils.getPathForFile is the only way to learn the path of a dropped file
 * in Electron 32+ (the File.path property is gone).
 */
contextBridge.exposeInMainWorld('mdv', {
  /**
   * The language from the main process command line: --lang=ru / --lang=en.
   *
   * An empty string means "no override". The value is needed before the
   * settings come over IPC — on the first frame — so it is synchronous and
   * arrives as a window argument: the renderer cannot see the main process
   * argv, and contextBridge exposes functions, not values.
   */
  forcedLang: () => {
    const arg = process.argv.find((a) => a.startsWith('--mdv-lang='));
    return arg ? arg.slice('--mdv-lang='.length) : '';
  },

  read: (p) => ipcRenderer.invoke('mdv:read', p),
  save: (filePath, content) => ipcRenderer.invoke('mdv:save', { filePath, content }),
  stat: (p) => ipcRenderer.invoke('mdv:stat', p),
  listMd: (root) => ipcRenderer.invoke('mdv:listMd', root),
  dialogFile: () => ipcRenderer.invoke('mdv:dialogFile'),
  dialogFolder: () => ipcRenderer.invoke('mdv:dialogFolder'),
  reveal: (p) => ipcRenderer.invoke('mdv:reveal', p),
  /** Move to the Windows recycle bin (recoverable). {ok, error} */
  trash: (p) => ipcRenderer.invoke('mdv:trash', p),
  /**
   * Width of the system caption buttons. The tab strip reserves room for
   * them, otherwise the "+" button slides under them and becomes unusable.
   */
  caption: () => ipcRenderer.invoke('mdv:caption'),
  /** Temporary note for Ctrl+N (tmpdir) and new folder for Ctrl+Shift+N. */
  newTemp: (seedName) => ipcRenderer.invoke('mdv:newTemp', seedName),
  newFolder: (parent, seedName) => ipcRenderer.invoke('mdv:newFolder', parent, seedName),
  /** Menu of the application icon */
  newFile: (seedName) => ipcRenderer.invoke('mdv:newFile', seedName),
  newProject: (seedName) => ipcRenderer.invoke('mdv:newProject', seedName),
  recentGet: () => ipcRenderer.invoke('mdv:recentGet'),
  recentAdd: (p) => ipcRenderer.invoke('mdv:recentAdd', p),
  recentClear: () => ipcRenderer.invoke('mdv:recentClear'),
  settingsGet: () => ipcRenderer.invoke('mdv:settingsGet'),
  settingsSet: (patch) => ipcRenderer.invoke('mdv:settingsSet', patch),
  /**
   * Signal to the main process: the language changed, rebuild the menu.
   * By this point the value is already in settings.json — the renderer sends
   * it first, and the main process re-reads the file rather than an argument.
   */
  setLang: () => ipcRenderer.invoke('mdv:setLang'),
  print: () => ipcRenderer.invoke('mdv:print'),
  exportHtml: (payload) => ipcRenderer.invoke('mdv:exportHtml', payload),
  /** PDF without the system print dialog: a finished file in Downloads. */
  exportPdf: (payload) => ipcRenderer.invoke('mdv:exportPdf', payload),
  /** System fonts for the drop-down in the export window. */
  fonts: () => ipcRenderer.invoke('mdv:fonts'),
  /**
   * Quit along the same path as Ctrl+Q, for the automated test.
   *
   * answer is the index of the confirmation button (0 to quit, 1 to cancel).
   * Without it the application shows the system dialog, which cannot be closed
   * from a script: the window pops up on screen and takes focus away from
   * whatever the person has open.
   *
   * The handler lives only in hidden mode (--jazzreader-hidden), so a normal
   * launch has no call and the method does nothing.
   */
  testQuit: (answer = null) => ipcRenderer.invoke('mdv:testQuit', answer),

  /** File path from a DataTransfer (drop) or from <input type=file>. */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  /** Subscription to menu actions and to files passed at launch. */
  onMenu: (cb) => ipcRenderer.on('mdv:menu', (_e, action) => cb(action)),
  onCli: (cb) => ipcRenderer.on('mdv:cli', (_e, paths) => cb(paths)),
});
