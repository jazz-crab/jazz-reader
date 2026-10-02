'use strict';

const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('path');
const ipc = require('./ipc');

// Множественные экземпляры — намеренно НЕ используем requestSingleInstanceLock().
// Каждый запуск = отдельный процесс со своим окном и своим набором вкладок,
// так можно держать рядом два разных проекта.

if (process.platform === 'linux' && process.getuid?.() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 760, minHeight: 480,
    backgroundColor: '#1a1b26',
    title: 'MDView',
    show: false,
    // titleBarStyle — только опция конструктора (метода setTitleBarStyle нет).
    // Прячем системный заголовок, чтобы полоса вкладок шла до самого верха.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // Системные кнопки окна рисует ОС поверх нашей полосы вкладок.
  if (process.platform === 'win32') {
    win.setTitleBarOverlay({ color: '#16161e', symbolColor: '#a9b1d6', height: 40 });
  }

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Внешние ссылки — в системный браузер.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
  return win;
}

function send(channel, payload) {
  const target = BrowserWindow.getFocusedWindow() || win;
  if (target) target.webContents.send(channel, payload);
}

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Файл',
      submenu: [
        { label: 'Открыть файл…', accelerator: 'CmdOrCtrl+O', click: () => send('mdv:menu', 'open-file') },
        { label: 'Открыть папку…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('mdv:menu', 'open-folder') },
        { type: 'separator' },
        { label: 'Сохранить', accelerator: 'CmdOrCtrl+S', click: () => send('mdv:menu', 'save') },
        { label: 'Скачать MD', click: () => send('mdv:menu', 'download-md') },
        { label: 'Скачать HTML', click: () => send('mdv:menu', 'download-html') },
        { label: 'Печать / PDF…', accelerator: 'CmdOrCtrl+P', click: () => send('mdv:menu', 'print') },
        { type: 'separator' },
        { label: 'Выход', accelerator: 'Alt+F4', role: 'quit' },
      ],
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выделить всё' },
        { type: 'separator' },
        { label: 'Найти в тексте', accelerator: 'CmdOrCtrl+F', click: () => send('mdv:menu', 'find') },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Панель файлов / оглавление', accelerator: 'CmdOrCtrl+B', click: () => send('mdv:menu', 'toggle-sidebar') },
        { label: 'Режим правки', accelerator: 'CmdOrCtrl+E', click: () => send('mdv:menu', 'toggle-mode') },
        { type: 'separator' },
        { label: 'Назад', accelerator: 'Alt+Left', click: () => send('mdv:menu', 'back') },
        { label: 'Вперёд', accelerator: 'Alt+Right', click: () => send('mdv:menu', 'forward') },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Масштаб 100%' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { label: 'Перезагрузить с диска', accelerator: 'F5', click: () => send('mdv:menu', 'reload') },
        { role: 'togglefullscreen', label: 'Полный экран' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
      ],
    },
    {
      label: 'Переход',
      submenu: [
        { label: 'Новая вкладка', accelerator: 'CmdOrCtrl+T', click: () => send('mdv:menu', 'new-tab') },
        { label: 'Закрыть вкладку', accelerator: 'CmdOrCtrl+W', click: () => send('mdv:menu', 'close-tab') },
        { type: 'separator' },
        { label: 'Следующая вкладка', accelerator: 'Ctrl+Tab', click: () => send('mdv:menu', 'next-tab') },
        { label: 'Предыдущая вкладка', accelerator: 'Ctrl+Shift+Tab', click: () => send('mdv:menu', 'prev-tab') },
      ],
    },
    {
      label: 'Справка',
      submenu: [{
        label: 'О программе',
        click: () => require('electron').dialog.showMessageBox(win, {
          type: 'info', title: 'MDView',
          message: 'MDView ' + app.getVersion(),
          detail: 'Офлайн-читалка Markdown с поддержкой LaTeX (KaTeX).\n'
            + 'Порт инструмента github.com/jazz-crab/jazz-reader/.\n\n'
            + 'Ctrl+O — открыть .md\nCtrl+Shift+O — открыть папку\n'
            + 'Ctrl+E — режим правки\nCtrl+S — сохранить / скачать MD\n'
            + 'Alt+← / Alt+→ — назад / вперёд\nF5 — перезагрузить файл с диска',
          buttons: ['Ок'],
        }),
      }],
    },
  ]));
}

/** Пути, переданные при запуске (аргументы, drag на .exe, ассоциация ОС). */
function cliPaths() {
  return process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
}

app.whenReady().then(() => {
  ipc.register();
  buildMenu();
  createWindow();

  const targets = cliPaths();
  if (targets.length) win.webContents.once('did-finish-load', () => send('mdv:cli', targets));
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    ipc.register();
    createWindow();
  }
});

app.on('open-file', (e, p) => {
  e.preventDefault();
  send('mdv:cli', [p]);
});