/*
 * i18n runtime.
 *
 * Loaded twice, by two different runtimes, from the same file:
 *   - renderer: plain <script> tag, no module system, CSP script-src 'self';
 *   - main process: require(), where it pulls the dictionaries in itself.
 * Hence the factory pattern: no top-level `require`, no imports.
 *
 * Only EN and RU, and nothing else by design: a third language is a new file
 * here plus one line in SUPPORTED.
 *
 * Missing keys do not throw. A missing key falls back to the fallback language
 * and then to the key itself, which is visible on screen but never breaks the
 * UI. Every miss is logged once so the hole is findable in the console rather
 * than in a bug report.
 */
(function (root) {
  'use strict';

  // In the main process the dictionaries are not on the page yet.
  if (typeof require === 'function' && typeof module !== 'undefined') {
    require('./ru.js');
    require('./en.js');
  }

  const DICT = root.MDV_I18N_DICT || (root.MDV_I18N_DICT = Object.create(null));

  const SUPPORTED = ['ru', 'en'];
  // Language for a system locale we do not ship. EN, because the project is
  // published: a visitor from an unsupported locale gets something readable
  // rather than a UI in a language nobody translated.
  const FALLBACK = 'en';

  const api = {
    SUPPORTED,
    FALLBACK,
    // 'auto' | 'ru' | 'en' — what the user picked, not what is in effect.
    locale: 'auto',
    // What the OS reports, resolved once.
    system: FALLBACK,
  };

  /** 'ru-RU' -> 'ru'. Anything unknown -> null, so the caller decides. */
  api.normalize = function (tag) {
    const base = String(tag || '').toLowerCase().split(/[-_.@]/)[0];
    return SUPPORTED.includes(base) ? base : null;
  };

  api.setSystemLocale = function (tag) {
    api.system = api.normalize(tag) || FALLBACK;
    return api.system;
  };

  api.setLocale = function (value) {
    api.locale = SUPPORTED.includes(value) ? value : 'auto';
    return api.lang;
  };

  /** Language actually in effect. */
  Object.defineProperty(api, 'lang', {
    get() {
      if (api.locale !== 'auto') return api.locale;
      return api.system || FALLBACK;
    },
  });

  const warned = new Set();

  /**
   * Pick a plural form for `count`.
   *
   * Russian needs one/few/many, English only one/other, so the rules come from
   * Intl rather than from a hand-rolled mod10/mod100 table. The old table was
   * correct for Russian — it handled 11 and 21 — but it hardcoded one language
   * into a string suffix, which does not survive being reused for the second
   * language, let alone a third.
   */
  function form(entry, count) {
    if (typeof entry === 'string') return entry;
    if (!entry || typeof entry !== 'object') return null;
    if (typeof count !== 'number') return entry.other || entry.many || null;
    let rule;
    try {
      rule = new Intl.PluralRules(api.lang).select(count);
    } catch (e) {
      rule = count === 1 ? 'one' : 'other';
    }
    return entry[rule] != null ? entry[rule]
      : entry.other != null ? entry.other
        : entry.many != null ? entry.many
          : null;
  }

  /** `{name}` placeholders. Not a full template engine on purpose. */
  function fill(text, params) {
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (m, name) =>
      (params[name] != null ? String(params[name]) : m));
  }

  api.t = function (key, params) {
    let entry = (DICT[api.lang] || DICT[FALLBACK] || {})[key];
    if (entry == null && api.lang !== FALLBACK) {
      entry = (DICT[FALLBACK] || {})[key];
    }
    if (entry == null) {
      if (!warned.has(key)) {
        warned.add(key);
        console.warn('[i18n] нет перевода для ключа', key, 'в языке', api.lang);
      }
      return key;
    }
    const text = form(entry, params && params.count);
    return fill(text == null ? key : text, params);
  };

  /** BCP-47 tag for <html lang>, so screen readers and fonts behave. */
  api.tag = function () {
    return api.lang === 'ru' ? 'ru' : 'en';
  };

  /**
   * Перевести атрибуты разметки, помеченные в index.html.
   *
   * title, aria-label и placeholder в HTML статичны: файл не выполняется, и
   * t() там не вызвать. Поэтому в разметке стоят ключи вида data-i18n-title,
   * а эта функция проставляет текст при первом кадре и при каждой смене языка.
   *
   * Ключи берутся из dom.js, а не из ru.js/en.js: в разметке свой набор
   * строк, и в общем словаре он был бы списком ключей, на которые никто не
   * ссылается из кода.
   */
  api.applyDom = function (root_) {
    const scope = root_ || (typeof document !== 'undefined' ? document : null);
    if (!scope) return 0;
    const domDict = root.MDV_I18N_DOM || {};
    let n = 0;
    for (const el of scope.querySelectorAll('[data-i18n-title],[data-i18n-aria],[data-i18n-placeholder]')) {
      for (const [attr, dataAttr] of [['title', 'i18nTitle'], ['aria-label', 'i18nAria'], ['placeholder', 'i18nPlaceholder']]) {
        const key = el.dataset[dataAttr];
        if (!key) continue;
        const entry = domDict[key];
        if (!entry) continue;
        const text = entry[api.lang] || entry[FALLBACK];
        if (text == null) continue;
        el.setAttribute(attr, text);
        n++;
      }
    }
    return n;
  };

  root.MDV_I18N = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);