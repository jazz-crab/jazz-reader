'use strict';
/*
 * Translations for markup attributes: the keys behind data-i18n-* in index.html.
 *
 * A dictionary of its own rather than part of ru.js/en.js: these strings are
 * never called by name from code, they are found by walking the markup. Mixing
 * them into the ordinary keys would leave a list where half the entries are
 * referred to from nowhere.
 */

const DICT = {
  'brand.title': {
    ru: 'Меню: Файл, Вид, Настройки',
    en: 'Menu: File, View, Settings',
  },
  'brand.ariaShort': { ru: 'Меню', en: 'Menu' },
  'tabs.left': { ru: 'Вкладки левее', en: 'Tabs to the left' },
  'tabs.right': { ru: 'Вкладки правее', en: 'Tabs to the right' },
  'tab.newTitle': { ru: 'Новая вкладка (Ctrl+T)', en: 'New tab (Ctrl+T)' },
  'nav.back': { ru: 'Назад (Alt+←)', en: 'Back (Alt+←)' },
  'nav.forward': { ru: 'Вперёд (Alt+→)', en: 'Forward (Alt+→)' },
  'zoom.in': { ru: 'Увеличить (Ctrl++)', en: 'Zoom in (Ctrl++)' },
  'zoom.out': { ru: 'Уменьшить (Ctrl+−)', en: 'Zoom out (Ctrl+−)' },
  'zoom.input': {
    ru: 'Масштаб: впиши число, например 85 или 175 (Enter)',
    en: 'Zoom: type a number, for example 85 or 175 (Enter)',
  },
  'resizer.toc': { ru: 'Потяни, чтобы изменить ширину', en: 'Drag to change the width' },
  'resizer.files': { ru: 'Потяни, чтобы изменить ширину', en: 'Drag to change the width' },
  'resizer.split': { ru: 'Потяни, чтобы изменить ширину', en: 'Drag to change the width' },
  'toTop': { ru: 'Наверх', en: 'Back to top' },
  'view.closeRightAria': { ru: 'Закрыть правую панель', en: 'Close the right pane' },
  'tree.filter': { ru: 'Фильтр по имени…', en: 'Filter by name…' },
};

if (typeof module !== 'undefined' && module.exports) module.exports = DICT;
else (typeof globalThis !== 'undefined' ? globalThis : this).MDV_I18N_DOM = DICT;
