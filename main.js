'use strict';

const { app, BrowserWindow, Menu, shell, dialog, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const ipc = require('./ipc');

// The same i18n runtime as the renderer: the dictionaries live in src/i18n, and
// it is needed here before the first window — the window title and the error
// dialog are created earlier than the renderer loads anything.
const i18n = require('./src/i18n/index.js');
i18n.setSystemLocale(app.getLocale());

/* Short name tr, not t: the one-letter names are already taken in this file
 * (t is a tab in the messages), and the collision silently breaks parsing of
 * expressions like t.name. */
const tr = (key, params) => i18n.t(key, params);

// Multiple instances: requestSingleInstanceLock() is deliberately NOT used.
// Every launch is a separate process with its own window and its own tabs, so
// that two different projects can sit side by side.

if (process.platform === 'linux' && process.getuid?.() === 0) {
  app.commandLine.appendSwitch('no-sandbox');
}

// ───────────────────────────── Diagnostics ─────────────────────────────
// Electron is a GUI-subsystem application, so stdout/stderr do not reach the
// console it was started from. That used to mean any startup error looked like
// "the program does nothing". So we write a log to disk and show a dialog
// rather than failing silently.

// Hidden mode: JAZZREADER_HIDDEN=1 or the --jazzreader-hidden flag.
// The window is created and works but is never shown: nothing appears on
// screen, it is absent from the taskbar and from Alt+Tab, and there is nothing
// to click. Needed so that automated tests and development do not pop a window
// on top of whatever is being worked on.
//
// Why not "another desktop": Windows virtual desktops are unavailable from this
// build (the IVirtualDesktopManager COM class is not registered), a hotkey
// requires handing focus to the window, and a separate Win32 desktop kills
// Chromium before main.js even starts.
//
// The names from before the rename (MDVIEW_HIDDEN, --mdview-hidden) are still
// accepted: old shortcuts and scripts should not break over a rename.
const HIDDEN = process.env.JAZZREADER_HIDDEN === '1'
  || process.env.MDVIEW_HIDDEN === '1'
  || process.argv.includes('--jazzreader-hidden')
  || process.argv.includes('--mdview-hidden');

/*
 * The strip Windows paints under the system caption buttons, and our fallback.
 *
 * OVERLAY.height is the height of the titleBarOverlay strip. Windows fills it
 * with ITS OWN colour (OVERLAY.color) on top of the window contents. The tab
 * strip is exactly 40px, and its bottom edge landed on the last pixel of that
 * strip — that is, on the last pixel of the line under the tabs. Windows
 * painted over it entirely, so the line stopped exactly where the
 * minimise/maximise/close buttons began: on the left under the tabs it was
 * there, under the buttons themselves it was not.
 *
 * The cure is the height: make the strip 2px shorter than the tab strip. Then
 * Windows paints only the top 38px, the bottom edge stays ours and runs the
 * full width. The side effect is two extra tab strips under the buttons, which
 * at a height of 40px is not visible.
 */
const OVERLAY = { color: '#16161e', symbolColor: '#a9b1d6', height: 38 };

/*
 * Width of the system caption buttons (minimise/maximise/close).
 *
 * titleBarOverlay draws them on top of the window contents, and that was our
 * trouble: the tab strip did not reserve room for them. With many tabs the "+"
 * button slid under the system buttons and became unusable, and the last tabs
 * became invisible. No scrollbar appeared meanwhile: the strip formally fitted,
 * so there was nothing to count the overflow against.
 *
 * A constant will not do: the width depends on DPI (at 150% it is ~207px
 * instead of ~138px). We measure on the live window with getTitleBarArea() —
 * it returns the title area available for dragging, that is, WITHOUT the block
 * of buttons on the right. The difference between the right edge of the window
 * and the right edge of that area is the width we need.
 *
 * The fallback path is 138px (the typical value at 100%): if the overlay did
 * not apply, better to over-reserve and leave empty space than to hide the "+".
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
/** Captured system hotkeys (see registerTabShortcuts). */
// let, not const: releaseTabShortcuts() assigns an empty array to it, and on a
// const the application died with "Assignment to constant variable" right in
// will-quit — that is, instead of closing, an error window appeared on screen.
// (A placeholder line to keep the comment block anchored: the let is below.)
let shortcuts = [];

function resolveLogPath() {
  // Portable: next to the .exe. Installed: Program Files is not writable — take userData.
  const candidates = [app.isPackaged ? path.dirname(process.execPath) : __dirname, null];
  try { candidates.splice(1, 0, app.getPath('userData')); } catch { /* not ready yet */ }
  for (const dir of candidates) {
    if (!dir) continue;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return path.join(dir, 'jazzreader.log');
    } catch { /* try the next one */ }
  }
  return null;
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ` + args.join(' ') + '\n';
  try { process.stderr.write(line); } catch { /* no stderr */ }
  if (logPath) {
    try { fs.appendFileSync(logPath, line); } catch { /* disk unavailable */ }
  }
}

/** Unhandled error: write it to the log and show the window with the text once. */
function reportFatal(where, err) {
  const text = err && err.stack ? err.stack : String(err);
  log(`FATAL ${where}: ${text}`);
  if (fatalShown) return;
  fatalShown = true;
  try {
    dialog.showErrorBox(
      tr('error.startup'),
      `${where}\n\n${text}\n\n` +
      tr('error.logAt', { path: logPath || tr('error.noLog') }) + '\n' +
      tr('error.sendLog')
    );
  } catch { /* no dialog before ready */ }
}

process.on('uncaughtException', (err) => reportFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => reportFatal('unhandledRejection', err));

// ───────────────────────────── Window ─────────────────────────────

let win = null;

function createWindow() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';

  win = new BrowserWindow({
    width: 1320, height: 880, minWidth: 760, minHeight: 480,
    backgroundColor: '#1a1b26',
    title: 'JazzReader',
    show: false,
    // titleBarStyle is a constructor option only (there is no setTitleBarStyle).
    // Hide the system title bar so the tab strip reaches the very top.
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // IMPORTANT: the overlay MUST be enabled HERE, in the constructor.
    // It used to be enabled only by a setTitleBarOverlay() call after the window
    // was created — that threw "Titlebar overlay is not enabled", the exception
    // went into app.whenReady().then() as an unhandledRejection, no window was
    // created at all, and the application hung silently with no window. Plus
    // app.asar was 6 MB.
    ...(isWin ? { titleBarOverlay: OVERLAY } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      // The --lang= language goes into the window argv: the renderer reads
      // settings.json itself, and without the override it fell back to the saved
      // value — so the window and the menu showed different languages. The name
      // carries an mdv- prefix to tell the internal argument from the user's
      // --lang=.
      ...(langFromArgv() ? { additionalArguments: ['--mdv-lang=' + langFromArgv()] } : {}),
      // The window is not visible, so the compositor will not draw: in offscreen
      // mode frames go straight out, and page screenshots come out non-empty.
      ...(HIDDEN ? { offscreen: true } : {}),
    },
  });

  // Safety net: if the overlay is unavailable after all (old Windows, extra
  // registry state), the window should appear rather than disappear with the
  // error.
  if (isWin) {
    try {
      win.setTitleBarOverlay(OVERLAY);
    } catch (e) {
      log('setTitleBarOverlay недоступен, продолжаем без него: ' + e.message);
    }
    // The button block width is only known once the overlay has been applied.
    const caption = captionButtonWidth(win);
    log('системные кнопки окна: ' + caption + 'px');
    ipc.setCaptionWidth(caption);
  }

  // Safety net against an "invisible" window: show on ready-to-show, but if the
  // event has not arrived within 6 s, show anyway.
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

  // External links go to the system browser.
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
 * Ctrl+Q asks for confirmation before quitting.
 *
 * The dialog is the system one, not a drawn one: it has a real frame with a
 * close box, and closing it means Cancel, as in any system window. A drawn
 * layer with two buttons would look like part of the application, and could not
 * be closed by anything except those two buttons.
 *
 * The "Don't ask again" checkbox is written to settings.json, so the choice
 * does not have to be looked up again on every launch.
 *
 * Permission to quit is granted once and dropped on any new call: while the
 * dialog is up, a repeated Ctrl+Q must not cancel the confirmation.
 */
let quitArmed = false;

/** How many tabs have unsaved changes — to warn about in the dialog. */
async function dirtyTabs() {
  const w = targetWindowSafe();
  if (!w || w.isDestroyed()) return 0;
  try {
    const n = await w.webContents.executeJavaScript(
      'window.mdvDirtyTabs ? window.mdvDirtyTabs() : 0');
    return Number(n) || 0;
  } catch {
    return 0;   // the renderer may already be closed, nothing to ask about then
  }
}

function targetWindowSafe() {
  return win || BrowserWindow.getAllWindows()[0] || null;
}

/**
 * Quit the application with confirmation.
 *
 * answer is the index of the pressed button when the answer is known in
 * advance. Normally that is null and the dialog is shown to the user. The test
 * passes the index directly: the system dialog can only be closed with a real
 * mouse, a script cannot raise it, and showing the window during automated
 * checks takes focus away from everything the person has open.
 */
async function requestQuit(answer = null) {
  if (quitArmed) { app.quit(); return; }
  let ask = true;
  try { ask = (await ipc.setting('quitAsk')) !== false; }
  catch { ask = true; }   // setting unreadable, ask as usual
  if (!ask) { log('выход: подтверждение выключено, закрываемся сразу'); app.quit(); return; }

  const dirty = await dirtyTabs();
  const detail = dirty
    ? tr('quit.detailDirty', { count: dirty })
    : tr('quit.detailClean');
  let res;
  if (answer === null) {
    log('выход: спрашиваем подтверждение, несохранённых ' + dirty);
    res = await dialog.showMessageBox(targetWindowSafe(), {
      type: 'question',
      title: tr('quit.title'),
      message: tr('quit.message'),
      detail,
      buttons: [tr('quit.close'), tr('quit.cancel')],
      defaultId: 0,
      cancelId: 1,          // the close box on the frame means cancel
      checkboxLabel: tr('quit.neverAgain'),
      noLink: true,
    });
  } else {
    // The same path without a window: the logs and the test see exactly what
    // they see with a live dialog, but nobody loses focus.
    log('выход: подтверждение получено без диалога (тест), несохранённых ' + dirty
      + ', ответ ' + answer);
    res = { response: answer, checkboxChecked: false };
  }
  if (res.checkboxChecked) {
    try { await ipc.setting('quitAsk', false); } catch { /* not written, we will ask next time */ }
  }
  if (res.response !== 0) { log('выход: отменён'); return; }
  log('выход: подтверждён, закрываемся'
    + (res.checkboxChecked ? ', больше не спрашиваем' : ''));
  quitArmed = true;
  app.quit();
}

/*
 * The command line language override: --lang=ru, --lang=en.
 *
 * It holds until the language is picked explicitly in the settings. After that
 * the override is dropped (see mdv:setLang): otherwise the person's choice
 * would not take effect while running with --lang, and the setting would be
 * unavailable altogether.
 */
let langOverrideArmed = true;

/**
 * The language from the command line: --lang=ru, --lang=en.
 *
 * It overrides the saved setting but does not rewrite it. That way a second
 * copy can run in another language without touching the first one — and, more
 * importantly for the tests, the language is given explicitly instead of being
 * guessed from the settings of the machine. Until now the argument was passed
 * in the tests but read by nobody: the language came from settings.json, and
 * the checks either failed or passed depending on what was in that file.
 */
function langFromArgv() {
  if (!langOverrideArmed) return null;
  const arg = process.argv.find((a) => a.startsWith('--lang='));
  if (!arg) return null;
  const tag = i18n.normalize(arg.slice('--lang='.length));
  return tag || 'auto';
}

/**
 * Apply the saved language choice.
 *
 * A function of its own because it is called from two places: at startup and
 * on a language change from the settings window. The value itself lives in
 * settings.json next to the zoom and the column width — a separate file for a
 * single value is not needed.
 */
async function applyLangSetting() {
  const forced = langFromArgv();
  if (forced) {
    // Not written to settings.json: the argument is a one-off override, otherwise
    // a launch with --lang=en would silently change the language of the next
    // ordinary launch.
    i18n.setLocale(forced);
    log('язык: задан аргументом командной строки (' + forced + ')');
    return i18n.lang;
  }
  try {
    await ipc.setting('lang', i18n.setLocale(await ipc.setting('lang')));
  } catch (e) {
    // The settings file may be unavailable (read-only directory, broken JSON).
    // Then the system language stands — the application must start in any case,
    // the language choice is no reason to fall over.
    i18n.setLocale('auto');
    log('язык: настройка недоступна, беру язык системы (' + e.message + ')');
  }
  return i18n.lang;
}

/** Rebuild the menu and the title after a language change, without a restart. */
// The renderer writes the value to settings.json itself first (the shared
// settings path), and the signal that arrives here means "re-read and rebuild
// the menu".
ipcMain.handle('mdv:setLang', async () => {
  // The language was picked explicitly — the command line override is no longer needed.
  langOverrideArmed = false;
  const lang = await applyLangSetting();
  buildMenu();
  return lang;
});

// A plural() function used to live here: mod10/mod100, three ending variants.
// The forms are now chosen by Intl.PluralRules inside i18n, and the dictionary
// keeps every needed ending next to the text — so the translation code should
// not know about languages at all.

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
        // CmdOrCtrl+Q instead of role: 'quit': the role closes the application
        // silently, bypassing the confirmation.
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
        // These two items deliberately have NO accelerator: Windows treats
        // Ctrl+Tab as a system combination and eats it before the menu does. The
        // capture is globalShortcut (registerTabShortcuts), it sends the same
        // action.
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

/** Paths passed at launch (arguments, a drop onto the .exe, an OS association). */
function cliPaths() {
  return process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-'));
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab never reach the renderer: Windows treats them as
 * system combinations (switching windows/tabs) and eats them before they get
 * to Chromium, so keydown in the renderer stays silent. Verified with a
 * synthetic keybd_event against a real window: the tab did not change and
 * keydown did not fire.
 *
 * The way out is globalShortcut, which captures the combination before the OS.
 * The registration MUST be released on will-quit: otherwise the hotkey sticks
 * and Ctrl+Tab stops working across the whole system until a reboot.
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
    try { globalShortcut.unregister(a); } catch { /* already released */ }
  }
  shortcuts = [];
}

app.on('will-quit', releaseTabShortcuts);

/*
 * Hidden mode + the test IPC for quitting.
 *
 * The channel returns the answer index instead of showing a window: the system
 * dialog can only be closed with a real mouse, a script cannot raise it, and a
 * window appearing during automated checks takes focus from whatever the person
 * has open on screen. The channel exists only where the window is not shown
 * anyway, and in a normal launch it does not exist.
 */
if (HIDDEN) {
  ipcMain.handle('mdv:testQuit', (_e, answer = null) => {
    requestQuit(answer === null || answer === undefined ? null : Number(answer));
    return true;
  });
}

app.whenReady()
  .then(async () => {
    logPath = resolveLogPath();
    log(`--- старт JazzReader ${app.getVersion()} · electron ${process.versions.electron} · ${process.platform}/${process.arch} · portable=${app.isPackaged}`);

    // The language is read before the menu: otherwise the first window would open
    // in the system language, and the chosen one only after a restart.
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
    // This used to be a bare .then() — any error became an unhandledRejection
    // with no window and no output. Now it is an explicit error with a dialog and
    // exit code 1.
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