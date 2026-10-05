'use strict';
/*
 * Счётчик строк кода по файлам.
 *
 * Снимок снимается один раз и хранится рядом. Каждый прогон сверяет текущее
 * число строк кода снимком, и расхождение означает, что при переносе комментариев
 * кто-то потерял кусок кода или, наоборот, вставил.
 *
 * Что именно ловит этот файл, а что нет:
 *
 *   Проверка разбора (test/page-scripts) ловит файл, который перестал
 *   разбираться: пропавший закрывающий маркер блочного комментария,
 *   потерянная скобка, await на верхнем уровне. Но она молчит, когда пропавший
 *   код просто ушёл внутрь комментария — файл остаётся синтаксически верным.
 *   Именно так при переводе потерялись `const UNDO_COALESCE_MS = 700` и
 *   `async function recentDialog() {`.
 *
 * Счётчик строк ловит и это: любая потеря кода меняет число строк.
 *
 * Обновлять снимок нужно только вместе с осознанным изменением кода:
 *   node test/code-lines.test.js --update
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(__dirname, 'code-lines.json');

const FILES = [
  'main.js', 'ipc.js', 'preload.js',
  'src/app.js', 'src/md.js',
  'scripts/vendor.js', 'build/icon/make-icons.js',
];

/** Строки кода: не пустые, не начинающиеся с маркера комментария. */
function codeLines(src) {
  return src.split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => {
      const t = l.trim();
      if (t === '') return false;
      if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.endsWith('*/')) return false;
      return true;
    }).length;
}

const now = {};
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) { console.error('нет файла: ' + rel); process.exit(2); }
  now[rel] = codeLines(fs.readFileSync(p, 'utf8'));
}

if (process.argv.includes('--update')) {
  fs.writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + '\n', 'utf8');
  console.log('снимок обновлён: ' + FILES.length + ' файлов');
  for (const [k, v] of Object.entries(now)) console.log('  ' + k + ': ' + v);
  process.exit(0);
}

const had = fs.existsSync(SNAPSHOT);
const was = had ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : null;

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

console.log('\n== число строк кода не изменилось ==');
t('снимок есть', had, 'запусти node test/code-lines.test.js --update');

for (const rel of FILES) {
  const expected = was ? was[rel] : null;
  t(rel + ': ' + (expected == null ? '?' : expected) + ' строк кода',
    expected === now[rel],
    expected == null ? 'файла нет в снимке' : 'стало ' + now[rel]);
}

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
console.log('Если код менялся осознанно — обнови снимок: node test/code-lines.test.js --update');
process.exit(fail ? 1 : 0);
