'use strict';
/*
 * Снимает снимок чисел проверок: запускает каждый тест из scripts.test по
 * отдельности и записывает, сколько он дал.
 *
 * Снимок снимается с прогона, а не из README. Иначе проверка была бы круговой:
 * снимок записал бы то, что и так написано в README, и расхождение появилось бы
 * только после того, как кто-то поменяет сам снимок.
 *
 *   node test/readme-counts.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const script = pkg.scripts.test || '';

const files = [...new Set([...script.matchAll(/test\/([\w.-]+)\.js/g)].map((m) => m[1]))];
const counts = {};
let bad = 0;

/*
 * Имя теста в README — без расширения .test: math.test.js называется «math».
 * Иначе в списке проверок стояло бы «math.test», и это уже не то же самое имя,
 * по которому тест называется в сообщениях прогона.
 */
const logical = (file) => file.replace(/\.test$/, '');

for (const name of files) {
  const key = logical(name);
  const p = path.join(ROOT, 'test', name + '.js');
  let out = '';
  try {
    out = execFileSync('node', [p], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300000 });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
    bad++;
  }
  /*
 * В итоге считаем и успешные проверки, и неуспешные: пока README не обновлён,
 * readme.test.js падает, и снимок снялся бы на неполном наборе. Сумма не
 * зависит от того, зелёное ли дерево, — а на зелёном дереве она равна числу
 * успешных, то есть именно то, что написано в README.
 */
  const m = out.match(/итого:\s*(\d+)\s*ok,\s*(\d+)\s*FAIL/);
  if (!m) {
    console.log('  ?? ' + name + ' — не нашлась строка итога');
    bad++;
    continue;
  }
  counts[key] = Number(m[1]) + Number(m[2]);
  console.log('  ' + key + ': ' + counts[key] + (Number(m[2]) ? ' (из них упало ' + m[2] + ')' : ''));
}

const out = path.join(__dirname, 'readme-counts.json');
fs.writeFileSync(out, JSON.stringify(counts, null, 2) + '\n', 'utf8');
const sum = Object.values(counts).reduce((a, b) => a + b, 0);
console.log('\nвсего: ' + sum + ' по ' + Object.keys(counts).length + ' тестам'
  + (bad ? ', проблем: ' + bad : ''));
console.log('записано: ' + out);
process.exit(bad ? 1 : 0);