/*
 * Русский словарь.
 *
 * Ключи не переводятся — это идентификаторы в коде, они остаются
 * английскими. Значения — то, что видит человек.
 *
 * Множественные формы записываются объектом с подписями one/few/many/other:
 *   { one: '...', few: '...', many: '...', other: '...' }
 * Форму выбирает Intl.PluralRules (см. i18n/index.js), поэтому «21 заметке» и
 * «11 заметках» получаются сами.
 *
 * Плейсхолдеры — в фигурных скобках: {name}.
 */
(function (root) {
  const DICT = root.MDV_I18N_DICT || (root.MDV_I18N_DICT = Object.create(null));

  DICT.ru = {
    // ---- главный процесс: меню ----
    'menu.file': 'Файл',
    'menu.file.open': 'Открыть файл…',
    'menu.file.openFolder': 'Открыть папку…',
    'menu.file.save': 'Сохранить',
    'menu.file.downloadMd': 'Скачать MD',
    'menu.file.downloadHtml': 'Скачать HTML',
    'menu.file.print': 'Печать / PDF…',
    'menu.file.quit': 'Выход',

    'menu.edit': 'Правка',
    'menu.edit.undo': 'Отменить',
    'menu.edit.redo': 'Повторить',
    'menu.edit.cut': 'Вырезать',
    'menu.edit.copy': 'Копировать',
    'menu.edit.paste': 'Вставить',
    'menu.edit.selectAll': 'Выделить всё',
    'menu.edit.find': 'Найти в тексте',

    'menu.view': 'Вид',
    'menu.view.sidebar': 'Проводник',
    'menu.view.toc': 'Оглавление',
    'menu.view.editMode': 'Режим правки',
    'menu.view.cancelEdit': 'Отменить правки',
    'menu.view.back': 'Назад',
    'menu.view.forward': 'Вперёд',
    'menu.view.zoomReset': 'Масштаб 100%',
    'menu.view.zoomIn': 'Увеличить',
    'menu.view.zoomOut': 'Уменьшить',
    'menu.view.reload': 'Перезагрузить с диска',
    'menu.view.fullscreen': 'Полный экран',
    'menu.view.devtools': 'Инструменты разработчика',

    'menu.go': 'Переход',
    'menu.go.newTab': 'Новая вкладка',
    'menu.go.closeTab': 'Закрыть вкладку',
    'menu.go.nextTab': 'Следующая вкладка',
    'menu.go.prevTab': 'Предыдущая вкладка',

    'menu.help': 'Справка',
    'menu.help.about': 'О программе',

    // ---- главный процесс: диалоги ----
    'about.detail': 'Офлайн-читалка Markdown с поддержкой LaTeX (KaTeX).\n'
      + 'Работает без сети, файлы остаются на диске.\n\n'
      + 'Ctrl+O — открыть .md\nCtrl+Shift+O — открыть папку\n'
      + 'Ctrl+E — правка; выход — кнопками «Сохранить»/«Отменить»\n'
      + 'Ctrl+S — сохранить / скачать MD\n'
      + 'Ctrl+Tab — следующая вкладка, Ctrl+Shift+Tab — предыдущая\n'
      + 'ПКМ по вкладке — закрыть вкладки\n'
      + 'Alt+← / Alt+→ — назад / вперёд\n'
      + 'F5 — перезагрузить файл с диска',
    'about.ok': 'Ок',

    'quit.title': 'Закрыть?',
    'quit.message': 'Закрыть JazzReader?',
    'quit.detailDirty': {
      one: 'В {count} заметке есть несохранённые правки — они пропадут.',
      few: 'В {count} заметках есть несохранённые правки — они пропадут.',
      many: 'В {count} заметках есть несохранённые правки — они пропадут.',
      other: 'В {count} заметках есть несохранённые правки — они пропадут.',
    },
    'quit.detailClean': 'Несохранённых правок нет.',
    'quit.close': 'Закрыть',
    'quit.cancel': 'Отмена',
    'quit.neverAgain': 'Не показывать больше',

    'error.startup': 'JazzReader — ошибка при запуске',
    'error.windowFailed': 'Не удалось создать окно',

    // ---- окно настроек ----
    'settings.title': 'Настройки',
    'settings.font.label': 'Размер текста',
    'settings.font.hint': 'Тот же масштаб, что и в тулбаре.',
    'settings.width.label': 'Ширина колонки',
    'settings.width.hint': 'Узкая колонка читается спокойнее.',
    'settings.autosave.label': 'Автосохранение',
    'settings.autosave.hint': 'Выход из правки сразу пишет файл — кнопка «Сохранить» не нужна.',
    'settings.lang.label': 'Язык интерфейса',
    'settings.lang.hint': '«Как в системе» — язык, который выбран в Windows.',
    'settings.lang.auto': 'Как в системе',
    'settings.lang.ru': 'Русский',
    'settings.lang.en': 'English',
    'settings.default': 'По умолчанию',
    'settings.done': 'Готово',
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DICT.ru;
})(typeof globalThis !== 'undefined' ? globalThis : this);