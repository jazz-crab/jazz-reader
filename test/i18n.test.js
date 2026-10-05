'use strict';
/*
 * i18n: the system language, the language choice, placeholders, plural forms,
 * and the fallback to the second language when a translation has a gap.
 *
 * Without Electron and without a window: the dictionaries are loaded by two
 * routes (the global object, as in the renderer, and require, as in the main
 * process) and checked directly. Both routes matter — the renderer has no
 * require, and the main process has no <script>.
 *
 *   node test/i18n.test.js
 */
const path = require('path');

const I18N = path.join(__dirname, '..', 'src', 'i18n');

let pass = 0, fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
};
const eq = (name, got, want) => t(name, got === want, 'got ' + JSON.stringify(got) +
  ', want ' + JSON.stringify(want));

console.log('\n== загрузка ==');

// the renderer route: three <script>s, no require and no modules
require(path.join(I18N, 'ru.js'));
require(path.join(I18N, 'en.js'));
require(path.join(I18N, 'index.js'));
const i18n = global.MDV_I18N;
t('MDV_I18N создан (renderer-путь)', !!i18n);
t('словари зарегистрировались в globalThis', !!(global.MDV_I18N_DICT && global.MDV_I18N_DICT.ru && global.MDV_I18N_DICT.en));

// the main route: index.js only, it pulls the dictionaries in itself. The require
// cache is cleared by hand, otherwise a repeated require returns the cache and
// the dictionaries are not registered again — that is how we imitate a new process.
for (const f of ['ru.js', 'en.js', 'index.js']) {
  delete require.cache[require.resolve(path.join(I18N, f))];
}
delete global.MDV_I18N;
const viaMain = require(path.join(I18N, 'index.js'));
t('index.js сам подтянул ru.js (main-путь)', !!global.MDV_I18N_DICT.ru);
t('index.js сам подтянул en.js (main-путь)', !!global.MDV_I18N_DICT.en);
t('index.js отдаёт себя в module.exports', viaMain === global.MDV_I18N);

console.log('\n== язык системы ==');
eq('ru-RU -> ru', i18n.setSystemLocale('ru-RU'), 'ru');
eq('en-US -> en', i18n.setSystemLocale('en-US'), 'en');
eq('de-DE -> en (нет такого перевода)', i18n.setSystemLocale('de-DE'), 'en');
eq('пустая строка -> en', i18n.setSystemLocale(''), 'en');
eq('normalize отбрасывает регион и кириллицу', i18n.normalize('RU_ru'), 'ru');

console.log('\n== выбор языка ==');
i18n.setSystemLocale('ru-RU');
i18n.setLocale('auto');
eq('auto берёт язык системы', i18n.lang, 'ru');
i18n.setLocale('en');
eq('явный выбор побеждает системный', i18n.lang, 'en');
i18n.setLocale('немецкий');
eq('ерунда на входе -> auto', i18n.locale, 'auto');
eq('после мусора снова язык системы', i18n.lang, 'ru');

console.log('\n== перевод ==');
i18n.setLocale('ru');
eq('ru', i18n.t('menu.file'), 'Файл');
i18n.setLocale('en');
eq('en', i18n.t('menu.file'), 'File');

console.log('\n== плейсхолдеры и многострочные значения ==');
i18n.setLocale('ru');
t('многострочный текст не поехал', i18n.t('about.detail').indexOf('Ctrl+Shift+O') > 0);

console.log('\n== множественные формы ==');
i18n.setLocale('ru');
// Russian changes the word at the boundaries 1, 2-4, 5+, 11-14, 21 and so on.
const RU_FORMS = {
  0: 'заметках', 1: 'заметке', 2: 'заметках', 4: 'заметках', 5: 'заметках',
  11: 'заметках', 12: 'заметках', 14: 'заметках',
  21: 'заметке', 22: 'заметках', 25: 'заметках',
  101: 'заметке', 111: 'заметках',
};
for (const [n, word] of Object.entries(RU_FORMS)) {
  const got = i18n.t('quit.detailDirty', { count: Number(n) });
  t('ru ' + n + ' -> ' + word, got.indexOf(word) > 0, got.slice(0, 40));
}
i18n.setLocale('en');
t('en 1 -> note has', i18n.t('quit.detailDirty', { count: 1 }).indexOf('1 note has') === 0);
t('en 5 -> notes have', i18n.t('quit.detailDirty', { count: 5 }).indexOf('5 notes have') === 0);
t('en 1 не становится «1 notes»', i18n.t('quit.detailDirty', { count: 1 }).indexOf('1 notes') === -1);
eq('число подставлено', /5 notes/.test(i18n.t('quit.detailDirty', { count: 5 })), true);

console.log('\n== пробелы в переводе ==');
const saved = global.MDV_I18N_DICT.ru['menu.help'];
delete global.MDV_I18N_DICT.ru['menu.help'];
i18n.setLocale('ru');
eq('нет ключа в ru -> берём из en', i18n.t('menu.help'), 'Help');
global.MDV_I18N_DICT.ru['menu.help'] = saved;

i18n.setLocale('ru');
eq('совсем неизвестный ключ виден на экране', i18n.t('menu.view.nope'), 'menu.view.nope');

console.log('\n== <html lang> ==');
i18n.setLocale('en');
eq('en', i18n.tag(), 'en');
i18n.setLocale('ru');
eq('ru', i18n.tag(), 'ru');
i18n.setLocale('auto');
i18n.setSystemLocale('de-DE');
eq('auto + неподдерживаемый системный -> en', i18n.tag(), 'en');

console.log('\n== ключи ==');
// The keys must match in both dictionaries: a mismatch means either a
// forgotten translation or a key nobody uses.
const ruKeys = Object.keys(global.MDV_I18N_DICT.ru).sort();
const enKeys = Object.keys(global.MDV_I18N_DICT.en).sort();
const onlyRu = ruKeys.filter((k) => !enKeys.includes(k));
const onlyEn = enKeys.filter((k) => !ruKeys.includes(k));
t('ключи словарей совпадают (' + ruKeys.length + ' шт.)', onlyRu.length === 0 && onlyEn.length === 0,
  'только в ru: ' + onlyRu.join(', ') + ' | только в en: ' + onlyEn.join(', '));
// The list of domains is set by hand: collecting it from the keys themselves would be
// pointless, the check would always pass. A new domain is a decision, not a consequence.
const DOMAINS = [
  'about', 'btn', 'clip', 'discard', 'err', 'error', 'export', 'file',
  'find', 'ipc', 'lang', 'md', 'menu', 'name', 'nav', 'path', 'quit',
  'recent', 'render', 'ring', 'seed', 'settings', 'split', 'status', 'tab',
  'toc', 'trash', 'tree', 'unit', 'view', 'zoom',
];
const domRe = new RegExp('^(' + DOMAINS.join('|') + ')\\.');
const strays = ruKeys.filter((k) => !domRe.test(k));
t('у ключей есть префикс из известных доменов (' + DOMAINS.length + ')',
  strays.length === 0, strays.join(', '));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL\n');
process.exit(fail ? 1 : 0);