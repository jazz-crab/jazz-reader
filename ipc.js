'use strict';
/*
 * IPC-слой: всё, что renderer просит у главного процесса.
 * Вынесено отдельно от main.js, чтобы smoke-тест проверял настоящие
 * обработчики, а не их копию.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const MD_EXT = /\.md$/i;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.obsidian', '.trash']);
const MAX_MD_BYTES = 5 * 1024 * 1024;

function targetWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

/** Кодировки: BOM -> строгий UTF-8 -> Windows-1251 (старые .md с русским). */
function decodeBuffer(buf) {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.toString('utf8', 3), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buf.subarray(2)), encoding: 'utf-16le' };
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch {
    try {
      return { text: new TextDecoder('windows-1251').decode(buf), encoding: 'windows-1251' };
    } catch {
      return { text: buf.toString('utf8'), encoding: 'utf-8 (lossy)' };
    }
  }
}

/** Рекурсивный список ТОЛЬКО .md, сгруппированный по каталогам. */
async function listMdTree(root) {
  const tree = [];
  let total = 0;

  async function walk(dir, rel, depth) {
    if (depth > 12) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch { return; }

    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (IGNORED_DIRS.has(ent.name)) continue;
        dirs.push({ name: ent.name, full, rel: rel ? rel + '/' + ent.name : ent.name });
      } else if (ent.isFile() && MD_EXT.test(ent.name)) {
        let size = 0, mtime = 0;
        try { const st = await fsp.stat(full); size = st.size; mtime = st.mtimeMs; } catch {}
        files.push({ name: ent.name, full, size, mtime });
      }
    }
    const coll = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
    dirs.sort((a, b) => coll.compare(a.name, b.name));
    files.sort((a, b) => coll.compare(a.name, b.name));

    if (files.length) tree.push({ type: 'files', dir: rel || path.basename(dir), full: dir, items: files });
    for (const d of dirs) {
      const before = tree.length;
      await walk(d.full, d.rel, depth + 1);
      if (tree.length > before) tree.push({ type: 'dir', dir: d.rel, full: d.full });
    }
  }

  await walk(root, '', 0);
  for (const grp of tree) if (grp.type === 'files') total += grp.items.length;
  return { root, tree, total };
}

/**
 * Автономный HTML одним файлом.
 *
 * Формулы к этому моменту уже отрендерены KaTeX в HTML, но KaTeX-CSS тянет
 * шрифты через url(fonts/...). Чтобы файл был по-настоящему автономным,
 * подставляем в @font-face base64-шрифты — но только те, что реально
 * встречаются на этой странице, иначе файл распухнет на пару мегабайт.
 */
async function buildStandaloneHtml(title, body) {
  const katexDir = path.join(__dirname, 'src', 'vendor', 'katex');
  const katexCss = await fsp.readFile(path.join(katexDir, 'katex.min.css'), 'utf8');
  const ourCss = await fsp.readFile(path.join(__dirname, 'src', 'style.css'), 'utf8');

  const classBag = [...String(body).matchAll(/class="([^"]*)"/g)].map((m) => m[1]).join(' ');

  const faces = [];
  for (const m of katexCss.matchAll(/@font-face\{[^}]*\}/g)) {
    const b = m[0];
    const fam = (b.match(/font-family:([^;]+)/) || [])[1];
    const w = (b.match(/font-weight:(\d+)/) || [, '400'])[1];
    const st = (b.match(/font-style:([a-z]+)/) || [, 'normal'])[1];
    const url2 = (b.match(/url\(([^)]+\.woff2)\)/) || [])[1];
    const url1 = (b.match(/url\(([^)]+\.woff)\)/) || [])[1];
    if (!fam || !(url2 || url1)) continue;
    faces.push({ key: fam + '|' + w + '|' + st, block: b, file: url2 || url1 });
  }

  const needed = new Set();
  for (const m of katexCss.matchAll(/([^{}]+)\{([^}]*KaTeX_[^}]*)\}/g)) {
    const fam = (m[2].match(/font-family:(KaTeX_[A-Za-z0-9_]+)/) || [])[1];
    if (!fam) continue;
    const w = (m[2].match(/font-weight:(\d+)/) || [, '400'])[1];
    const st = (m[2].match(/font-style:([a-z]+)/) || [, 'normal'])[1];
    const classes = m[1].match(/\.[A-Za-z0-9_-]+/g) || [];
    if (classes.some((c) => classBag.includes(c.slice(1)))) needed.add(fam + '|' + w + '|' + st);
  }

  // База добавляется всегда: если эвристика по классам что-то пропустила,
  // формула не развалится, а просто возьмёт запасной системный шрифт.
  for (const k of [
    'KaTeX_Main|400|normal', 'KaTeX_Main|700|normal',
    'KaTeX_Main|400|italic', 'KaTeX_Main|700|italic',
    'KaTeX_Math|400|italic', 'KaTeX_Size1|400|normal', 'KaTeX_Size2|400|normal',
    'KaTeX_AMS|400|normal', 'KaTeX_Typewriter|400|normal',
  ]) needed.add(k);

  const fontDir = path.join(katexDir, 'fonts');
  let out = katexCss;
  let inlined = 0;
  const done = new Set();
  for (const f of faces) {
    if (!needed.has(f.key) || done.has(f.block)) continue;
    const mime = f.file.endsWith('.woff2') ? 'font/woff2' : 'font/woff';
    let data;
    try { data = await fsp.readFile(path.join(fontDir, path.basename(f.file))); }
    catch { continue; }
    out = out.split(f.block).join(f.block.replace(/url\([^)]+\)/g, 'url(data:' + mime + ';base64,' + data.toString('base64') + ')'));
    done.add(f.block);
    inlined++;
  }
  // Неиспользуемые @font-face убираем совсем, иначе в файле остаются
  // битые ссылки url(fonts/...) и он перестаёт быть автономным.
  for (const f of faces) {
    if (done.has(f.block)) continue;
    out = out.split(f.block).join('');
  }

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const html = '<!DOCTYPE html>\n<html lang="ru">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '<title>' + esc(title) + '</title>\n<style>\n' + out + '\n' + ourCss + '\n'
    + 'html,body{height:auto;overflow:visible;background:#1a1b26}\n'
    + '.content{position:static;max-width:900px;margin:0 auto;padding:34px 26px 70px}\n'
    + '</style>\n</head>\n<body>\n<article class="content">' + body + '</article>\n</body>\n</html>\n';

  const name = String(title).replace(/\.md$/i, '') + '.html';
  const file = path.join(app.getPath('downloads'), name);
  await fsp.writeFile(file, html, 'utf8');
  return { path: file, fonts: inlined, bytes: Buffer.byteLength(html) };
}

function register() {
  ipcMain.handle('mdv:read', async (_e, filePath) => {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) throw new Error('Это каталог, а не файл');
    if (!MD_EXT.test(filePath)) throw new Error('Поддерживаются только .md');
    if (st.size > MAX_MD_BYTES) throw new Error('Файл больше 5 МБ');
    const { text, encoding } = decodeBuffer(await fsp.readFile(filePath));
    return {
      path: filePath,
      name: path.basename(filePath),
      text,
      encoding,
      size: st.size,
      // file://URL каталога: нужен, чтобы относительные картинки нашлись
      baseUrl: pathToFileURL(path.dirname(filePath) + path.sep).href,
      mtime: st.mtimeMs,
    };
  });

  ipcMain.handle('mdv:save', async (_e, { filePath, content }) => {
    if (!MD_EXT.test(filePath)) throw new Error('Поддерживаются только .md');
    // Пишем атомарно: сначала во временный рядом, потом rename.
    const tmp = filePath + '.mdvtmp';
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, filePath);
    return { path: filePath, mtime: Date.now() };
  });

  ipcMain.handle('mdv:stat', async (_e, p) => {
    try {
      const st = await fsp.stat(p);
      return { exists: true, isDir: st.isDirectory(), isFile: st.isFile(), name: path.basename(p) };
    } catch {
      return { exists: false, isDir: false, isFile: false, name: path.basename(p) };
    }
  });

  ipcMain.handle('mdv:listMd', (_e, root) => listMdTree(root));

  ipcMain.handle('mdv:dialogFile', async () => {
    const r = await dialog.showOpenDialog(targetWindow(), {
      title: 'Открыть Markdown',
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('mdv:dialogFolder', async () => {
    const r = await dialog.showOpenDialog(targetWindow(), {
      title: 'Открыть папку с заметками',
      properties: ['openDirectory'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('mdv:reveal', (_e, p) => { shell.showItemInFolder(p); });

  /**
   * Удаление заметки. Кладём в КОРЗИНУ, а не unlink: удаление из ПКМ по
   * дереву — необратимая операция одним кликом, и shell.trashItem даёт
   * «не отправилось в корзину» как страховку. Возвращает {ok} или {ok:false,
   * error} — renderer покажет текст.
   */
  ipcMain.handle('mdv:trash', async (_e, p) => {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) return { ok: false, error: 'Это не файл' };
      await shell.trashItem(path.resolve(p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * «Новый файл» — спросить имя и создать заметку с заготовкой.
   * showSaveDialog, а не openDialog: пользователь сам задаёт имя и папку.
   */
  ipcMain.handle('mdv:newFile', async (_e, seedName) => {
    const r = await dialog.showSaveDialog(targetWindow(), {
      title: 'Новая заметка',
      defaultPath: String(seedName || 'Новая заметка') + '.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      const p = r.filePath.endsWith('.md') ? r.filePath : r.filePath + '.md';
      const title = path.basename(p, '.md');
      const text = [
        '# ' + title,
        '',
        'Описание тут.',
        '',
        '## Раздел',
        '',
        '- пункт',
        '',
      ].join('\n');
      // Не затираем существующий файл: showOverwriteConfirmation уже спросил,
      // но подстраховка от гонки не повредит.
      if (!fs.existsSync(p)) await fsp.writeFile(p, text, 'utf8');
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * «Новый проект» — папка с заметками: создаём её и кладём README.md,
   * чтобы проект сразу был виден в проводнике, а не пустой.
   */
  ipcMain.handle('mdv:newProject', async (_e, seedName) => {
    const r = await dialog.showOpenDialog(targetWindow(), {
      title: 'Папка нового проекта',
      defaultPath: String(seedName || 'Новый проект'),
      buttonLabel: 'Создать проект',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    try {
      await fsp.mkdir(dir, { recursive: true });
      const readme = path.join(dir, 'README.md');
      const title = path.basename(dir);
      if (!fs.existsSync(readme)) {
        await fsp.writeFile(readme, [
          '# ' + title,
          '',
          'Заметки проекта. Файлы разложены по подпапкам.',
          '',
        ].join('\n'), 'utf8');
      }
      return { ok: true, path: dir, readme };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * Недавние файлы и настройки — маленькие json рядом с настройками
   * пользователя. Пишем атомарно (через tmp + rename), иначе падение
   * посреди записи оставляет битый файл и приложение падает на старте.
   */
  const storeFile = (name) => path.join(app.getPath('userData'), name);

  async function readStore(name, fallback) {
    try {
      const raw = await fsp.readFile(storeFile(name), 'utf8');
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : fallback;
    } catch {
      return fallback;   // нет файла или битый — начинаем с пустого
    }
  }

  async function writeStore(name, value) {
    const file = storeFile(name);
    const tmp = file + '.tmp';
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fsp.rename(tmp, file);
    return true;
  }

  const RECENT_MAX = 24;

  ipcMain.handle('mdv:recentGet', () => readStore('recent.json', { files: [] }));
  ipcMain.handle('mdv:recentAdd', async (_e, p) => {
    if (!p) return { files: [] };
    const st = await readStore('recent.json', { files: [] });
    // Только существующие .md: файл могли удалить или переименовать.
    const files = Array.isArray(st.files) ? st.files.filter((x) => x && x.path) : [];
    const rest = files.filter((x) => path.resolve(x.path) !== path.resolve(p));
    const item = { path: p, name: path.basename(p), at: Date.now() };
    const next = [item, ...rest].slice(0, RECENT_MAX);
    await writeStore('recent.json', { files: next });
    return { files: next };
  });
  ipcMain.handle('mdv:recentClear', async () => {
    await writeStore('recent.json', { files: [] });
    return { files: [] };
  });

  // Значения по умолчанию дублируются в renderer (applySettings): он знает,
  // что означает каждое поле, и применяет их сам.
  ipcMain.handle('mdv:settingsGet', () => readStore('settings.json', {}));
  ipcMain.handle('mdv:settingsSet', async (_e, patch) => {
    const cur = await readStore('settings.json', {});
    const next = Object.assign({}, cur, patch || {});
    await writeStore('settings.json', next);
    return next;
  });

  ipcMain.handle('mdv:print', () => {
    const w = targetWindow();
    if (w) w.webContents.print({ silent: false, printBackground: true });
  });
  ipcMain.handle('mdv:exportHtml', (_e, { title, body }) => buildStandaloneHtml(title, body));
}

module.exports = { register, listMdTree, decodeBuffer, buildStandaloneHtml };