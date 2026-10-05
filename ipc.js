'use strict';
/*
 * The IPC layer: everything the renderer asks of the main process.
 * Kept apart from main.js so that the smoke test exercises the real handlers
 * rather than a copy of them.
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');
const { execFile } = require('child_process');
const i18n = require('./src/i18n/index.js');

const MD_EXT = /\.md$/i;
const IGNORED_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '.obsidian', '.trash']);
const MAX_MD_BYTES = 5 * 1024 * 1024;

/*
 * Translation of a string. ipc.js needs it for itself: the titles of the system
 * open dialogs and the error texts are seen by a person, and the module knew
 * nothing about i18n. main.js sets the language at startup, before the
 * handlers are registered.
 */
const tr = (key, params) => i18n.t(key, params);

function targetWindow() {
  return BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0] || null;
}

/** Encodings: BOM -> strict UTF-8 -> Windows-1251 (old .md files in Russian). */
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

/** Recursive list of .md ONLY, grouped by directory. */
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
 * Replace references to files next to the CSS with base64 data.
 *
 * Needed for a self-contained file: the leftover url(fonts/...) in @font-face is
 * a broken reference, and without a network (and in a train there is none) the
 * browser shows a system font instead of ours. All eight JetBrains Mono weights
 * together weighed less than a megabyte, and @font-face with a data-URI works
 * everywhere.
 *
 * base64 is applied only to woff2/woff/ttf/otf: SVG and the rest on data: are
 * left alone — the CSS may contain an image that ought to stay a file, and
 * then a broken reference is the better outcome, rather than a silent turn
 * into base64 ten times larger.
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
    // Replaced by string rather than by a regex with a backreference $1: that
    // would eat the slashes, and here accuracy to the character matters.
    for (const q of [u, '"' + u + '"', "'" + u + "'"]) {
      out = out.split('url(' + q + ')').join('url(' + data2 + ')');
    }
    inlined += 1;
  }
  return { css: out, inlined };
}

/*
 * Recent files and settings are small json files next to the user settings.
 * They are written atomically (via tmp + rename), otherwise a crash in the
 * middle of a write leaves a broken file and the application fails at startup.
 *
 * They live at module level rather than inside register(): the quit confirmation
 * window is shown by the main process, and it needs to read and write the
 * "do not ask again" setting too — not through the renderer, because the
 * question comes up exactly when the renderer is already closing.
 */
const storeFile = (name) => path.join(app.getPath('userData'), name);

async function readStore(name, fallback) {
  try {
    const raw = await fsp.readFile(storeFile(name), 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;   // no file or broken, start from empty
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

/** One settings field: read it and (optionally) write it. */
async function setting(key, value) {
  const cur = await readStore('settings.json', {});
  if (value === undefined) return cur[key];
  const next = Object.assign({}, cur, { [key]: value });
  await writeStore('settings.json', next);
  return next[key];
}

/**
 * A self-contained HTML file.
 *
 * By this point KaTeX has already rendered the formulas into HTML, but the
 * KaTeX CSS pulls its fonts through url(fonts/...). For the file to be truly
 * self-contained we put base64 fonts into @font-face — but only the ones that
 * actually occur on this page, or the file would swell by a couple of megabytes.
 */
async function buildStandaloneHtml(title, body, opts) {
  const o = opts || {};
  const katexDir = path.join(__dirname, 'src', 'vendor', 'katex');
  /*
   * The BOM must go.
   *
   * style.css starts with U+FEFF — in a file that is normal, the parser reads
   * the file and does not see the mark. In the standalone HTML that same CSS
   * lands in the middle of one <style>, and a mark in the middle is no longer
   * "start of file" but an invalid character: Chromium swallows the next block
   * whole.
   *
   * That is how :root was lost — that is, ALL the theme variables: --bg, --fg,
   * --border and the rest. The page came out with no colour at all: text and
   * background colours came from an undefined variable, that is, turned black
   * on transparent. Hence "the export does not keep all of the CSS".
   */
  const readCss = async (p) => (await fsp.readFile(p, 'utf8')).replace(/^\uFEFF/, '');
  const katexCss = await readCss(path.join(katexDir, 'katex.min.css'));
  let ourCss = await readCss(path.join(__dirname, 'src', 'style.css'));
  // Our own font lives in a separate file src/fonts.css and is not in style.css —
  // it was forgotten, and the export showed a system monospace instead of
  // JetBrains Mono. We attach and inline it alongside KaTeX.
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

  // The base is always added: if the class heuristic missed something, the
  // formula will not fall apart, it will simply take a fallback system font.
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
  // Unused @font-face blocks are removed entirely, otherwise broken
  // url(fonts/...) references stay in the file and it stops being self-contained.
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
 * The list of system fonts.
 *
 * The browser will not enumerate fonts for us: queryLocalFonts() does not work
 * in Electron, and font-family always falls through silently to the next entry
 * in the list. The only honest source is the Windows registry, where the value
 * name is built as "Family Style (TrueType)".
 *
 *   Consolas Bold Italic (TrueType)   -> Consolas
 *   Segoe UI Semibold (TrueType)      -> Segoe UI Semibold
 *
 * The second case is not parsed all the way (for Segoe UI Semibold the family is
 * "Segoe UI" and the weight is bold), but for a drop-down list that is more
 * honest than nothing: the person sees a familiar name and, if it did not
 * apply, sees the preview and picks another.
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
  // The style may be two words ("Bold Italic"); we strip one word at a time while
  // the tail still looks like a style.
  for (let n = 0; n < 3; n += 1) {
    const m = /^(.*\S)\s+([A-Za-z]+)$/.exec(name);
    if (!m) break;
    const tail = m[2].toLowerCase().replace(/[^a-z]/g, '');
    if (!FONT_STYLE_WORDS.has(tail)) break;
    name = m[1];
  }
  name = name.trim();
  // @-fonts in the registry are files, not families, and in a drop-down list they
  // are useless.
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
      // The key may not exist (for instance for a portable build in someone
      // else's profile) — that is not an error, just one empty source.
      continue;
    }
    for (const line of String(outp).split(/\r?\n/)) {
      // A line of reg query output: "    Name    REG_SZ    file.ttf".
      const m = /^\s{4}(.+?)\s{4}REG_\w+\s/.exec(line);
      if (!m) continue;
      put(fontFamilyFromRegistryName(m[1]));
    }
  }
  const coll = new Intl.Collator('ru', { sensitivity: 'base' });
  // Our own font first, the rest alphabetically: the drop-down starts with what
  // is needed most often.
  const all = [...out.values()];
  const own = all.filter((n) => n === 'JetBrainsMono');
  const rest = all.filter((n) => n !== 'JetBrainsMono').sort(coll.compare);
  return own.concat(rest).slice(0, 600);
}

/*
 * CSS from the choices in the export window: palette, font, size.
 *
 * The size is set on .content — everything inside is in em, so it scales exactly
 * what the zoom slider in the application scales, in the preview and in the
 * file alike.
 *
 * The font goes through --mono and --ui: both the code and the interface are
 * marked with them, and substituting the name into hundreds of rules is
 * pointless. The name is quoted and stripped of quotes and backslashes —
 * otherwise the value from the select would travel into the CSS as is.
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
 * The black and white palette.
 *
 * On screen and on paper. The rules are the same as in @media print, only
 * without !important on text colour where the ordinary cascade is enough: this
 * block goes last and overrides both @media print and the theme.
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
 * The colour palette on paper.
 *
 * @media print in style.css forcibly repaints the page white — on paper that
 * is correct, but the person chose "colour", and their choice has to win. So we
 * put the theme colours back, repeating the same selectors.
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
 * An addition to the standalone HTML for printing.
 *
 * It goes AFTER style.css, where @media print lives, and therefore overrides its
 * !important rules — otherwise the person's choices (palette, font, size) would
 * be overridden by the print values.
 *
 *   @page margin: 0 — printing without margins. The indent before the text is
 *   set by the .content padding: otherwise the text would lie at the very edge
 *   of the sheet.
 *   pre and blockquote without borders: @media print draws 1px solid #ccc
 *   around them — on paper that is a border around every code block, and on a
 *   colour background it looks like a layout bug.
 */
const PRINT_CSS = `
/* печать */
@page { size: A4; margin: 0; }
.content { padding: 16mm 18mm 18mm !important; }
.content pre, .content blockquote { border: none !important; }
`;

/**
 * PDF without the system print dialog.
 *
 * The dialog on Windows is itself the "bottom toolbar with captions": it has a
 * panel of buttons at the bottom and a footer with the file name and page
 * numbers, and that ended up in the result. printToPDF goes around the dialog
 * and returns a finished file; it has no footers at all.
 *
 * The page is printed in a hidden window from the same standalone HTML as the
 * export: one build for both formats, so the PDF and the HTML cannot drift
 * apart.
 */
async function buildPdf(title, body, opts) {
  const built = await buildStandaloneHtml(title, body, Object.assign({}, opts, { print: true }));
  const file = path.join(app.getPath('temp'), 'jazz-reader-print-' + process.pid + '.html');
  await fsp.writeFile(file, built.html, 'utf8');

  const w = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { sandbox: true, contextIsolation: true, javascript: false },
  });
  try {
    await w.loadFile(file);
    // The fonts are inlined into the CSS as base64, but Chromium gets around to
    // laying them out later than did-finish-load fires: printing without this
    // wait gives a sheet where half the text is set in the fallback font.
    // fonts.ready is the honest wait, and if the page does not provide it (old
    // Chromium) we simply wait a little.
    try { await w.webContents.executeJavaScript('document.fonts.ready.then(function(){return 1})'); }
    catch { await new Promise((r) => setTimeout(r, 600)); }
    const buf = await w.webContents.printToPDF({
      printBackground: true,
      // Footers: file name, date, page number. That is what the very bottom
      // toolbar draws, so we turn them off explicitly.
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
    try { await fsp.unlink(file); } catch { /* the temporary file may not have been created */ }
  }
}

/** The width is set by main after titleBarOverlay has been applied. */
let captionWidth = 140;

function register() {
  ipcMain.handle('mdv:read', async (_e, filePath) => {
    const st = await fsp.stat(filePath);
    if (st.isDirectory()) throw new Error(tr('ipc.notAFile'));
    if (!MD_EXT.test(filePath)) throw new Error(tr('ipc.mdOnly'));
    if (st.size > MAX_MD_BYTES) throw new Error(tr('ipc.tooBig'));
    const { text, encoding } = decodeBuffer(await fsp.readFile(filePath));
    return {
      path: filePath,
      name: path.basename(filePath),
      text,
      encoding,
      size: st.size,
      // file:// URL of the directory: needed so that relative images are found
      baseUrl: pathToFileURL(path.dirname(filePath) + path.sep).href,
      mtime: st.mtimeMs,
    };
  });

  ipcMain.handle('mdv:save', async (_e, { filePath, content }) => {
    if (!MD_EXT.test(filePath)) throw new Error(tr('ipc.mdOnly'));
    // Write atomically: first to a temporary file next to it, then rename.
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
      title: tr('ipc.openMdTitle'),
      properties: ['openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('mdv:dialogFolder', async () => {
    const r = await dialog.showOpenDialog(targetWindow(), {
      title: tr('ipc.openFolderTitle'),
      properties: ['openDirectory'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('mdv:reveal', (_e, p) => { shell.showItemInFolder(p); });

  /**
   * Deleting a note. It goes to the RECYCLE BIN, not unlink: deleting from the
   * tree context menu is an irreversible operation with one click, and
   * shell.trashItem gives "did not reach the recycle bin" as a safety net.
   * Returns {ok} or {ok:false, error} — the renderer shows the text.
   */
  ipcMain.handle('mdv:trash', async (_e, p) => {
    try {
      const st = await fsp.stat(p);
      if (!st.isFile()) return { ok: false, error: tr('ipc.notAFileShort') };
      await shell.trashItem(path.resolve(p));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * "New file" — ask for a name and create a note with a stub.
   * showSaveDialog, not openDialog: the person sets the name and the folder.
   */
  ipcMain.handle('mdv:newFile', async (_e, seedName) => {
    const r = await dialog.showSaveDialog(targetWindow(), {
      title: tr('ipc.newNoteTitle'),
      defaultPath: String(seedName || tr('name.newNote')) + '.md',
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
        tr('seed.description'),
        '',
        tr('seed.heading'),
        '',
        tr('seed.item'),
        '',
      ].join('\n');
      // Do not overwrite an existing file: showOverwriteConfirmation has already
      // asked, but protection against a race does no harm.
      if (!fs.existsSync(p)) await fsp.writeFile(p, text, 'utf8');
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /**
   * "New project" — a folder of notes: we create it and put a README.md in it,
   * so that the project is visible in the explorer straight away, not empty.
   */
  ipcMain.handle('mdv:newProject', async (_e, seedName) => {
    const r = await dialog.showOpenDialog(targetWindow(), {
      title: tr('ipc.newProjectFolder'),
      defaultPath: String(seedName || tr('name.newProject')),
      buttonLabel: tr('ipc.createProject'),
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
          tr('seed.projectReadme'),
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
    // Existing .md only: the file may have been deleted or renamed.
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

  // The defaults are duplicated in the renderer (applySettings): it knows what
  // each field means and applies them itself.
  ipcMain.handle('mdv:settingsGet', () => readStore('settings.json', {}));

  /*
   * Settings writes are put in a queue.
   *
   * Settings are written on every movement of a slider, that is, dozens of
   * times per second. Each write is a read, a merge and a write, and without a
   * queue those cycles overlapped: the file would be half rewritten, and the
   * next read would see broken JSON while readStore silently returned an empty
   * object. From the outside it looked like "the settings were not saved".
   */
  let settingsChain = Promise.resolve();
  ipcMain.handle('mdv:settingsSet', (_e, patch) => {
    settingsChain = settingsChain.then(async () => {
      const cur = await readStore('settings.json', {});
      const next = Object.assign({}, cur, patch || {});
      await writeStore('settings.json', next);
      return next;
    }).catch((e) => {
      // A failure in one write must not bring down the queue: otherwise every
      // later setting would silently stop being saved.
      console.error('settingsSet:', e && e.message);
      return null;
    });
    return settingsChain;
  });

  /*
   * Ctrl+N: a temporary note in os.tmpdir()/jazz-reader. The "Untitled-N.md"
   * names are tried until a free one is found: a note must not silently
   * overwrite an earlier one the person did not save.
   */
  ipcMain.handle('mdv:newTemp', async (_e, seedName) => {
    try {
      const dir = path.join(os.tmpdir(), 'jazz-reader');
      await fsp.mkdir(dir, { recursive: true });
      const base = String(seedName || tr('name.untitled'));
      let file = '';
      for (let n = 1; n < 1000; n++) {
        file = path.join(dir, base + (n === 1 ? '' : ' ' + n) + '.md');
        if (!fs.existsSync(file)) break;
      }
      if (fs.existsSync(file)) return { ok: false, error: tr('ipc.tooManyTemp') };
      await fsp.writeFile(file, '# ' + path.basename(file, '.md') + '\n\n', 'utf8');
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /*
   * Ctrl+Shift+N: a folder inside the already open one. The default name is
   * "New folder"; on a collision we add a number — silently reusing someone
   * else's name is not allowed.
   */
  ipcMain.handle('mdv:newFolder', async (_e, parent, seedName) => {
    try {
      if (!parent) return { ok: false, error: tr('ipc.noFolderOpen') };
      const st = await fsp.stat(parent).catch(() => null);
      if (!st || !st.isDirectory()) return { ok: false, error: tr('ipc.notAFolder') };
      const base = String(seedName || tr('name.newFolder'));
      let dir = '';
      for (let n = 1; n < 1000; n++) {
        dir = path.join(parent, base + (n === 1 ? '' : ' ' + n));
        if (!fs.existsSync(dir)) break;
      }
      if (fs.existsSync(dir)) return { ok: false, error: tr('ipc.tooManyFolders') };
      await fsp.mkdir(dir, { recursive: true });
      return { ok: true, path: dir, name: path.basename(dir) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /*
   * The width of the system caption buttons. The renderer asks for it once at
   * startup, to reserve room in the tab strip.
   * A push channel did not work: the message could leave before the renderer
   * subscribed, and the reserve would stay at the default.
   */
  ipcMain.handle('mdv:caption', () => captionWidth);

  ipcMain.handle('mdv:print', () => {
    const w = targetWindow();
    if (w) w.webContents.print({ silent: false, printBackground: true });
  });
  ipcMain.handle('mdv:exportHtml', (_e, { title, body, opts }) => buildStandaloneHtml(title, body, opts));
  ipcMain.handle('mdv:exportPdf', (_e, { title, body, opts }) => buildPdf(title, body, opts));
  /** System fonts for the drop-down in the export window. */
  ipcMain.handle('mdv:fonts', () => listSystemFonts());
}

module.exports = {
  register, listMdTree, decodeBuffer, buildStandaloneHtml, buildPdf,
  listSystemFonts, exportCss, setting,
  setCaptionWidth: (px) => { captionWidth = Math.max(0, Math.round(px || 0)); },
};