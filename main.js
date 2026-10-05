'use strict';

const { app, BrowserWindow, Menu, shell, dialog, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ipc = require('./ipc');

// Тот же i18n-рантайм, что и в renderer: словарями владеет src/i18n, здесь он
// нужен до первого окна — заголовок окна и диалог об ошибке создаются раньше,
// чем renderer что-либо загрузит.
const i18n = require('./src/i18n/index.js');
i18n.setSystemLocale(app.getLocale());

/* Короткое имя tr, а не t: короткие однобуквенные имена в этом файле
 * уже заняты (t здесь — вкладка в сообщениях), и перекрытие молча ломает
 * разбор выражений вида t.name. */
const tr = (key, params) => i18n.t(key, params);

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

// Скрытый режим: JAZZREADER_HIDDEN=1 или ключ --jazzreader-hidden.
// Окно создаётся и работает, но не показывается ни разу: на экране ничего
// нет, в панели задач и Alt+Tab его нет, тыкнуть некуда. Нужен, чтобы
// автотесты и разработка не выскакивали окном поверх работы.
//
// Почему не «другой рабочий стол»: виртуальные столы Windows недоступны
// с этой сборки (COM-класс IVirtualDesktopManager не зарегистрирован),
// горячая клавиша требует передать фокус окну, а отдельный Win32-стол
// убивает Chromium до старта main.js.
//
// Имена до переименования (MDVIEW_HIDDEN, --mdview-hidden) принимаются
// и дальше: старые сценарии и ярлыки не должны падать из-за переименования.
const HIDDEN = process.env.JAZZREADER_HIDDEN === '1'
  || process.env.MDVIEW_HIDDEN === '1'
  || process.argv.includes('--jazzreader-hidden')
  || process.argv.includes('--mdview-hidden');

/*
 * Полоса, которую Windows рисует под системными кнопки окна, и наш резерв.
 *
 * OVERLAY.height — это высота полосы titleBarOverlay. Windows заливает её
 * СВОИМ цветом (OVERLAY.color) поверх содержимого окна. Полоска вкладок
 * ровно 40px, и её нижняя граница приходилась ровно на последний пиксель
 * этой полосы — то есть на последний пиксель линии под вкладками. Windows
 * заливала его целиком, и линия обрывалась ровно там, где начинались
 * кнопки «свернуть/развернуть/закрыть»: слева под вкладками она была, а
 * под самими кнопками — нет.
 *
 * Лечится высотой: делаем полосу на 2px меньше полосы вкладок. Тогда
 *Windows заливает только верхние 38px, нижняя граница остаётся наша и
 * тянется во всю ширину. Побочный эффект — две лишние полоски вкладок под
 * кнопками, что при 40px высоты не видно.
 */
const OVERLAY = { color: '#16161e', symbolColor: '#a9b1d6', height: 38 };

/*
 * Ширина блока системных кнопок окна (свернуть/развернуть/закрыть).
 *
 * titleBarOverlay рисует их поверх содержимого окна, и это была наша беда:
 * полоса вкладок не резервировала под них место. При множестве вкладок
 * кнопка «+» уезжала под системные кнопки и становилась недоступной, а
 * последние вкладки — невидимыми. Скролла при этом не появлялось: лента
 * формально влезала, и переполнение считать было не от чего.
 *
 * Константа не годится: ширина зависит от DPI (на 150% это ~207px вместо
 * ~138px). Меряем на живом окне через getTitleBarArea() — он отдаёт область
 * заголовка, доступную для перетаскивания, то есть БЕЗ блока кнопок справа.
 * Разница между правым краем окна и правым краем этой области и есть нужная
 * ширина.
 *
 * Запасной путь — 138px (типичное значение при 100%): если overlay не
 * применился, лучше перестараться и оставить пустое место, чем спрятать «+».
 */
const CAPTION_FALLBACK = 138;

function captionButtonWidth(win) {
  try {
    const b = win.getBounds();
    const area = win.getTitleBarArea();
    const winRight = b.x + b.width;
    const areaRight = area.x + area.width;
    const w = Math.round(winRight - areaRight);
    return w > 0 ? w : CAPTION_FALLBACK;
  } catch {
    return CAPTION_FALLBACK;
  }
}

let logPath = null;
let fatalShown = false;
/** Захваченные системные хоткеи (см. registerTabShortcuts). */
// let, а не const: releaseTabShortcuts() присваивает ему пустой массив, и
// на const приложение падало с «Assignment to constant variable» прямо в
// will-quit — то есть вместо закрытия на экране появлялось окно ошибки.
let shortcuts = [];

function resolveLogPath() {
  // Portable: рядом с .exe. Установленная: Program Files не writable — берём userData.
  const candidates = [app.isPackaged ? path.dirname(process.execPath) : __dirname, null];
  try { candidates.splice(1, 0, app.getPath('userData')); } catch { /* до ready */ }
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'jazzreader.log');
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
      tr('error.startup'),
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
    title: 'JazzReader',
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
      // Окно не видно, значит композитор не будет рисовать: в offscreen
      // кадры идут напрямую, и снимки страницы получаются непустыми.
      ...(HIDDEN ? { offscreen: true } : {}),
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
    // Ширину блока кнопок узнаём только после того, как overlay применён.
    const caption = captionButtonWidth(win);
    log('системные кнопки окна: ' + caption + 'px');
    ipc.setCaptionWidth(caption);
  }

  // Страховка от «невидимого» окна: показываем по ready-to-show, но если событие
  // не пришло за 6 с — показываем всё равно.
  if (HIDDEN) {
    log('скрытый режим: окно создано, но не показывается (JAZZREADER_HIDDEN)');
  } else {
    const showTimer = setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) win.show(); }, 6000);
    win.once('ready-to-show', () => { clearTimeout(showTimer); win.show(); });
  }

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

/*
 * Выход по Ctrl+Q спрашивает подтверждение.
 *
 * Диалог системный, а не нарисованный: у него есть настоящая рамка с
 * крестиком, и закрытие крестиком равносильно «Отмена» — как в любом
 * системном окне. Рисованный слой с двумя кнопками выглядел бы частью
 * приложения, и его нельзя закрыть ничем, кроме двух этих кнопок.
 *
 * Галочка «Не показывать больше» записывается в settings.json, поэтому
 * настройку не нужно искать заново при каждом запуске.
 *
 * Право выхода выдаётся один раз и снимается при любом новом вызове: пока
 * идёт диалог, повторный Ctrl+Q не должен подтверждения отменять.
 */
let quitArmed = false;

/** Сколько вкладок с несохранёнными правками — предупредить в диалоге. */
async function dirtyTabs() {
  const w = targetWindowSafe();
  if (!w || w.isDestroyed()) return 0;
  try {
    const n = await w.webContents.executeJavaScript(
      'window.mdvDirtyTabs ? window.mdvDirtyTabs() : 0');
    return Number(n) || 0;
  } catch {
    return 0;   // renderer мог уже закрыться — тогда и спрашивать не о чем
  }
}

function targetWindowSafe() {
  return win || BrowserWindow.getAllWindows()[0] || null;
}

async function requestQuit() {
  if (quitArmed) { app.quit(); return; }
  let ask = true;
  try { ask = (await ipc.setting('quitAsk')) !== false; }
  catch { ask = true; }   // не прочитали настройку — спрашиваем, как обычно
  if (!ask) { log('выход: подтверждение выключено, закрываемся сразу'); app.quit(); return; }

  const dirty = await dirtyTabs();
  log('выход: спрашиваем подтверждение, несохранённых ' + dirty);
  const detail = dirty
    ? tr('quit.detailDirty', { count: dirty })
    : tr('quit.detailClean');
  const res = await dialog.showMessageBox(targetWindowSafe(), {
    type: 'question',
    title: tr('quit.title'),
    message: tr('quit.message'),
    detail,
    buttons: [tr('quit.close'), tr('quit.cancel')],
    defaultId: 0,
    cancelId: 1,          // крестик в рамке равносилен отмене
    checkboxLabel: tr('quit.neverAgain'),
    noLink: true,
  });
  if (res.checkboxChecked) {
    try { await ipc.setting('quitAsk', false); } catch { /* не записалось — спросим в следующий раз */ }
  }
  if (res.response !== 0) { log('выход: отменён'); return; }
  log('выход: подтверждён, закрываемся'
    + (res.checkboxChecked ? ', больше не спрашиваем' : ''));
  quitArmed = true;
  app.quit();
}

/**
 * Применить сохранённый выбор языка.
 *
 * Отдельная функция, потому что вызывается в двух местах: на старте и при
 * смене языка из окна настроек. Само значение живёт в settings.json рядом с
 * зумом и шириной колонки — отдельный файл ради одного значения не нужен.
 */
async function applyLangSetting() {
  try {
    await ipc.setting('lang', i18n.setLocale(await ipc.setting('lang')));
  } catch (e) {
    // Файл настроек может быть недоступен (read-only каталог, битый JSON).
    // Тогда остаётся язык системы — приложение обязано запуститься в любом
    // случае, выбор языка не повод падать.
    i18n.setLocale('auto');
    log('язык: настройка недоступна, беру язык системы (' + e.message + ')');
  }
  return i18n.lang;
}

/** Пересобрать меню и заголовок после смены языка, не перезапуская приложение. */
// Renderer сначала пишет значение в settings.json сам (общий путь настроек),
// а сюда приходит сигнал «перечитай и пересобери меню».
ipcMain.handle('mdv:setLang', async () => {
  const lang = await applyLangSetting();
  buildMenu();
  return lang;
});

// Раньше здесь жила функция plural(): mod10/mod100, три варианта окончания.
// Формы теперь выбирает Intl.PluralRules внутри i18n, и словарь хранит все
// нужные окончания рядом с текстом — поэтому код перевода не должен знать
// про язык вообще.

function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: tr('menu.file'),
      submenu: [
        { label: tr('menu.file.open'), accelerator: 'CmdOrCtrl+O', click: () => send('mdv:menu', 'open-file') },
        { label: tr('menu.file.openFolder'), accelerator: 'CmdOrCtrl+Shift+O', click: () => send('mdv:menu', 'open-folder') },
        { type: 'separator' },
        { label: tr('menu.file.save'), accelerator: 'CmdOrCtrl+S', click: () => send('mdv:menu', 'save') },
        { label: tr('menu.file.downloadMd'), click: () => send('mdv:menu', 'download-md') },
        { label: tr('menu.file.downloadHtml'), click: () => send('mdv:menu', 'download-html') },
        { label: tr('menu.file.print'), accelerator: 'CmdOrCtrl+P', click: () => send('mdv:menu', 'print') },
        { type: 'separator' },
        // CmdOrCtrl+Q вместо role: 'quit': роль закрывает приложение молча,
        // минуя подтверждение.
        { label: tr('menu.file.quit'), accelerator: 'CmdOrCtrl+Q', click: () => requestQuit() },
      ],
    },
    {
      label: tr('menu.edit'),
      submenu: [
        { role: 'undo', label: tr('menu.edit.undo') },
        { role: 'redo', label: tr('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: tr('menu.edit.cut') },
        { role: 'copy', label: tr('menu.edit.copy') },
        { role: 'paste', label: tr('menu.edit.paste') },
        { role: 'selectAll', label: tr('menu.edit.selectAll') },
        { type: 'separator' },
        { label: tr('menu.edit.find'), accelerator: 'CmdOrCtrl+F', click: () => send('mdv:menu', 'find') },
      ],
    },
    {
      label: tr('menu.view'),
      submenu: [
        { label: tr('menu.view.sidebar'), accelerator: 'CmdOrCtrl+B', click: () => send('mdv:menu', 'toggle-sidebar') },
        { label: tr('menu.view.toc'), accelerator: 'CmdOrCtrl+Shift+B', click: () => send('mdv:menu', 'toggle-toc') },
        { type: 'separator' },
        { label: tr('menu.view.editMode'), accelerator: 'CmdOrCtrl+E', click: () => send('mdv:menu', 'toggle-mode') },
        { label: tr('menu.view.cancelEdit'), accelerator: 'Escape', click: () => send('mdv:menu', 'cancel-edit') },
        { type: 'separator' },
        { label: tr('menu.view.back'), accelerator: 'Alt+Left', click: () => send('mdv:menu', 'back') },
        { label: tr('menu.view.forward'), accelerator: 'Alt+Right', click: () => send('mdv:menu', 'forward') },
        { type: 'separator' },
        { role: 'resetZoom', label: tr('menu.view.zoomReset') },
        { role: 'zoomIn', label: tr('menu.view.zoomIn') },
        { role: 'zoomOut', label: tr('menu.view.zoomOut') },
        { type: 'separator' },
        { label: tr('menu.view.reload'), accelerator: 'F5', click: () => send('mdv:menu', 'reload') },
        { role: 'togglefullscreen', label: tr('menu.view.fullscreen') },
        { role: 'toggleDevTools', label: tr('menu.view.devtools') },
      ],
    },
    {
      label: tr('menu.go'),
      submenu: [
        { label: tr('menu.go.newTab'), accelerator: 'CmdOrCtrl+T', click: () => send('mdv:menu', 'new-tab') },
        { label: tr('menu.go.closeTab'), accelerator: 'CmdOrCtrl+W', click: () => send('mdv:menu', 'close-tab') },
        { type: 'separator' },
        // Акселераторы у этих двух пунктов намеренно НЕ заданы: Windows считает
        // Ctrl+Tab системной комбинацией и съедает её раньше меню. Перехват
        // делает globalShortcut (registerTabShortcuts), он шлёт то же действие.
        { label: tr('menu.go.nextTab'), click: () => send('mdv:menu', 'next-tab') },
        { label: tr('menu.go.prevTab'), click: () => send('mdv:menu', 'prev-tab') },
      ],
    },
    {
      label: tr('menu.help'),
      submenu: [{
        label: tr('menu.help.about'),
        click: () => require('electron').dialog.showMessageBox(win, {
          type: 'info', title: 'JazzReader',
          message: 'JazzReader ' + app.getVersion(),
          detail: tr('about.detail'),
          buttons: [tr('about.ok')],
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

/*
 * Скрытый режим + тестовый IPC для выхода.
 *
 * Проверить окно подтверждения из теста иначе нечем: системный диалог
 * закрывается только настоящей мышью, и поднять его из скрипта нельзя.
 * Канал живёт только там, где окно и так не показывается, и в обычном
 * запуске его не существует.
 */
if (HIDDEN) {
  ipcMain.handle('mdv:testQuit', () => { requestQuit(); return true; });
}

app.whenReady()
  .then(async () => {
    logPath = resolveLogPath();
    log(`--- старт JazzReader ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform}/${process.arch} · portable=${app.isPackaged}`);

    // Язык читаем до меню: иначе первое окно открылось бы на языке системы,
    // а выбранный — только после перезапуска.
    await applyLangSetting();

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
    reportFatal(tr('error.windowFailed'), err);
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