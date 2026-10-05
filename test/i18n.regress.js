'use strict';
/*
 * Регресс-проверки i18n, которые ловят то, что не видно в словарях.
 *
 * Каждая проверка here соответствует реально случившейся ошибке, поэтому
 * формат один: сначала что сломалось, потом почему проверка такая.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

const i18n = require(path.join(ROOT, 'src', 'i18n', 'index.js'));
const dictRu = require(path.join(ROOT, 'src', 'i18n', 'ru.js'));
const dictEn = require(path.join(ROOT, 'src', 'i18n', 'en.js'));
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const i18nSrc = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'index.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const tabsSrc = fs.readFileSync(path.join(ROOT, 'test', 'tabs.js'), 'utf8');

console.log('\n== перевод строк ==');

// --- 1. --lang= должен читаться, а не игнорироваться ----------------------
//
// Тесты передавали --lang=ru, и приложение его не читало: язык брался из
// settings.json. test:tabs работал на личных настройках того, кто его
// запустил, а блок переключения языка в конце оставлял после себя en.
// Проверки падали или проходили в зависимости от того, что лежало в файле.
t('--lang= читается главным процессом',
  /function langFromArgv\(\)/.test(mainSrc)
  && /process\.argv\.find\(\(a\) => a\.startsWith\('--lang='\)\)/.test(mainSrc));
t('--lang= перекрытие не пишется в settings.json',
  /async function applyLangSetting\(\) \{[\s\S]{0,200}Не пишем в settings\.json/.test(mainSrc));
t('аргумент языка доходит до renderer',
  /additionalArguments: \['--mdv-lang='/.test(mainSrc)
  && /forcedLang: \(\) =>/.test(preloadSrc));
t('renderer уважает перекрытие языка',
  /(?:const|let) MDV_FORCED_LANG = \(api\.forcedLang/.test(appSrc)
  && /if \(MDV_FORCED_LANG\) MDV_I18N\.setLocale\(MDV_FORCED_LANG\)/.test(appSrc));

// --- 2. Перекрытие должно сниматься явным выбором ------------------------
//
// Иначе выбор языка в настройках не действовал бы, пока запущено с --lang:
// настройка стала бы недоступна вовсе, и переключатель в окне настроек был бы
// украшением.
t('явный выбор языка снимает перекрытие в renderer',
  /langSel\.onchange = async \(\) => \{[\s\S]{0,300}MDV_FORCED_LANG = ''/.test(appSrc));
t('явный выбор языка снимает перекрытие в главном процессе',
  /handle\('mdv:setLang', async \(\) => \{[\s\S]{0,120}langOverrideArmed = false/.test(mainSrc));

// --- 3. Тесты не работают на личных настройках ---------------------------
t('test:tabs запускается со своим каталогом настроек',
  /'--user-data-dir=' \+ userData/.test(tabsSrc));

// --- 4. Подписи не запекаются на стартовом языке ------------------------
//
// RADIAL_LAYOUT был константой с переведёнными текстами: она собиралась один
// раз при загрузке скрипта, когда язык ещё не применён, и подписи кольца
// оставались на стартовом языке навсегда.
const radialBlock = appSrc.match(/const RADIAL_LAYOUT = \[[\s\S]*?\n\];/);
const radialItems = radialBlock
  ? [...radialBlock[0].matchAll(/\{\s*act:/g)].length : 0;
t('таблица кольца хранит ключи, а не тексты',
  !!radialBlock
  && !/tip:\s*tr\(/.test(radialBlock[0])
  && (radialBlock[0].match(/tipKey:/g) || []).length === radialItems,
  radialBlock
    ? radialItems + ' действий, tipKey: '
      + (radialBlock[0].match(/tipKey:/g) || []).length
    : 'таблица не найдена');
t('подпись сектора переводится в момент сборки',
  /b\.title = tr\(item\.tipKey\)/.test(appSrc));

// --- 5. Имя функции перевода не перекрывает переменные -------------------
//
// Функция называлась t(). В app.js переменная t — это вкладка, и в диалогах
// отмены правки `t.name` отдавало имя функции: в текст попадала буква «t».
t('функция перевода называется tr, а не t',
  /const tr = \(key, params\) =>/.test(appSrc) && /const tr = \(key, params\) =>/.test(mainSrc));
t('не осталось вызовов перевода через t(',
  !/(?<![A-Za-z0-9_$.])t\('[a-z]/.test(appSrc)
  && !/(?<![A-Za-z0-9_$.])t\('[a-z]/.test(mainSrc));

// --- 6. Русский текст в словарях, а не в разметке ------------------------
//
// Проверка по атрибутам разметки, а не «есть ли где-нибудь кириллица»: её
// задача — убедиться, что index.html не отдаёт русский текст напрямую.
// Комментарии в HTML кириллицей не считаются: их не видно человеку.
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const htmlBody = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
const cyrAttrs = [...htmlBody.matchAll(
  /(?:title|aria-label|placeholder)="[^"]*[А-Яа-яЁё][^"]*"/g)].map((m) => m[0]);
t('в разметке нет русских title/aria-label/placeholder', cyrAttrs.length === 0,
  cyrAttrs.join('\n       '));

// Ключи разметки должны быть и в словаре, и в разметке: иначе перевод
// молча не подставится, и подпись останется пустой.
const domDict = require(path.join(ROOT, 'src', 'i18n', 'dom.js'));
const markupKeys = new Set([...htmlBody.matchAll(/data-i18n-(?:title|aria|placeholder)="([^"]+)"/g)]
  .map((m) => m[1]));
const missingInDict = [...markupKeys].filter((k) => !domDict[k]);
const unusedInDict = Object.keys(domDict).filter((k) => !markupKeys.has(k));
t('все ключи разметки есть в dom.js', missingInDict.length === 0, missingInDict.join(', '));
t('в dom.js нет ключей без разметки', unusedInDict.length === 0, unusedInDict.join(', '));
t('у каждого ключа dom.js есть ru и en',
  Object.entries(domDict).every(([, v]) => v.ru && v.en),
  Object.entries(domDict).filter(([, v]) => !v.ru || !v.en).map(([k]) => k).join(', '));
t('applyDom вызывается при применении настроек',
  /MDV_I18N\.applyDom\(\)/.test(appSrc));
t('applyDom проставляет все три атрибута',
  /'title', 'i18nTitle'/.test(i18nSrc)
  && /'aria-label', 'i18nAria'/.test(i18nSrc)
  && /'placeholder', 'i18nPlaceholder'/.test(i18nSrc));

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
