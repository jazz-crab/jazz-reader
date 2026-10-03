'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Мост renderer -> main. Узких API, ничего лишнего наружу не торчит.
 * webUtils.getPathForFile — единственный способ узнать путь перетащенного файла
 * в Electron 32+ (свойство File.path удалено).
 */
contextBridge.exposeInMainWorld('mdv', {
  read: (p) => ipcRenderer.invoke('mdv:read', p),
  save: (filePath, content) => ipcRenderer.invoke('mdv:save', { filePath, content }),
  stat: (p) => ipcRenderer.invoke('mdv:stat', p),
  listMd: (root) => ipcRenderer.invoke('mdv:listMd', root),
  dialogFile: () => ipcRenderer.invoke('mdv:dialogFile'),
  dialogFolder: () => ipcRenderer.invoke('mdv:dialogFolder'),
  reveal: (p) => ipcRenderer.invoke('mdv:reveal', p),
  /** Удаление в корзину Windows (не безвозвратно). {ok, error} */
  trash: (p) => ipcRenderer.invoke('mdv:trash', p),
  /** Меню иконки приложения */
  newFile: (seedName) => ipcRenderer.invoke('mdv:newFile', seedName),
  newProject: (seedName) => ipcRenderer.invoke('mdv:newProject', seedName),
  recentGet: () => ipcRenderer.invoke('mdv:recentGet'),
  recentAdd: (p) => ipcRenderer.invoke('mdv:recentAdd', p),
  recentClear: () => ipcRenderer.invoke('mdv:recentClear'),
  settingsGet: () => ipcRenderer.invoke('mdv:settingsGet'),
  settingsSet: (patch) => ipcRenderer.invoke('mdv:settingsSet', patch),
  print: () => ipcRenderer.invoke('mdv:print'),
  exportHtml: (payload) => ipcRenderer.invoke('mdv:exportHtml', payload),

  /** Путь файла из DataTransfer (drop) или из <input type=file>. */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  /** Подписка на действия меню и на файлы, переданные при запуске. */
  onMenu: (cb) => ipcRenderer.on('mdv:menu', (_e, action) => cb(action)),
  onCli: (cb) => ipcRenderer.on('mdv:cli', (_e, paths) => cb(paths)),
});