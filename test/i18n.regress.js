'use strict';
/*
 * Regression checks for i18n: the things that cannot be seen in the dictionaries.
 *
 * Every check here corresponds to an error that actually happened, so the
 * format is the same throughout: first what broke, then why the check is like
 * that.
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

// --- 0. What must not be translated ------------------------------------------
// Two Russian literals remain in ipc.js: they are comments that get substituted
// into the CSS of the exported file. They belong to the output file, not to the
// interface, and must not be translated — a comment in someone else's CSS in a
// foreign language. The check pins that it is exactly these two, so that an
// "unfinished translation" is not hunted down again.
const ipcSrc = fs.readFileSync(path.join(ROOT, 'ipc.js'), 'utf8');
const ipcStrays = [...ipcSrc.matchAll(/^\s*.*(?:'|`)[^'`\n]*[А-Яа-яЁё][^'`\n]*(?:'|`)[^/]*$/gm)]
  .map((m) => m[0].trim())
  .filter((l) => l.includes('/*') || l.includes('css'));
t('в ipc.js русским остались только комментарии в CSS',
  ipcStrays.length === 2 && ipcStrays.every((l) => /шрифты приложения|выбор из окна экспорта/.test(l)),
  ipcStrays.join('\n       '));

console.log('\n== перевод строк ==');

// --- 1. --lang= must be read, not ignored ----------------------
// The tests passed --lang=ru and the application did not read it: the language
// came from settings.json. test:tabs ran on the personal settings of whoever
// started it, and the language switch block at the end left en behind.
// The checks either failed or passed depending on what was in that file.
t('--lang= читается главным процессом',
  /function langFromArgv\(\)/.test(mainSrc)
  && /process\.argv\.find\(\(a\) => a\.startsWith\('--lang='\)\)/.test(mainSrc));
// The override branch must end before the try: a write to settings.json
// inside it would mean that a launch with a second language silently changes the
// language of the next ordinary launch.
const applyLang = mainSrc.match(/async function applyLangSetting\(\) \{[\s\S]*?\n\}/);
t('--lang= перекрытие не пишется в settings.json',
  !!applyLang
  && applyLang[0].indexOf('ipc.setting(') > applyLang[0].indexOf('return i18n.lang'),
  'запись в settings.json внутри ветки с перекрытием означала бы, что запуск\n'
  + 'со вторым языком молча меняет язык у следующего обычного запуска');
t('аргумент языка доходит до renderer',
  /additionalArguments: \['--mdv-lang='/.test(mainSrc)
  && /forcedLang: \(\) =>/.test(preloadSrc));
t('renderer уважает перекрытие языка',
  /(?:const|let) MDV_FORCED_LANG = \(api\.forcedLang/.test(appSrc)
  && /if \(MDV_FORCED_LANG\) MDV_I18N\.setLocale\(MDV_FORCED_LANG\)/.test(appSrc));

// --- 2. The override must be dropped by an explicit choice ------------------------
// Otherwise the language choice in the settings would not take effect while
// running with --lang: the setting would be unavailable altogether, and the
// switch in the settings window would be decoration.
t('явный выбор языка снимает перекрытие в renderer',
  /langSel\.onchange = async \(\) => \{[\s\S]{0,300}MDV_FORCED_LANG = ''/.test(appSrc));
t('явный выбор языка снимает перекрытие в главном процессе',
  /handle\('mdv:setLang', async \(\) => \{[\s\S]{0,120}langOverrideArmed = false/.test(mainSrc));

// --- 3. The tests do not run on personal settings ---------------------------
t('test:tabs запускается со своим каталогом настроек',
  /'--user-data-dir=' \+ userData/.test(tabsSrc));

// --- 4. Captions are not baked in at the starting language ------------------------
// RADIAL_LAYOUT was a constant with translated texts: it was built once when the
// script loaded, before the language had been applied, and the captions of the
// ring stayed in the starting language forever.
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

// --- 5. The name of the translation function does not shadow variables -------------------
// The function was called t(). In app.js the variable t is a tab, and in the
// discard dialogs `t.name` returned the name of the function: the letter "t" ended
// up in the text.
t('функция перевода называется tr, а не t',
  /const tr = \(key, params\) =>/.test(appSrc) && /const tr = \(key, params\) =>/.test(mainSrc));
t('не осталось вызовов перевода через t(',
  !/(?<![A-Za-z0-9_$.])t\('[a-z]/.test(appSrc)
  && !/(?<![A-Za-z0-9_$.])t\('[a-z]/.test(mainSrc));

// --- 6. Russian text belongs in the dictionaries, not in the markup ------------------------
// The check goes by markup attributes rather than by "is there any Cyrillic
// anywhere": its task is to make sure index.html does not hand out Russian text
// directly.
// Comments in HTML in Cyrillic do not count: a person does not see them.
const htmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const htmlBody = htmlSrc.replace(/<!--[\s\S]*?-->/g, '');
const cyrAttrs = [...htmlBody.matchAll(
  /(?:title|aria-label|placeholder)="[^"]*[А-Яа-яЁё][^"]*"/g)].map((m) => m[0]);
t('в разметке нет русских title/aria-label/placeholder', cyrAttrs.length === 0,
  cyrAttrs.join('\n       '));

// The markup keys must be both in the dictionary and in the markup: otherwise the
// translation is silently not applied and the caption stays empty.
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
