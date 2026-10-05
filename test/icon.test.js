'use strict';
/*
 * Checking the icon build/icon/icon.{svg,png,ico} pixel by pixel.
 * Our own PNG parsing on top of zlib — so that the test pulls in only the standard
 * library, without python/Pillow.
 *   node test/icon.test.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DIR = path.join(__dirname, '..', 'build', 'icon');
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SMALL = [16, 20, 24];
const TOKYO = { plate: 0x16161e, blue: 0x7aa2f7, cyan: 0x7dcfff, border: 0x3b4261 };

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

// ---------- PNG: 8-bit RGBA only, no interlacing (exactly what rsvg produces) ----------
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('не PNG');
  let pos = 8, ihdr = null, idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9], inter: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!ihdr) throw new Error('нет IHDR');
  if (ihdr.depth !== 8 || ihdr.color !== 6 || ihdr.inter !== 0) {
    throw new Error('ожидался 8-bit RGBA без чередования, а пришло depth=%d color=%d interlace=%d',
      ihdr.depth, ihdr.color, ihdr.inter);
  }
  const { w, h } = ihdr, bpp = 4, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < h * (stride + 1)) throw new Error('short IDAT');
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride); rp += stride;
    const cur = out.slice(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) throw new Error('неизвестный фильтр ' + filter);
      cur[x] = v & 0xff;
    }
  }
  return { w, h, data: out };
}

const px = (img, x, y) => {
  const i = (y * img.w + x) * 4;
  return { r: img.data[i], g: img.data[i + 1], b: img.data[i + 2], a: img.data[i + 3] };
};
const hex = c => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
// The letters are the only noticeably blue and light thing in the frame; the tile is dark
// (#16161e, b-r=12), the outline grey (#3b4261, b-r=38). The threshold is by
// chromaticity, not by absolute channels: at 16..20px after anti-aliasing there are
// almost no pixels at 100% of the letter colour, and a strict detector would lose
// half of the capitals.
const isInk = p => p.a > 128 && (p.b - p.r) > 60 && p.r > 40;
// For picking the colour: a pixel where the letter lies almost entirely, without anti-aliasing.
const isInkSolid = p => p.a > 200 && p.b > 200 && p.r < 200;

function inkBox(img) {
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (!isInk(px(img, x, y))) continue;
    n++; if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (!n) return null;
  const cols = new Set();
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (isInk(px(img, x, y))) cols.add(x);
  const list = [...cols].sort((a, b) => a - b);
  const gaps = [];
  for (let i = 0; i + 1 < list.length; i++) if (list[i + 1] - list[i] > 1) gaps.push([list[i], list[i + 1]]);
  return { x0, y0, x1, y1, n, cols: list, gaps };
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---------- PNG layers ----------
console.log('\n== PNG-слои ==');
const png = {};
let missing = [];
for (const s of SIZES.concat([512])) {
  const f = path.join(DIR, 'icon-' + s + '.png');
  if (!fs.existsSync(f)) { missing.push(s); continue; }
  png[s] = { buf: fs.readFileSync(f), img: decodePng(fs.readFileSync(f)) };
}
t('все слои на месте' + (missing.length ? ' (нет ' + missing + ')' : ''), missing.length === 0);
for (const s of SIZES.concat([512])) {
  if (!png[s]) continue;
  t('icon-' + s + '.png квадратный ' + s + 'x' + s, png[s].img.w === s && png[s].img.h === s,
    'а пришло ' + png[s].img.w + 'x' + png[s].img.h);
}
t('icon.png == icon-512.png',
  fs.existsSync(path.join(DIR, 'icon.png')) &&
  fs.readFileSync(path.join(DIR, 'icon.png')).equals(fs.readFileSync(path.join(DIR, 'icon-512.png'))));

// ---------- ICO ----------
console.log('\n== ICO ==');
const icoPath = path.join(DIR, 'icon.ico');
t('icon.ico существует', fs.existsSync(icoPath));
if (fs.existsSync(icoPath)) {
  const ico = fs.readFileSync(icoPath);
  const reserved = ico.readUInt16LE(0), type = ico.readUInt16LE(2), count = ico.readUInt16LE(4);
  t('заголовок ICONDIR (reserved=0, type=1)', reserved === 0 && type === 1, reserved + '/' + type);
  t('слоёв: ' + SIZES.length + ' (' + SIZES.join(', ') + ')', count === SIZES.length, 'пришло ' + count);

  const seen = [];
  let structOk = true, rangeOk = true, payloadOk = true, dimOk = true, sameAsPng = true;
  const notes = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = ico[o], h = ico[o + 1], colors = ico[o + 2], res = ico[o + 3];
    const planes = ico.readUInt16LE(o + 4), bits = ico.readUInt16LE(o + 6);
    const bytes = ico.readUInt32LE(o + 8), off = ico.readUInt32LE(o + 12);
    seen.push(w === 0 ? 256 : w);
    if (!(colors === 0 && res === 0 && planes === 1 && bits === 32)) structOk = false;
    if (off + bytes > ico.length) { rangeOk = false; notes.push('слой ' + i + ' вылезает за файл'); }
    const data = ico.slice(off, off + bytes);
    if (data.readUInt32BE(0) !== 0x89504e47) { payloadOk = false; notes.push('слой ' + i + ' не PNG'); continue; }
    let img;
    try { img = decodePng(data); } catch (e) { payloadOk = false; notes.push('слой ' + i + ': ' + e.message); continue; }
    const size = w === 0 ? 256 : w;
    if (img.w !== size || img.h !== size) { dimOk = false; notes.push('слой ' + i + ' = ' + img.w + 'x' + img.h); }
    if (png[size] && !data.equals(png[size].buf)) { sameAsPng = false; notes.push('слой ' + size + ' отличается от icon-' + size + '.png'); }
  }
  t('размеры слоёв идут по возрастанию и совпадают с набором', seen.join(',') === SIZES.join(','), seen.join(','));
  t('поля каталога ICO корректны (0/0, planes=1, 32 bpp)', structOk);
  t('смещения в пределах файла, файл не обрезан', rangeOk, notes.join('\n       '));
  t('внутри ICO лежат PNG (Vista+) и все декодируются', payloadOk, notes.join('\n       '));
  t('размер пикселей в слое = размер в каталоге (0 => 256)', dimOk, notes.join('\n       '));
  t('слои ICO побайтово равны icon-<n>.png', sameAsPng, notes.join('\n       '));
  // electron-builder/app-builder requires a layer of 256+, otherwise the exe keeps the default icon.
  t('есть слой 256x256 (иначе electron-builder не встроит иконку)', seen.includes(256));
  t('ICO заметно больше дефолтной иконки Electron', ico.length > 5000, ico.length + ' байт');
}

// ---------- Geometry ----------
console.log('\n== геометрия ==');
if (png[256]) {
  const img = png[256].img, box = inkBox(img);
  t('буквы найдены', !!box);
  if (box) {
    const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
    t('ширина «JR» ~137px (' + w + ')', near(w, 137, 4));
    t('высота «JR» ~89px (' + h + ')', near(h, 89, 4));
    t('центр букв в центре плитки', near((box.x0 + box.x1) / 2, 127.5, 2) && near((box.y0 + box.y1) / 2, 127.5, 2),
      'центр=' + ((box.x0 + box.x1) / 2) + ',' + ((box.y0 + box.y1) / 2));
    t('поля слева/справа симметричны', Math.abs(box.x0 - (255 - box.x1)) <= 2,
      'лево ' + box.x0 + ', справа ' + (255 - box.x1));
    t('поля сверху/снизу симметричны', Math.abs(box.y0 - (255 - box.y1)) <= 2,
      'верх ' + box.y0 + ', низ ' + (255 - box.y1));
    t('ровно два глифа, один зазор между ними (' + box.gaps.length + ')', box.gaps.length === 1,
      'зазоры: ' + JSON.stringify(box.gaps));
  }
  t('углы прозрачные — плитка скруглённая',
    [px(img, 0, 0).a, px(img, 255, 0).a, px(img, 0, 255).a, px(img, 255, 255).a].every(a => a < 8));
  t('центр непрозрачный', px(img, 128, 128).a === 255, 'alpha=' + px(img, 128, 128).a);
  let transparent = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (px(img, x, y).a < 8) transparent++;
  t('прозрачного поля 2..20% (скруглённые углы, не обрезанный квадрат) (' + (transparent / 65536 * 100).toFixed(1) + '%)',
    transparent / 65536 > 0.02 && transparent / 65536 < 0.2, transparent + ' px');

  // The TokyoNight palette
  const counts = new Map();
  for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
    const c = px(img, x, y);
    if (c.a < 250) continue;
    const k = (c.r << 16) | (c.g << 8) | c.b;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const has = (rgb, tol) => top.some(([k]) => Math.abs((k >> 16) - (rgb >> 16)) <= tol &&
    Math.abs(((k >> 8) & 255) - ((rgb >> 8) & 255)) <= tol && Math.abs((k & 255) - (rgb & 255)) <= tol);
  t('плашка цвета TokyoNight bg (#16161e)', has(TOKYO.plate, 14), top.slice(0, 4).map(([k, n]) => '#' + k.toString(16).padStart(6, '0') + ':' + n).join(' '));
  t('обводка #3b4261 присутствует', has(TOKYO.border, 10));
  t('буквы — blue #7aa2f7', has(TOKYO.blue, 6));

  if (box) {
    // A horizontal gradient: blue on the left, cyan on the right. We take the median
    // colour over the dense pixels of the outer 10% of the ink — at the very edge
    // the colour is already mixed with the tile, and in the middle the second
    // gradient stop has not begun yet.
    const band = (from, to) => {
      const list = [];
      for (let y = box.y0; y <= box.y1; y++) for (let x = from; x <= to; x++) {
        if (isInkSolid(px(img, x, y))) list.push(px(img, x, y));
      }
      if (!list.length) return null;
      const mid = v => { const s = [...v].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
      return { r: mid(list.map(c => c.r)), g: mid(list.map(c => c.g)), b: mid(list.map(c => c.b)) };
    };
    const L = band(box.x0, box.x0 + Math.round((box.x1 - box.x0) * 0.1));
    const R = band(box.x1 - Math.round((box.x1 - box.x0) * 0.1), box.x1);
    t('левый край букв #7aa2f7', !!L && near(L.r, TOKYO.blue >> 16, 10) && near(L.b, TOKYO.blue & 255, 10), L && hex(L));
    t('правый край букв #7dcfff', !!R && near(R.r, TOKYO.cyan >> 16, 10) && near(R.b, TOKYO.cyan & 255, 10), R && hex(R));
  }
}

// ---------- Small layers ----------
console.log('\n== малые слои ==');
const fracOf = i => { const b = inkBox(i); return b ? (b.x1 - b.x0 + 1) / i.w : 0; };
for (const s of SMALL) {
  if (!png[s]) continue;
  const box = inkBox(png[s].img);
  if (!box) { t(s + 'px: буквы найдены', false); continue; }
  const w = box.x1 - box.x0 + 1, h = box.y1 - box.y0 + 1;
  t(s + 'px: буквы не выходят за холст', box.x0 >= 0 && box.y0 >= 0 && box.x1 < s && box.y1 < s);
  t(s + 'px: капитель не мельче 29% холста (' + h + 'px)', h / s >= 0.29, 'w=' + w + ' h=' + h);
  t(s + 'px: «JR» не шире 80% холста (' + w + 'px)', w / s <= 0.8);
}
// Layers <=24px are drawn with an increased font size (SMALL_SCALE in
// make-icons.sh), otherwise at 16px the capitals degenerate into 4 pixels and
// cannot be read. We compare the average share of ink: averaging takes away the
// rounding noise at small sizes.
const have = s => png[s] && fracOf(png[s].img);
if (SMALL.every(have) && [32, 40, 48, 64, 128, 256].every(have)) {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const small = mean(SMALL.map(have)), base = mean([32, 40, 48, 64, 128, 256].map(have));
  const ratio = small / base;
  t('слои <=24px увеличены относительно базовых (x' + ratio.toFixed(2) + ', ждём ~1.2)',
    ratio > 1.1 && ratio < 1.32, 'small=' + small.toFixed(3) + ' base=' + base.toFixed(3));
}

// ---------- The source ----------
console.log('\n== исходник ==');
const svgPath = path.join(DIR, 'icon.svg');
t('icon.svg есть', fs.existsSync(svgPath));
if (fs.existsSync(svgPath)) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  t('рисует ровно один <text> с содержимым JR', (svg.match(/<text\b/g) || []).length === 1 && />\s*JR\s*</.test(svg));
  t('цвета TokyoNight на месте',
    ['#1f2333', '#16161e', '#7aa2f7', '#7dcfff', '#3b4261'].every(c => svg.toLowerCase().includes(c)));
  t('есть запасной моноширинный шрифт (иначе на машине без JetBrains Mono будет мыло)',
    /font-family="[^"]*(sans-serif|monospace)/.test(svg));
  t('внешние ресурсы не тянутся (без <image>/http)',
    !/<image\b|https?:\/\/(?!www\.w3\.org)/.test(svg));
}
// The execute bit only makes sense on POSIX; in git on Windows the file
// comes as 0644, and there is nothing to check.
// The icon generator: make-icons.js is the primary one (it works wherever there
// is node and electron). make-icons.sh stays as the path for machines with Lato
// and rsvg-convert: there the letters land slightly differently, and the metrics
// in icon.svg will have to be nudged.
// The execute bit of the .sh is checked only on POSIX — in git on Windows the
// file comes as 0644, and there is nothing to check.
t('make-icons.js есть (генератор по умолчанию)', fs.existsSync(path.join(DIR, 'make-icons.js')));
const iconsScript = path.join(DIR, 'make-icons.sh');
t('make-icons.sh есть' + (process.platform === 'win32' ? ' (режим exec на Windows не проверяем)' : ' и исполняемый'),
  fs.existsSync(iconsScript)
  && (process.platform === 'win32' || !!(fs.statSync(iconsScript).mode & 0o111)));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);