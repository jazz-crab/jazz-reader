// Готовит всё, чем приложение пользуется офлайн. Запускается в postinstall.
//
//  1. KaTeX  -> src/vendor/katex/   (формулы)
//  2. Lucide -> src/icons.js        (SVG-иконки, генерируется из пакета)
//  3. JetBrains Mono -> src/fonts/  (основной шрифт UI и кода)
//
// Раньше иконки были глифами Font Awesome (&#xf07b; и т.п.) из JetBrainsMono
// Nerd Font: глифы рисовались только если Nerd-шрифт грузился, а сам он весил
// 4 x ~1 МБ. Теперь это обычные SVG-иконки Lucide, а шрифт — regular
// JetBrains Mono (те же глифы + кириллица, но вчетверо легче суммарно).
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function rel(p) { return path.relative(process.cwd(), p); }

// ───────────────────────────────────────────────────────────── 1. KaTeX

(function vendorKatex() {
  const SRC = path.join(NM, 'katex', 'dist');
  const DST = path.join(ROOT, 'src', 'vendor', 'katex');
  if (!fs.existsSync(SRC)) {
    console.error('[vendor] KaTeX не найден в', SRC, '— выполни npm install');
    return;
  }
  fs.rmSync(DST, { recursive: true, force: true });
  copyDir(SRC, DST);
  // contrib/auto-render нам не нужен: формулы мы вырезаем в плейсхолдеры
  // сами и рендерим точечно (так надёжнее, чем post-hoc авторендер).
  fs.rmSync(path.join(DST, 'contrib'), { recursive: true, force: true });
  const ver = require(path.join(SRC, '..', 'package.json')).version;
  console.log('[vendor] KaTeX ' + ver + ' ->', rel(DST));
})();

// ────────────────────────────────────────────��──────────────── 2. Lucide

// Список иконок, которые реально использует интерфейс. Lucide приносит
// ~1600 файлов; в сборку берём только эти, инлайня в один маленький модуль.
const USED_ICONS = [
  'file-text', 'folder-open', 'folder', 'file', 'arrow-left', 'arrow-right',
  'arrow-up', 'pencil', 'save', 'zoom-in', 'zoom-out', 'folder-output',
  'x', 'copy', 'eye-off', 'printer', 'folder-search',
  'search', 'file-down', 'file-code', 'check', 'list-tree', 'menu', 'plus', 'chevron-left', 'chevron-right',
  // Чекбоксы task-list (- [x] / 1. [ ]): marked рендерит их нативными
  // <input type=checkbox>, они выглядели чужеродно в тёмной теме.
  'square-check-big', 'square',
];

(function vendorLucide() {
  const SRC = path.join(NM, 'lucide-static', 'icons');
  const DST = path.join(ROOT, 'src', 'icons.js');
  if (!fs.existsSync(SRC)) {
    console.error('[vendor] lucide-static не найден в', SRC, '— выполни npm install');
    return;
  }

  const bodies = {};
  const missing = [];
  for (const name of USED_ICONS) {
    const p = path.join(SRC, name + '.svg');
    if (!fs.existsSync(p)) { missing.push(name); continue; }
    let svg = fs.readFileSync(p, 'utf8');
    svg = svg.replace(/<!--[\s\S]*?-->/g, '').trim();
    const m = svg.match(/^<svg[^>]*?>([\s\S]*)<\/svg>$/);
    if (!m) { missing.push(name + ' (не распознан)'); continue; }
    bodies[name] = m[1].trim().replace(/\s+/g, ' ');
  }
  if (missing.length) {
    console.error('[vendor] lucide: не найдены иконки:', missing.join(', '));
    process.exitCode = 1;
    return;
  }

  const ver = require(path.join(NM, 'lucide-static', 'package.json')).version;
  const entries = Object.keys(bodies).sort()
    .map((n) => '    ' + JSON.stringify(n) + ': ' + JSON.stringify(bodies[n]) + ',')
    .join('\n');

  const out = `'use strict';
/*
 * SVG-иконки Lucide. Файл СГЕНЕРИРОВАН scripts/vendor.js из пакета
 * lucide-static — правь список USED_ICONS в vendor.js, а не этот файл.
 *
 * Инлайн, а не <use href="sprite.svg#...">: в index.html стоит жёсткий CSP
 * (default-src 'none'), и внешняя ссылка в <use> — это fetch, который его
 * не проходит. Инлайн гарантированно работает офлайн и без сети.
 *
 * Иконки шли глифами Font Awesome (&#xf07b;) из Nerd Font — они требовали
 * иконочного шрифта и молча пропадали, если шрифт не загрузился.
 *
 * lucide-static ${ver} (ISC).
 */
(function (global) {
  const ICONS = {
${entries}
  };

  const ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor"'
    + ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

  /** Разметка SVG для иконки. class добавляется к .ico-svg. */
  function icon(name, cls) {
    const body = ICONS[name];
    if (!body) return '';
    return '<svg class="ico-svg' + (cls ? ' ' + cls : '') + '" ' + ATTRS
      + ' aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  /** Заполняет все <span data-i="имя"> внутри root (по умолчанию весь документ). */
  function hydrate(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i]').forEach((el) => {
      el.innerHTML = icon(el.getAttribute('data-i'), el.getAttribute('data-i-cls') || '');
    });
  }

  global.MDV_ICONS = { ICONS, icon, hydrate };
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.MDV_ICONS;
`;

  fs.writeFileSync(DST, out, 'utf8');
  console.log('[vendor] Lucide ' + ver + ' -> ' + rel(DST) + ' (' + Object.keys(bodies).length + ' иконок)');
})();

// ─────────────────────────────────────────────────── 3. JetBrains Mono

// Только нужные сабсеты и начертания: кириллица (интерфейс русский) и
// латиница (код, идентификаторы). Начертания — 400/500/700 прямой и 400
// курсив. Nerd Font (4 x ~1 МБ) больше не нужен.
const FONT_SUBSETS = ['cyrillic', 'latin'];
const FONT_FACES = [
  { weight: 400, style: 'normal', file: 'jetbrains-mono-{s}-400-normal.woff2' },
  { weight: 500, style: 'normal', file: 'jetbrains-mono-{s}-500-normal.woff2' },
  { weight: 700, style: 'normal', file: 'jetbrains-mono-{s}-700-normal.woff2' },
  { weight: 400, style: 'italic', file: 'jetbrains-mono-{s}-400-italic.woff2' },
];

// Диапазоны unicode для @font-face. Без них браузер грузит cyrillic-файл
// даже для латинских букв, а latin-файл — для кириллицы.
const SUBSET_RANGES = {
  cyrillic: 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116',
  latin: 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA,'
    + ' U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191,'
    + ' U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
};

(function vendorFont() {
  const SRC = path.join(NM, '@fontsource', 'jetbrains-mono', 'files');
  const DST = path.join(ROOT, 'src', 'fonts');
  if (!fs.existsSync(SRC)) {
    console.error('[vendor] @fontsource/jetbrains-mono не найден в', SRC, '— выполни npm install');
    return;
  }
  fs.mkdirSync(DST, { recursive: true });

  let total = 0;
  for (const face of FONT_FACES) {
    for (const subset of FONT_SUBSETS) {
      const name = face.file.replace('{s}', subset);
      const from = path.join(SRC, name);
      if (!fs.existsSync(from)) { console.error('[vendor] нет файла шрифта', name); continue; }
      const to = path.join(DST, name);
      fs.copyFileSync(from, to);
      total += fs.statSync(to).size;
    }
  }

  // Nerd Font больше не используется: иконки теперь SVG.
  for (const f of fs.readdirSync(DST)) {
    if (/NerdFont/i.test(f)) {
      fs.unlinkSync(path.join(DST, f));
      console.log('[vendor] удалён устаревший файл', f);
    }
  }

  // Генерируем @font-face-блоки, чтобы CSS не расходился с реально
  // скопированными файлами.
  const blocks = [];
  for (const face of FONT_FACES) {
    for (const subset of FONT_SUBSETS) {
      const file = face.file.replace('{s}', subset);
      if (!fs.existsSync(path.join(DST, file))) continue;
      blocks.push(
        '@font-face {\n'
        + '    font-family: "JetBrainsMono";\n'
        + `    src: url("fonts/${file}") format("woff2");\n`
        + `    font-weight: ${face.weight};\n`
        + `    font-style: ${face.style};\n`
        + `    font-display: swap;\n`
        + `    unicode-range: ${SUBSET_RANGES[subset]};\n`
        + '}'
      );
    }
  }
  fs.writeFileSync(path.join(ROOT, 'src', 'fonts.css'), blocks.join('\n') + '\n', 'utf8');

  console.log('[vendor] JetBrains Mono -> ' + rel(DST)
    + ' (' + (total / 1024).toFixed(0) + ' КБ woff2, ' + blocks.length + ' @font-face)');
})();
