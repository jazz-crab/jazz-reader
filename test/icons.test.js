'use strict';
/*
 * Иконки и шрифт.
 *
 * Иконки раньше были глифами Font Awesome (&#xf07b; и подобные) из
 * JetBrainsMono Nerd Font. Это работало только пока грузился иконочный шрифт,
 * а сам он занимал 4 x ~1 МБ. Сейчас это инлайновый SVG из Lucide, который
 * генерирует scripts/vendor.js в src/icons.js.
 *
 * Тест ловит возврат к глифам, потерянную иконку и возврат Nerd Font.
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

// Комментарии упоминают старые глифы намеренно («раньше было &#xf07b;»),
// поэтому вырезаем их перед проверкой.
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

console.log('== иконки ==');

// 1. Глифов Font Awesome в коде быть не должно.
const GLYPH = /&#x[0-9a-fA-F]{3,4};|\\uf[0-9a-fA-F]{3}/;
for (const [name, src] of [['index.html', html], ['app.js', app], ['style.css', css]]) {
  const bad = stripComments(src).match(new RegExp(GLYPH.source, 'g'));
  t('нет глифов Font Awesome в ' + name, !bad, bad ? bad.join(' ') : '');
}

// 2. Модуль иконок сгенерирован и на месте.
const iconsPath = path.join(SRC, 'icons.js');
t('src/icons.js существует', fs.existsSync(iconsPath));
if (fs.existsSync(iconsPath)) {
  const icons = read(iconsPath);
  t('icons.js отдаёт MDV_ICONS', /global\.MDV_ICONS/.test(icons));

  // 3. Каждая data-i из index.html должна быть в ICONS.
  const used = new Set();
  for (const m of html.matchAll(/data-i="([a-z0-9-]+)"/g)) used.add(m[1]);
  t('в index.html есть иконки через data-i', used.size > 0, 'найдено ' + used.size);
  for (const name of used) {
    t('иконка «' + name + '» есть в icons.js', icons.includes(JSON.stringify(name) + ':'));
  }

  // 4. Каждый ICONS.icon('...') из app.js должен существовать.
  const inJs = new Set();
  for (const m of app.matchAll(/ICONS\.icon\('([a-z0-9-]+)'/g)) inJs.add(m[1]);
  t('app.js рисует иконки через ICONS.icon', inJs.size > 0, 'найдено ' + inJs.size);
  for (const name of inJs) {
    t('иконка «' + name + '» (app.js) есть в icons.js', icons.includes(JSON.stringify(name) + ':'));
  }

  // 5. Иконки обязаны быть SVG, а не текстом.
  t('icons.js рисует <svg>', icons.includes("'<svg class=\"ico-svg\"'") || icons.includes('<svg class="ico-svg'));
}

// 6. Никаких Nerd Font в сборке.
const fontDir = path.join(SRC, 'fonts');
const fontFiles = fs.existsSync(fontDir) ? fs.readdirSync(fontDir) : [];
t('Nerd Font выкинут из src/fonts', !fontFiles.some((f) => /NerdFont/i.test(f)),
  fontFiles.join(', '));
t('в src/fonts есть обычный JetBrains Mono',
  fontFiles.some((f) => /^jetbrains-mono-(latin|cyrillic)-\d+-(normal|italic)\.woff2$/.test(f)),
  fontFiles.join(', '));

// 7. fonts.css подключён и покрывает кириллицу (интерфейс русский).
t('index.html подключает fonts.css', /href="fonts\.css"/.test(html));
const fontsCssPath = path.join(SRC, 'fonts.css');
t('src/fonts.css существует', fs.existsSync(fontsCssPath));
if (fs.existsSync(fontsCssPath)) {
  const fc = read(fontsCssPath);
  t('fonts.css объявляет JetBrainsMono', /font-family:\s*"JetBrainsMono"/.test(fc));
  t('в fonts.css есть кириллический сабсет', /cyrillic-\d+-/.test(fc));
  t('в fonts.css есть латинский сабсет', /latin-\d+-/.test(fc));
  // Каждый упомянутый файл должен существовать на диске.
  const refs = [...fc.matchAll(/url\("fonts\/([^"]+)"\)/g)].map((m) => m[1]);
  t('fonts.css ссылается на файлы', refs.length > 0, 'ссылок: ' + refs.length);
  for (const f of refs) {
    t('файл шрифта ' + f + ' на месте', fs.existsSync(path.join(SRC, 'fonts', f)));
  }
}

// 8. Шрифт UI — JetBrains Mono (а не Segoe UI).
t('в CSS задан --ui: JetBrainsMono', /--ui:\s*"JetBrainsMono"/.test(css));
t('в CSS больше нет Segoe UI в --ui', !/--ui:[^;]*Segoe UI/.test(css));
t('CSS ссылается на --mono, а не на удалённый --nf', !/var\(--nf\)/.test(css));

// 9. margin-block / margin-inline принимают 1–2 значения. Тройная запись
//    молча отбрасывается всей декларацией — на этом уже потерялись
//    вертикальные отступы у заголовков (margin: 1.5em 0 .55em ->
//    margin-block: 1.5em 0 .55em).
for (const prop of ['margin-block', 'margin-inline', 'padding-block', 'padding-inline']) {
  const bad = [];
  for (const m of css.matchAll(new RegExp(prop + ':\\s*([^;{}]+);', 'g'))) {
    const n = m[1].trim().split(/\s+/).length;
    if (n > 2) bad.push(prop + ': ' + m[1].trim());
  }
  t('нет невалидных ' + prop + ' (больше 2 значений)', bad.length === 0, bad.join('; '));
}

// 10. Универсальный сброс * { margin: 0 } обнуляет всё — значит у каждого
//     блочного элемента колонки должно быть своё вертикальное правило.
t('сброс * { margin: 0 } на месте (ожидаем)', /\*\s*\{[^}]*margin:\s*0/.test(css));
t('у заголовков есть вертикальный margin-block',
  /\.content h1[^{]*\{[^}]*margin-block:/.test(css) || /\.content h1,\s*\.content h2/.test(css));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);