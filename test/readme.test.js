'use strict';
/*
 * Сверяет README с тем, что реально на диске и в package.json.
 *
 * Документация расходится с кодом тихо: размеры сборки, количество файлов шрифтов
 * и числа проверок меняются, а README продолжает утверждать старое. Каждое
 * проверяемое число здесь берётся с файла или с диска.
 *
 * Три идеи, ради которых файл и написан:
 *
 *  - список тестов берётся из scripts.test в package.json, то есть из того, что
 *    действительно запускается. Список, записанный в самом тесте, разошёлся бы с
 *    реальностью молча — ровно так же, как README.
 *  - числа проверок сверяются со снимком test/readme-counts.json, а не вычисляются:
 *    чтобы узнать число, нужно прогнать набор, а прогон внутри npm test — это
 *    рекурсия. Снимок обновляется осознанно: --update.
 *  - сумма чисел по файлам должна сходиться с заявленным итогом. Список и итог
 *    написаны рядом, и одно из двух устареет.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const md = read('README.md');
const ru = read('README_ru.md');
const pkg = JSON.parse(read('package.json'));
const SNAPSHOT = path.join(__dirname, 'readme-counts.json');

let pass = 0, fail = 0;
function t(name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '\n       ' + extra : '')); }
}

console.log('\n== README: версия, лицензия, имя ==');

t('версия в обоих README совпадает с package.json',
  md.includes(pkg.version) && ru.includes(pkg.version), 'версия ' + pkg.version);
t('название пакета — jazz-reader', pkg.name === 'jazz-reader');
t('лицензия в обоих README совпадает с package.json',
  pkg.license === 'GPL-3.0' && /GPL-3\.0/.test(md) && /GPL-3\.0/.test(ru));
t('файл LICENSE есть и упоминается в обоих README',
  fs.existsSync(path.join(ROOT, 'LICENSE'))
  && /\[LICENSE\]\(LICENSE\)/.test(md) && /\[LICENSE\]\(LICENSE\)/.test(ru));

console.log('\n== README: i18n и переменные окружения ==');

t('в README.md есть раздел о языках', /^## Languages$/m.test(md));
t('в README_ru.md есть раздел о языках', /^## Языки$/m.test(ru));
t('переключатель языка в настройках описан в обоих',
  /Settings → Language/.test(md) && /Настройках → Язык/.test(ru));
t('язык системы как умолчание указан в обоих',
  /follows the system locale/.test(md) && /следует за языком системы/.test(ru));
t('--lang= описан в обоих',
  /--lang=ru/.test(md) && /--lang=ru/.test(ru));
t('слой i18n есть в таблице структуры в обоих',
  /\| `src\/i18n\/`/.test(md) && /\| `src\/i18n\/`/.test(ru));
t('переключатель языка первой строкой в обоих',
  /\[English\]\(README\.md\) \| \[Русский\]\(README_ru\.md\)/.test(md)
  && /\[English\]\(README\.md\) \| \[Русский\]\(README_ru\.md\)/.test(ru));

// Каждая переменная окружения проверяется по трём местам: есть в коде, есть в
// английском README и в русском. Расхождение в любом из них — ошибка.
console.log('\n== README: переменные окружения ==');
const VARS = ['MDV_REAL_NOTE', 'MDV_NOTES_DIR', 'MDV_SAMPLE_DIR', 'MDV_SAMPLE_NOTE'];
const codeAll = ['main.js', 'ipc.js', 'test/tabs.js', 'test/math.test.js', 'test/audit.js',
  'test/smoke.js', 'test/startup.js', 'test/print.test.js']
  .map((f) => read(f)).join('\n');
for (const v of VARS) {
  t(v + ': есть в коде и в обоих README',
    codeAll.includes(v) && md.includes(v) && ru.includes(v),
    'код: ' + codeAll.includes(v) + ', README.md: ' + md.includes(v)
    + ', README_ru.md: ' + ru.includes(v));
}

console.log('\n== README: тесты ==');

// Кто действительно запускается: имена файлов из scripts.test. Расширение .test
// отбрасываем — в README тест называется коротко, «math», а не «math.test».
const script = pkg.scripts.test || '';
const runs = [...new Set([...script.matchAll(/test\/([\w.-]+)\.js/g)]
  .map((m) => m[1].replace(/\.test$/, '')))];
t('в scripts.test есть тесты', runs.length > 0, 'нашли: ' + runs.join(', '));

// Абзац со счётчиками: от «Current counts:» до пустой строки. Только он —
// числа в остальном README к проверке не относятся.
const from = md.indexOf('Current counts:');
const para = from === -1 ? '' : md.slice(from, md.indexOf('\n\n', from));
const claimed = {};
for (const m of para.matchAll(/`([a-z][\w.-]*)` (\d+)/g)) claimed[m[1]] = Number(m[2]);

t('в README есть абзац со счётчиками', from !== -1 && Object.keys(claimed).length > 0);
t('README перечисляет каждый запускаемый тест',
  runs.every((n) => n in claimed),
  'не перечислены: ' + runs.filter((n) => !(n in claimed)).join(', '));
t('README не перечисляет несуществующие тесты',
  Object.keys(claimed).every((n) => fs.existsSync(path.join(ROOT, 'test', n + '.js'))
    || fs.existsSync(path.join(ROOT, 'test', n + '.test.js'))),
  'нет таких файлов: ' + Object.keys(claimed)
    .filter((n) => !fs.existsSync(path.join(ROOT, 'test', n + '.js'))
      && !fs.existsSync(path.join(ROOT, 'test', n + '.test.js'))).join(', '));

// Числа по файлам — против снимка, а не против самих себя.
const snapshotPath = SNAPSHOT;
const want = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : null;
const flat = {};
for (const [k, v] of Object.entries(claimed)) flat[k] = v;

if (process.argv.includes('--update')) {
  fs.writeFileSync(snapshotPath, JSON.stringify(flat, null, 2) + '\n', 'utf8');
  console.log('снимок обновлён: ' + Object.keys(flat).length + ' тестов');
  for (const [k, v] of Object.entries(flat)) console.log('  ' + k + ': ' + v);
  process.exit(0);
}

t('снимок чисел есть', !!want, 'запусти node test/readme.test.js --update');
if (want) {
  const diffs = [];
  for (const [k, v] of Object.entries(want)) {
    if (claimed[k] !== v) diffs.push(k + ': в снимке ' + v + ', в README ' + claimed[k]);
  }
  for (const k of Object.keys(claimed)) {
    if (!(k in want)) diffs.push(k + ': в README ' + claimed[k] + ', в снимке нет');
  }
  t('числа проверок в README совпадают со снимком', diffs.length === 0, diffs.join('\n       '));
}

// Заявленный итог должен сходиться с суммой по файлам.
const total = (md.match(/fast suite: (\d+) checks/) || [])[1];
if (total) {
  const sum = Object.values(claimed).reduce((a, b) => a + b, 0);
  t('сумма по файлам даёт заявленный итог (' + total + ')', sum === Number(total),
    'по файлам ' + sum);
} else {
  t('в README есть заявленный итог быстрых проверок', false);
}

// Русский README должен называть те же числа: иначе один из двух врёт.
const ruFrom = ru.indexOf('Текущие числа:');
const ruPara = ruFrom === -1 ? '' : ru.slice(ruFrom, ru.indexOf('\n\n', ruFrom));
const ruClaimed = {};
for (const m of ruPara.matchAll(/`([a-z][\w.-]*)` (\d+)/g)) ruClaimed[m[1]] = Number(m[2]);
const ruDiffs = Object.keys(claimed)
  .filter((k) => ruClaimed[k] !== claimed[k])
  .map((k) => k + ': EN ' + claimed[k] + ', RU ' + ruClaimed[k]);
t('числа в README_ru.md совпадают с README.md', ruDiffs.length === 0, ruDiffs.join('\n       '));
const ruTotal = (ru.match(/весь быстрый набор: (\d+) проверок/) || [])[1];
t('итог в README_ru.md совпадает с README.md', ruTotal === total,
  'EN ' + total + ', RU ' + ruTotal);

console.log('\n== README: сборка ==');
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  const exes = fs.readdirSync(dist).filter((f) => f.endsWith('.exe'));
  t('в dist есть собранный exe', exes.length > 0);
  for (const f of exes) {
    const mb = fs.statSync(path.join(dist, f)).size / 1048576;
    t('README упоминает ' + f, md.includes(f));
    const esc = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const row = (md.match(new RegExp('\\|\\s*`' + esc + '`\\s*\\|\\s*~([\\d.]+) MB')) || [])[1];
    if (row) {
      t('размер ' + f + ' в README (~' + row + ' МБ) сходится с диском (' + mb.toFixed(1) + ' МБ)',
        Math.abs(Number(row) - mb) < 0.2, 'в README ' + row + ', на диске ' + mb.toFixed(2));
    }
  }
} else {
  console.log('  --   dist нет, размеры сборки не проверяем');
}

const fontDir = path.join(ROOT, 'src', 'fonts');
if (fs.existsSync(fontDir)) {
  const woff2 = fs.readdirSync(fontDir).filter((f) => f.endsWith('.woff2'));
  const kb = Math.round(woff2.reduce((a, f) => a + fs.statSync(path.join(fontDir, f)).size, 0) / 1024);
  const faces = (read('src/fonts.css').match(/@font-face/g) || []).length;
  t('fonts.css содержит по @font-face на каждый файл шрифта', faces === woff2.length,
    faces + ' против ' + woff2.length);
  const said = md.match(/(\d+) woff2 files totalling \*\*(\d+) KB\*\*/);
  if (said) {
    t('README называет верное число файлов и вес шрифтов (' + woff2.length + ' файлов, ' + kb + ' КБ)',
      Number(said[1]) === woff2.length && Math.abs(Number(said[2]) - kb) <= 1,
      'в README ' + said[1] + ' файлов / ' + said[2] + ' КБ');
  }
  console.log('       (фактически: ' + woff2.length + ' файлов, ' + kb + ' КБ)');
}

console.log('\nитого: ' + pass + ' ok, ' + fail + ' FAIL');
if (fail) console.log('Числа проверок изменились осознанно — обнови снимок: node test/readme.test.js --update');
process.exit(fail ? 1 : 0);