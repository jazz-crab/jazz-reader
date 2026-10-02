'use strict';

const { app, BrowserWindow, Menu, shell, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const ipc = require('./ipc');

// Множественные экземпляры — намеренно НЕ используем requestSingleInstanceLock().
// Каждый запуск = отдельный процесс со своим окном и своим набором вкладок,
// так можно держать рядом два разных проекта.

if (process.platform === 'linux' && process.getuid?.() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

// ───────────────────────────── Диагностика ─────────────────────────────
// Electron — приложение с подсистемой GUI, поэтому stdout/stderr не идут
// в консоль, из которой его запустили. Раньше это означало, что любая ошибка
// на старте выглядела как «программа ничего не делает». Поэтому пишем лог на
// диск и показываем диалог, а не падаем молча.

const OVERLAY = { color: '#16161e', symbolColor: '#a9b1d6', height: 40 };

let logPath = null;
let fatalShown = false;
/** Захваченные системные хоткеи (см. registerTabShortcuts). */
const shortcuts = [];

function resolveLogPath() {
  // Portable: рядом с .exe. Установленная: Program Files не writable — берём userData.
  const candidates = [app.isPackaged ? path.dirname(process.execPath) : __dirname, null];
  try { candidates.splice(1, 0, app.getPath('userData')); } catch { /* до ready */ }
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'mdview.log');
    } catch { /* пробуем следующий */ }
  }
  return null;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ') + '\n';
  try { process.stderr.write(line); } catch { /* нет stderr */ }
  if (logPath) {
    try { fs.appendFileSync(logPath, line); } catch { /* диск недоступен */ }
  }
}

/** Необработанная ошибка: пишем в лог и один раз показываем окно с текстом. */
function reportFatal(where, err) {
  const text = err && err.stack ? err.stack : String(err);
  log(`FATAL ${where}: ${text}`);
  if (fatalShown) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      'MDView — ошибка при запуске',
      `${where}\n\n${text}\n\n` +
      `Подробности: ${logPath || '(лог недоступен)'}\n` +
      'Если окно с приложением не появилось — пришлите этот файл, разберёмся.'
    );
  } catch { /* до ready диалога нет */ }
}

process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => reportFatal('unhandledRejection', err));

// ───────────────────────────── Окно ─────────────────────────────

let win = null;

function createWindow() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 760, minHeight: 480,
    backgroundColor: '#1a1b26',
    title: 'MDView',
    show: false,
    // titleBarStyle — только опция конструктора (метода setTitleBarStyle нет).
    // Прячем системный заголовок, чтобы полоса вкладок шла до самого верха.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // ВАЖНО: overlay обязан быть включён ЗДЕСЬ, в конструкторе.
    // Раньше его включали только вызовом setTitleBarOverlay() после создания окна —
    // тот бросал «Titlebar overlay is not enabled», исключение уходило в
    // app.whenReady().then() как unhandledRejection, окно не создавалось вообще,
    // и приложение молча висело без единого окна. Плюс app.asar на 6 МБ.
    ...(isWin ? { titleBarOverlay: OVERLAY } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // Страховка: если overlay всё-таки недоступен (старая Windows, доп. реестр),
  // окно должно показаться, а не исчезнуть вместе с ошибкой.
  if (isWin) {
    try {
      win.setTitleBarOverlay(OVERLAY);
    } catch (e) {
      log('setTitleBarOverlay недоступен, продолжаем без него: ' + e.message);
    }
  }

  // Страховка от «невидимого» окна: показываем по ready-to-show, но если событие
  // не пришло за 6 с — показываем всё равно.
  const showTimer = setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 6000);
  win.once('ready-to-show', () => { clearTimeout(showTimer); win.show(); });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`did-fail-load code=${code} desc=${desc} url=${url}`);
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

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
        { label: 'Проводник', accelerator: 'CmdOrCtrl+B', click: () => send('mdv:menu', 'toggle-sidebar') },
        { label: 'Оглавление', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('mdv:menu', 'toggle-toc') },
        { type: 'separator' },
        { label: 'Режим правки', accelerator: 'CmdOrCtrl+E', click: () => send('mdv:menu', 'toggle-mode') },
        { label: 'Отменить правки', accelerator: 'Escape', click: () => send('mdv:menu', 'cancel-edit') },
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
        // Акселераторы у этих двух пунктов намеренно НЕ заданы: Windows считает
        // Ctrl+Tab системной комбинацией и съедает её раньше меню. Перехват
        // делает globalShortcut (registerTabShortcuts), он шлёт то же действие.
        { label: 'Следующая вкладка', click: () => send('mdv:menu', 'next-tab') },
        { label: 'Предыдущая вкладка', click: () => send('mdv:menu', 'prev-tab') },
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
            + 'Ctrl+E — правка; выход — кнопками «Сохранить»/«Отменить»\n'
            + 'Ctrl+S — сохранить / скачать MD\n'
            + 'Ctrl+Tab — следующая вкладка, Ctrl+Shift+Tab — предыдущая\n'
            + 'ПКМ по вкладке — закрыть вкладки\n'
            + 'Alt+← / Alt+→ — назад / вперёд\n'
            + 'F5 — перезагрузить файл с диска',
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

/**
 * Ctrl+Tab / Ctrl+Shift+Tab до renderer'а не доходят: Windows считает их
 * системными (переключение окон/вкладок) и съедает раньше, чем дойдёт до
 * Chromium, поэтому keydown в renderer'е молчит. Проверено синтетическим
 * keybd_event по настоящему окну: вкладка не менялась, keydown не сработал.
 *
 * Выход — globalShortcut, он перехватывает комбинацию до ОС. Регистрация
 * обязательно снимается на will-quit: иначе хоткей залипает и Ctrl+Tab не
 * работает во всей системе до перезагрузки.
 */
function registerTabShortcuts() {
  const grab = (accel, action) => {
    try {
      const ok = globalShortcut.register(accel, () => {
        const target = BrowserWindow.getFocusedWindow() || win;
        if (target && !target.isDestroyed()) target.webContents.send('mdv:menu', action);
      });
      if (ok) { shortcuts.push(accel); return; }
      log('хоткей ' + accel + ' занят другой программой — переключение вкладок им не сработает');
    } catch (e) {
      log('globalShortcut ' + accel + ': ' + (e.message || e));
    }
  };
  grab('Ctrl+Tab', 'next-tab');
  grab('Ctrl+Shift+Tab', 'prev-tab');
  log('перехвачены хоткеи вкладок: ' + (shortcuts.join(', ') || 'нет'));
}

function releaseTabShortcuts() {
  for (const a of shortcuts) {
    try { globalShortcut.unregister(a); } catch { /* уже снят */ }
  }
  shortcuts = [];
}

app.on('will-quit', releaseTabShortcuts);

app.whenReady()
  .then(() => {
    logPath = resolveLogPath();
    log(`--- старт MDView ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform}/${process.arch} · portable=${app.isPackaged}`);

    ipc.register();
    buildMenu();
    registerTabShortcuts();
    createWindow();

    const targets = cliPaths();
    if (targets.length) win.webContents.once('did-finish-load', () => send('mdv:cli', targets));

    log('окно создано, targets=' + JSON.stringify(targets));
  })
  .catch((err) => {
    // Раньше здесь был bare .then() — любая ошибка становилась unhandledRejection
    // без окна и без вывода. Теперь это явная ошибка с диалогом и кодом возврата 1.
    reportFatal('Не удалось создать окно', err);
    app.exit(1);
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