'use strict';
/* Прогон рендера на синтетике и на реальных заметках /srv/uchoba. */
const fs = require('fs');
const path = require('path');

global.marked = require(path.join(__dirname, '..', 'src', 'vendor', 'marked.min.js'));
global.katex = require(path.join(__dirname, '..', 'src', 'vendor', 'katex', 'katex.min.js'));
const MDV = require(path.join(__dirname, '..', 'src', 'md.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

console.log('\n== синтетика ==');

// 1. блочная формула отдельным абзацем -> <div>, не внутри <p>
let h = MDV.renderMd('текст до\n\n$$E = mc^2$$\n\nтекст после');
t('блок $$ -> div вне <p>', /<div class="mdv-math mdv-math-block"/.test(h) && !/<p><div/.test(h));
t('у формулы есть data-tex (исходник по клику)', /data-tex="E = mc\^2"/.test(h), h.slice(0, 300));
t('блок не остался плейсхолдером', !/MDVMATH\d+END/.test(h), h.slice(0, 300));

// 2. инлайновая формула
h = MDV.renderMd('смотри $Z_{2}$ и $Z_{3}$ вместе');
t('инлайн $..$ -> span', (h.match(/mdv-math-inline/g) || []).length === 2, h);
t('инлайн не разорван <em>', !/<em>|\/em>/.test(h), h);

// 3. `\\` НЕ должен теряться (главная беда auto-render после marked)
h = MDV.renderMd('$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$');
t('\\\\ сохранён как \\\\ в katex', /\\\\/.test(h) && !/katex[^]*?\\\\/.test(h) === false);
t('aligned отрисован', /mord|begin-array|katex/.test(h) && !/Undefined control/.test(h));

// 4. экранированные скобки \{ \} и \, {,}
h = MDV.renderMd('$$A = \\{1,2\\}, \\quad B = 1{,}5 \\text{ Ом}$$');
t('\\{ \\} не развалились', !/Undefined control sequence/.test(h));
t('нет ошибок KaTeX', !/katex-error/.test(h), h.replace(/<[^>]+>/g, ' ').slice(0, 200));

// 5. кириллица в \text{}
h = MDV.renderMd('$$\\tau = 2{,}564\\cdot10^{-4}\\ \\text{с}.$$');
t('кириллица в \\text{}', !/katex-error/.test(h) && /mathdefault|mathrm|mord/.test(h), h.replace(/<[^>]+>/g, ' ').slice(0, 200));

// 6. код НЕ трогаем: $ внутри fence
h = MDV.renderMd('```tikz\n\\begin{tikzpicture}\n$x$ and $$\n```\n');
t('$ внутри fence не формула', !/katex/.test(h), h);
t('tikz-код на месте', /tikzpicture/.test(h));

// 7. код НЕ трогаем: `$` inline-code
h = MDV.renderMd('введи `$PATH` и всё');
t('$ внутри inline-code не формула', !/katex/.test(h), h);

// 8. валюта не считается формулой
h = MDV.renderMd('Цена $5 и $10 в итоге');
t('$5 и $10 — не формула', !/katex/.test(h), h);

// 9. экранированный \$
h = MDV.renderMd('цена \\$5, а формула $x^2$ тут');
t('\\$ не открывает формулу', (h.match(/katex/g) || []).length > 0 && !/Undefined/.test(h));
t('обе части на месте', /\$5/.test(h) && /5/.test(h));

// 10. пустой/битый ввод не роняет
h = MDV.renderMd('$$\\frac{1}$$');
t('битая формула не роняет рендер', typeof h === 'string' && h.length > 0);
h = MDV.renderMd('');
t('пустой ввод -> пусто', h.trim() === '');
h = MDV.renderMd('```\nнезакрытый fence\n$$x$$');
t('незакрытый fence не роняет', typeof h === 'string');

// 11. ссылки на .md помечаются
h = MDV.renderMd('[вот](Лекция%201.md)', 'file:///home/u/uchoba/');
t('.md-ссылка помечена data-mdpath', /data-mdpath="/.test(h), h);
t('путь с кириллицей декодирован', /Лекция 1\.md/.test(h), h);

// 12. картинки
h = MDV.renderMd('![схема](img%2Fсхема.png)', 'file:///home/u/uchoba/Электротехника/');
t('img -> абсолютный file://', /<img[^>]+src="file:\/\/\/home\/u\/uchoba\/%D0%AD/.test(h), h);

console.log('\n== реальные заметки /srv/uchoba ==');
const ROOT = '/srv/uchoba';
if (fs.existsSync(ROOT)) {
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.md$/i.test(e.name)) files.push(f);
    }
  })(ROOT);

  let totalMath = 0, errFiles = 0, leftover = 0, errSamples = [];
  const base = 'file://' + ROOT + '/';
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    let html;
    try { html = MDV.renderMd(src, base); }
    catch (e) { errFiles++; errSamples.push(path.relative(ROOT, f) + ' => УПАЛ: ' + e.message); continue; }
    const n = (html.match(/class="mdv-math /g) || []).length;
    totalMath += n;
    const e = (html.match(/class="mdv-math-error"/g) || []).length;
    if (e) { errFiles++; errSamples.push(path.relative(ROOT, f) + ' => ошибок формул: ' + e); }
    if (/MDVMATH\d+END/.test(html)) { leftover++; errSamples.push(path.relative(ROOT, f) + ' => остался плейсхолдер'); }
  }
  console.log('  файлов: ' + files.length + ', отрендеренных формул: ' + totalMath);
  t('все файлы отрендерились без падений', errFiles === 0 || !errSamples.some(s => s.includes('УПАЛ')));
  t('не осталось неразобранных плейсхолдеров', leftover === 0);
  t(' KaTeX не ошибся ни на одном файле', !errSamples.some(s => s.includes('ошибок формул')),
    errSamples.filter(s => s.includes('ошибок')).slice(0, 5).join('\n       '));
  t('формулы реально найдены и отрендерены', totalMath > 300, 'найдено: ' + totalMath);
} else {
  console.log('  (каталога ' + ROOT + ' нет — пропускаю)');
}

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);