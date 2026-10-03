'use strict';
/*
 * Рендер Markdown с поддержкой LaTeX.
 *
 * ПОЧЕМУ НЕ auto-render после marked:  marked — это markdown, и он портит
 * LaTeX до неузнаваемости: `\\` -> `\`, `\{` -> `{`, `\_` -> `_`. KaTeX такое
 * не осилит. Поэтому формулы ВЫРЕЗАЮТСЯ из исходника в плейсхолдеры ДО
 * marked.parse(), а рендерятся KaTeX уже после. Код (fenced и inline)
 * при этом копируется дословно и в подстановку не попадает.
 */
(function (global) {
  const MDV = (global.MDV = global.MDV || {});

  const TOK = 'MDVMATH';        // буквы+цифры: markdown такой текст не трогает
  const TOK_RE = /MDVMATH(\d+)END/g;

  // ---------------------------------------------------------------- сканер

  /** Открывающий или закрывающий fence: до 3 пробелов, затем ` или ~ (>=3). */
  function fenceAt(src, i) {
    let p = i, spaces = 0;
    while (p < src.length && src[p] === ' ' && spaces < 4) { p++; spaces++; }
    if (spaces > 3) return null;
    const ch = src[p];
    if (ch !== '`' && ch !== '~') return null;
    let run = 0;
    while (p + run < src.length && src[p + run] === ch) run++;
    if (run < 3) return null;
    // В info-строке открывающего ``` обратных кавычек быть не должно.
    let q = p + run, ticks = 0;
    while (q < src.length && src[q] !== '\n') { if (src[q] === '`') ticks++; q++; }
    if (ch === '`' && ticks > 0) return null;
    return { marker: ch, len: run, bodyStart: q };
  }

  /** Конец fenced-блока, начиная с его открывающего fence. */
  function skipFence(src, i) {
    const f = fenceAt(src, i);
    let p = src.indexOf('\n', f.bodyStart);
    if (p === -1) p = src.length;
    p++;
    while (p <= src.length) {
      let nl = src.indexOf('\n', p);
      if (nl === -1) nl = src.length;
      const c = fenceAt(src, p);
      if (c && c.marker === f.marker && c.len >= f.len && src.slice(c.bodyStart, nl).trim() === '') {
        return nl < src.length ? nl + 1 : src.length;
      }
      p = nl + 1;
    }
    return src.length; // незакрытый fence — до конца файла
  }

  /** Конец inline-кода, если он закрыт; иначе -1. */
  function skipInlineCode(src, i) {
    let run = 0;
    while (i + run < src.length && src[i + run] === '`') run++;
    let p = i + run;
    while (p < src.length) {
      if (src[p] === '`') {
        let r = 0;
        while (p + r < src.length && src[p + r] === '`') r++;
        if (r === run) return p + r; // закрывающий ран строго той же длины
        p += r;
      } else p++;
    }
    return -1;
  }

  function escapedAt(src, i) {
    let c = 0, p = i - 1;
    while (p >= 0 && src[p] === '\\') { c++; p--; }
    return c % 2 === 1;
  }

  /** Вырезает формулы. Возвращает { text, blocks:[{tex, display}] }. */
  function extractMath(src) {
    const blocks = [];
    const out = [];
    const n = src.length;
    let plain = 0;   // начало текущего сырого куска
    let i = 0;
    let atLineStart = true;

    const flush = (end) => { if (end > plain) out.push(src.slice(plain, end)); };
    /** Заменяет src[start..end] на плейсхолдер, запоминая формулу. */
    const take = (tex, display, start, end) => {
      const idx = blocks.length;
      blocks.push({ tex, display });
      flush(start);
      out.push(TOK + idx + 'END');
      plain = end;
      i = end;
    };

    while (i < n) {
      const c = src[i];

      if (atLineStart) {
        const f = fenceAt(src, i);
        if (f) { i = skipFence(src, i); atLineStart = true; continue; }
      }

      if (c === '`') {
        const end = skipInlineCode(src, i);
        if (end !== -1) { i = end; atLineStart = false; continue; }
      }

      if (!escapedAt(src, i)) {
        // --- блочная: $$ ... $$
        if (c === '$' && src[i + 1] === '$') {
          const close = src.indexOf('$$', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), true, i, close + 2); atLineStart = false; continue; }
        }
        // --- блочная: \[ ... \]
        if (c === '\\' && src[i + 1] === '[') {
          const close = src.indexOf('\\]', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), true, i, close + 2); atLineStart = false; continue; }
        }
        // --- инлайновая: \( ... \)
        if (c === '\\' && src[i + 1] === '(') {
          const close = src.indexOf('\\)', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), false, i, close + 2); atLineStart = false; continue; }
        }
        // --- инлайновая: $ ... $ (только в пределах строки)
        if (c === '$' && src[i + 1] !== '$') {
          const nxt = src[i + 1];
          if (nxt && !/\s/.test(nxt)) {
            let j = i + 1, found = -1;
            while (j < n && src[j] !== '\n') {
              // закрывающий $: не экранирован, перед ним не пробел, после не цифра
              if (src[j] === '$' && src[j + 1] !== '$' && !escapedAt(src, j)
                  && !/\s/.test(src[j - 1]) && !/\d/.test(src[j + 1] || '')) { found = j; break; }
              j++;
            }
            if (found > i + 1) { take(src.slice(i + 1, found), false, i, found + 1); atLineStart = false; continue; }
          }
        }
      }

      if (c === '\n') atLineStart = true;
      else if (c !== ' ' && c !== '\t') atLineStart = false;
      i++;
    }
    flush(n);
    return { text: out.join(''), blocks };
  }

  // -------------------------------------------------------------- рендеринг

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  }

  function renderTex(tex, display) {
    const K = global.katex;
    const src = ' data-tex="' + escapeHtml(tex.trim()) + '"';
    if (!K) return '<code class="mdv-math-error">' + escapeHtml(tex) + '</code>';
    try {
      const body = K.renderToString(tex, {
        displayMode: display,
        throwOnError: false,  // ошибку показываем красным, страницу не роняем
        strict: false,        // разрешаем \text{Ом}, кириллицу, \, и {,} — привычка из Word
        trust: false,
      });
      return display
        ? '<div class="mdv-math mdv-math-block"' + src + '>' + body + '</div>'
        : '<span class="mdv-math mdv-math-inline"' + src + '>' + body + '</span>';
    } catch (e) {
      return '<code class="mdv-math-error" title="' + escapeHtml(String((e && e.message) || e)) + '">'
        + escapeHtml(tex) + '</code>';
    }
  }

  /** Плейсхолдеры -> отрендеренные формулы. */
  function restoreMath(html, blocks) {
    if (!blocks.length) return html;

    // Сначала блочные формулы, составляющие целый абзац: выносим из <p>,
    // иначе внутри <p> окажется div и центрирование/переносы будут кривые.
    for (let k = 0; k < blocks.length; k++) {
      if (!blocks[k].display) continue;
      const re = new RegExp('<p>(\\s*)' + TOK + k + 'END(\\s*)</p>', 'g');
      html = html.replace(re, () => renderTex(blocks[k].tex, true));
    }
    // Остальные плейсхолдеры (инлайновые и «прилипшие» к тексту блочные).
    return html.replace(TOK_RE, (m, n) => {
      const b = blocks[Number(n)];
      return b ? renderTex(b.tex, b.display) : m;
    });
  }

  // ------------------------------------------------------- URL и ссылки

  /** file:// -> путь ФС (с учётом ведущего слэша Windows). */
  function fileUrlToPath(url) {
    try {
      const u = new URL(url);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      return p;
    } catch { return null; }
  }

  /** Относительные src/href -> абсолютные; .md-ссылки помечаются data-mdpath. */
  function resolveUrls(html, baseUrl) {
    if (!baseUrl) return html;
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';

    html = html.replace(/<img\b([^>]*?)\ssrc="([^"]*)"([^>]*)>/gi, (m, a, src, c) => {
      if (/^(https?:|data:|file:)/i.test(src)) return m;
      let abs;
      try { abs = new URL(src, base).href; } catch { return m; }
      return '<img' + a + ' src="' + escapeHtml(abs) + '"' + c + '>';
    });

    html = html.replace(/<a\b([^>]*?)\shref="([^"]*)"([^>]*)>/gi, (m, a, href, c) => {
      if (/^(https?:|mailto:|file:|#)/i.test(href)) return m;
      let abs;
      try { abs = new URL(href, base).href; } catch { return m; }
      const p = fileUrlToPath(abs);
      const extra = p && /\.md$/i.test(p) ? ' data-mdpath="' + escapeHtml(p) + '"' : '';
      return '<a' + a + ' href="' + escapeHtml(abs) + '"' + c + extra + '>';
    });

    return html;
  }

  // ------------------------------------------------------- чекбоксы task-list

  /**
   * marked превращает «- [x]» / «1. [ ]» в нативный <input type="checkbox">.
   * В тёмной теме они выглядят как серые плашки из другой вселенной (и на
   * Windows вообще рисуются системным стилем, мимо CSS), поэтому заменяем их
   * на SVG-иконки Lucide: square-check-big для отмеченного и square для
   * неотмеченного. Разметка остаётся в <li>, сам input исчезает.
   *
   * Порядок атрибутов у marked бывает разным (checked="" disabled="" type=
   * и наоборот), поэтому ищем по типу, а не по точному тегу.
   */
  const INPUT_RE = /<input\b([^>]*)\btype="checkbox"([^>]*)>/g;
  const CHECKED_RE = /\bchecked\b/;

  function hasClass(attrs) {
    return /class="([^"]*)"/.exec(attrs);
  }

  function replaceCheckboxes(html) {
    const I = global.MDV_ICONS;
    return html.replace(INPUT_RE, (_m, pre, post) => {
      const attrs = pre + post;
      const done = CHECKED_RE.test(attrs);
      const cls = hasClass(attrs);
      const extra = cls ? ' ' + cls[1] : '';
      // Без icons.js (например, в node-тестах) оставляем как есть.
      if (!I || !I.icon) return _m;
      const name = done ? 'square-check-big' : 'square';
      const icon = I.icon(name, 'mdv-task' + (done ? ' mdv-task-done' : '') + extra);
      return icon ? '<span class="mdv-task-wrap">' + icon + '</span>' : _m;
    });
  }

  // ------------------------------------------------------------ публичное API

  /** src -> HTML. baseUrl — file://URL каталога файла (картинки/ссылки). */
  MDV.renderMd = function (src, baseUrl) {
    const { text, blocks } = extractMath(src);
    let html = global.marked.parse(text, { gfm: true, breaks: false });
    html = replaceCheckboxes(html);
    html = restoreMath(html, blocks);
    html = resolveUrls(html, baseUrl);
    return html;
  };

  MDV.replaceCheckboxes = replaceCheckboxes;

  MDV.extractMath = extractMath;
  MDV.restoreMath = restoreMath;
  MDV.resolveUrls = resolveUrls;
  MDV.fileUrlToPath = fileUrlToPath;
  MDV.escapeHtml = escapeHtml;
  MDV.TOK = TOK;

  if (typeof module !== 'undefined' && module.exports) module.exports = MDV;
})(typeof window !== 'undefined' ? window : globalThis);