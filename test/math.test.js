'use strict';
/* Rendering on synthetic input and, if MDV_NOTES_DIR is set, on real notes. */
const fs = require('fs');
const path = require('path');

global.marked = require(path.join(__dirname, '..', 'src', 'vendor', 'marked.min.js'));
global.katex = require(path.join(__dirname, '..', 'src', 'vendor', 'katex', 'katex.min.js'));
// md.js draws task-list checkboxes through MDV_ICONS; without it they would be
// left as native <input>, so the icons are loaded BEFORE md.js.
require(path.join(__dirname, '..', 'src', 'icons.js'));
const MDV = require(path.join(__dirname, '..', 'src', 'md.js'));

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};

console.log('\n== синтетика ==');

// 1. a block formula as its own paragraph -> <div>, not inside <p>
let h = MDV.renderMd('текст до\n\n$$E = mc^2$$\n\nтекст после');
t('блок $$ -> div вне <p>', /<div class="mdv-math mdv-math-block"/.test(h) && !/<p><div/.test(h));
t('у формулы есть data-tex (исходник по клику)', /data-tex="E = mc\^2"/.test(h), h.slice(0, 300));
t('блок не остался плейсхолдером', !/MDVMATH\d+END/.test(h), h.slice(0, 300));

// 2. an inline formula
h = MDV.renderMd('смотри $Z_{2}$ и $Z_{3}$ вместе');
t('инлайн $..$ -> span', (h.match(/mdv-math-inline/g) || []).length === 2, h);
t('инлайн не разорван <em>', !/<em>|\/em>/.test(h), h);

// 3. `\\` must NOT be lost (the main trouble with auto-render after marked)
h = MDV.renderMd('$$\\begin{aligned}\na &= b \\\\\nc &= d\n\\end{aligned}$$');
t('\\\\ сохранён как \\\\ в katex', /\\\\/.test(h) && !/katex[^]*?\\\\/.test(h) === false);
t('aligned отрисован', /mord|begin-array|katex/.test(h) && !/Undefined control/.test(h));

// 4. escaped braces \{ \} and \, {,}
h = MDV.renderMd('$$A = \\{1,2\\}, \\quad B = 1{,}5 \\text{ Ом}$$');
t('\\{ \\} не развалились', !/Undefined control sequence/.test(h));
t('нет ошибок KaTeX', !/katex-error/.test(h), h.replace(/<[^>]+>/g, ' ').slice(0, 200));

// 5. Cyrillic in \text{}
h = MDV.renderMd('$$\\tau = 2{,}564\\cdot10^{-4}\\ \\text{с}.$$');
t('кириллица в \\text{}', !/katex-error/.test(h) && /mathdefault|mathrm|mord/.test(h), h.replace(/<[^>]+>/g, ' ').slice(0, 200));

// 6. code is NOT touched: $ inside a fence
h = MDV.renderMd('```tikz\n\\begin{tikzpicture}\n$x$ and $$\n```\n');
t('$ внутри fence не формула', !/katex/.test(h), h);
t('tikz-код на месте', /tikzpicture/.test(h));

// 7. code is NOT touched: `$` inline code
h = MDV.renderMd('введи `$PATH` и всё');
t('$ внутри inline-code не формула', !/katex/.test(h), h);

// 8. currency is not a formula
h = MDV.renderMd('Цена $5 и $10 в итоге');
t('$5 и $10 — не формула', !/katex/.test(h), h);

// 9. an escaped \$
h = MDV.renderMd('цена \\$5, а формула $x^2$ тут');
t('\\$ не открывает формулу', (h.match(/katex/g) || []).length > 0 && !/Undefined/.test(h));
t('обе части на месте', /\$5/.test(h) && /5/.test(h));

// 10. empty/broken input does not bring anything down
h = MDV.renderMd('$$\\frac{1}$$');
t('битая формула не роняет рендер', typeof h === 'string' && h.length > 0);
h = MDV.renderMd('');
t('пустой ввод -> пусто', h.trim() === '');
h = MDV.renderMd('```\nнезакрытый fence\n$$x$$');
t('незакрытый fence не роняет', typeof h === 'string');

// 11. .md links are marked
h = MDV.renderMd('[вот](Лекция%201.md)', 'file:///home/user/notes/');
t('.md-ссылка помечена data-mdpath', /data-mdpath="/.test(h), h);
t('путь с кириллицей декодирован', /Лекция 1\.md/.test(h), h);

// 12. images
h = MDV.renderMd('![схема](img%2Fсхема.png)', 'file:///home/user/notes/Электротехника/');
t('img -> абсолютный file://', /<img[^>]+src="file:\/\/\/home\/user\/notes\/%D0%AD/.test(h), h);

// 13. task-list: native <input type=checkbox> -> Lucide SVG
console.log('\n== task-list (- [x] / - [ ]) ==');

h = MDV.renderMd('- [x] сделано\n- [ ] не сделано\n');
t('нативных checkbox не осталось', !/type="checkbox"/.test(h), h);
t('есть обёртка mdv-task-wrap', /mdv-task-wrap/.test(h), h);
t('отмеченный -> mdv-task-done', /mdv-task mdv-task-done/.test(h), h);
t('неотмеченный -> без mdv-task-done', (h.match(/mdv-task-done/g) || []).length === 1, h);
t('иконки — это svg, а не глифы', (h.match(/<svg/g) || []).length === 2, h);
t('текст задачи сохранён', /сделано/.test(h) && /не сделано/.test(h), h);

// a numbered list — the most common case in notes
h = MDV.renderMd('1. [x] первый\n2. [ ] второй\n');
t('нумерованный: checkbox заменён', !/type="checkbox"/.test(h), h);
t('нумерованный: один done', (h.match(/mdv-task-done/g) || []).length === 1, h);

// nesting
h = MDV.renderMd('- [x] да\n  - [ ] вложенная\n');
t('вложенная задача обработана', !/type="checkbox"/.test(h), h);
t('вложенная: один done один нет', (h.match(/mdv-task-done/g) || []).length === 1, h);

// an ordinary list must not suffer
h = MDV.renderMd('- просто пункт\n- [ ] с галочкой\n');
t('в обычном пункте нет иконки', !/mdv-task-wrap[\s\S]*просто пункт/.test(h), h);
t('в обычном пункте нет task-wrap вообще', (h.match(/mdv-task-wrap/g) || []).length === 1, h);

// no space after the brackets — this is NOT a task, and must not break
h = MDV.renderMd('- [x]слитно\n');
t('[x] без пробела не трогаем', !/mdv-task/.test(h), h);

// inline code with [x] must not become a checkbox
h = MDV.renderMd('- `[x]` в коде\n');
t('[x] в inline-коде не стал иконкой', !/mdv-task-wrap/.test(h), h);

// A real note from someone's own library, to check the renderer on
// something we did not write. Point MDV_REAL_NOTE at a .md file; skipped
// when unset or missing.
const REAL = process.env.MDV_REAL_NOTE || '';
if (REAL && fs.existsSync(REAL)) {
  const src = fs.readFileSync(REAL, 'utf8');
  const h2 = MDV.renderMd(src);
  t('реальный файл: нет нативных checkbox', !/type="checkbox"/.test(h2));
  // How many tasks there are — we count from the file itself rather than hardcode
  // a number: a user's note changes, and the check used to fall after it, saying
  // nothing about the rendering.
  // The task marker also occurs in "1. [x]" lists, not only in "- [x]", so we
  // take any numbered or bulleted item.
  const wantTasks = (src.match(/^\s*(?:[-*]|\d+\.)\s+\[[ xX]\]/gm) || []).length;
  const gotTasks = (h2.match(/mdv-task-wrap/g) || []).length;
  t('реальный файл: все задачи получили иконки', gotTasks === wantTasks && wantTasks > 0,
    'в файле ' + wantTasks + ', отрисовано ' + gotTasks);
  t('реальный файл: первая задача done', /mdv-task mdv-task-done/.test(h2));
}

console.log('\n== реальные заметки ==');
const ROOT = process.env.MDV_NOTES_DIR || '';
if (ROOT && fs.existsSync(ROOT)) {
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