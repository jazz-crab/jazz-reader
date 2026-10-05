'use strict';
/*
 * Иконка приложения: icon.svg -> icon-<n>.png (16..512) + icon.png + icon.ico.
 *
 * Заменяет make-icons.sh: тот требовал rsvg-convert и python3, то есть
 * умел только на POSIX. Здесь то же самое делает сам Electron (Chromium) —
 * растеризует SVG в окне, а Pillow ужимает со сглаживанием. Работает на Windows.
 *
 *   npm run icons        (node build/icon/make-icons.js)
 *
 * Почему со сглаживанием, а не «окно размером ровно в пиксель»: у Windows есть
 * минимальный размер окна, окно в 16 px может не создаться. Рисуем в 4 раза
 * больше и ужимаем — качество на мелких размерах выше, чем у rsvg без хинтинга.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DIR = __dirname;
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const SMALL_SIZES = [16, 20, 24];
const SMALL_SCALE = 1.2;
const SS = 4; // supersampling
const TMP = path.join(require('os').tmpdir(), 'jazz-reader-icons-' + process.pid);

const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');

// Мелкие размеры: буквы крупнее на 20%, иначе на 16 px «JR» превращается в кашу.
function scaled(s) {
  if (!SMALL_SIZES.includes(s)) return svg;
  const t = `transform="translate(128 128) scale(${SMALL_SCALE}) translate(-128 -128)"`;
  const out = svg.replace(/<text\b/, '<text ' + t);
  if (out === svg) throw new Error('в icon.svg нет <text>');
  return out;
}

const py = (code, args) =>
  execFileSync('python', ['-c', code, ...args], { encoding: 'utf8' }).trim();

fs.mkdirSync(TMP, { recursive: true });

const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const all = [...SIZES, 512];

  // Одно окно на все размеры и пересоздание: после destroy второе offscreen-окно
// Chromium стабильно падает с ERR_FAILED. Окно просто переставляем размером.
const win = new BrowserWindow({
  width: SIZES[SIZES.length - 1] * SS, height: SIZES[SIZES.length - 1] * SS,
  useContentSize: true, show: false, frame: false,
  transparent: true, backgroundColor: '#00000000',
  webPreferences: { offscreen: true, backgroundThrottling: false },
});

for (const s of all) {
    const px = s * SS;
    const html = `<!doctype html><meta charset="utf-8">
      <style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${px}px;height:${px}px}</style>${scaled(s)}`;

    // Файл, а не data: URL — длинный data: URL Chromium периодически роняет
    // с ERR_FAILED, и падать из-за этого не хочется.
    const page = path.join(TMP, `render-${s}.html`);
    fs.writeFileSync(page, html, 'utf8');

    win.setContentSize(px, px);
    await win.loadFile(page);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(TMP, s + '.png'), img.toPNG());
    process.stdout.write(`  ${s}px  ok\n`);
  }
win.destroy();

  // Ужимаем со сглаживанием (Pillow) и собираем ICO из уже готовых PNG.
  py(`
import os, struct, sys
from PIL import Image
tmp, d, sizes, ss = sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3].split()], int(sys.argv[4])
blobs, entries = [], []
for s in sizes:
    im = Image.open(os.path.join(tmp, '%d.png' % s)).convert('RGBA')
    im = im.resize((s, s), Image.LANCZOS)
    p = os.path.join(d, 'icon-%d.png' % s)
    im.save(p)
    data = open(p, 'rb').read()
    if data[:8] != b'\\x89PNG\\r\\n\\x1a\\n':
        raise SystemExit('не png: %d' % s)
    entries.append(struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(data), 0))
    blobs.append(data)
off = 6 + 16 * len(entries)
out = [struct.pack('<HHH', 0, 1, len(entries))]
for e, b in zip(entries, blobs):
    out.append(e[:12] + struct.pack('<I', off))
    off += len(b)
out.extend(blobs)
open(os.path.join(d, 'icon.ico'), 'wb').write(b''.join(out))
print('icon.ico: %d layers, %d bytes' % (len(entries), os.path.getsize(os.path.join(d, 'icon.ico'))))
`, [TMP, DIR, SIZES.join(' '), String(SS)]);

  fs.copyFileSync(path.join(DIR, 'icon-512.png'), path.join(DIR, 'icon.png'));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('готово:', fs.readdirSync(DIR).filter(f => /^icon/.test(f)).sort().join(', '));
  app.exit(0);
});