'use strict';
/*
 * IPC-слой: всё, что renderer просит у главного процесса.
 * Вынесено отдельно от main.js, чтобы smoke-тест проверял настоящие
 * обработчики, а не их копию.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');

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
 * Заменить в CSS ссылки на файлы рядом с ним на base64-данные.
 *
 * Нужно для автономного файла: оставшийся url(fonts/...) в @font-face — это
 * битая ссылка, и без интернета (а в поезде его нет) вместо своего шрифта
 * браузер покажет системный. Все восемь начертаний JetBrains Mono весили
 * меньше мегабайта вместе, а @font-face с data-URI работает везде.
 *
 * base64 кладём только на woff2/woff/ttf/otf: на data:, SVG и прочее не
 * трогаем — вдруг в CSS встретится картинка, которую и так надо хранить
 * файлом (тогда пусть лучше битая ссылка, чем молчаливое превращение в
 * base64 в десять раз больший файл).
 */
async function inlineLocalFonts(css, baseDir) {
  const urls = [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
  let out = css;
  let inlined = 0;
  for (const u of new Set(urls)) {
    if (!/\.(woff2?|ttf|otf)(\?.*)?$/i.test(u)) continue;
    const file = path.join(baseDir, u.replace(/[\\/]/g, path.sep));
    let data;
    try { data = await fsp.readFile(file); }
    catch { continue; }
    const ext = path.extname(file).toLowerCase();
    const mime = ext === '.woff2' ? 'font/woff2' : ext === '.woff' ? 'font/woff'
      : ext === '.ttf' ? 'font/ttf' : 'font/otf';
    const data2 = 'data:' + mime + ';base64,' + data.toString('base64');
    // Заменяем посимвольно-по-строке: регулярка с обратной ссылкой $1
    // съедала бы слэши, а тут важна точность до символа.
    for (const q of [u, '"' + u + '"', "'" + u + "'"]) {
      out = out.split('url(' + q + ')').join('url(' + data2 + ')');
    }
    inlined += 1;
  }
  return { css: out, inlined };
}

/*
 * Недавние файлы и настройки — маленькие json рядом с настройками
 * пользователя. Пишем атомарно (через tmp + rename), иначе падение
 * посреди записи оставляет битый файл и приложение падает на старте.
 *
 * Живут на уровне модуля, а не внутри register(): окно подтверждения выхода
 * показывает главный процесс, и ему тоже нужно прочитать и записать
 * настройку «не спрашивать больше» — не через renderer, потому что вопрос
 * возникает как раз когда renderer уже закрывается.
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

/** Одно поле настроек: прочитать и (по желанию) записать. */
async function setting(key, value) {
  const cur = await readStore('settings.json', {});
  if (value === undefined) return cur[key];
  const next = Object.assign({}, cur, { [key]: value });
  await writeStore('settings.json', next);
  return next[key];
}

/**
 * Автономный HTML одним файлом.
 *
 * Формулы к этому моменту уже отрендерены KaTeX в HTML, но KaTeX-CSS тянет
 * шрифты через url(fonts/...). Чтобы файл был по-настоящему автономным,
 * подставляем в @font-face base64-шрифты — но только те, что реально
 * встречаются на этой странице, иначе файл распухнет на пару мегабайт.
 */
async function buildStandaloneHtml(title, body, opts) {
  const o = opts || {};
  const katexDir = path.join(__dirname, 'src', 'vendor', 'katex');
  /*
   * BOM снимаем обязательно.
   *
   * style.css начинается с U+FEFF — в файле это нормально, парсер читает файл
   * и знак не видит. А в автономном HTML этот же CSS оказывается в середине
   * одного <style>, и знак посередине уже не «начало файла», а недопустимый
   * символ: Chromium съедает на нём следующий блок целиком.
   *
   * Так терялся :root — то есть ВСЕ переменные темы: --bg, --fg, --border и
   * остальные. Страница собиралась без цвета вообще: цвет текста и фона
   * брался из неопределённой переменной, то есть становился чёрным на
   * прозрачном. Отсюда и «экспорт сохраняет не весь CSS».
   */
  const readCss = async (p) => (await fsp.readFile(p, 'utf8')).replace(/^\uFEFF/, '');
  const katexCss = await readCss(path.join(katexDir, 'katex.min.css'));
  let ourCss = await readCss(path.join(__dirname, 'src', 'style.css'));
  // Свой шрифт лежит отдельным файлом src/fonts.css и в style.css его нет —
  // про него забыли, и в экспорте вместо JetBrains Mono была системная
  // моноширинная. Подключаем и вшиваем наравне с KaTeX.
  const fontCss = await readCss(path.join(__dirname, 'src', 'fonts.css'));
  const own = await inlineLocalFonts(fontCss, path.join(__dirname, 'src'));
  ourCss += '\n/* шрифты приложения */\n' + own.css;

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
    + (o.print ? PRINT_CSS + exportCss(o) : exportCss(o))
    + '</style>\n</head>\n<body>\n<article class="content">' + body + '</article>\n</body>\n</html>\n';

  if (o.print) return { html, fonts: inlined + own.inlined, bytes: Buffer.byteLength(html) };

  const name = String(title).replace(/\.md$/i, '') + '.html';
  const file = path.join(app.getPath('downloads'), name);
  await fsp.writeFile(file, html, 'utf8');
  return { path: file, fonts: inlined + own.inlined, bytes: Buffer.byteLength(html) };
}

/*
 * Список системных шрифтов.
 *
 * Браузер шрифты не перечислит: queryLocalFonts() в Electron не работает, а
 * font-family всегда молча падает на следующий в списке. Единственный честный
 * источник — реестр Windows, где имя значения устроено как «Семейство Стиль
 * (TrueType)».
 *
 *   Consolas Bold Italic (TrueType)   -> Consolas
 *   Segoe UI Semibold (TrueType)      -> Segoe UI Semibold
 *
 * Второй случай разбирается не до конца (у Segoe UI Semibold семейство —
 * «Segoe UI», а начертание жирное), но для списка выбора это честнее, чем
 * ничего: человек увидит знакомое имя и, если оно не применилось, увидит
 * предпросмотр и поставит другое.
 */
const FONT_STYLE_WORDS = new Set([
  'regular', 'roman', 'book', 'bold', 'black', 'heavy', 'demibold', 'semibold',
  'extralight', 'ultralight', 'light', 'thin', 'extrathin', 'ultrathin',
  'semilight', 'lightitalic', 'medium', 'semimedium', 'extramedium', 'demi',
  'italic', 'oblique', 'condensed', 'semicondensed', 'narrow', 'expanded',
  'semiexpanded', 'extended', 'extraexpanded', 'ultraexpanded',
  'normal', 'italic', 'bolditalic',
]);

function fontFamilyFromRegistryName(value) {
  let name = String(value).replace(/\s*\([^()]*\)\s*$/, '').trim();
  // Стиль может идти двумя словами («Bold Italic»), снимаем по одному, пока
  // хвост похож на стиль.
  for (let n = 0; n < 3; n += 1) {
    const m = /^(.*\S)\s+([A-Za-z]+)$/.exec(name);
    if (!m) break;
    const tail = m[2].toLowerCase().replace(/[^a-z]/g, '');
    if (!FONT_STYLE_WORDS.has(tail)) break;
    name = m[1];
  }
  name = name.trim();
  // @-шрифты в реестре — это файлы, а не семейства, в списке выбора они
  // бесполезны.
  if (!name || name.startsWith('@')) return null;
  return name;
}

async function listSystemFonts() {
  const out = new Map();
  const put = (n) => {
    if (n) out.set(n.toLowerCase(), n);
  };
  put('JetBrainsMono');
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
    'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  ];
  for (const key of keys) {
    let outp = '';
    try {
      outp = await new Promise((res, rej) => {
        execFile('reg.exe', ['query', key], {
          encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8 << 20,
        }, (e, so) => (e ? rej(e) : res(so)));
      });
    } catch {
      // Ключа может не быть (например, у portable-сборки в чужом профиле) —
      // это не ошибка, а просто один из источников пуст.
      continue;
    }
    for (const line of String(outp).split(/\r?\n/)) {
      // Строка вывода reg query: «    Имя    REG_SZ    файл.ttf».
      const m = /^\s{4}(.+?)\s{4}REG_\w+\s/.exec(line);
      if (!m) continue;
      put(fontFamilyFromRegistryName(m[1]));
    }
  }
  const coll = new Intl.Collator('ru', { sensitivity: 'base' });
  // Свой шрифт первым, остальные по алфавиту: список в выпадающем поле
  // начинается с того, что нужно чаще всего.
  const all = [...out.values()];
  const own = all.filter((n) => n === 'JetBrainsMono');
  const rest = all.filter((n) => n !== 'JetBrainsMono').sort(coll.compare);
  return own.concat(rest).slice(0, 600);
}

/*
 * CSS по выбору в окне экспорта: палитра, шрифт, размер.
 *
 * Размер задаётся на .content — всё внутри в em, поэтому масштабируется
 * ровно то же, что масштабируется ползунком зума в приложении, и в
 * предпросмотре, и в файле.
 *
 * Шрифт идёт через --mono и --ui: ими размечены и код, и интерфейс, и
 * подставлять имя в сотни правил незачем. Имя в кавычках и с отброшенными
 * кавычками и обратными слэшами — иначе значение из select уехало бы в CSS
 * как есть.
 */
function exportCss(opts) {
  const o = opts || {};
  const raw = String(o.font || 'JetBrainsMono').replace(/["'\\;{}()]/g, '').trim();
  const family = '"' + (raw || 'JetBrainsMono') + '", monospace';
  const size = Math.min(48, Math.max(8, Number(o.size) || 15));
  const pad = o.print ? '16mm 18mm 18mm' : '34px 26px 70px';
  let css = '\n/* --- выбор из окна экспорта --- */\n'
    + ':root { --mono: ' + family + '; --ui: ' + family + '; }\n'
    + '.content { font-family: var(--mono) !important; font-size: ' + size + 'px !important;'
    + ' padding: ' + pad + ' !important; }\n';
  css += o.bw ? BANDW_CSS : (o.print ? COLOUR_PRINT_CSS : '');
  return css;
}

/*
 * Чёрно-белая палитра.
 *
 * На экране и на бумаге. Правила те же, что в @media print, только без
 * !important по цвету текста там, где хватает обычного каскада: этот блок
 * стоит последним и перебивает и @media print, и тему.
 */
const BANDW_CSS = `
html, body, .content { background: #fff !important; color: #14161c !important; }
.content p, .content li, .content td, .content th,
.content h1, .content h2, .content h3, .content h4, .content h5, .content h6,
.content pre, .content code, .content blockquote { color: #14161c !important; }
.content pre, .content blockquote { background: #f5f5f7 !important; border-color: #d8d8de !important; }
.content code { background: #eeeef2 !important; }
.content a { color: #1450c0 !important; border-bottom-color: #1450c0 !important; }
.content th, .content td { border-color: #b9b9c2 !important; }
.content th { background: #eeeef2 !important; }
.content h2, .content h3 { border-color: #d8d8de !important; }
.content hr { border-color: #d8d8de !important; }
`;

/*
 * Цветная палитра на печати.
 *
 * @media print в style.css насильно перекрашивает страницу в белый — на
 * бумаге это правильно, но человек выбрал «цветное», и его выбор должен
 * выиграть. Поэтому возвращаем цвета темы, дублируя те же селекторы.
 */
const COLOUR_PRINT_CSS = `
html, body, .content { background: var(--bg) !important; color: var(--fg) !important; }
.content p, .content li, .content td, .content th,
.content h1, .content h2, .content h3, .content h4, .content h5, .content h6,
.content pre, .content code, .content blockquote { color: var(--fg) !important; }
.content pre, .content blockquote { background: var(--bg-soft) !important;
    border-color: var(--border) !important; }
.content code { background: var(--bg-alt) !important; }
.content a { color: var(--blue) !important; border-bottom-color: var(--blue) !important; }
.content th, .content td { border-color: var(--border) !important; }
.content th { background: var(--bg-soft) !important; }
.content hr { border-color: var(--border) !important; }
`;

/*
 * Дополнение к автономному HTML для печати.
 *
 * Стоит ПОСЛЕ style.css, где лежит @media print, и поэтому перебивает его
 * !important-правила — иначе выбор человека (палитра, шрифт, размер)
 * оказывался бы перебит печатными значениями.
 *
 *   @page margin: 0 — печать без полей. Отступ до текста задаёт padding
 *   .content: иначе текст ложился бы в самый край листа.
 *   pre и blockquote без рамок: @media print рисует вокруг них
 *   1px solid #ccc — на бумаге это рамка вокруг каждого блока кода, а на
 *   цветном фоне она вообще выглядит как ошибка вёрстки.
 */
const PRINT_CSS = `
/* печать */
@page { size: A4; margin: 0; }
.content { padding: 16mm 18mm 18mm !important; }
.content pre, .content blockquote { border: none !important; }
`;

/**
 * PDF без системного диалога печати.
 *
 * Диалог на Windows — это и есть «нижний тулбар с надписями»: у него внизу
 * панель с кнопками и колонтитул с именем файла и номерами страниц, и она
 * попадала в результат. printToPDF идёт мимо диалога и возвращает готовый
 * файл; колонтитулов там нет в принципе.
 *
 * Страница печатается в скрытом окне из того же автономного HTML, что и
 * экспорт: одна сборка на оба формата, значит PDF и HTML не могут разойтись.
 */
async function buildPdf(title, body, opts) {
  const built = await buildStandaloneHtml(title, body, Object.assign({}, opts, { print: true }));
  const file = path.join(app.getPath('temp'), 'mdview-print-' + process.pid + '.html');
  await fsp.writeFile(file, built.html, 'utf8');

  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  });
  try {
    await w.loadFile(file);
    // Шрифты вшиты в CSS как base64, но Chromium успевает разложить их
    // позже, чем сработает did-finish-load: печать без этого даст лист, где
    // половина текста напечатана запасным шрифтом. fonts.ready — честное
    // ожидание, а если страница его не отдаёт (старый Chromium) — просто
    // ждём немного.
    try { await w.webContents.executeJavaScript('document.fonts.ready.then(function(){return 1})'); }
    catch { await new Promise((r) => setTimeout(r, 600)); }
    const buf = await w.webContents.printToPDF({
      printBackground: true,
      // Колонтитулы: имя файла, дата, номер страницы. Их и рисует тот самый
      // нижний тулбар, поэтому выключаем явно.
      headerFooter: false,
      preferCSSPageSize: true,
      margins: { marginType: 'none' },
    });
    const name = String(title).replace(/\.md$/i, '') + '.pdf';
    const out = path.join(app.getPath('downloads'), name);
    await fsp.writeFile(out, buf);
    return { path: out, bytes: buf.length };
  } finally {
    if (!w.isDestroyed()) w.destroy();
    try { await fsp.unlink(file); } catch { /* временный файл мог не создаться */ }
  }
}

/** Ширину проставляет main после применения titleBarOverlay. */
let captionWidth = 140;

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

  /*
   * Записи настроек выстраиваются в очередь.
   *
   * Настройки пишутся на каждое движение ползунка, то есть десятки раз в
   * секунду. Каждая запись — чтение, объединение, запись, и без очереди эти
   * циклы накладывались: файл успевал переписаться наполовину, и следующее
   * чтение видело битый JSON, а readStore молча отдавал пустой объект. Со
   * стороны это выглядело как «настройки не сохранились».
   */
  let settingsChain = Promise.resolve();
  ipcMain.handle('mdv:settingsSet', (_e, patch) => {
    settingsChain = settingsChain.then(async () => {
      const cur = await readStore('settings.json', {});
      const next = Object.assign({}, cur, patch || {});
      await writeStore('settings.json', next);
      return next;
    }).catch((e) => {
      // Ошибку одной записи не даём уронить очередь: иначе все следующие
      // настройки молча перестали бы сохраняться.
      console.error('settingsSet:', e && e.message);
      return null;
    });
    return settingsChain;
  });

  /*
   * Ctrl+N: временная заметка в os.tmpdir()/mdview. Имена «Безымянный-N.md»
   * перебираются, пока не найдётся свободное: заметка не должна молча
   * перезаписать прошлую, если пользователь её не сохранил.
   */
  ipcMain.handle('mdv:newTemp', async (_e, seedName) => {
    try {
      const dir = path.join(os.tmpdir(), 'mdview');
      await fsp.mkdir(dir, { recursive: true });
      const base = String(seedName || 'Безымянный');
      let file = '';
      for (let n = 1; n < 1000; n++) {
        file = path.join(dir, base + (n === 1 ? '' : ' ' + n) + '.md');
        if (!fs.existsSync(file)) break;
      }
      if (fs.existsSync(file)) return { ok: false, error: 'слишком много временных заметок' };
      await fsp.writeFile(file, '# ' + path.basename(file, '.md') + '\n\n', 'utf8');
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /*
   * Ctrl+Shift+N: папка внутри уже открытой. Имя по умолчанию «Новая папка»,
   * при совпадении добавляем номер — молча переиспользовать чужое имя нельзя.
   */
  ipcMain.handle('mdv:newFolder', async (_e, parent, seedName) => {
    try {
      if (!parent) return { ok: false, error: 'не открыта папка' };
      const st = await fsp.stat(parent).catch(() => null);
      if (!st || !st.isDirectory()) return { ok: false, error: 'не каталог' };
      const base = String(seedName || 'Новая папка');
      let dir = '';
      for (let n = 1; n < 1000; n++) {
        dir = path.join(parent, base + (n === 1 ? '' : ' ' + n));
        if (!fs.existsSync(dir)) break;
      }
      if (fs.existsSync(dir)) return { ok: false, error: 'слишком много папок' };
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true, path: dir, name: path.basename(dir) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /*
   * Ширина блока системных кнопок окна. Renderer спрашивает её один раз при
   * старте, чтобы зарезервировать место в полосе вкладок.
   * Push-канал не годился: сообщение могло уйти раньше, чем renderer
   * подпишется, и тогда резерв остался бы дефолтным.
   */
  ipcMain.handle('mdv:caption', () => captionWidth);

  ipcMain.handle('mdv:print', () => {
    const w = targetWindow();
    if (w) w.webContents.print({ silent: false, printBackground: true });
  });
  ipcMain.handle('mdv:exportHtml', (_e, { title, body, opts }) => buildStandaloneHtml(title, body, opts));
  ipcMain.handle('mdv:exportPdf', (_e, { title, body, opts }) => buildPdf(title, body, opts));
  /** Системные шрифты для выпадающего списка в окне экспорта. */
  ipcMain.handle('mdv:fonts', () => listSystemFonts());
}

module.exports = {
  register, listMdTree, decodeBuffer, buildStandaloneHtml, buildPdf,
  listSystemFonts, exportCss, setting,
  setCaptionWidth: (px) => { captionWidth = Math.max(0, Math.round(px || 0)); },
};