'use strict';
/*
 * Проверка именно запакованной сборки: запускаем бинарник из dist
 * с --remote-debugging-port и опрашиваем живое окно через CDP.
 * Это ловит то, что не ловят тесты на исходниках (asar-пути, шрифты из
 * архива, отсутствующие файлы в пакете).
 */
const { spawn } = require('child_process');
const http = require('http');

const BIN = process.argv[2];
const SAMPLE = process.argv[3];
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  if (!BIN) { console.error('укажи путь к бинарнику'); process.exit(2); }
  const child = spawn(BIN, ['--no-sandbox', '--disable-gpu', '--mdview-hidden',
    '--remote-debugging-port=' + PORT, SAMPLE], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await getTargets();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch {}
  }
  if (!target) {
    console.log('НЕ УДАЛОСЬ ПОДКЛЮЧИТЬСЯ CDP');
    console.log(out.slice(0, 2000));
    child.kill('SIGKILL');
    process.exit(1);
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) => new Promise((resolve) => {
    const mid = ++id;
    pending.set(mid, resolve);
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };

  const expr = `(async () => {
    await new Promise(r => setTimeout(r, 1500));
    const c = document.getElementById('content');
    return {
      title: document.title,
      file: document.getElementById('fileName').textContent,
      katex: document.querySelectorAll('#content .katex').length,
      mathErrors: document.querySelectorAll('#content .mdv-math-error').length,
      blocks: document.querySelectorAll('#content .mdv-math-block').length,
      toc: document.querySelectorAll('#paneToc .toc-item').length,
      contentH: c ? c.clientHeight : 0,
      welcomeHidden: document.querySelector('.welcome').hidden,
      nerdFont: document.fonts.check('12px JetBrainsMonoNF'),
      katexFont: document.fonts.check('12px KaTeX_Main'),
      placeholder: /MDVMATH\\\\d+END/.test(c ? c.innerHTML : ''),
      status: document.getElementById('statusText').textContent
    };
  })()`;

  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log('\n=== ЗАПАКОВАННАЯ СБОРКА ===');
  console.log(JSON.stringify(r.result && r.result.result ? r.result.result.value : r, null, 2));

  ws.close();
  child.kill('SIGKILL');
  await sleep(300);
  process.exit(0);
})();