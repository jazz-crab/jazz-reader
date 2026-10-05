/*
 * English dictionary.
 *
 * Same keys as ru.js, same structure. Kept as a separate file rather than a
 * branch in one file so a translator sees exactly the strings and nothing else.
 *
 * Plural forms: one/other is all English needs.
 */
(function (root) {
  const DICT = root.MDV_I18N_DICT || (root.MDV_I18N_DICT = Object.create(null));

  DICT.en = {
    // ---- main process: menu ----
    'menu.file': 'File',
    'menu.file.open': 'Open file…',
    'menu.file.openFolder': 'Open folder…',
    'menu.file.save': 'Save',
    'menu.file.downloadMd': 'Download Markdown',
    'menu.file.downloadHtml': 'Download HTML',
    'menu.file.print': 'Print / PDF…',
    'menu.file.quit': 'Quit',

    'menu.edit': 'Edit',
    'menu.edit.undo': 'Undo',
    'menu.edit.redo': 'Redo',
    'menu.edit.cut': 'Cut',
    'menu.edit.copy': 'Copy',
    'menu.edit.paste': 'Paste',
    'menu.edit.selectAll': 'Select all',
    'menu.edit.find': 'Find in text',

    'menu.view': 'View',
    'menu.view.sidebar': 'File explorer',
    'menu.view.toc': 'Table of contents',
    'menu.view.editMode': 'Editing mode',
    'menu.view.cancelEdit': 'Discard changes',
    'menu.view.back': 'Back',
    'menu.view.forward': 'Forward',
    'menu.view.zoomReset': 'Actual size',
    'menu.view.zoomIn': 'Zoom in',
    'menu.view.zoomOut': 'Zoom out',
    'menu.view.reload': 'Reload from disk',
    'menu.view.fullscreen': 'Full screen',
    'menu.view.devtools': 'Developer tools',

    'menu.go': 'Go',
    'menu.go.newTab': 'New tab',
    'menu.go.closeTab': 'Close tab',
    'menu.go.nextTab': 'Next tab',
    'menu.go.prevTab': 'Previous tab',

    'menu.help': 'Help',
    'menu.help.about': 'About',

    // ---- main process: dialogs ----
    'about.detail': 'Offline Markdown reader with LaTeX support (KaTeX).\n'
      + 'Runs without a network; your files stay on disk.\n\n'
      + 'Ctrl+O — open a .md file\nCtrl+Shift+O — open a folder\n'
      + 'Ctrl+E — edit mode; leave it with Save/Discard\n'
      + 'Ctrl+S — save / download Markdown\n'
      + 'Ctrl+Tab — next tab, Ctrl+Shift+Tab — previous tab\n'
      + 'Right-click a tab — close tabs\n'
      + 'Alt+← / Alt+→ — back / forward\n'
      + 'F5 — reload the file from disk',
    'about.ok': 'OK',

    'quit.title': 'Quit?',
    'quit.message': 'Quit JazzReader?',
    'quit.detailDirty': {
      one: '{count} note has unsaved changes — it will be lost.',
      other: '{count} notes have unsaved changes — they will be lost.',
    },
    'quit.detailClean': 'No unsaved changes.',
    'quit.close': 'Quit',
    'quit.cancel': 'Cancel',
    'quit.neverAgain': "Don't ask again",

    'error.startup': 'JazzReader — failed to start',
    'error.windowFailed': 'Could not create the window',

    // ---- settings dialog ----
    'settings.title': 'Settings',
    'settings.font.label': 'Text size',
    'settings.font.hint': 'The same scale as in the toolbar.',
    'settings.width.label': 'Column width',
    'settings.width.hint': 'A narrow column is easier to read.',
    'settings.autosave.label': 'Autosave',
    'settings.autosave.hint': 'Leaving edit mode writes the file straight away, so Save is not needed.',
    'settings.lang.label': 'Interface language',
    'settings.lang.hint': '"Match the system" follows the language chosen in Windows.',
    'settings.lang.auto': 'Match the system',
    'settings.lang.ru': 'Русский',
    'settings.lang.en': 'English',
    'settings.default': 'Default',
    'settings.done': 'Done',
    'unit.b': 'B',
    'unit.kb': 'KB',
    'unit.mb': 'MB',
    'btn.close': 'Close',
    'btn.cancel': 'Cancel',
    'btn.ok': 'OK',
    'status.savedEllipsis': 'Saved…',
    'status.opening': 'Opening…',
    'tab.new': 'New tab',
    'discard.title': 'Save changes?',
    'btn.save': 'Save',
    'discard.inFile': 'In “',
    'discard.hasChanges': '” there are unsaved changes.',
    'discard.withoutSaving': 'Close without saving',
    'discard.tailHasChanges': '” there are unsaved changes. ',
    'discard.willBeLost': 'Without saving they will be lost.',
    'btn.discard': 'Discard',
    'status.editsDiscarded': 'Changes discarded',
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = DICT.en;
})(typeof globalThis !== 'undefined' ? globalThis : this);