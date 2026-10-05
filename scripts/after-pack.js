'use strict';

/*
 * afterPack: подрезаем файлы Electron, которые читалке Markdown не нужны.
 * electron-builder не умеет исключать файлы самого рантайма через `files` —
 * тот фильтр действует только на исходники приложения, поэтому режем после
 * упаковки.
 *
 * Что уже делает конфиг (scripts/../package.json -> build.electronLanguages):
 *   locales/* кроме ru и en-US   ~38.9 MB распакованных
 *
 * Что НЕЛЬЗЯ вырезать, проверено экспериментально на electron 33.4.11:
 *   ffmpeg.dll — Chromium грузит его на старте ради медиа-стека, даже если
 *     читалка Markdown ни одного видео не воспроизводит. Без него процесс
 *     падает ДО выполнения main.js: ни окна, ни лога, ни единого байта в
 *     stderr. Выглядит как «программа молча ничего не делает» — ровно тот
 *     баг, который мы уже чинили. Не трогать.
 *   d3dcompiler_47.dll — fallback для GPU, без него артефакты рендера.
 *   vk_swiftshader*.dll, libGLESv2.dll, vulkan-1.dll — программный растеризатор.
 *   resources.pak, *.pak, icudtl.dat — сам браузер.
 *   snapshot_blob.bin — ускоряет старт V8.
 *   LICENSES.chromium.html (~8.8 MB) — лицензии Chromium, принято сохранять.
 *
 * Итог по размеру (win32-x64, распакованный):
 *   было 274.6 MB -> стало 232.9 MB. Остальное — JazzReader.exe (180 MB), и это
 *   сам Chromium: собственного кода в приложении всего 6.6 MB (app.asar).
 */

const fs = require('fs');
const path = require('path');

/** Языки, которые оставляем. Дублирует build.electronLanguages как страховку. */
const KEEP_LOCALES = new Set(['ru.pak', 'en-US.pak']);

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const root = context.appOutDir;
  const localesDir = path.join(root, 'locales');

  // Страховка на случай, если electronLanguages перестанет работать:
  // вырезаем лишние .pak сами. Идемпотентно — если electronLanguages уже
  // отработал, лишних файлов просто не будет.
  let saved = 0;
  let dropped = 0;
  try {
    for (const name of fs.readdirSync(localesDir)) {
      if (!name.endsWith('.pak') || KEEP_LOCALES.has(name)) continue;
      const p = path.join(localesDir, name);
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      saved += size;
      dropped++;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`  ! afterPack: locales: ${e.message}`);
  }

  if (dropped) {
    console.log(`  • afterPack: locales — вырезано ${dropped} .pak (${(saved / 1048576).toFixed(1)} MB), `
      + `оставлено ${[...KEEP_LOCALES].join(', ')}`);
  }

  // Рантайм Electron не трогаем — см. длинный комментарий выше.
};
