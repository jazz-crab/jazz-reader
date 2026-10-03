'use strict';
/* ============================================================================
 *  MDView — renderer. Вкладки, дерево папок, оглавление, история навигации.
 * ========================================================================== */

const api = window.mdv;

/** SVG-иконки Lucide (модуль генерирует scripts/vendor.js). */
const ICONS = window.MDV_ICONS;

const $ = (id) => document.getElementById(id);
const el = {
  tabbar: $('tabbar'), tabs: $('tabs'), btnNewTab: $('btnNewTab'),
  appBrand: $('appBrand'), tabsWrap: $('tabsWrap'),
  tabsLeft: $('tabsLeft'), tabsRight: $('tabsRight'),
  loading: $('loading'), loadingText: $('loadingText'), loadingSub: $('loadingSub'),
  btnBack: $('btnBack'), btnForward: $('btnForward'),
  btnMode: $('btnMode'), btnSave: $('btnSave'), btnCancelEdit: $('btnCancelEdit'),
  btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), zoomVal: $('zoomVal'),
  dlBtn: $('dlBtn'), dlMenu: $('dlMenu'), btnSidebar: $('btnSidebar'),
  btnToc: $('btnToc'),
  welcome: $('welcome'), wOpenFile: $('wOpenFile'), wOpenFolder: $('wOpenFolder'),
    workspace: $('workspace'),
    tocSide: $('tocSide'), filesSide: $('filesSide'),
    tocResizer: $('tocResizer'), filesResizer: $('filesResizer'),
    topbar: document.querySelector('.topbar'),
    split: $('split'), splitDivider: $('splitDivider'),
    panel2: $('panel2'), content2: $('content2'), secondTitle: $('secondTitle'),
  paneFiles: $('paneFiles'), paneToc: $('paneToc'), treeFilter: $('treeFilter'),
  content: $('content'), editor: $('editor'), toTop: $('toTop'),
  statusbar: $('statusbar'), statusText: $('statusText'), fileName: $('fileName'),
  modeDock: $('modeDock'),
  dropOverlay: $('dropOverlay'),
};

// --------------------------------------------------------------- состояние

let seq = 0;
/** @type {Map<number, object>} */
const tabs = new Map();
let activeId = null;
/** Вкладка в правой панели разделения. null — экран не разделён.
 *  Сама вкладка живёт в общем tabs: полоса вкладок одна на обе панели. */
let secondId = null;

/** стек посещённых вкладок — чтобы Alt+←/→ работали как в браузере */
let visit = [];
let visitPos = -1;
/** открытые корневые папки: [{path, name, tree:[], total}] */
const roots = [];
let zoom = 1;
let statusTimer = null;
let findBar = null;

function active() { return tabs.get(activeId) || null; }

/** Переключение вкладки. touch=false — не двигать позицию в стеке посещений. */
function selectTab(id, touch) {
  if (!tabs.has(id)) return;
  // Клик по вкладке правой панели: она и так на виду, и ждёшь, что окажется
  // в рабочей области. Меняем панели местами — иначе справа оказалась бы та
  // же заметка, что и слева, то есть ничего.
  if (secondId !== null && id === secondId) {
    if (active()) active().scroll = el.content.scrollTop;
    secondId = activeId;
    activeId = id;
    renderTabs();
    renderActive();
    renderSecond();
    updateNavButtons();
    return;
  }
  if (active()) active().scroll = el.content.scrollTop;
  activeId = id;
  if (touch !== false) {
    const i = visit.indexOf(id);
    if (i >= 0) visit.splice(i, 1);
    visit.push(id);
    visitPos = visit.length - 1;
  }
  // Переключились на другую вкладку — незавершённая загрузка первой больше
  // не актуальна, иначе индикатор остался бы висеть поверх готового текста.
  // Счётчик загрузки loadSeq здесь трогать НЕЛЬЗЯ: по нему openPath()
  // понимает, что его вытеснил более новый запрос, а blankTab() внутри
  // openPath() вызывает selectTab() совершенно штатно.
  hideLoading();
  renderTabs();
  renderActive();
  updateNavButtons();
}

/** Alt+←/→, когда история документа исчерпана: шаг по стеку вкладок. */
function cycleTab(dir) {
  if (visit.length < 2) return;
  const ni = visitPos + dir;
  if (ni < 0 || ni >= visit.length) return;
  visitPos = ni;
  selectTab(visit[ni], false);
}

/**
 * Ctrl+Tab / Ctrl+Shift+Tab — по ПОРЯДКУ вкладок, а не по истории
 * посещений. Раньше обе комбинации шли в cycleTab(), то есть по стеку
 * visit: туда-сюда-обратно, а ожидаешь спокойного шага «следующая/предыдущая».
 * По кругу: с последней вкладки переходим на первую.
 */
function stepTab(dir) {
  const ids = [...tabs.keys()];
  if (ids.length < 2) return;
  const i = ids.indexOf(activeId);
  if (i === -1) { selectTab(ids[0]); return; }
  const n = (i + dir + ids.length) % ids.length;
  selectTab(ids[n]);
}

// ------------------------------------------------------------------ утилиты

/**
 * Сообщение в правом углу нижней панели.
 * kind: 'ok' — зелёный (сохранено), 'warn' — жёлтый (правки отменены, файл
 * не тронут), 'err' — красный. Раньше отмена правок не имела своего цвета и
 * выглядела как обычное нейтральное сообщение, хотя это потеря работы.
 */
function status(msg, kind) {
  clearTimeout(statusTimer);
  el.statusText.textContent = msg;
  el.statusbar.className = 'statusbar' + (kind ? ' ' + kind : '');
  if (kind === 'err') {
    statusTimer = setTimeout(() => { el.statusbar.className = 'statusbar'; }, 6000);
  } else if (kind === 'warn') {
    statusTimer = setTimeout(() => { el.statusbar.className = 'statusbar'; }, 6000);
  }
}

function fmtSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' КБ';
  return (b / 1048576).toFixed(1) + ' МБ';
}

function basname(p) {
  const parts = String(p).split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function dirOf(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '';
}

/**
 * Диалог подтверждения без window.confirm (его в Electron нет).
 *
 * Собран на общих modalShell/modalBox, а не на inline-стилях, как раньше:
 * иначе он выглядел не как остальные окна приложения — другой шрифт, другие
 * отступы, без крестика.
 *
 * opts:
 *   note        — пояснение под заголовком (что именно будет потеряно)
 *   okClass     — 'primary' | 'danger' | '' (обычная кнопка)
 *   cancelText  — текст второй кнопки
 *   closeIsNo  — крестик и Esc означают «Нет» (по умолчанию).
 *                 Для «Сохранить правки?» это НЕ так: крестик должен просто
 *                 закрыть вопрос и вернуть в правку, иначе он уничтожал бы
 *                 несохранённое одним нажатием.
 *   xButton     — показывать ли крестик
 */
function askConfirm(title, okText, opts) {
  // Тесты подменяют ответ, чтобы не открывать диалог.
  // null из хука — «закрыли без ответа» (крестик или Esc при closeIsNo:false),
  // поэтому !! здесь нельзя: он превратил бы null в false, то есть в
  // «выбросить правки».
  if (__confirmHook) return Promise.resolve(__confirmHook(title, okText));
  const o = opts || {};
  const back = modalShell();
  const box = modalBox(null, 430, 0);
  // Коробку нужно прикрепить к подложке: modalShell() создаёт только её саму.
  back.append(box);
  let resolve;

  const head = document.createElement('div');
  head.className = 'dlg-head';
  if (o.xButton !== false) {
    const x = document.createElement('button');
    x.className = 'dlg-x';
    x.title = 'Закрыть';
    x.innerHTML = ICONS.icon('x');
    x.onclick = () => done(o.closeIsNo ? false : null);
    head.append(x);
  }
  const msg = document.createElement('div');
  msg.className = 'dlg-msg';
  msg.textContent = title;
  head.append(msg);
  box.append(head);

  if (o.note) {
    const note = document.createElement('div');
    note.className = 'dlg-note';
    note.textContent = o.note;
    box.append(note);
  }

  const row = document.createElement('div');
  row.className = 'dlg-row';
  const mk = (label, cls) => {
    const b = document.createElement('button');
    b.className = 'dlgbtn' + (cls ? ' dlgbtn-' + cls : '');
    b.textContent = label;
    return b;
  };
  const no = mk(o.cancelText || 'Отмена', '');
  const yes = mk(okText || 'ОК', o.okClass || '');
  no.onclick = () => done(false);
  yes.onclick = () => done(true);
  row.append(no, yes);
  box.append(row);

  document.body.append(back);

  let closed = false;
  function done(v) {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
    // null — «закрыли, не ответив»: вызывающий обязан трактовать это как
    // «ничего не делать», а не как «нет».
    resolve(v);
  }
  const onKey = (e) => {
    // См. комментарий в wireModal: узел могли снести извне, и тогда этот
    // слушатель цеплялся за каждый последующий Enter и Escape в приложении.
    if (!back.isConnected) {
      document.removeEventListener('keydown', onKey, true);
      return;
    }
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); done(o.closeIsNo ? false : null); }
    else if (e.key === 'Enter') { e.stopPropagation(); e.preventDefault(); done(true); }
  };
  document.addEventListener('keydown', onKey, true);
  wireModal(back, yes);
  return new Promise((r) => { resolve = r; });
}

/**
 * Общие кирпичики модальных окон: подложка, коробка с заголовком, закрытие
 * по Esc и клику мимо. askConfirm живёт отдельно — он возвращает промис и
 * сам решает, что нажали.
 *
 * back._onCancel вызывается при закрытии БЕЗ сохранения (Esc, клик мимо) —
 * настройки этим откатывают предпросмотр.
 */
function modalShell() {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back._onCancel = null;
  return back;
}

function modalBox(title, width, height) {
  const box = document.createElement('div');
  box.className = 'modal-box';
  if (width) box.style.width = width + 'px';
  if (height) box.style.maxHeight = height + 'px';
  if (title) {
    const h = document.createElement('div');
    h.className = 'modal-title';
    h.textContent = title;
    box.append(h);
  }
  return box;
}

/** Закрытие по Esc и клику мимо. Возвращает close(cancelled). */
function wireModal(back, focusTarget) {
  const close = (cancelled) => {
    if (cancelled && back._onCancel) back._onCancel();
    back.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    // Окно могли закрыть иначе, чем через close(): снести узел извне. Тогда
    // наш слушатель остаётся висеть на document и следующий Escape во всём
    // приложении «закрывает» несуществующее окно — у настроек это откат
    // только что подтверждённых значений. Проверяем, что узел ещё в документе,
    // и заодно снимаем с себя слушатель: дальше он не нужен.
    if (!back.isConnected) {
      document.removeEventListener('keydown', onKey, true);
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    close(true);
  };
  back.addEventListener('mousedown', (e) => {
    // Только клик по самой подложке: клик внутри коробки не закрывает.
    if (e.target === back) close(true);
  });
  document.addEventListener('keydown', onKey, true);
  const f = typeof focusTarget === 'function' ? focusTarget() : focusTarget;
  if (f && f.focus) f.focus();
  return close;
}

/**
 * Короткий алиас status(). Второй аргумент ОБЯЗАТЕЛЬНО пробрасываем:
 * раньше toast(msg) принимал только текст, и все вызовы вида
 * toast('Сохранено: ...', 'ok') молча теряли цвет — сообщение выводилось
 * серым вместо зелёного.
 */
function toast(msg, kind) { status(msg, kind); }

// ------------------------------------------------------- индикатор загрузки

let loadSeq = 0;

/**
 * Открытие большой заметки занимает доли секунды: чтение, рендер Markdown и
 * вставка в DOM. Без индикатора окно выглядит просто зависшим, поэтому
 * показываем его ДО чтения и прячем только после того, как кадр с содержимым
 * ушёл на экран.
 *
 * requestAnimationFrame в свёрнутом или скрытом окне не срабатывает (так
 * работает и наш собственный --mdview-hidden), поэтому ждём кадр, но
 * страхуемся таймером: иначе openPath() навечно завис бы на скрытом окне.
 */
function nextPaint() {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => setTimeout(fin, 0));
    setTimeout(fin, 60);
  });
}

function showLoading(text, sub) {
  el.loadingText.textContent = text || 'Открываю…';
  el.loadingSub.textContent = sub || '';
  el.loading.hidden = false;
}

function hideLoading() {
  el.loading.hidden = true;
  el.loadingText.textContent = 'Открываю…';
  el.loadingSub.textContent = '';
}

// ------------------------------------------------------------------- вкладки

function newTab() {
  const id = ++seq;
  tabs.set(id, {
    id, path: null, name: 'Новая вкладка', raw: '', html: null,
    dirty: false, mode: 'read', baseUrl: '', encoding: '', size: 0,
    // blank: пользователь явно попросил новую пустую вкладку -> показывать
    // дефолтную заглушку, даже если папка уже открыта.
    blank: true,
    hist: [], hi: -1, scroll: 0,
  });
  selectTab(id);
  return tabs.get(id);
}

async function closeTab(id, opts) {
  const t = tabs.get(id);
  if (!t) return false;
  // Вкладку правой панели закрыли — панели больше нечего показывать.
  // Проверяем здесь, до вопроса про правки: иначе «Сохранить» закрыл бы
  // вкладку, а панель осталась бы висеть с чужим текстом.
  const wasSecond = secondId === id;
  // silent — массовое закрытие («все кроме этой», «все справа»): не засоряем
  // экран пятью одинаковыми вопросами подряд. Но несохранённое не теряем:
  // такие вкладки просто не закрываем и сообщаем, сколько осталось.
  if (t.dirty) {
    if (opts && opts.silent) return false;
    const answer = await askConfirm(
      'Сохранить правки?',
      'Сохранить',
      {
        note: 'В «' + t.name + '» есть несохранённые изменения.',
        okClass: 'primary',
        cancelText: 'Закрыть без сохранения',
        closeIsNo: false,
      }
    );
    // null — крестик: вопрос закрыт, вкладка остаётся на месте.
    if (answer === null) return false;
    if (answer === true) {
      await saveTab(t);
      tabs.delete(id);
      if (activeId === id) {
        const rest = [...tabs.keys()];
        activeId = rest.length ? rest[rest.length - 1] : null;
        if (activeId === null) newTab();
        else selectTab(activeId);
      }
      if (wasSecond) { secondId = null; renderSecond(); }
      renderTabs();
      renderActive();
      return true;
    }
  }
  tabs.delete(id);
  if (wasSecond) { secondId = null; renderSecond(); }
  if (activeId === id) {
    const rest = [...tabs.keys()];
    activeId = null;
    if (rest.length) selectTab(rest[rest.length - 1]);
    else { newTab(); }
  } else {
    renderTabs();
  }
  refreshTreeSelection();
  return true;
}

/** Перерисовать подсветку открытых файлов в дереве (дешёво, без сборки дерева заново). */
function refreshTreeSelection() {
  const cur = active() ? active().path : null;
  for (const row of el.paneFiles.querySelectorAll('.tree-item')) {
    const full = row.dataset.path || '';
    const isCur = samePath(cur, full);
    const openInSome = isCur || [...tabs.values()].some((x) => samePath(x.path, full));
    row.classList.toggle('is-open', openInSome);
    row.classList.toggle('active', isCur);
    // Подсказку держим только пока файл открыт в НЕактивной вкладке
    row.title = openInSome && !isCur ? full + ' — открыт в другой вкладке' : full;
  }
}

/** Контекстное меню вкладки (ПКМ): закрыть / остальные / справа / слева / все. */
/** Массовое закрытие: несохранённые пропускаем, а не теряем. */
async function closeMany(list, keepId) {
  let closed = 0, skipped = 0;
  for (const k of list) {
    if (k === keepId) continue;
    const t = tabs.get(k);
    if (t && t.dirty) { skipped++; continue; }
    if (await closeTab(k, { silent: true })) closed++;
  }
  if (skipped) {
    status('Закрыто ' + closed + ', с несохранёнными пропущено: ' + skipped
      + ' — сохрани или отмени в них', 'err');
  } else if (closed) {
    status('Закрыто вкладок: ' + closed, 'ok');
  }
  if (keepId !== undefined && tabs.has(keepId)) selectTab(keepId);
  return closed;
}
function closeOthers(id) {
  return closeMany([...tabs.keys()], id);
}
function closeToRight(id) {
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  if (i < 0) return Promise.resolve(0);
  return closeMany(ids.slice(i + 1), id);
}
function closeToLeft(id) {
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  if (i < 0) return Promise.resolve(0);
  return closeMany(ids.slice(0, i), id);
}
async function closeAll() {
  const ids = [...tabs.keys()];
  for (const k of ids) {
    const t = tabs.get(k);
    if (t && t.dirty) {
      const answer = await askConfirm(
        'Сохранить правки?',
        'Сохранить',
        {
          note: 'В «' + t.name + '» есть несохранённые изменения.',
          okClass: 'primary',
          cancelText: 'Закрыть без сохранения',
          closeIsNo: false,
        }
      );
      if (answer === null) return;
      if (answer === true) await saveTab(t);
    }
  }
  for (const k of ids) await closeTab(k, { silent: true });
  if (!tabs.size) newTab();
}

/**
 * Общее контекстное меню: {label, hint, act, off} и {sep:true}.
 * Один код и для вкладки, и для файла в дереве — иначе две копии разъедутся.
 */
function showContextMenu(x, y, items, opts) {
  const o = opts || {};
  // Подменю не выкидывает родителя: галочки «Вид» должны остаться на месте,
  // пока курсор над цепочкой. Флаг ставим ДО чистки — иначе подменю успевает
  // снести меню, из которого его открыли, и вместо двух меню остаётся одно.
  if (o.parent && o.keepParent) o.parent._keep = true;
  for (const c of document.querySelectorAll('.ctxmenu')) if (!c._keep) c.remove();
  const w = o.width || 232;
  const h = o.height || (items.length * 30 + 14);

  const m = document.createElement('div');
  m.className = 'ctxmenu';
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';

  /*
   * Элемент меню:
   *   check: true|false — галочка, пункт-переключатель в подменю «Вид»
   *   items: [...]      — подменю, раскрывается вправо по наведению
   *   off               — пункт неактивен
   */
  const closeAll = () => {
    for (const c of document.querySelectorAll('.ctxmenu')) c.remove();
    document.removeEventListener('mousedown', kill, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('keydown', onEsc);
  };

  for (const it of items) {
    if (it.sep) {
      const s = document.createElement('div');
      s.className = 'ctxmenu-sep';
      m.append(s);
      continue;
    }
    const b = document.createElement('button');
    b.className = 'ctxmenu-item' + (it.danger ? ' ctxmenu-danger' : '');
    b.disabled = !!it.off;

    const l = document.createElement('span');
    l.className = 'ctxmenu-label';
    if (it.check !== undefined) {
      const tick = document.createElement('span');
      tick.className = 'ctxmenu-check';
      tick.textContent = it.check ? '✓' : '';
      l.append(tick);
    }
    l.append(document.createTextNode(it.label));
    const hn = document.createElement('span');
    hn.className = 'ctxmenu-hint';
    hn.textContent = it.hint !== undefined ? it.hint : (it.items ? '\u203a' : '');
    b.append(l, hn);

    if (it.items) {
      // Подменю держим открытым, пока курсор над цепочкой.
      b.classList.add('ctxmenu-parent');
      let sub = null;
      b.onmouseenter = () => {
        if (sub) return;
        const r = b.getBoundingClientRect();
        sub = showContextMenu(r.right - 4, r.top - 5, it.items, {
          width: o.subWidth || 232, parent: m, keepParent: true,
        });
      };
      b.onclick = (e) => e.stopPropagation();
    } else {
      b.onclick = () => { closeAll(); it.act(); };
    }
    m.append(b);
  }

  document.body.append(m);
  if (o.parent && o.keepParent) o.parent._keep = true;
  // Клик мимо закрывает всю цепочку. Клик внутри подменю не закрывает:
  // подменю — отдельный .ctxmenu, и e.target.closest('.ctxmenu') его найдёт.
  const kill = (e) => {
    if (!e.target.closest || !e.target.closest('.ctxmenu')) closeAll();
  };
  // По Esc меню закрывается — иначе после ПКМ его нечем убрать с клавиатуры.
  const onEsc = (e) => {
    if (e.key !== 'Escape') return;
    closeAll();
  };
  const onBlur = () => closeAll();
  setTimeout(() => {
    document.addEventListener('mousedown', kill, true);
    document.addEventListener('keydown', onEsc);
    window.addEventListener('blur', onBlur);
  }, 0);
  m.addEventListener('contextmenu', (e) => e.preventDefault());
  return m;
}

function tabContextMenu(id, x, y) {
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  const count = ids.length;
  const other = count - 1;

  return showContextMenu(x, y, [
    { label: 'Дублировать', act: () => duplicateTab(id) },
    { sep: true },
    { label: 'Закрыть вкладку', hint: 'Ctrl+W', act: () => closeTab(id) },
    { label: 'Закрыть все кроме этой', hint: other ? other + ' шт.' : '', act: () => closeOthers(id), off: other < 1 },
    { label: 'Закрыть все справа', hint: count - i - 1 ? count - i - 1 + ' шт.' : '', act: () => closeToRight(id), off: i >= count - 1 },
    { label: 'Закрыть все слева', hint: i ? i + ' шт.' : '', act: () => closeToLeft(id), off: i < 1 },
    { sep: true },
    { label: 'Закрыть все вкладки', hint: count ? count + ' шт.' : '', act: () => closeAll(), off: count < 1 },
  ]);
}

/**
 * Контекстное меню файла в дереве.
 *   Просмотр           — открыть в текущей вкладке
 *   Отложенный просмотр — открыть в новой вкладке, фокус остаётся здесь
 *   Редактировать      — открыть и сразу войти в режим правки
 *   Удалить            — в корзину Windows, с подтверждением
 */
function fileContextMenu(full, x, y) {
  const open = findTabByPath(full);
  const label = basname(full);
  const dirtyTab = open && open.dirty;

  return showContextMenu(x, y, [
    {
      label: 'Просмотр',
      hint: open ? 'уже открыта' : 'Ctrl+O',
      act: () => openPath(full, { newTab: false }),
    },
    {
      label: 'Отложенный просмотр',
      hint: open ? 'уже открыта' : 'в фоне',
      act: () => openPath(full, { newTab: true, background: true }),
    },
    {
      label: 'Редактировать',
      off: !!dirtyTab,
      hint: dirtyTab ? 'есть правки' : 'Ctrl+E',
      act: async () => {
        const t = await openPath(full, { newTab: true });
        if (!t) return;
        if (t.mode !== 'edit') { t.mode = 'edit'; renderActive(); el.editor.focus(); }
      },
    },
    { sep: true },
    {
      label: 'Показать в проводнике',
      act: () => api.reveal(full),
    },
    {
      label: 'Удалить',
      danger: true,
      off: !!dirtyTab,
      hint: dirtyTab ? 'есть несохранённые правки' : 'в корзину',
      act: () => trashFile(full, label),
    },
  ], { width: 250, height: 250 });
}

/** Удаление в корзину: спрашиваем и имя файла, и сам факт. */
async function trashFile(full, label) {
  const open = findTabByPath(full);
  if (open && open.dirty) {
    status('В «' + open.name + '» есть несохранённые правки — удаление отменено', 'err');
    return;
  }
  const answer = await askConfirm(
    'Удалить «' + label + '»?',
    'В корзину',
    {
      note: 'Файл уйдёт в корзину Windows, его можно будет вернуть.',
      okClass: 'danger',
      cancelText: 'Оставить',
    }
  );
  if (answer !== true) return;
  const res = await api.trash(full);
  if (!res || !res.ok) {
    status('Не удалось удалить: ' + ((res && res.error) || 'неизвестно'), 'err');
    return;
  }
  // Закрываем вкладку с удалённым файлом, чтобы не повисла со старым текстом.
  if (open) await closeTab(open.id);
  // Пересобираем дерево: файл мог лежать в корне или во вложенной папке.
  await refreshRoots();
  status('Удалено в корзину: ' + label, 'ok');
}

/** Дублирование вкладки: та же заметка, новая вкладка сразу справа. */
async function duplicateTab(id) {
  const src = tabs.get(id);
  if (!src) return;
  if (!src.path) { status('Пустую вкладку дублировать нечего'); return; }
  // findTabByPath вернёт уже открытую вкладку, поэтому читаем файл в обход
  // openPath и создаём вкладку напрямую.
  const data = await api.read(src.path).catch(() => null);
  if (!data) { status('Не удалось прочитать ' + src.name, 'err'); return; }
  const t = blankTab();
  applyData(t, data);
  t.hist = [{ path: data.path, anchor: null }];
  t.hi = 0;
  selectTab(t.id);
  // Ставим копию сразу за исходной (moveTab перерисовывает сам).
  moveTab(t.id, id);
  renderActive();
  status('Дублировано: ' + t.name, 'ok');
}

/** Переставить вкладку id сразу после after (порядок задаёт Map). */
function moveTab(id, after) {
  const entries = [...tabs.entries()];
  const idx = entries.findIndex(([k]) => k === id);
  if (idx === -1) return;
  const [entry] = entries.splice(idx, 1);
  let to = after === undefined ? entries.length : entries.findIndex(([k]) => k === after);
  if (to === -1) to = entries.length;
  entries.splice(to + 1, 0, entry);
  tabs.clear();
  for (const [k, v] of entries) tabs.set(k, v);
  // Порядок в DOM обязан совпадать с порядком в Map, иначе вкладки после
  // перестановки выглядят старыми, а Ctrl+Tab идёт по новому.
  renderTabs();
  refreshTreeSelection();
}

/** Перетаскивание вкладок мышью: сортировка по середине элементов. */
/**
 * Призрак перетаскиваемой вкладки.
 *
 * По умолчанию браузер рисует его со снимка элемента: туда попадают старые
 * размеры, обводка выделения, обрезанное имя и куски соседних вкладок — и под
 * курсором едет обрывок интерфейса, а не вкладка. Рисуем ровно то, что нужно:
 * плашку с тем же именем, и отдаём её setDragImage.
 *
 * Элемент должен быть в документе на момент вызова setDragImage, но не
 * виден — поэтому уводим его за левый край и убираем на следующем тике.
 */
function showDragGhost(e, label) {
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  const nm = document.createElement('span');
  nm.className = 'tname';
  nm.textContent = label;
  g.append(nm);
  document.body.append(g);
  // Точка захвата: за левый край плашки, а не за центр — так вкладка
  // «висит» на курсоре слева, как её тянут за вкладку, а не за середину.
  e.dataTransfer.setDragImage(g, Math.min(24, Math.round(g.offsetWidth / 4)), 13);
  setTimeout(() => g.remove(), 0);
}

/**
 * Рамка на месте будущей правой панели.
 *
 * Пока вкладку тянут над полем заметки, показываем кромку там, где встанет
 * вторая панель: иначе непонятно, что будет, если отпустить. Кромка снимается
 * при уходе курсора и при отпускании — либо её повесил drop мимо цели.
 */
function hintSplitPlace(on) {
  const main = document.querySelector('.main');
  if (main) main.classList.toggle('drop-split', !!on);
}

function initTabDrag() {
  let dragId = null;

  el.tabs.addEventListener('dragstart', (e) => {
    const d = e.target.closest('.tab');
    if (!d) return;
    const t = tabs.get(+d.dataset.id);
    // Пустые вкладки тоже таскаются: иначе «новую вкладку» нельзя было
    // переставить, а при работе с несколькими заметками это самая частая
    // вкладка. Раньше здесь стояло `!t.path` и она оставалась на месте.
    if (!t) { e.preventDefault(); return; }
    dragId = +d.dataset.id;
    d.classList.add('dragging');
    el.tabs.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
    // Firefox требует данные, иначе drag не стартует
    e.dataTransfer.setData('text/plain', t.name);
    showDragGhost(e, t.name);
  });

  el.tabs.addEventListener('dragend', () => {
    dragId = null;
    el.tabs.classList.remove('dragging-active');
    hintSplitPlace(false);
    for (const x of el.tabs.querySelectorAll('.tab')) x.classList.remove('dragging', 'drop-before', 'drop-after');
  });

  // Перетаскивание в поле заметки — разделение экрана. Слушаем окно, а не
  // .main: пока вкладку тянут из ленты, указатель над лентой и над областью
  // заметки — это разные элементы, и .main не узнает о dragover, если
  // курсор над лентой. Над самой лентой работает перестановка вкладок.
  window.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    if (el.tabs.contains(e.target)) return;
    if (!el.split.contains(e.target)) { hintSplitPlace(false); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    hintSplitPlace(true);
  });
  window.addEventListener('drop', (e) => {
    if (dragId === null) return;
    if (el.tabs.contains(e.target)) return;
    if (!el.split.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    const id = dragId;
    dragId = null;
    el.tabs.classList.remove('dragging-active');
    openSecond(id);
  });

  el.tabs.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.tab');
    for (const x of el.tabs.querySelectorAll('.tab')) x.classList.remove('drop-before', 'drop-after');
    if (!over || +over.dataset.id === dragId) return;
    const r = over.getBoundingClientRect();
    over.classList.add(e.clientX < r.left + r.width / 2 ? 'drop-before' : 'drop-after');
  });

  el.tabs.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    const over = e.target.closest('.tab');
    for (const x of el.tabs.querySelectorAll('.tab')) x.classList.remove('drop-before', 'drop-after');
    if (over && +over.dataset.id !== dragId) {
      const r = over.getBoundingClientRect();
      const before = e.clientX < r.left + r.width / 2;
      // Ставим перед или после целевой вкладки.
      const ids = [...tabs.keys()];
      const target = +over.dataset.id;
      const ti = ids.indexOf(target);
      const ref = before ? (ti > 0 ? ids[ti - 1] : null) : target;
      // moveTab сам перерисовывает DOM; после «перед самой первой» (ref === null)
      // он уводит вкладку в конец, поэтому докручиваем руками.
      moveTab(dragId, ref === null ? undefined : ref);
      if (before && ti === 0) {
        const tmp = [...tabs.entries()];
        const e2 = tmp.splice(tmp.findIndex(([k]) => k === dragId), 1)[0];
        tabs.clear();
        tabs.set(e2[0], e2[1]);
        for (const [k, v] of tmp) tabs.set(k, v);
        renderTabs();
        refreshTreeSelection();
      }
      renderActive();
      refreshTreeSelection();
    }
    dragId = null;
  });
}

/**
 * Лента вкладок: прокрутка и шевроны.
 *
 * Раньше лента имела overflow-x:auto, но без min-width:0 на самой ленте и её
 * обёртке flex-элемент не сжимался ниже содержимого — вкладки просто уезжали
 * за край окна, и доехать до них было нечем. Теперь колесо над лентой листает
 * её вбок, а по краям появляются шевроны, когда есть что листать.
 */
function initTabsScroll() {
  const step = () => Math.max(120, Math.round(el.tabs.clientWidth * 0.6));

  // Плавность живёт здесь, а не в CSS: у ленты и контента стояло
  // scroll-behavior:smooth, и колесо мыши тоже анимировалось — прокрутка
  // шла рывками. Правило простое: то, что человек двигает руками (колесо,
  // полоса прокрутки, перетаскивание), мгновенное; то, что он нажимает
  // (шевроны, «Наверх», пункт оглавления), — плавное.
  el.tabsLeft.onclick = () => el.tabs.scrollBy({ left: -step(), behavior: 'smooth' });
  el.tabsRight.onclick = () => el.tabs.scrollBy({ left: step(), behavior: 'smooth' });

  // Вертикальный скролл над полосой вкладок должен листать её, а не страницу.
  // Важно: scroll-behavior:smooth делает присваивание scrollLeft отложенным,
  // поэтому сразу после присваивания scrollLeft ещё старый. Значит сравнивать
  // «изменилось ли» бесполезно — решаем по наличию переполнения и отменяем
  // событие сразу.
  el.tabs.addEventListener('wheel', (e) => {
    if (!e.deltaY || e.deltaX) return;
    if (el.tabs.scrollWidth <= el.tabs.clientWidth + 1) return;
    e.preventDefault();
    el.tabs.scrollLeft += e.deltaY;
  }, { passive: false });

  // Шевроны должны знать текущее положение ленты. Раньше updateTabsNav
  // звался только из ResizeObserver, то есть только при изменении ширины:
  // уехав колесом или шевроном в конец, вкладка «уезжала» под обрезку, но
  // шеврон, которым можно вернуться, оставался скрытым — назад было нечем
  // листать. Слушатель passive: он ничего не отменяет и не тормозит.
  // Обратной связи с updateTabsNav нет: он только прячет/показывает шевроны,
  // а ширину ленты не меняет.
  el.tabs.addEventListener('scroll', updateTabsNav, { passive: true });

  // Шефроны зависят от ширины ЛЕНТЫ, а обрезка имени — от ширины ВКЛАДКИ.
  // Это разные величины: при сжатии полосы общая ширина может не измениться
  // ни на пиксель, пока отдельные вкладки сжмутся со 180 до 110. Наблюдая
  // только за лентой, мы пропускали этот переход, и имена оставались
  // необрезанными при заведомо узких вкладках.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => updateTabsNav()).observe(el.tabs);
  } else {
    window.addEventListener('resize', () => updateTabsNav());
  }
}

/** Показываем шеврон только с той стороны, где есть что листать. */
function updateTabsNav() {
  const max = el.tabs.scrollWidth - el.tabs.clientWidth;
  el.tabsWrap.classList.toggle('has-overflow', max > 2);
  el.tabsLeft.hidden = max <= 2 || el.tabs.scrollLeft <= 2;
  el.tabsRight.hidden = max <= 2 || el.tabs.scrollLeft >= max - 2;
}

/**
 * Обрезать длинное имя в конце, многоточием: «Заметка-с-дли…».
 *
 * Обрезка по середине была моей идеей («различается хвост — покажем хвост»),
 * но на деле выглядит хуже: получается «Заметка-с-дли…енем-24.md», обрезка
 * ровно посередине слова плюс рваный остаток. Просили просто обрезать с конца.
 *
 * Двоичный поиск по числу символов, а не цикл по одному: длина ленты
 * линейная по числу вкладок, а тут на каждый шаг нужен замер ширины.
 */
function elideTail(el, full) {
  if (!full) return;
  const cur = el.textContent;
  if (cur !== full) {
    // Уже обрезано. Полное имя возвращаем только если оно теперь помещается:
    // вкладка могла разъехаться (сменилось число вкладок, ресайз, резерв под
    // системные кнопки).
    el.textContent = full;
    if (el.scrollWidth <= el.clientWidth + 1) return;
  } else if (el.scrollWidth <= el.clientWidth + 1) {
    return;
  }
  const build = (n) => (n >= full.length ? full : full.slice(0, n) + '…');
  let lo = 1;
  let hi = full.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    el.textContent = build(mid);
    if (el.scrollWidth <= el.clientWidth + 1) lo = mid; else hi = mid - 1;
  }
  el.textContent = build(lo);
}

/**
 * Пересчёт обрезки имён под текущую ширину вкладок.
 *
 * Следить надо за вкладками, а не за лентой: при сжатии полосы её ширина может
 * не измениться ни на пиксель, пока отдельные вкладки сойдутся со 180 до 110.
 *
 * Переподключать наблюдатель из его же колбэка нельзя — disconnect() там
 * отменяет доставку уже поставленных в очередь уведомлений, и часть вкладок
 * оставалась необрезанной навсегда. Поэтому переподключение живёт в
 * observeTabWidths(), а колбэк только пересчитывает.
 */
let tabResizeObs = null;

function elideAllTabNames() {
  for (const nm of el.tabs.querySelectorAll('.tname')) elideTail(nm, nm.dataset.full);
}

function observeTabWidths() {
  if (typeof ResizeObserver === 'undefined') return;
  if (!tabResizeObs) {
    tabResizeObs = new ResizeObserver(() => elideAllTabNames());
  } else {
    tabResizeObs.disconnect();
  }
  for (const t of el.tabs.querySelectorAll('.tab')) tabResizeObs.observe(t);
}

/**
 * Пересчитать сейчас и ещё дважды отложенно. Первая раскладка flex может
 * прийти позже нашей синхронной проверки, а таймеры закрывают этот зазор
 * независимо от того, сработал ли ResizeObserver (в скрытом окне кадров нет,
 * но layout всё равно происходит).
 */
function scheduleElide() {
  elideAllTabNames();
  setTimeout(elideAllTabNames, 0);
  setTimeout(elideAllTabNames, 150);
}

function renderTabs() {
  el.tabs.innerHTML = '';
  // Много вкладок — жмём ширину, чтобы меньше уезжало за край
  el.tabs.classList.toggle('many', tabs.size > 7);
  for (const t of tabs.values()) {
    const d = document.createElement('div');
    d.className = 'tab' + (t.id === activeId ? ' active' : '');
    // Полоса вкладок одна на обе панели, поэтому вкладку правой панели
    // помечаем: без метки не видно, какая заметка где.
    if (secondId !== null && t.id === secondId) d.classList.add('in-second');
    d.dataset.id = String(t.id);
    // Таскаются и пустые: иначе «новую вкладку» нельзя было переставить,
    // хотя это самая обычная вкладка при работе с несколькими заметками.
    d.draggable = true;
    d.title = (t.path || t.name)
      + (t.id === secondId ? '\n(справа — вторая панель)' : '');
    if (t.id === activeId) d.focus();   // чтобы Shift+F10 и клавиатура работали на активной вкладке
    const nm = document.createElement('span');
    nm.className = 'tname';
    nm.textContent = t.name;
    nm.dataset.full = t.name;
    d.append(nm);
    if (t.dirty) {
      const dot = document.createElement('span');
      dot.className = 'dirty';
      dot.textContent = '●';
      dot.title = 'не сохранено';
      d.append(dot);
    }
    const x = document.createElement('button');
    x.className = 'tclose';
    x.innerHTML = ICONS.icon('x');
    x.title = 'Закрыть (Ctrl+W)';
    x.onclick = (e) => { e.stopPropagation(); closeTab(t.id); };
    d.append(x);
    d.onclick = () => selectTab(t.id);
    d.onauxclick = (e) => { if (e.button === 1) closeTab(t.id); };
    d.oncontextmenu = (e) => { e.preventDefault(); tabContextMenu(t.id, e.clientX, e.clientY); };
    // Shift+F10 и «контекстное меню» с клавиатуры прилетают как отдельный
    // keydown без координат — без этого меню по Tab-у не открывалось.
    d.tabIndex = 0;
    d.onkeydown = (e) => {
      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        e.preventDefault();
        const r = d.getBoundingClientRect();
        tabContextMenu(t.id, r.left + 8, r.bottom + 2);
      }
    };
    el.tabs.append(d);
  }
  // Ширины вкладок известны только после того, как они в DOM, поэтому
  // обрезаем имена вторым проходом.
  scheduleElide();
  observeTabWidths();
  // активную вкладку видно
  const act = el.tabs.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTabsNav();
}

/**
 * Один и тот же файл приходит двумя способами: из дерева — через path.join
 * («C:\dir\file.md»), из openPath — с прямыми слэшами («C:/dir/file.md»).
 * Наивное === их не считывает, из-за чего подсветка открытого файла в дереве
 * не работала. Здесь оба приводятся к одному виду и к нижнему регистру
 * (Windows регистр не различает).
 */
function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (s) => String(s).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function findTabByPath(p) {
  for (const t of tabs.values()) {
    if (samePath(t.path, p)) return t;
  }
  return null;
}

// --------------------------------------------------------------- загрузка

/** Пустая вкладка для переиспользования (иначе копятся пустые). */
function blankTab() {
  for (const t of tabs.values()) if (!t.path) return t;
  return newTab();
}

function applyData(t, data) {
  Object.assign(t, {
    path: data.path, name: data.name, raw: data.text, html: null,
    dirty: false, mode: 'read', baseUrl: data.baseUrl,
    encoding: data.encoding, size: data.size || data.text.length,
    blank: false,
  });
  t._diskRaw = data.text;   // как лежит на диске — база для «есть изменения»
}

function pushHist(t, p, anchor) {
  t.hist = t.hist.slice(0, t.hi + 1);
  t.hist.push({ path: p, anchor: anchor || null });
  t.hi = t.hist.length - 1;
}

/**
 * Открыть файл.
 *   newTab:true  — в новой вкладке (дерево, диалог, drop, кли по «Файл»);
 *   newTab:false — в текущей (переход по ссылке .md внутри документа).
 */
async function openPath(p, opts) {
  opts = opts || {};
  const existing = findTabByPath(p);
  if (existing) {
    // Отложенный просмотр уже открытой вкладки не должен перехватывать фокус
    if (!opts.background) selectTab(existing.id);
    return existing;
  }
  const prevActive = activeId;
  const my = ++loadSeq;
  try {
    status('Открываю ' + basname(p) + '…');
    // Показываем индикатор и отдаём кадр, иначе он появится уже после того,
    // как всё отрисовалось, и толку от него не будет.
    showLoading('Открываю ' + basname(p) + '…');
    await nextPaint();
    const data = await api.read(p);
    if (my !== loadSeq) return null;
    showLoading('Открываю ' + basname(p) + '…', fmtSize(data.size));
    await nextPaint();
    noteRecent(data.path);
    const t = opts.newTab ? blankTab() : (active() && active().path ? active() : blankTab());
    applyData(t, data);
    t.hist = [{ path: data.path, anchor: null }];
    t.hi = 0;

    if (opts.background) {
      // Вкладка появляется и рендерится, но фокус остаётся на прежней.
      // html готовим сразу, иначе переключение на неё потом подтормаживало бы
      // (renderActive рендерит лениво, при первом показе).
      t.html = null;
      try {
        t.html = MDV.renderMd(t.raw, t.baseUrl);
      } catch (e) {
        t.html = '<pre style="color:var(--red)">Ошибка рендера: '
          + MDV.escapeHtml(String(e.message || e)) + '</pre>';
      }
      activeId = prevActive;
      if (!tabs.has(prevActive)) activeId = t.id;
      renderTabs();
      renderActive();
      refreshTreeSelection();
    } else {
      selectTab(t.id);
    }
    // Прячем после кадра с содержимым, иначе индикатор гаснет раньше текста.
    await nextPaint();
    if (my === loadSeq) hideLoading();
    status(data.encoding.toUpperCase() + ' · ' + fmtSize(t.size) + ' · ' + t.name, 'ok');
    return t;
  } catch (e) {
    if (my === loadSeq) hideLoading();
    status('Не удалось открыть: ' + (e.message || e), 'err');
    return null;
  }
}

/** Переход по ссылке .md — в текущей вкладке, с записью в историю. */
async function navigate(p, anchor) {
  const t = active();
  if (!t || !t.path) return openPath(p, {});
  if (p === t.path) {
    if (anchor) scrollToAnchor(anchor);
    if (anchor) pushHist(t, p, anchor);
    updateNavButtons();
    return t;
  }
  const data = await api.read(p).catch(() => null);
  if (!data) { status('Не удалось открыть ' + basname(p), 'err'); return null; }
  applyData(t, data);
  pushHist(t, data.path, anchor);
  selectTab(t.id);
  if (anchor) setTimeout(() => scrollToAnchor(anchor), 0);
}

/**
 * Alt+←/→. Сначала — история документа (ссылки и якоря оглавления),
 * когда она кончилась — переключение вкладок, как в браузере.
 */
async function go(delta) {
  const t = active();
  if (!t) return;
  const ni = t.hi + delta;
  if (ni >= 0 && ni < t.hist.length) {
    const entry = t.hist[ni];
    if (entry.path !== t.path) {
      const data = await api.read(entry.path).catch(() => null);
      if (!data) { status('Файл недоступен: ' + basname(entry.path), 'err'); return; }
      applyData(t, data);
    }
    t.hi = ni;
    selectTab(t.id);
    if (entry.anchor) setTimeout(() => scrollToAnchor(entry.anchor), 0);
    return;
  }
  cycleTab(delta > 0 ? 1 : -1);
}

function updateNavButtons() {
  const t = active();
  const docBack = !!t && t.hi > 0;
  const docFwd = !!t && t.hi < t.hist.length - 1;
  const tabBack = visitPos > 0;
  const tabFwd = visitPos < visit.length - 1;
  el.btnBack.disabled = !(docBack || tabBack);
  el.btnForward.disabled = !(docFwd || tabFwd);
  el.btnBack.title = docBack ? 'Назад по истории (Alt+←)' : 'Предыдущая вкладка (Alt+←)';
  el.btnForward.title = docFwd ? 'Вперёд по истории (Alt+→)' : 'Следующая вкладка (Alt+→)';
}

// ------------------------------------------------------------------ рендер

function renderActive() {
  const t = active();
  const has = !!t && !!t.path;
  // Рабочую область показываем не только когда открыт файл, но и когда
  // добавлена папка. Раньше условие было строго `has`, а дерево файлов
  // рисуется в #paneFiles внутри скрытого #workspace: после «Папка» не было
  // видно ничего, дерево «появлялось» лишь вместе с первым открытым файлом.
  const show = has || roots.length > 0;
  // Пустая вкладка (нет файла) показывает дефолтную заглушку. Но если
  // открыта папка, заглушка не нужна — показываем проводник с деревом,
  // иначе «Папка» снова выглядит как ничего не сделавшая кнопка.
  const isBlank = !has;
  // Заглушка нужна в двух разных случаях, и их нельзя смешивать:
  //  • папка не открыта — показываем экран приветствия;
  //  • пользователь нажал «новая вкладка» (blank=true) — тоже заглушка,
  //    даже если папка уже открыта.
  // Если же папку открыли при пустой вкладке (blank сброшен в addFolder),
  // заглушку не показываем — иначе «Папка» снова выглядит как кнопка,
  // которая ничего не делает.
  const wantWelcome = isBlank && (!roots.length || (t && t.blank));
  el.welcome.hidden = !wantWelcome;
  // Показываем что-то одно: заглушку ИЛИ рабочую область. Иначе при
  // открытой папке и новой пустой вкладке welcome ложился поверх дерева.
  el.workspace.hidden = wantWelcome || !show;
  closeFind();
  if (isBlank) {

    // Файла нет — не пишем ничего. Чёрточка-разделитель читалась как
    // «имя файла, но я не знаю какое».
    el.fileName.textContent = '';
    el.fileName.title = '';
    el.content.innerHTML = '';
    el.editor.hidden = true;
    el.toTop.hidden = true;
    el.statusbar.hidden = true;
    // Док режима целиком прячем: файла нет — правки негде и нечего.
    el.modeDock.hidden = true;
    el.btnToc.hidden = true;
    document.title = 'MDView';
    updateNavButtons();
    return;
  }
  el.statusbar.hidden = !view.statusbar;
  el.modeDock.hidden = false;

  document.title = t.name + ' — MDView';
  el.fileName.textContent = t.path;
  el.fileName.title = t.path;

  const editing = t.mode === 'edit';
  el.editor.hidden = !editing;
  el.content.hidden = editing;
  // В правке — зелёная «Сохранить» и красная «Отменить» вместо одного
  // переключателя. Раньше он просто уводил из правки, оставляя изменения
  // в памяти: их можно было потерять молча, ничего не спрашивая.
  el.btnMode.hidden = editing;
  el.btnSave.hidden = !editing;
  el.btnCancelEdit.hidden = !editing;
  el.btnSave.classList.toggle('btn-save-dirty', editing && t.dirty);
  // Кнопка оглавления нужна только при открытом файле (и то, когда есть
  // что показывать — заголовки строятся в buildToc() ниже).
  el.btnToc.hidden = false;

  if (editing) {
    el.editor.value = t.raw;
  } else {
    if (t.html === null) {
      try {
        t.html = MDV.renderMd(t.raw, t.baseUrl);
      } catch (e) {
        t.html = '<pre style="color:var(--red)">Ошибка рендера: ' + MDV.escapeHtml(String(e.message || e)) + '</pre>';
        status('Ошибка рендера: ' + (e.message || e), 'err');
      }
    }
    el.content.innerHTML = t.html;
    // Явно мгновенно: при переключении вкладок «уезжать» к прежнему месту
  // анимацией не нужно — это задерживает появление текста.
  el.content.scrollTo({ top: t.scroll || 0, behavior: 'instant' });
    decorateCode();
    decorateMath();
  }
  buildToc();
  updateNavButtons();
  updateZoom();
  refreshTreeSelection();
  // Нет заголовков — прятать кнопку бессмысленно.
  el.btnToc.hidden = !t.path || el.paneToc.querySelector('.toc-hint') !== null;
}

/* ------------------------------------------------- разделение экрана

 * Правая панель — вторая заметка рядом с рабочей. Полоса вкладок общая, и
 * вкладка правой панели помечена кромкой слева: иначе непонятно, какая из
 * двух заметок сейчас в какой панели.
 *
 * Панель появляется, когда вкладку тянут из ленты в поле заметки, и
 * исчезает, когда в правой панели нажали крестик или её вкладку закрыли.
 * Состояние намеренно не сохраняется: разделение — это способ посмотреть на
 * две заметки сразу, а не настройка вида.
 */

/** Показать вкладку в правой панели. */
function openSecond(id) {
  if (!tabs.has(id)) return false;
  // Ту же вкладку, что и в рабочей области, во вторую панель нечего помещать:
  // рядом с самим собой пусто, и человек ничего не получает.
  if (id === activeId) { status('Эта вкладка уже открыта слева'); return false; }
  if (secondId !== null && tabs.has(secondId)) secondTab().scroll2 = el.content2.scrollTop;
  secondId = id;
  renderSecond();
  renderTabs();
  status('Справа: ' + tabs.get(id).name, 'ok');
  return true;
}

/** Убрать правую панель. */
function closeSecond() {
  if (secondId === null) return;
  secondId = null;
  renderSecond();
  renderTabs();
  renderActive();
}

/** Правая панель и активная вкладка поменялись местами. */
function swapPanes() {
  const other = activeId;
  secondId = other;
  renderTabs();
  renderActive();
  renderSecond();
}

/** Правая панель занимает вторую позицию: сначала разделить, потом смотреть. */
function splitScreen() {
  const ids = [...tabs.keys()].filter((k) => k !== activeId);
  if (!ids.length) { status('Нужна ещё одна вкладка — разделить нечего'); return false; }
  return openSecond(ids[ids.length - 1]);
}

function secondTab() { return secondId === null ? null : tabs.get(secondId) || null; }

function renderSecond() {
  const t = secondTab();
  const on = !!t;
  el.panel2.hidden = !on;
  el.splitDivider.hidden = !on;
  if (!on) {
    // Панели нет — её содержимое и рамка места разделения не нужны.
    el.content2.innerHTML = '';
    hintSplitPlace(null);
    return;
  }
  el.secondTitle.textContent = t.name;
  el.secondTitle.title = t.path || t.name;
  if (t.html === null) {
    try {
      t.html = MDV.renderMd(t.raw, t.baseUrl);
    } catch (e) {
      t.html = '<pre style="color:var(--red)">Ошибка рендера: ' + MDV.escapeHtml(String(e.message || e)) + '</pre>';
    }
  }
  el.content2.innerHTML = t.html;
  el.content2.scrollTo({ top: t.scroll2 || 0, behavior: 'instant' });
  decorateCode(el.content2);
  decorateMath(el.content2);
}

function reload() {
  const t = active();
  if (!t || !t.path) return;
  t.html = null;
  renderActive();
}

const LANG_NAMES = {
  js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', json: 'JSON',
  py: 'Python', sh: 'Shell', bash: 'Bash', zsh: 'Zsh', fish: 'Fish',
  c: 'C', cpp: 'C++', h: 'C', hpp: 'C++', cs: 'C#', java: 'Java',
  go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', sql: 'SQL',
  html: 'HTML', xml: 'XML', css: 'CSS', scss: 'SCSS', less: 'Less',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI', cfg: 'Config',
  md: 'Markdown', markdown: 'Markdown', tex: 'LaTeX', latex: 'LaTeX',
  tikz: 'TikZ', circuitikz: 'circuitikz', diff: 'Diff', patch: 'Diff',
  dockerfile: 'Dockerfile', makefile: 'Makefile', plaintext: 'Текст', text: 'Текст',
};

/* root передаётся, потому что при разделении экрана текст рисуется в двух
   контейнерах, а оформление блоков кода и формул должно одинаково работать
   в обоих. Без аргумента — прежнее поведение, только el.content. */
function decorateCode(root) {
  const box = root || el.content;
  for (const pre of box.querySelectorAll('pre')) {
    const code = pre.querySelector('code');
    if (!code || pre.querySelector('.code-lang')) continue;
    const m = (code.className || '').match(/language-([\w-]+)/);
    if (m) {
      const key = m[1].toLowerCase();
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = LANG_NAMES[key] || key;
      pre.append(tag);
    }
    const btn = document.createElement('button');
    btn.className = 'code-copy';
    btn.innerHTML = ICONS.icon('copy') + '<span>Копировать</span>';
    btn.onclick = () => {
      const text = code ? code.innerText : pre.innerText;
      navigator.clipboard.writeText(text).then(
        () => {
          btn.classList.add('ok');
          btn.innerHTML = ICONS.icon('check') + '<span>Скопировано</span>';
          setTimeout(() => {
            btn.classList.remove('ok');
            btn.innerHTML = ICONS.icon('copy') + '<span>Копировать</span>';
          }, 1400);
        },
        () => { btn.textContent = 'Не вышло'; }
      );
    };
    pre.append(btn);
  }
}

/** Клик по отрендеренной формуле показывает её LaTeX-исходник. */
function decorateMath(root) {
  const box = root || el.content;
  for (const m of box.querySelectorAll('.mdv-math')) {
    m.title = 'LaTeX: клик — показать исходник';
    m.style.cursor = 'pointer';
  }
}

// ---------------------------------------------------------------- оглавление

function slugify(txt) {
  return txt.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-').slice(0, 60);
}

let spyHeads = [], spyLinks = [];

function buildToc() {
  const t = active();
  el.paneToc.innerHTML = '';
  spyHeads = []; spyLinks = [];
  if (!t || !t.path || t.mode === 'edit') {
    el.paneToc.innerHTML = '<div class="toc-hint">Нет заголовков</div>';
    return;
  }
  const heads = [...el.content.querySelectorAll('h1, h2, h3, h4')];
  if (!heads.length) {
    el.paneToc.innerHTML = '<div class="toc-hint">В файле нет заголовков<br>Оглавление пустое</div>';
    return;
  }
  const used = new Set();
  for (const h of heads) {
    let id = h.id;
    if (!id || used.has(id)) {
      id = slugify(h.textContent) || 'h';
      let n = 2;
      while (used.has(id)) id = slugify(h.textContent) + '-' + n++;
      h.id = id;
    }
    used.add(id);

    const a = document.createElement('a');
    a.className = 'toc-item';
    a.dataset.l = h.tagName[1];
    a.textContent = h.textContent;
    a.href = '#' + id;
    a.onclick = (e) => {
      e.preventDefault();
      // Переход по разделам — полноценный шаг истории, чтобы Alt+← его откатывал.
      pushHist(t, t.path, id);
      scrollToAnchor(id);
      updateNavButtons();
    };
    el.paneToc.append(a);
    spyHeads.push(h); spyLinks.push(a);
  }
}

function scrollToAnchor(id) {
  const target = id && el.content.querySelector('#' + CSS.escape(id));
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function updateSpy() {
  if (!spyHeads.length) return;
  const y = el.content.scrollTop + 90;
  let idx = -1;
  for (let i = 0; i < spyHeads.length; i++) {
    if (spyHeads[i].offsetTop <= y) idx = i;
  }
  for (let i = 0; i < spyLinks.length; i++) {
    spyLinks[i].classList.toggle('active', i === idx);
  }
  const act = spyLinks[idx];
  if (act && el.paneToc.scrollHeight > el.paneToc.clientHeight) {
    const top = act.offsetTop;
    if (top < el.paneToc.scrollTop || top > el.paneToc.scrollTop + el.paneToc.clientHeight - 30) {
      el.paneToc.scrollTop = top - el.paneToc.clientHeight / 2;
    }
  }
}

// ------------------------------------------------------------- дерево папок

async function addFolder(p) {
  if (roots.some((r) => r.path === p)) { status('Папка уже открыта: ' + p); return; }
  status('Сканирую ' + basname(p) + '…');
  const res = await api.listMd(p);
  roots.push({ path: p, name: basname(p), tree: res.tree, total: res.total });
  renderTree();
  // Открытие папки на пустой вкладке должно показать дерево, а не заглушку:
  // сбрасываем флаг «пользователь хотел пустую вкладку».
  const a = active();
  if (a && a.blank && !a.path) a.blank = false;
  // Без этого рабочая область оставалась скрытой и дерево было не видно:
  // показывать его должен renderActive, а не renderTree.
  renderActive();
  status(res.total ? 'В папке ' + res.total + ' .md — ' + basname(p) : 'В папке нет .md — ' + basname(p), res.total ? 'ok' : 'err');
}

async function openFolderDialog() {
  const dirs = await api.dialogFolder();
  for (const d of dirs) await addFolder(d);
}

async function openFileDialog() {
  const files = await api.dialogFile();
  for (const f of files) await openPath(f, { newTab: true });
}

function renderTree() {
  const q = (el.treeFilter.value || '').trim().toLowerCase();
  el.paneFiles.innerHTML = '';
  if (!roots.length) {
    el.paneFiles.innerHTML = '<div class="tree-empty">Папка не открыта.<br>Нажми «Папка» или перетащи каталог.</div>';
    return;
  }
  for (const r of roots) {
    const head = document.createElement('div');
    head.className = 'tree-root';
    const rm = document.createElement('button');
    rm.className = 'tree-remove';
    rm.innerHTML = ICONS.icon('x');
    rm.title = 'Убрать папку из списка';
    rm.onclick = () => {
      const i = roots.findIndex((x) => x.path === r.path);
      if (i >= 0) roots.splice(i, 1);
      renderTree();
    };
    const label = document.createElement('span');
    label.textContent = r.name + ' — ' + r.total + ' .md';
    label.title = r.path;
    head.append(label, rm);
    el.paneFiles.append(head);

    let shown = 0;
    for (const grp of r.tree) {
      if (grp.type === 'dir') {
        const d = document.createElement('div');
        d.className = 'tree-grp';
        const n = document.createElement('div');
        n.className = 'grp-name';
        n.innerHTML = ICONS.icon('folder', 'grp-ico') + '<span></span>';
        n.querySelector('span').textContent = grp.dir;
        d.append(n);
        el.paneFiles.append(d);
      } else {
        const box = document.createElement('div');
        for (const it of grp.items) {
          if (q && !it.name.toLowerCase().includes(q)) continue;
          shown++;
          const row = document.createElement('div');
          row.className = 'tree-item';
          row.title = it.full;
          // Открытый в любой вкладке файл — выделен, текущая вкладка — ещё и ярче.
          const isCur = active() && samePath(active().path, it.full);
          const openInSome = isCur || [...tabs.values()].some((x) => samePath(x.path, it.full));
          if (openInSome) row.classList.add('is-open');
          if (isCur) row.classList.add('active');
          row.innerHTML = '<span class="fi">' + ICONS.icon('file') + '</span><span class="fn"></span><span class="sz"></span>';
          row.querySelector('.fn').textContent = it.name;
          row.querySelector('.sz').textContent = fmtSize(it.size);
          row.dataset.path = it.full;
          if (openInSome && !isCur) row.title = it.full + ' — открыт в другой вкладке';
          row.onclick = () => openPath(it.full, { newTab: true });
          row.oncontextmenu = (e) => { e.preventDefault(); fileContextMenu(it.full, e.clientX, e.clientY); };
          box.append(row);
        }
        if (box.childNodes.length) el.paneFiles.append(box);
      }
    }
    if (!shown) {
      const none = document.createElement('div');
      none.className = 'tree-empty';
      none.textContent = q ? 'Ничего не найдено' : 'Здесь нет .md';
      el.paneFiles.append(none);
    }
  }
}

// ------------------------------------------------------------------ зум

/* Границы масштаба. Ниже 40% текст становится нечитаемым, выше 250%
   полосы перестают помещаться в колонку и она начинает прыгать на строках. */
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2.5;

/* Пока в поле печатают, updateZoom его не трогает: иначе каждый setZoom
   затирал бы половину набранного. */
let zoomEditing = false;

function updateZoom() {
  if (!zoomEditing) el.zoomVal.value = Math.round(zoom * 100) + '%';
  el.content.style.fontSize = (15 * zoom).toFixed(2) + 'px';
  el.editor.style.fontSize = (14 * zoom).toFixed(2) + 'px';
  el.zoomVal.classList.toggle('pending', zoomEditing);
}

function setZoom(z) {
  zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  updateZoom();
}

/**
 * Применить масштаб, вписанный в поле.
 *
 * Понимаем «85», «85%», «0.85», «1,85» и пробелы вокруг. Молча ставить
 * 100% при опечатке — плохо: человек думал, что задал 130%, и получал 100%
 * без единого слова. Поэтому неудача — это строка в статусе и возврат
 * того, что было.
 */
function applyZoomInput() {
  const raw = el.zoomVal.value.trim();
  const bare = raw.replace(/%/g, '').replace(',', '.').trim();
  let n = parseFloat(bare);
  if (raw === '' || !isFinite(n)) {
    status('Не понял масштаб: ' + raw, 'err');
    zoomEditing = false;
    updateZoom();
    return false;
  }
  // Без знака «%» число <= 1 читаем как долю (0.85 -> 85%), больше 1 — как
  // проценты (85 -> 85%). Иначе «1» означал бы 1% невозможного.
  const z = raw.indexOf('%') >= 0 ? n / 100 : (n <= 1 ? n : n / 100);
  if (z < ZOOM_MIN || z > ZOOM_MAX) {
    status('Масштаб вне ' + Math.round(ZOOM_MIN * 100) + '–'
      + Math.round(ZOOM_MAX * 100) + '%: ' + raw, 'err');
    zoomEditing = false;
    updateZoom();
    return false;
  }
  zoom = z;
  zoomEditing = false;
  updateZoom();
  return true;
}

el.zoomVal.addEventListener('focus', () => {
  zoomEditing = true;
  el.zoomVal.select();
  el.zoomVal.classList.add('pending');
});
el.zoomVal.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    applyZoomInput();
    el.zoomVal.blur();
    return;
  }
  // Escape — откат к настоящему масштабу, поле закрывается.
  // stopPropagation обязателен: иначе Escape, отменявший набор в поле,
  // долетал до обработчика окна и доходил до диалогов — там он закрывал
  // их и откатывал настройки, то есть одно нажатие делало три разных
  // вещи. Остальные клавиши останавливаем ниже.
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    zoomEditing = false;
    updateZoom();
    el.zoomVal.blur();
    return;
  }
  // Остальные клавиши не должны улетать в обработчик окна: пробел там
  // означал бы «листать вниз», и «85 » не применилось бы.
  e.stopPropagation();
});
el.zoomVal.addEventListener('blur', () => {
  if (zoomEditing) applyZoomInput();
});
/* Ctrl+колесо над полем — грубая подстройка, раз точное значение вводится
   руками. preventDefault обязателен: иначе страница едет от прокрутки. */
el.zoomVal.addEventListener('wheel', (e) => {
  e.preventDefault();
  setZoom(zoom + (e.deltaY < 0 ? 0.05 : -0.05));
}, { passive: false });

// ------------------------------------------------------------ сохранение и т.п.

/**
 * Сохранить конкретную вкладку.
 *
 * Отдельная функция нужна для диалогов: при закрытии вкладки с правками
 * спрашивать можно про ЛЮБУЮ вкладку, а save() работала только с активной и
 * брала текст из редактора. Текст берём из редактора только когда вкладка
 * активна и в правке; у остальных t.raw уже актуален — он обновляется на
 * каждом нажатии клавиши.
 */
async function saveTab(t) {
  if (!t || !t.path) return false;
  if (!t.dirty) return false;
  const text = (t === active() && t.mode === 'edit') ? el.editor.value : t.raw;
  try {
    await api.save(t.path, text);
    t.raw = text;
    t._diskRaw = text;
    t.dirty = false;
    t.mode = 'read';
    t.html = null;
    renderTabs();
    renderActive();
    toast('Сохранено: ' + t.name, 'ok');
    return true;
  } catch (e) {
    status('Не удалось сохранить: ' + (e.message || e), 'err');
    return false;
  }
}

async function save() {
  const t = active();
  if (!t || !t.path) return;
  if (!t.dirty) { toast('Изменений нет'); return; }
  // После сохранения выходим из правки в просмотр. Раньше save() намеренно
  // оставлял правку включённой (мысль была «Ctrl+S не должен выбрасывать в
  // чтение»), но это означало, что после сохранения остаёшься в редакторе уже
  // чистого файла — зелёная «Сохранить» продолжала висеть в углу.
  await saveTab(t);
}

function download(name, text, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function downloadMd() {
  const t = active();
  if (!t || !t.path) return;
  if (t.mode === 'edit' && t.dirty) { toast('Сначала сохрани (Ctrl+S)'); return; }
  download(t.name, t.raw, 'text/markdown');
}

/**
 * Автономный HTML одним файлом. Сборку делает main: он умеет прочитать
 * style.css и шрифты KaTeX и подставить их base64 прямо в @font-face
 * (из renderer их не достать — CSP запрещает connect-src).
 */
async function downloadHtml() {
  const t = active();
  if (!t || !t.path) return;
  if (t.mode === 'edit' && t.dirty) { toast('Сначала сохрани (Ctrl+S)'); return; }
  try {
    const body = MDV.renderMd(t.raw, t.baseUrl);
    const res = await api.exportHtml({ title: t.name, body });
    toast('Сохранено: ' + res.path + ' (' + fmtSize(res.bytes) + ', шрифтов: ' + res.fonts + ')', 'ok');
    api.reveal(res.path);
  } catch (e) {
    status('Ошибка сборки HTML: ' + (e.message || e), 'err');
  }
}

// ------------------------------------------------------------------ поиск

function openFind() {
  if (findBar) { findBar.input.focus(); return; }
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:8px;right:22px;z-index:70;display:flex;gap:5px;align-items:center;'
    + 'background:#1f2335;border:1px solid #2f3b54;border-radius:8px;padding:5px 7px;font-family:"Segoe UI",sans-serif';
  bar.innerHTML = '<input style="width:190px;padding:4px 8px;border-radius:5px;background:#1a1b26;border:1px solid #2f3b54;color:#c0caf5;font-size:12px" placeholder="Найти…">'
    + '<span class="cnt" style="color:#565f89;font-size:11px;min-width:44px;text-align:center"></span>'
    + '<button class="pv" style="background:#24283b;border:1px solid #2f3b54;color:#a9b1d6;border-radius:5px;padding:3px 8px;cursor:pointer">&#8593;</button>'
    + '<button class="nx" style="background:#24283b;border:1px solid #2f3b54;color:#a9b1d6;border-radius:5px;padding:3px 8px;cursor:pointer">&#8595;</button>'
    + '<button class="cl" style="background:#24283b;border:1px solid #2f3b54;color:#a9b1d6;border-radius:5px;padding:3px 8px;cursor:pointer">&#10005;</button>';
  el.content.parentElement.append(bar);
  findBar = { box: bar, input: bar.querySelector('input'), marks: [], cur: -1 };
  const run = () => runFind(findBar.input.value);
  findBar.input.addEventListener('input', run);
  findBar.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
    e.stopPropagation();
  });
  bar.querySelector('.nx').onclick = () => stepFind(1);
  bar.querySelector('.pv').onclick = () => stepFind(-1);
  bar.querySelector('.cl').onclick = () => closeFind();
  findBar.input.focus();
}

function closeFind() {
  if (!findBar) return;
  for (const m of findBar.marks) {
    const p = m.parentNode;
    if (p) { p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
  }
  findBar.box.remove();
  findBar = null;
}

function runFind(q) {
  closeFindKeepBar();
  const bar = findBar;
  if (!bar) return;
  q = (q || '').trim();
  bar.box.querySelector('.cnt').textContent = q ? '0/0' : '';
  if (q.length < 2) return;
  const lower = q.toLowerCase();
  const walker = document.createTreeWalker(el.content, NodeFilter.SHOW_TEXT, null);
  const hits = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(lower)) continue;
    if (node.parentElement.closest('pre, code, script, style')) continue;
    let idx = -1, from = 0;
    const s = node.nodeValue, sl = s.toLowerCase();
    while ((idx = sl.indexOf(lower, from)) !== -1) {
      hits.push({ node, idx, len: q.length });
      from = idx + q.length;
    }
  }
  for (const h of hits) {
    const range = document.createRange();
    range.setStart(h.node, h.idx);
    range.setEnd(h.node, h.idx + h.len);
    const m = document.createElement('mark');
    m.style.cssText = 'background:#e0af68;color:#1a1b26;border-radius:2px';
    try { range.surroundContents(m); } catch { continue; }
    bar.marks.push(m);
  }
  bar.box.querySelector('.cnt').textContent = bar.marks.length + ' найдено';
  if (bar.marks.length) stepFind(1);
}

function closeFindKeepBar() {
  if (!findBar) return;
  for (const m of findBar.marks) {
    const p = m.parentNode;
    if (p) { p.replaceChild(document.createTextNode(m.textContent), m); p.normalize(); }
  }
  findBar.marks = [];
  findBar.cur = -1;
}

function stepFind(dir) {
  const bar = findBar;
  if (!bar || !bar.marks.length) return;
  if (bar.cur >= 0 && bar.marks[bar.cur]) bar.marks[bar.cur].style.background = '#e0af68';
  bar.cur = (bar.cur + dir + bar.marks.length) % bar.marks.length;
  const m = bar.marks[bar.cur];
  m.style.background = '#ff9e64';
  m.scrollIntoView({ block: 'center', behavior: 'smooth' });
  bar.box.querySelector('.cnt').textContent = (bar.cur + 1) + '/' + bar.marks.length;
}

// ============================================================ обработчики

// --- клики по контенту: .md-ссылки -> новая вкладка, формулы -> исходник
el.content.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-mdpath]');
  if (a) {
    e.preventDefault();
    navigate(a.getAttribute('data-mdpath'), null);
    return;
  }
  const plain = e.target.closest('a[href]');
  if (plain && !plain.hasAttribute('data-mdpath')) {
    e.preventDefault();
    const href = plain.getAttribute('href');
    if (/^https?:/i.test(href)) window.open(href, '_blank');
    return;
  }
  const hashLink = e.target.closest('a[href^="#"]');
  if (hashLink) {
    e.preventDefault();
    const id = decodeURIComponent(hashLink.getAttribute('href').slice(1));
    const t = active();
    if (t && t.path) pushHist(t, t.path, id);
    scrollToAnchor(id);
    updateNavButtons();
    return;
  }
  const math = e.target.closest('.mdv-math');
  if (math) {
    const tex = math.getAttribute('data-tex');
    if (tex) { status('LaTeX: ' + tex); }
  }
});

// --- кнопки
// Плюсик снова просто открывает пустую вкладку: меню ради одной кнопки было
// лишним кликом, а открыть файл/папку и так есть чем в тулбаре.
el.btnNewTab.onclick = () => newTab();
/*
 * ПКМ по «+» открывает то же, что ЛКМ делает раньше: открыть файл или
 * папку. Сам «+» остаётся новой пустой вкладкой — так привычнее.
 */
el.btnNewTab.oncontextmenu = (e) => {
  e.preventDefault();
  const r = el.btnNewTab.getBoundingClientRect();
  showContextMenu(r.left - 60, r.bottom + 4, [
    { label: 'Открыть .md', hint: 'Ctrl+O', act: openFileDialog },
    { label: 'Открыть папку', hint: 'Ctrl+Shift+O', act: openFolderDialog },
  ], { width: 232, height: 80 });
};

// ------------------------------------------------------- временный файл / папка

/**
 * Ctrl+N: заметка без пути — в tmpdir, чтобы можно было набрать текст и сразу
 * читать, не создавая файл в живом месте. При сохранении такой вкладки
 * предлагаем «Сохранить как…».
 */
async function newTempNote() {
  let res;
  try { res = await api.newTemp('Безымянный'); }
  catch (e) { status('Не удалось создать временную заметку: ' + (e.message || e), 'err'); return; }
  if (!res) return;
  if (!res.ok) { status('Не удалось создать временную заметку: ' + (res.error || 'ошибка'), 'err'); return; }
  const t = await openPath(res.path, { newTab: true });
  if (t) { t.temp = true; renderTabs(); }
  status('Временная заметка: ' + basname(res.path), 'ok');
}

/**
 * Ctrl+Shift+N: папка внутри открытой. Без открытой папки пункт недоступен —
 * создавать папку «где-то» незачем.
 */
function folderForNew() {
  const t = active();
  if (t && t.path) return dirOf(t.path);
  if (roots.length) return roots[0].path;
  return null;
}

async function newFolderInOpen() {
  const parent = folderForNew();
  if (!parent) { status('Сначала открой папку с заметками', 'err'); return; }
  let res;
  try { res = await api.newFolder(parent, 'Новая папка'); }
  catch (e) { status('Не удалось создать папку: ' + (e.message || e), 'err'); return; }
  if (!res) return;
  if (!res.ok) { status('Не удалось создать папку: ' + (res.error || 'ошибка'), 'err'); return; }
  await refreshRoots();
  status('Создана папка: ' + res.name, 'ok');
}

/** Перечитать деревья открытых папок после появления новой. */
async function refreshRoots() {
  for (const r of roots) {
    const fresh = await api.listMd(r.path).catch(() => null);
    if (fresh) { r.tree = fresh.tree; r.total = fresh.total; }
  }
  renderTree();
  refreshTreeSelection();
}

// ------------------------------------------------- меню иконки приложения

/** Пункты «Вид» с галочками. Значения берутся из view, а не хранятся в меню. */
function viewMenuItems() {
  return [
    { sep: true },
    { label: 'Проводник', check: view.files, act: () => toggleView('files') },
    { label: 'Оглавление', check: view.toc, act: () => toggleView('toc') },
    { label: 'Верхняя панель', check: view.topbar, act: () => toggleView('topbar') },
    { label: 'Нижняя панель', check: view.statusbar, act: () => toggleView('statusbar') },
    { sep: true },
    // Разделение удобнее всего получить перетаскиванием вкладки в поле
    // заметки, но пункт в меню нужен тоже: перетаскивать нечем, когда
    // открыта одна вкладка и вторую ещё не открывали.
    { label: 'Разделить экран', hint: 'перетащи вкладку', act: splitScreen, off: tabs.size < 2 },
    { label: 'Закрыть правую панель', act: closeSecond, off: secondId === null },
  ];
}

el.appBrand.onclick = (e) => {
  const r = el.appBrand.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    {
      label: 'Файл',
      items: [
        { label: 'Новый файл', hint: 'Ctrl+N', act: newTempNote },
        { label: 'Новая папка', hint: 'Ctrl+Shift+N', act: newFolderInOpen, off: !folderForNew() },
        { sep: true },
        { label: 'Открыть .md', hint: 'Ctrl+O', act: openFileDialog },
        { label: 'Открыть папку', hint: 'Ctrl+Shift+O', act: openFolderDialog },
        { sep: true },
        { label: 'Недавние', act: recentDialog },
      ],
    },
    { label: 'Вид', items: viewMenuItems() },
    { sep: true },
    { label: 'Настройки', hint: 'Ctrl+,', act: settingsDialog },
  ], { width: 250, height: 190, subWidth: 240 });
};
el.appBrand.oncontextmenu = (e) => {
  e.preventDefault();
  el.appBrand.click();
};

async function newFileAction() {
  let res;
  try {
    res = await api.newFile('Новая заметка');
  } catch (e) {
    status('Не удалось создать файл: ' + (e.message || e), 'err');
    return;
  }
  if (!res) return;
  if (res.canceled) return;
  if (!res.ok) { status('Не удалось создать файл: ' + (res.error || 'ошибка'), 'err'); return; }
  noteRecent(res.path);
  await openPath(res.path, { newTab: true });
  status('Создан: ' + basname(res.path), 'ok');
}

async function newProjectAction() {
  let res;
  try {
    res = await api.newProject('Новый проект');
  } catch (e) {
    status('Не удалось создать проект: ' + (e.message || e), 'err');
    return;
  }
  if (!res || res.canceled) return;
  if (!res.ok) { status('Не удалось создать проект: ' + (res.error || 'ошибка'), 'err'); return; }
  await addFolder(res.path);
  if (res.readme) noteRecent(res.readme);
  status('Проект готов: ' + basname(res.path), 'ok');
}

/**
 * «Недавние» открывают не выпадающим списком, а отдельным окном со списком:
 * пути длинные, их надо читать целиком, а в меню места нет. Пропускаем
 * исчезнувшие файлы — метку «не найден» в списке показывать незачем.
 */
async function recentDialog() {
  /*
   * Закрывать это окно можно только через closeModal (= close из
   * wireModal). back.remove() сам по себе сносит узел, но НЕ снимает
   * слушатель Escape, который wireModal вешает на document в фазе
   * захвата: тот остаётся жить, и следующий Escape во всём приложении
   * «закрывает» уже несуществующее окно — для настроек это откат только
   * что подтверждённых значений.
   */
  let closeModal = () => back.remove();
  let st;
  try {
    st = await api.recentGet();
  } catch { st = { files: [] }; }
  const files = (st && st.files) || [];

  const exists = [];
  for (const f of files) {
    const info = await api.stat(f.path).catch(() => null);
    if (info && info.exists && info.isFile) exists.push({ ...f, dir: dirOf(f.path) });
  }

  const back = modalShell();
  const box = modalBox('Недавние файлы', 440, 420);

  if (!exists.length) {
    const empty = document.createElement('div');
    empty.className = 'modal-empty';
    empty.textContent = files.length
      ? 'Все файлы из списка удалены или переименованы.'
      : 'Пока пусто. Откройте заметку — она появится здесь.';
    box.append(empty);
  } else {
    const list = document.createElement('div');
    list.className = 'recent-list';
    for (const f of exists) {
      const b = document.createElement('button');
      b.className = 'recent-item';
      b.title = f.path;

      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.dataset.i = 'file-text';

      const col = document.createElement('span');
      col.className = 'recent-col';
      const n = document.createElement('span');
      n.className = 'recent-name';
      n.textContent = f.name;
      const d = document.createElement('span');
      d.className = 'recent-dir';
      d.textContent = f.dir;
      col.append(n, d);

      b.append(ico, col);
      b.onclick = async () => { closeModal(false); await openPath(f.path, { newTab: true }); };
      list.append(b);
    }
    box.append(list);
    // ICONS.hydrate на старте уже отработал (до появления этого окна), поэтому
    // свежесозданные [data-i] сами не подхватятся — гидрируем список заново.
    ICONS.hydrate(box);
  }

  const row = document.createElement('div');
  row.className = 'modal-row';
  const clear = document.createElement('button');
  clear.className = 'dlgbtn';
  clear.textContent = 'Очистить список';
  clear.disabled = !files.length;
  clear.onclick = async () => {
    await api.recentClear();
    closeModal(false);
    status('Список недавних очищен', 'ok');
  };
  row.append(clear);
  box.append(row);

  back.append(box);
  document.body.append(back);
  closeModal = wireModal(back, () => box.querySelector('.recent-item') || clear);
}

/**
 * Настройки: размер шрифта колонки, её ширина и автосохранение при выходе
 * из правки. Хранятся в userData/settings.json, применяются как CSS-переменные
 * на :root, поэтому работают без перезапуска.
 */
const SETTINGS_DEFAULT = {
  zoom: 1,
  columnWidth: 900,
  autosave: false,
};

// updateZoom считает размер от 15px при 100%. Настройка «Размер текста»
// показывает пиксели и переводит их в zoom — одна шкала вместо двух.
const BASE_TEXT_PX = 15;

/** Залить левую часть ползунка до текущего значения (CSS рисует по --fill). */
function paintRange(inp) {
  const min = +inp.min;
  const max = +inp.max;
  const span = max - min || 1;
  const pct = ((+inp.value - min) / span) * 100;
  inp.style.setProperty('--fill', pct.toFixed(1) + '%');
}

async function loadSettings() {
  let saved = {};
  try { saved = (await api.settingsGet()) || {}; } catch { saved = {}; }
  const merged = Object.assign({}, SETTINGS_DEFAULT);
  for (const k of Object.keys(SETTINGS_DEFAULT)) {
    const v = saved[k];
    if (typeof SETTINGS_DEFAULT[k] === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) merged[k] = v;
    } else if (typeof v === typeof SETTINGS_DEFAULT[k]) {
      merged[k] = v;
    }
  }
  applySettings(merged);
  // Вид хранится рядом с настройками, но это объект, а не число/флаг:
  // берём только известные ключи, чтобы битый файл не навязал лишнего.
  if (saved.view && typeof saved.view === 'object') {
    for (const k of Object.keys(VIEW_DEFAULT)) {
      if (typeof saved.view[k] === 'boolean') view[k] = saved.view[k];
    }
  }
  applyView();
  syncViewButtons();
  return merged;
}

/** Актуальное состояние панелей на кнопках тулбара. */
function syncViewButtons() {
  el.btnToc.classList.toggle('on', view.toc);
  el.btnSidebar.classList.toggle('on', view.files);
}

/**
 * Открыта ли пустая вкладка. Проверка стояла инлайном в renderActive, а
 * понадобилась ещё и в applyView — для галочек вида.
 */
function isBlankTab() {
  const t = active();
  return !t || !t.path;
}

function applySettings(s) {
  const root = document.documentElement;
  root.style.setProperty('--content-max-width', s.columnWidth + 'px');
  // Размер текста идёт через setZoom, чтобы ползунок в настройках и кнопки
  // масштаба в тулбаре всегда показывали одно и то же.
  setZoom(s.zoom);
}

function settingsDialog() {
  /*
   * Закрывать это окно можно только через closeModal (= close из
   * wireModal). back.remove() сам по себе сносит узел, но НЕ снимает
   * слушатель Escape, который wireModal вешает на document в фазе
   * захвата: тот остаётся жить, и следующий Escape во всём приложении
   * «закрывает» уже несуществующее окно — для настроек это откат только
   * что подтверждённых значений.
   */
  let closeModal = () => back.remove();
  const back = modalShell();
  const box = modalBox('Настройки', 470, 460);

  const rows = [];

  /**
   * Одна настройка — карточка: заголовок со значением справа, сам контрол под
   * ним, подсказка внизу мелким шрифтом. Раньше была сетка «метка слева,
   * контрол справа» в две колонки, и подсказки вылезали отдельной строкой
   * под меткой — окно выглядело как таблица, а не как диалог.
   * Возвращает карточку, чтобы положить в неё контрол.
   */
  function addCard(label, valueEl, hint) {
    const row = document.createElement('div');
    row.className = 'set-row';

    const head = document.createElement('div');
    head.className = 'set-head';
    const l = document.createElement('span');
    l.className = 'set-label';
    l.textContent = label;
    head.append(l);
    if (valueEl) head.append(valueEl);
    row.append(head);

    let hintEl = null;
    if (hint) {
      hintEl = document.createElement('div');
      hintEl.className = 'set-hint';
      hintEl.textContent = hint;
      row.append(hintEl);
    }
    box.append(row);
    rows.push(row);

    // Контрол кладём ПЕРЕД подсказкой, а не в конец: иначе порядок получается
    // «заголовок → подсказка → ползунок», и текст висит над самим элементом,
    // к которому относится.
    row._before = hintEl;
    row.addControl = (ctl) => {
      row.insertBefore(ctl, hintEl || null);
      return ctl;
    };
    return row;
  }

  const next = Object.assign({}, currentSettings);

  // Размер текста. Ползунок в пикселях (людям понятнее), внутри — zoom.
  const fontOut = document.createElement('span');
  fontOut.className = 'set-val';
  const font = document.createElement('input');
  font.type = 'range';
  font.min = '11';
  font.max = '24';
  font.step = '1';
  const pxToZoom = (px) => px / BASE_TEXT_PX;
  const zoomToPx = (z) => Math.round(BASE_TEXT_PX * z);
  font.value = String(zoomToPx(next.zoom));
  const syncFont = () => {
    fontOut.textContent = font.value + ' px';
    paintRange(font);
    previewSettings({ zoom: pxToZoom(+font.value) });
  };
  font.oninput = syncFont;
  syncFont();
  addCard('Размер текста', fontOut, 'Тот же масштаб, что и в тулбаре.').addControl(font);

  // Ширина колонки
  const widthOut = document.createElement('span');
  widthOut.className = 'set-val';
  const width = document.createElement('input');
  width.type = 'range';
  width.min = '640';
  width.max = '1400';
  width.step = '20';
  width.value = String(next.columnWidth);
  const syncWidth = () => {
    widthOut.textContent = width.value + ' px';
    paintRange(width);
    previewSettings({ columnWidth: +width.value });
  };
  width.oninput = syncWidth;
  syncWidth();
  addCard('Ширина колонки', widthOut, 'Узкая колонка читается спокойнее.').addControl(width);

  // Автосохранение. Настоящий <input type=checkbox> прячем, а рисуем
  // переключатель: системный квадратик в тёмной теме выглядит чужеродно.
  const autoIn = document.createElement('input');
  autoIn.type = 'checkbox';
  autoIn.className = 'set-switch-input';
  autoIn.checked = !!next.autosave;
  const auto = document.createElement('label');
  auto.className = 'set-switch';
  const knob = document.createElement('span');
  knob.className = 'knob';
  auto.append(autoIn, knob);
  autoIn.onchange = () => previewSettings({ autosave: autoIn.checked });
  addCard('Автосохранение', null,
    'Выход из правки сразу пишет файл — кнопка «Сохранить» не нужна.').addControl(auto);

  // Предпросмотр должен откатываться при отмене
  const before = Object.assign({}, currentSettings);
  const oldOnCancel = back._onCancel;
  back._onCancel = () => {
    // previewSettings, а не applySettings: откатить надо и CSS, и currentSettings,
    // иначе состояние в памяти разойдётся с тем, что на экране.
    previewSettings(before);
    if (oldOnCancel) oldOnCancel();
  };

  const row = document.createElement('div');
  row.className = 'modal-row';
  const reset = document.createElement('button');
  reset.className = 'dlgbtn';
  reset.textContent = 'Сбросить';
  reset.onclick = () => {
    const d = SETTINGS_DEFAULT;
    font.value = String(zoomToPx(d.zoom));
    width.value = String(d.columnWidth);
    autoIn.checked = d.autosave;
    syncFont();
    syncWidth();
    previewSettings(Object.assign({}, d));
  };
  const ok = document.createElement('button');
  ok.className = 'dlgbtn dlgbtn-primary';
  ok.textContent = 'Готово';
  ok.onclick = async () => {
    const val = {
      zoom: pxToZoom(+font.value),
      columnWidth: +width.value,
      autosave: autoIn.checked,
    };
    currentSettings = val;
    applySettings(val);
    try {
      await api.settingsSet(val);
    } catch (e) {
      status('Настройки не сохранены: ' + (e.message || e), 'err');
    }
    closeModal(false);
  };
  row.append(reset, ok);
  box.append(row);

  back.append(box);
  document.body.append(back);
  closeModal = wireModal(back, () => font);
}

let currentSettings = Object.assign({}, SETTINGS_DEFAULT);

function previewSettings(patch) {
  Object.assign(currentSettings, patch);
  applySettings(currentSettings);
}

/** Отмечаем файл в списке недавних (без await — ошибка тут не критична). */
function noteRecent(p) {
  if (!p) return;
  Promise.resolve(api.recentAdd(p)).catch(() => {});
}
// Открытие файла/папки живёт на экране-подсказке, в меню иконки и в ПКМ по «+».
// Отдельных кнопок в тулбаре больше нет, обращаться к ним не к чему.
el.wOpenFile.onclick = openFileDialog;
el.wOpenFolder.onclick = openFolderDialog;
el.btnBack.onclick = () => go(-1);
el.btnForward.onclick = () => go(1);
el.btnSave.onclick = save;
el.toTop.onclick = () => el.content.scrollTo({ top: 0, behavior: 'smooth' });

/** Выйти из правки с явным решением: сохранить или отменить. */
async function exitEdit(saveIt) {
  const t = active();
  if (!t || !t.path || t.mode !== 'edit') return;

  // Включённое автосохранение убирает сам повод нажимать «Сохранить»:
  // выход из правки пишет файл сам. Вопрос про отмену тогда не нужен —
  // отменять нечего.
  if (!saveIt && t.dirty && currentSettings.autosave) {
    await save();
    // save() намеренно оставляет правку включённой (Ctrl+S не должен
    // выбрасывать в чтение), а тут мы именно выходим — доводим до конца.
    t.mode = 'read';
    t.html = null;
    renderTabs();
    renderActive();
    status('Автосохранено: ' + t.name, 'ok');
    return;
  }

  if (!saveIt && t.dirty) {
    /*
     * Вопрос задаётся как «Сохранить правки?», а не «Отменить правки?».
     * Второй вариант ставил вопрос о том действии, которое уже вызвали, и
     * кнопки «Отмена» / «Отменить правки» отличались от названия вопроса.
     * Здесь выбор исчерпывающий: сохранить или выбросить, а закрытие окна
     * возвращает в правку ничего не теряя.
     *
     * null — крестик или Esc: вопрос закрыт, ответ не дан, остаёмся в правке.
     */
    const answer = await askConfirm(
      'Сохранить правки?',
      'Сохранить',
      {
        note: 'В «' + t.name + '» есть несохранённые изменения. '
            + 'Без сохранения они будут потеряны.',
        okClass: 'primary',
        cancelText: 'Отменить',
        closeIsNo: false,
      }
    );
    // null — закрыли без ответа: ничего не делаем, остаёмся в правке.
    if (answer === null) return;
    if (answer === true) {
      await save();
      return;
    }
  }

  if (saveIt) {
    await save();
    return;
  }

  // Отмена: возвращаем то, что реально лежит на диске.
  t.raw = t._diskRaw;
  t.dirty = false;
  t.mode = 'read';
  t.html = null;
  renderTabs();
  renderActive();
  status('Правки отменены', 'warn');
}

el.btnMode.onclick = async () => {
  const t = active();
  if (!t || !t.path) return;
  t.mode = 'edit';
  renderActive();
  el.editor.focus();
};

el.btnCancelEdit.onclick = () => exitEdit(false);

el.editor.addEventListener('input', () => {
  const t = active();
  if (!t) return;
  t.dirty = el.editor.value !== t._diskRaw;
  renderTabs();
  el.btnSave.classList.toggle('btn-save-dirty', t.dirty);
});

el.btnZoomIn.onclick = () => setZoom(zoom + 0.1);
el.btnZoomOut.onclick = () => setZoom(zoom - 0.1);

el.btnSidebar.onclick = () => toggleView('files');

el.dlBtn.onclick = (e) => { e.stopPropagation(); el.dlBtn.parentElement.classList.toggle('open'); };
document.addEventListener('click', () => el.dlBtn.parentElement.classList.remove('open'));
el.dlMenu.onclick = async (e) => {
  const act = e.target.getAttribute('data-act');
  if (!act) return;
  el.dlBtn.parentElement.classList.remove('open');
  const t = active();
  if (!t || !t.path) return;
  if (act === 'download-md') downloadMd();
  else if (act === 'download-html') downloadHtml();
  else if (act === 'print') api.print();
  else if (act === 'reveal') api.reveal(t.path);
  else if (act === 'copy-path') {
    navigator.clipboard.writeText(t.path).then(
      () => toast('Путь скопирован: ' + t.path),
      () => status('Буфер обмена недоступен', 'err')
    );
  }
};

// ---------------------------------------------------------- вид и панели

/*
 * Что показывать: оглавление слева, проводник справа, панели и полосы — по
 * галочкам в меню «Вид». Полоса вкладок не скрывается никогда: без неё
 * нельзя ни открыть файл, ни понять, что открыто.
 *
 * Состояние лежит в settings.json рядом с остальными настройками.
 */
const VIEW_DEFAULT = { toc: true, files: true, topbar: true, statusbar: true };
let view = Object.assign({}, VIEW_DEFAULT);

function applyView() {
  el.tocSide.hidden = !view.toc;
  el.tocResizer.hidden = !view.toc;
  el.filesSide.hidden = !view.files;
  el.filesResizer.hidden = !view.files;
  el.topbar.hidden = !view.topbar;
  el.statusbar.hidden = !view.statusbar || isBlankTab();
  if (view.toc && !isBlankTab()) { buildToc(); updateSpy(); }
  // Полоса вкладок живёт в своём контейнере и от панелей не зависит, но
  // шевроны прокрутки зависят от доступной ширины — пересчитываем.
  if (typeof updateTabsNav === 'function') updateTabsNav();
}

/** Переключить часть интерфейса и запомнить выбор. */
async function toggleView(key, force) {
  const next = force === undefined ? !view[key] : !!force;
  if (view[key] === next) return view[key];
  view[key] = next;
  applyView();
  syncViewButtons();
  try {
    currentSettings = Object.assign({}, currentSettings, { view: Object.assign({}, view) });
    await api.settingsSet({ view: Object.assign({}, view) });
  } catch (e) {
    status('Вид не сохранён: ' + (e.message || e), 'err');
  }
  return view[key];
}

function toggleToc(force) { return toggleView('toc', force); }
el.btnToc.onclick = () => toggleView('toc');
$('btnHideToc').onclick = () => toggleView('toc', false);
$('btnHideFiles').onclick = () => toggleView('files', false);

el.treeFilter.addEventListener('input', renderTree);

// Перетаскивание вкладок
initTabDrag();
initTabsScroll();

// --- правая панель разделения: крестик и ресайз
$('btnHideSecond').onclick = () => closeSecond();

// Позицию прокрутки второй панели запоминаем отдельно от первой: у них
// разные контейнеры, и при перестановке панелей местами scroll и scroll2
// меняются ролями вместе с вкладками.
el.content2.addEventListener('scroll', () => {
  const t = secondTab();
  if (t) t.scroll2 = el.content2.scrollTop;
}, { passive: true });

(() => {
  let drag = false;
  el.splitDivider.addEventListener('mousedown', (e) => {
    drag = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const box = el.split.getBoundingClientRect();
    const w = Math.max(260, Math.min(Math.round(box.width * 0.78), e.clientX - box.left));
    el.panel2.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// --- ресайз панелей: слева тянем за правый край, справа — за левый
(() => {
  let drag = null;
  const start = (side) => (e) => {
    drag = side;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  el.tocResizer.addEventListener('mousedown', start('toc'));
  el.filesResizer.addEventListener('mousedown', start('files'));

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const panel = drag === 'toc' ? el.tocSide : el.filesSide;
    const w = Math.max(170, Math.min(620, drag === 'toc' ? e.clientX : innerWidth - e.clientX));
    panel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// --- скролл: scroll-spy + кнопка «наверх»
el.content.addEventListener('scroll', () => {
  if (active()) active().scroll = el.content.scrollTop;
  updateSpy();
  el.toTop.hidden = el.content.scrollTop < 300;
}, { passive: true });

// --- drag & drop файлов и папок
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  el.dropOverlay.classList.add('on');
});
window.addEventListener('dragover', (e) => {
  if (![...(e.dataTransfer.types || [])].includes('Files')) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.dropOverlay.classList.remove('on');
});
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  el.dropOverlay.classList.remove('on');
  const files = [...(e.dataTransfer.files || [])];
  const dirs = [], mds = [], other = [];
  for (const f of files) {
    const p = api.pathForFile(f);
    if (!p) continue;
    const st = await api.stat(p);
    if (st.isDir) dirs.push(p);
    else if (/\.md$/i.test(p)) mds.push(p);
    else other.push(p);
  }
  for (const d of dirs) await addFolder(d);
  for (const m of mds) await openPath(m, { newTab: true });  // каждый файл — в своей вкладке
  if (other.length) status('Пропущено (не .md и не папка): ' + other.length, 'err');
});

// --- меню приложения
api.onMenu((action) => {
  switch (action) {
    case 'open-file': openFileDialog(); break;
    case 'open-folder': openFolderDialog(); break;
    case 'save': save(); break;
    case 'download-md': downloadMd(); break;
    case 'download-html': downloadHtml(); break;
    case 'print': api.print(); break;
    case 'find': openFind(); break;
    case 'toggle-sidebar': toggleView('files'); break;
    case 'toggle-toc': toggleToc(); break;
    // Ctrl+E только входит в правку. Выйти из неё — явными кнопками
    // «Сохранить»/«Отменить» (или Esc), чтобы правки не терялись молча.
    case 'toggle-mode': if (active() && active().mode !== 'edit') el.btnMode.click(); break;
    case 'cancel-edit': exitEdit(false); break;
    case 'back': go(-1); break;
    case 'forward': go(1); break;
    case 'new-tab': newTab(); break;
    case 'close-tab': if (activeId !== null) closeTab(activeId); break;
    // По порядку вкладок, а не по стеку visit.
    case 'next-tab': stepTab(1); break;
    case 'prev-tab': stepTab(-1); break;
    case 'reload': reload(); break;
  }
});

api.onCli(async (paths) => {
  for (const p of paths) {
    const st = await api.stat(p);
    if (st.isDir) await addFolder(p);
    else if (st.isFile && /\.md$/i.test(p)) await openPath(p, { newTab: true });
  }
});

// --- клавиатура
document.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) {
    if (e.key === 'F5' || !e.shiftKey) { e.preventDefault(); reload(); }
    return;
  }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); go(-1); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); go(1); return; }
  // Ctrl+Tab / Ctrl+Shift+Tab — по порядку вкладок, по кругу.
  // Здесь же renderer ловит то, что Chromium отдаёт системе: настоящие
  // Ctrl+Tab/Ctrl+Shift+Tab перехватывает ОС и в renderer они не приходят.
  if ((e.ctrlKey || e.metaKey) && e.key === 'Tab') {
    e.preventDefault();
    stepTab(e.shiftKey ? -1 : 1);
    return;
  }
  if (e.key === 'Escape') {
    const t = active();
    // Esc в правке — отмена (с вопросом, если есть несохранённое).
    if (t && t.mode === 'edit') { e.preventDefault(); exitEdit(false); return; }

  }
  // Ctrl+N — временная заметка в tmpdir, Ctrl+Shift+N — папка в открытой.
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'n' && !e.shiftKey) { e.preventDefault(); newTempNote(); return; }
    if (k === 'n' && e.shiftKey) { e.preventDefault(); newFolderInOpen(); return; }
    // Ctrl+, — настройки. shiftKey важен: Ctrl+Shift+, в Chromium это zoom out.
    if (k === ',' && !e.shiftKey) { e.preventDefault(); settingsDialog(); return; }
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    const t = active();
    if (t && t.mode === 'edit' && t.dirty) save(); else downloadMd();
  }
  // Tab в textarea должен вставлять отступ, а не менять фокус
  if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && document.activeElement === el.editor) {
    e.preventDefault();
    const s = el.editor.selectionStart, en = el.editor.selectionEnd;
    el.editor.value = el.editor.value.slice(0, s) + '  ' + el.editor.value.slice(en);
    el.editor.selectionStart = el.editor.selectionEnd = s + 2;
    el.editor.dispatchEvent(new Event('input'));
  }
});

// --- не закрывать молча с несохранённым
window.addEventListener('beforeunload', (e) => {
  const dirty = [...tabs.values()].some((t) => t.dirty);
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

// ============================================================ старт

// Статические <span data-i="имя"> в index.html превращаем в SVG.
// Раньше там стояли глифы Font Awesome (&#xf07b;), которые рисовались
// только при загруженном Nerd Font.
ICONS.hydrate(document);

/*
 * Резерв под системные кнопки окна. titleBarOverlay рисует «свернуть/развернуть/
 * закрыть» поверх содержимого, и без резерва полоса вкладок заезжала под них:
 * кнопка «+» пропадала, последние вкладки были не видны, а скролла не
 * появлялось — лента формально влезала, и переполнение считать было не от чего.
 */
function applyCaptionReserve(px) {
  const w = Math.max(0, Math.round(px || 0));
  document.documentElement.style.setProperty('--titlebar-right', w + 'px');
  updateTabsNav();
  scheduleElide();
}
if (api.caption) {
  // Запрос, а не подписка: сообщение могло бы уйти раньше, чем мы повесили
  // слушатель, и резерв остался бы дефолтным.
  api.caption().then(applyCaptionReserve).catch(() => {});
}

/* Хук для автотестов (test/startup.js).
   Системный диалог выбора папки из теста не открыть, а без него нельзя
   проверить, что дерево вообще появляется: addFolder() писал его в скрытый
   #workspace, и «Папка» визуально ничего не делала, пока не откроешь файл.
   Основной код сюда не обращается. Через contextBridge подменить
   диалог нельзя — объекты от contextBridge заморожены, присваивание молча
   игнорируется (на этом сначала и споткнулся тест). */
/* setConfirm подменяет вопрос «отменить правки?» — в тестах системный диалог
   открывать нельзя, он бы заблокировал renderer. */
let __confirmHook = null;
window.__mdvTest = {
  addFolder, renderTree, renderActive, refreshTreeSelection,
  roots, tabs, closeTab,
  newTab, openPath, active, stepTab, selectTab, samePath,
  duplicateTab, moveTab, fileContextMenu, tabContextMenu, trashFile, basname,
  setConfirm: (fn) => { __confirmHook = fn; },
  // Меню иконки приложения, недавние, настройки
  newFileAction, newProjectAction, recentDialog, settingsDialog,
  loadSettings, applySettings, previewSettings, noteRecent,
  view: () => Object.assign({}, view),
  secondId: () => secondId,
  zoom: () => zoom,
  setZoom,
  openSecond, closeSecond, splitScreen, renderSecond, swapPanes, secondTab,
  setView: (patch) => { Object.assign(view, patch); applyView(); syncViewButtons(); },
  settings: () => currentSettings,
  setSettings: (v) => { currentSettings = Object.assign({}, currentSettings, v); applySettings(currentSettings); },
  modalShell, modalBox, wireModal,
  clearRecents: () => api.recentClear(),
};

newTab();
renderTree();
loadSettings();
updateZoom();
status('Готово. Ctrl+O — открыть .md, Ctrl+Shift+O — открыть папку');