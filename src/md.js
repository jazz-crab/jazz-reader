'use strict';
/*
 * Markdown rendering with LaTeX support.
 *
 * WHY NOT auto-render after marked: marked is markdown, and it mangles LaTeX
 * beyond recognition: `\\` -> `\`, `\{` -> `{`, `\_` -> `_`. KaTeX cannot
 * cope with that. So the formulas are CUT OUT of the source into placeholders
 * BEFORE marked.parse(), and rendered by KaTeX afterwards. Code (fenced and
 * inline) is copied verbatim and never reaches the substitution.
 */
(function (global) {
  const MDV = (global.MDV = global.MDV || {});

  const TOK = 'MDVMATH';        // letters+digits: markdown leaves such text alone
  const TOK_RE = /MDVMATH(\d+)END/g;

  // ---------------------------------------------------------------- scanner

  /** An opening or closing fence: up to 3 spaces, then ` or ~ (3 or more). */
  function fenceAt(src, i) {
    let p = i, spaces = 0;
    while (p < src.length && src[p] === ' ' && spaces < 4) { p++; spaces++; }
    if (spaces > 3) return null;
    const ch = src[p];
    if (ch !== '`' && ch !== '~') return null;
    let run = 0;
    while (p + run < src.length && src[p + run] === ch) run++;
    if (run < 3) return null;
    // The info string of an opening ``` must not contain backticks.
    let q = p + run, ticks = 0;
    while (q < src.length && src[q] !== '\n') { if (src[q] === '`') ticks++; q++; }
    if (ch === '`' && ticks > 0) return null;
    return { marker: ch, len: run, bodyStart: q };
  }

  /** The end of a fenced block, starting from its opening fence. */
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
    return src.length; // unclosed fence — to the end of the file
  }

  /** The end of inline code if it is closed; otherwise -1. */
  function skipInlineCode(src, i) {
    let run = 0;
    while (i + run < src.length && src[i + run] === '`') run++;
    let p = i + run;
    while (p < src.length) {
      if (src[p] === '`') {
        let r = 0;
        while (p + r < src.length && src[p + r] === '`') r++;
        if (r === run) return p + r; // the closing run is exactly the same length
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

  /** Cut out the formulas. Returns { text, blocks:[{tex, display}] }. */
  function extractMath(src) {
    const blocks = [];
    const out = [];
    const n = src.length;
    let plain = 0;   // start of the current raw chunk
    let i = 0;
    let atLineStart = true;

    const flush = (end) => { if (end > plain) out.push(src.slice(plain, end)); };
    /** Replaces src[start..end] with a placeholder, remembering the formula. */
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
        // --- block: $$ ... $$
        if (c === '$' && src[i + 1] === '$') {
          const close = src.indexOf('$$', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), true, i, close + 2); atLineStart = false; continue; }
        }
        // --- block: \[ ... \]
        if (c === '\\' && src[i + 1] === '[') {
          const close = src.indexOf('\\]', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), true, i, close + 2); atLineStart = false; continue; }
        }
        // --- inline: \( ... \)
        if (c === '\\' && src[i + 1] === '(') {
          const close = src.indexOf('\\)', i + 2);
          if (close !== -1) { take(src.slice(i + 2, close), false, i, close + 2); atLineStart = false; continue; }
        }
        // --- inline: $ ... $ (only within the line)
        if (c === '$' && src[i + 1] !== '$') {
          const nxt = src[i + 1];
          if (nxt && !/\s/.test(nxt)) {
            let j = i + 1, found = -1;
            while (j < n && src[j] !== '\n') {
              // closing $: not escaped, no space before it, no digit after it
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

  // --------------------------------------------------------------- rendering

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
        throwOnError: false,  // show the error in red rather than breaking the page
        strict: false,        // allow \text{Om}, Cyrillic, \, and {,} — a habit from Word
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

  /** Placeholders -> rendered formulas. */
  function restoreMath(html, blocks) {
    if (!blocks.length) return html;

    // Block formulas that make up a whole paragraph come first: they are taken
    // out of <p>, otherwise a div ends up inside <p> and the centring and line
    // breaks come out wrong.
    for (let k = 0; k < blocks.length; k++) {
      if (!blocks[k].display) continue;
      const re = new RegExp('<p>(\\s*)' + TOK + k + 'END(\\s*)</p>', 'g');
      html = html.replace(re, () => renderTex(blocks[k].tex, true));
    }
    // The remaining placeholders (inline ones and block ones stuck to text).
    return html.replace(TOK_RE, (m, n) => {
      const b = blocks[Number(n)];
      return b ? renderTex(b.tex, b.display) : m;
    });
  }

  // ------------------------------------------------------ URLs and links

  /** file:// -> file system path (accounting for the leading Windows slash). */
  function fileUrlToPath(url) {
    try {
      const u = new URL(url);
      let p = decodeURIComponent(u.pathname);
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      return p;
    } catch { return null; }
  }

  /** Relative src/href -> absolute; .md links get data-mdpath. */
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

  // ------------------------------------------------------ task-list checkboxes

  /**
   * marked turns "- [x]" / "1. [ ]" into a native <input type="checkbox">.
   * In the dark theme they look like grey slabs from another universe (and on
   * Windows they are drawn in the system style, past the CSS), so we replace
   * them with Lucide SVG icons: square-check-big for checked and square for
   * unchecked. The markup stays in <li>, the input itself disappears.
   *
   * The attribute order from marked varies (checked="" disabled="" type=
   * and the other way round), so we search by type rather than by exact tag.
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
      // Without icons.js (in node tests, for instance) leave it as it is.
      if (!I || !I.icon) return _m;
      const name = done ? 'square-check-big' : 'square';
      const icon = I.icon(name, 'mdv-task' + (done ? ' mdv-task-done' : '') + extra);
      return icon ? '<span class="mdv-task-wrap">' + icon + '</span>' : _m;
    });
  }

  // -------------------------------------------------------------- public API

  /** src -> HTML. baseUrl is the file:// URL of the file's folder (images/links). */
  MDV.renderMd = function (src, baseUrl) {
    const { text, blocks } = extractMath(src);
    let html = global.marked.parse(text, { gfm: true, breaks: false });
    html = replaceCheckboxes(html);
    html = restoreMath(html, blocks);
    html = resolveUrls(html, baseUrl);
    return html;
  };

  /**
   * Markup -> plain text.
   *
   * For the TXT export. Not "strip the tags from the HTML": in a TXT a person
   * expects text that can be read in a notepad — no hashes, asterisks, backticks
   * or underscores. Lists stay lists, tables become tabs, links become their
   * text, images become a caption, code stays code.
   *
   * A heuristic, not a parser: there is nothing to parse non-standard markup
   * with, and there is nothing to invent here.
   */
  const ESC_MARK = '\uE000';

  function plainInline(src) {
    let x = String(src);
    // Escaped characters: \* does not start emphasis. We hide them behind a
    // private-use character, which does not occur in a note.
    const esc = [];
    x = x.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, (_m, c) => {
      esc.push(c);
      return ESC_MARK + (esc.length - 1) + ESC_MARK;
    });
    x = x.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
    x = x.replace(/!\[([^\]]*)\]\[[^\]]*\]/g, '$1');
    x = x.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    x = x.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1');
    x = x.replace(/<\/?[A-Za-z][^>]*>/g, '');
    x = x.replace(/`+/g, '');
    x = x.replace(/(\*\*\*|\*\*|\*|___|__|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2');
    x = x.replace(/[ \t]+$/g, '');
    return x.replace(new RegExp(ESC_MARK + '(\\d+)' + ESC_MARK, 'g'),
      (_m, n) => esc[+n]);
  }

  function mdToText(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let fence = '';
    let inTable = false;

    const flushTable = () => {
      if (inTable) { out.push(''); inTable = false; }
    };

    for (const raw of lines) {
      const f = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
      if (fence) {
        if (f && raw.trim().startsWith(fence)) { fence = ''; out.push(''); continue; }
        out.push(raw);
        continue;
      }
      if (f) { flushTable(); fence = f[1].replace(/[`~]/g, ''); out.push(''); continue; }

      // A horizontal rule: there is nothing for it to correspond to in text.
      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(raw)) { flushTable(); out.push(''); continue; }

      // A table: the separator row is dropped, the cells are glued with a tab.
      if (raw.includes('|') && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(raw)) continue;
      if (raw.includes('|') && /^\s*\|/.test(raw)) {
        inTable = true;
        out.push(raw.replace(/^\s*\|/, '').replace(/\|\s*$/, '')
          .split('|').map((c) => plainInline(c.trim())).join('\t'));
        continue;
      }
      flushTable();

      const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
      if (h) { out.push(plainInline(h[2])); continue; }

      let line = raw.replace(/^\s{0,3}>\s?/, '');
      // A task: a checkbox is more useful in text than an empty bracket.
      line = line.replace(/^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s+/, '$1- [$3] ');
      line = line.replace(/^(\s*)([-*+]|\d+[.)])\s+/, '$1- ');
      out.push(plainInline(line));
    }

    return out.join('\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  }

  MDV.mdToText = mdToText;

  MDV.replaceCheckboxes = replaceCheckboxes;

  MDV.extractMath = extractMath;
  MDV.restoreMath = restoreMath;
  MDV.resolveUrls = resolveUrls;
  MDV.fileUrlToPath = fileUrlToPath;
  MDV.escapeHtml = escapeHtml;
  MDV.TOK = TOK;

  if (typeof module !== 'undefined' && module.exports) module.exports = MDV;
})(typeof window !== 'undefined' ? window : globalThis);