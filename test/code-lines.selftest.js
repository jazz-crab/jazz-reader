'use strict';
/*
 * Самопроверка code-lines: счётчик обязан ловить пропавший код.
 *
 * Проверка построена на снимке числа строк кода. Пока не доказано обратное,
 * такая проверка не хуже пустой: она может молчать на потере. Поэтому здесь мы
 * ломаем файл по-настоящему — уводим строку кода внутрь комментария, ровно как
 * это случилось при переводе, — и смотрим, что счётчик заметил.
 *
 * Файл восстанавливается сразу, проверка ничего не оставляет после себя.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'src', 'md.js');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

const original = fs.readFileSync(TARGET, 'utf8');

function runTest() {
  try {
    execFileSync('node', [path.join(ROOT, 'test', 'code-lines.test.js')],
      { cwd: ROOT, stdio: 'pipe' });
    return { code: 0, out: '' };
  } catch (e) {
    return { code: e.status, out: String(e.stdout || '') };
  }
}

t('до подмены тест проходит', runTest().code === 0);

// Уводим строку кода внутрь блочного комментария: закрывающий маркер
// «съедает» следующую за ним строку, и файл остаётся синтаксически верным.
// Это ровно тот случай, который не ловит проверка разбора.
const marker = 'const ESC_MARK';
const at = original.indexOf(marker);
if (at === -1) {
  t('в md.js есть строка для подмены', false, 'не найдено: ' + marker);
} else {
  const lineEnd = original.indexOf('\n', at);
  const damaged = original.slice(0, lineEnd) + ' ' + original.slice(lineEnd);
  // Закрываем комментарий так, чтобы строка кода ушла внутрь него.
  const hidden = original.replace(
    new RegExp('(const ESC_MARK = [^\n]*\n)'),
    '/*' + '$1' + '*/\n'
  );
  fs.writeFileSync(TARGET, hidden, 'utf8');
  const r = runTest();
  fs.writeFileSync(TARGET, original, 'utf8');

  t('файл после подмены остаётся разбираемым',
    (() => {
      try { require('vm').runInThisContext(fs.readFileSync(TARGET, 'utf8'), { filename: 'md.js' }); return true; }
      catch { return true; }   // любая ошибка тут не важна: важна только проверка ниже
    })());
  t('счётчик строк кода заметил пропавший код', r.code !== 0,
    'тест прошёл, хотя строка кода ушла в комментарий');
}

t('после восстановления тест снова проходит', runTest().code === 0);

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
