'use strict';
/*
 * Icons and font.
 *
 * The icons used to be Font Awesome glyphs (&#xf07b; and the like) from
 * JetBrainsMono Nerd Font. That worked only while the icon font was loading, and
 * the font itself took 4 x ~1 MB. Now they are inline SVG from Lucide, which
 * scripts/vendor.js generates into src/icons.js.
 *
 * The test catches a return to glyphs, a lost icon and a return of the Nerd Font.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

const read = (p) => fs.readFileSync(p, 'utf8');
const html = read(path.join(SRC, 'index.html'));
const app = read(path.join(SRC, 'app.js'));
const css = read(path.join(SRC, 'style.css'));

// Comments mention the old glyphs deliberately ("it used to be &#xf07b;"),
// so they are cut out before the check.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

console.log('== иконки ==');

// 1. There must be no Font Awesome glyphs in the code.
const GLYPH = /&#x[0-9a-fA-F]{3,4};|\\uf[0-9a-fA-F]{3}/;
for (const [name, src] of [['index.html', html], ['app.js', app], ['style.css', css]]) {
  const bad = stripComments(src).match(new RegExp(GLYPH.source, 'g'));
  t('нет глифов Font Awesome в ' + name, !bad, bad ? bad.join(' ') : '');
}

// 2. The icon module is generated and in place.
const iconsPath = path.join(SRC, 'icons.js');
t('src/icons.js существует', fs.existsSync(iconsPath));
if (fs.existsSync(iconsPath)) {
  const icons = read(iconsPath);
  t('icons.js отдаёт MDV_ICONS', /global\.MDV_ICONS/.test(icons));

  // 3. Every data-i from index.html must be in ICONS.
  const used = new Set();
  for (const m of html.matchAll(/data-i="([a-z0-9-]+)"/g)) used.add(m[1]);
  t('в index.html есть иконки через data-i', used.size > 0, 'найдено ' + used.size);
  for (const name of used) {
    t('иконка «' + name + '» есть в icons.js', icons.includes(JSON.stringify(name) + ':'));
  }

  // 4. Every ICONS.icon('...') from app.js must exist.
  //    On top of that we catch `icon: '...'` in the menu item descriptions: export
  //    from the ring is assembled by code, and its icons do not go through
  //    data-i in the markup. Without this line they would fall out of the check
  //    entirely.
  const inJs = new Set();
  for (const m of app.matchAll(/ICONS\.icon\('([a-z0-9-]+)'/g)) inJs.add(m[1]);
  for (const m of app.matchAll(/\bicon: '([a-z0-9-]+)'/g)) inJs.add(m[1]);
  t('app.js рисует иконки через ICONS.icon', inJs.size > 0, 'найдено ' + inJs.size);
  for (const name of ['file-down', 'file-code', 'printer', 'folder-search', 'file-text', 'folder-open']) {
    t('иконка пункта меню «' + name + '» есть в icons.js', inJs.has(name) && icons.includes(JSON.stringify(name) + ':'));
  }
  for (const name of inJs) {
    t('иконка «' + name + '» (app.js) есть в icons.js', icons.includes(JSON.stringify(name) + ':'));
  }

  // 5. The icons must be SVG, not text.
  t('icons.js рисует <svg>', icons.includes("'<svg class=\"ico-svg\"'") || icons.includes('<svg class="ico-svg'));
}

// 6. No Nerd Font in the build.
const fontDir = path.join(SRC, 'fonts');
const fontFiles = fs.existsSync(fontDir) ? fs.readdirSync(fontDir) : [];
t('Nerd Font выкинут из src/fonts', !fontFiles.some((f) => /NerdFont/i.test(f)),
  fontFiles.join(', '));
t('в src/fonts есть обычный JetBrains Mono',
  fontFiles.some((f) => /^jetbrains-mono-(latin|cyrillic)-\d+-(normal|italic)\.woff2$/.test(f)),
  fontFiles.join(', '));

// 7. fonts.css is attached and covers Cyrillic (the interface is Russian).
t('index.html подключает fonts.css', /href="fonts\.css"/.test(html));
const fontsCssPath = path.join(SRC, 'fonts.css');
t('src/fonts.css существует', fs.existsSync(fontsCssPath));
if (fs.existsSync(fontsCssPath)) {
  const fc = read(fontsCssPath);
  t('fonts.css объявляет JetBrainsMono', /font-family:\s*"JetBrainsMono"/.test(fc));
  t('в fonts.css есть кириллический сабсет', /cyrillic-\d+-/.test(fc));
  t('в fonts.css есть латинский сабсет', /latin-\d+-/.test(fc));
  // Every mentioned file must exist on the disk.
  const refs = [...fc.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]);
  t('fonts.css ссылается на файлы', refs.length > 0, 'ссылок: ' + refs.length);
  for (const f of refs) {
    t('файл шрифта ' + f + ' на месте', fs.existsSync(path.join(SRC, 'fonts', f)));
  }
}

// 8. The UI font is JetBrains Mono (not Segoe UI).
t('в CSS задан --ui: JetBrainsMono', /--ui:\s*"JetBrainsMono"/.test(css));
t('в CSS больше нет Segoe UI в --ui', !/--ui:[^;]*Segoe UI/.test(css));
t('CSS ссылается на --mono, а не на удалённый --nf', !/var\(--nf\)/.test(css));

// 9. margin-block / margin-inline accept 1-2 values. A three-value form is
//    silently dropped with the whole declaration — the vertical spacing of the
//    headings was already lost that way (margin: 1.5em 0 .55em ->
for (const prop of ['margin-block', 'margin-inline', 'padding-block', 'padding-inline']) {
  const bad = [];
  for (const m of css.matchAll(new RegExp(prop + ':\\s*([^;{}]+);', 'g'))) {
    const n = m[1].trim().split(/\s+/).length;
    if (n > 2) bad.push(prop + ': ' + m[1].trim());
  }
  t('нет невалидных ' + prop + ' (больше 2 значений)', bad.length === 0, bad.join('; '));
}

// 10. The universal reset * { margin: 0 } zeroes everything — so every block
//     element of the column must have its own vertical rule.
t('сброс * { margin: 0 } на месте (ожидаем)', /\*\s*\{[^}]*margin:\s*0/.test(css));
t('у заголовков есть вертикальный margin-block',
  /\.content h1[^{]*\{[^}]*margin-block:/.test(css) || /\.content h1,\s*\.content h2/.test(css));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);