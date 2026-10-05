'use strict';
/*
 * Скрипты страницы должны разбираться как скрипты страницы.
 *
 * node --check проверяет файл как CommonJS и пропускает то, что renderer
 * не примет: верхний await внутри обычного файла, возврат на верхнем уровне.
 * Наоборот, renderer собирает файлы index.html как обычные скрипты, и любая
 * такая ошибка обрывает выполнение app.js целиком — снаружи это видно только
 * как «тестовый хук не найден», и виноват всегда оказывается не тот файл.
 *
 * Именно так выглядела потеря `async function recentDialog() {` при переводе
 * комментариев: файл оставался синтаксически верным, а страница падала.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

console.log('\n== скрипты страницы ==');

const html = fs.readFileSync(path.join(ROOT, 'src', 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

t('в index.html есть скрипты', srcs.length > 0, String(srcs.length));
t('все скрипты на месте', srcs.every((s) => fs.existsSync(path.join(ROOT, 'src', s))),
  srcs.filter((s) => !fs.existsSync(path.join(ROOT, 'src', s))).join(', '));

for (const rel of srcs) {
  const src = fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8');
  let err = null;
  let line = null;
  try {
    new vm.Script(src, { filename: rel });
  } catch (e) {
    err = e.message;
    line = (e.stack.match(new RegExp(rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)')) || [])[1];
  }
  let where = '';
  if (line) {
    const lines = src.split('\n');
    for (let i = Math.max(1, Number(line) - 2); i <= Math.min(lines.length, Number(line) + 1); i++) {
      where += '\n       ' + i + (i === Number(line) ? ' > ' : ' | ') + lines[i - 1];
    }
  }
  t(rel + ' разбирается как скрипт страницы', err === null, (err || '') + where);
}

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
