'use strict';
/*
 * Переводы для атрибутов разметки: ключи из data-i18n-* в index.html.
 *
 * Отдельный словарь, а не общий ru.js/en.js: эти строки не вызываются из кода
 * по имени, а находятся по разметке. Смешивать их с обычными ключами значило бы
 * получать список, в котором половина строк нигде не упоминается.
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
