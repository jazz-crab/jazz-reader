// Копирует KaTeX из node_modules в src/vendor/katex, чтобы приложение
// работало полностью офлайн (без CDN). Запускается в postinstall.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
const DST = path.join(__dirname, '..', 'src', 'vendor', 'katex');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

if (!fs.existsSync(SRC)) {
  console.error('[vendor] KaTeX не найден в', SRC, '— выполни npm install');
  process.exit(0); // не валим установку
}

fs.rmSync(DST, { recursive: true, force: true });
copyDir(SRC, DST);

// contrib/auto-render нам не нужен: формулы мы вырезаем в плейсхолдеры
// сами и рендерим точечно (так надёжнее, чем post-hoc авторендер).
fs.rmSync(path.join(DST, 'contrib'), { recursive: true, force: true });

const ver = require(path.join(SRC, '..', 'package.json')).version;
console.log('[vendor] KaTeX ' + ver + ' ->', path.relative(process.cwd(), DST));