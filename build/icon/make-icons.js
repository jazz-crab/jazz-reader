'use strict';
/*
 * The application icon: icon.svg -> icon-<n>.png (16..512) + icon.png + icon.ico.
 *
 * Replaces make-icons.sh: that one required rsvg-convert and python3, that is,
 * it only worked on POSIX. Here Electron itself (Chromium) does the same thing —
 * it rasterises the SVG in a window, and Pillow shrinks it with anti-aliasing. It
 * works on Windows.
 *
 *   npm run icons        (node build/icon/make-icons.js)
 *
 * Why with anti-aliasing rather than "a window exactly the size in pixels": Windows
 * has a minimum window size, and a 16 px window may not even be created. We draw
 * 4 times larger and shrink — the quality at small sizes is higher than with rsvg
 * without hinting.
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

/*
 * The font of the letters is JetBrains Mono, as everywhere in the application. On
 * Windows it is usually not installed system-wide, so the font-family from
 * icon.svg would not work: Chromium would substitute a fallback monospace font and
 * the letters would come out different. So the generator supplies an @font-face
 * with a woff2 from the project itself.
 *
 * A data: URI rather than a path to a file: from a page opened over file://,
 * Chromium does not load fonts from disk (file:// has an opaque origin), and it
 * will quietly hand back a fallback font instead of ours.
 *
 * ExtraBold (800) is the heaviest weight of JetBrains Mono. It is not put into the
 * vendored src/fonts (there are 400/500/700 — for the interface only), so we take
 * it from @fontsource in devDependencies, and if it is missing — 700.
 */
const FONT_WEIGHT = 800;
const ROOT = path.join(DIR, '..', '..');

function fontFile(weight) {
  const cands = [
    path.join(ROOT, 'src', 'fonts', `jetbrains-mono-latin-${weight}-normal.woff2`),
    path.join(ROOT, 'node_modules', '@fontsource', 'jetbrains-mono', 'files',
      `jetbrains-mono-latin-${weight}-normal.woff2`),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

const fontPath = fontFile(FONT_WEIGHT) || fontFile(700);
if (!fontPath) {
  throw new Error('не найден woff2 JetBrains Mono: поставь npm ci или положи файл в src/fonts/');
}
const FONT_WEIGHT_USED = fontPath.includes(`-${FONT_WEIGHT}-`) ? FONT_WEIGHT : 700;
const fontData = fs.readFileSync(fontPath).toString('base64');

const FONT_FACE = `@font-face{font-family:'JetBrains Mono';` +
  `font-weight:${FONT_WEIGHT_USED};font-style:normal;font-display:block;` +
  `src:url(data:font/woff2;base64,${fontData}) format('woff2')}`;

// Small sizes: the letters are 20% larger, otherwise at 16 px "JR" turns to mush.
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
  console.log(`шрифт: JetBrains Mono ${FONT_WEIGHT_USED} (${path.basename(fontPath)})`);

  // One window for all sizes and no recreating: after destroy, a second offscreen
  // window makes Chromium fail stably with ERR_FAILED. We simply resize the window.
const win = new BrowserWindow({
  width: SIZES[SIZES.length - 1] * SS, height: SIZES[SIZES.length - 1] * SS,
  useContentSize: true, show: false, frame: false,
  transparent: true, backgroundColor: '#00000000',
  webPreferences: { offscreen: true, backgroundThrottling: false },
});

for (const s of all) {
    const px = s * SS;
    const html = `<!doctype html><meta charset="utf-8">
      <style>${FONT_FACE}
      html,body{margin:0;padding:0;background:transparent;overflow:hidden}
      svg{display:block;width:${px}px;height:${px}px}</style>${scaled(s)}`;

    // A file rather than a data: URL — Chromium periodically drops a long data: URL
    // with ERR_FAILED, and we do not want to fall over because of that.
    const page = path.join(TMP, `render-${s}.html`);
    fs.writeFileSync(page, html, 'utf8');

    win.setContentSize(px, px);
    await win.loadFile(page);
    // Without this the frame may leave before the font has loaded — and the letters
    // will be in the fallback.
    await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(TMP, s + '.png'), img.toPNG());
    process.stdout.write(`  ${s}px  ok\n`);
  }
win.destroy();

  // We shrink with anti-aliasing (Pillow) and assemble the ICO from the finished PNGs.
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