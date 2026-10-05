'use strict';
/* Быстрая проверка mdToText вне Electron. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ee = require.resolve('electron');
require.cache[ee] = { id: ee, filename: ee, loaded: true, exports: { app: { getPath: () => os.tmpdir() } } };
global.marked = require(path.join(ROOT, 'src', 'vendor', 'marked.min.js'));
global.katex = require(path.join(ROOT, 'src', 'vendor', 'katex', 'katex.min.js'));
require(path.join(ROOT, 'src', 'icons.js'));
const MDV = require(path.join(ROOT, 'src', 'md.js'));

const BT = String.fromCharCode(96);
const src = [
  '# Заголовок',
  '',
  'Текст с **жирным** и ' + BT + 'кодом' + BT + ', ссылка [JazzReader](https://x.y) и ~~зачёркнутый~~.',
  'Экранированный \\*звёздочник\\* и \\\\ обратный слэш.',
  '',
  '- [x] сделано',
  '- [ ] не сделано',
  '  - вложенный пункт',
  '',
  '1. первый',
  '2. второй',
  '',
  '> цитата **жирная**',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  BT.repeat(3) + 'js',
  'const x = 1 < 2;',
  BT.repeat(3),
  '',
  '---',
  '',
  'Картинка ![схема](./i.png)',
  '',
].join('\n');

process.stdout.write(MDV.mdToText(src));
process.stdout.write('-----\n');
process.stdout.write(JSON.stringify(MDV.mdToText('# Только заголовок')));
process.stdout.write('\n');
process.stdout.write(JSON.stringify(MDV.mdToText('')));
process.stdout.write('\n');
