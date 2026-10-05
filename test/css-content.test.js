'use strict';
/*
 * Проверка, что текст, вставляемый через CSS content:, переводится.
 *
 * Случай был такой: строка `content: 'вторая панель'` попала под массовый
 * перевод комментариев и была переведена в коде — то есть на любом языке
 * подпись стала бы английской. В CSS нельзя вызвать перевод, поэтому значение
 * приходит переменной, которую ставит applySettings.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

const css = fs.readFileSync(path.join(ROOT, 'src', 'style.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const ru = require(path.join(ROOT, 'src', 'i18n', 'ru.js'));
const en = require(path.join(ROOT, 'src', 'i18n', 'en.js'));

console.log('\n== текст, вставляемый через CSS ==');

// Ни одного content: с текстом прямо в CSS: переводить там нечем.
const literalContent = [...css.matchAll(/content:\s*['"][^'"]*[A-Za-zА-Яа-яЁё][^'"]*['"]/g)]
  .map((m) => m[0]);
t('в CSS нет непереводимого content с текстом', literalContent.length === 0,
  literalContent.join('\n       '));

t('подпись второй панели приходит переменной',
  /content:\s*var\(--i18n-second-pane/.test(css));
t('переменная ставится при применении настроек',
  /setProperty\('--i18n-second-pane',\s*tr\('split\.secondPane'\)\)/.test(appSrc));
t('у ключа есть русский и английский',
  ru['split.secondPane'] && en['split.secondPane']
  && ru['split.secondPane'] !== en['split.secondPane'],
  'ru=' + JSON.stringify(ru['split.secondPane'])
  + ' en=' + JSON.stringify(en['split.secondPane']));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
