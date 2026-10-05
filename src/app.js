'use strict';
/* ============================================================================
 *  JazzReader — renderer. Вкладки, дерево папок, оглавление, история навигации.
 * ========================================================================== */

const api = window.mdv;
const { MDV_I18N } = window;
/*
 * Перевод строки. Короткое имя, потому что вызовов будет очень много.
 *
 * Не t(): в этом файле t — это вкладка, и таких мест несколько десятков.
 * Одноимённая функция молча перекрывала переменную, и `t.name` в диалогах
 * отдавал имя функции вместо имени файла.
 */
const tr = (key, params) => MDV_I18N.t(key, params);

/*
 * Язык из --lang=, заданный командной строкой. Пустая строка, если перекрытия
 * нет. Renderer не имеет доступа к argv главного процесса, значение отдаёт
 * preload, который читает аргумент, переданный окну при создании.
 *
 * let, а не const: перекрытие действует до первого явного выбора языка в
 * настройках, иначе окно настроек не могло бы сменить язык вообще — выбор
 * пользователя должен быть сильнее того, что было в командной строке.
 */
let MDV_FORCED_LANG = (api.forcedLang && api.forcedLang()) || '';

/** SVG-иконки Lucide (модуль генерирует scripts/vendor.js). */
const ICONS = window.MDV_ICONS;

const $ = (id) => document.getElementById(id);
const el = {
  tabbar: $('tabbar'), tabs: $('tabs'), btnNewTab: $('btnNewTab'),
  appBrand: $('appBrand'), tabsWrap: $('tabsWrap'),
  tabsLeft: $('tabsLeft'), tabsRight: $('tabsRight'),
  loading: $('loading'), loadingText: $('loadingText'), loadingSub: $('loadingSub'),
  btnBack: $('btnBack'), btnForward: $('btnForward'),
  btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), zoomVal: $('zoomVal'),
  welcome: $('welcome'), wOpenFile: $('wOpenFile'), wOpenFolder: $('wOpenFolder'),
    workspace: $('workspace'),
    tocSide: $('tocSide'), filesSide: $('filesSide'),
    tocResizer: $('tocResizer'), filesResizer: $('filesResizer'),
    topbar: document.querySelector('.topbar'),
    split: $('split'), splitDivider: $('splitDivider'),
    readProgress: $('readProgress'),
    radial: $('radial'),
    panel2: $('panel2'), content2: $('content2'), secondTitle: $('secondTitle'),
  paneFiles: $('paneFiles'), paneToc: $('paneToc'), treeFilter: $('treeFilter'),
  content: $('content'), editor: $('editor'), toTop: $('toTop'),
  statusbar: $('statusbar'), statusText: $('statusText'), fileName: $('fileName'),
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

/*
 * Какая из панелей «в фокусе» — та, с последней в которую ты заглянул.
 *
 * Новая вкладка открывается именно в ней. Раньше это работало только для
 * правой панели и только при клике по её вкладке: во всех остальных случаях
 * новая заметка занимала левую панель, даже если последние полминуты ты
 * смотрел в правую. Именно это и было неудобно: ждёшь, что заметка появится
 * там, где ты её видишь, а она появляется в другом краю экрана.
 */
let paneFocus = 'main';

/** Отметить панель, в которую только что зашли. */
function setPaneFocus(which) {
  paneFocus = which;
  // Подсветка нужна, чтобы было видно, куда придёт следующая вкладка.
  // Ставим безусловно, а не только при смене значения: атрибут — это и есть
  // состояние, и он должен быть верным с первой отрисовки, а не после первого
  // клика мышью.
  el.split.dataset.focus = which;
}
el.split.dataset.focus = paneFocus;

/** стек посещённых вкладок — чтобы Alt+←/→ работали как в браузере */
let visit = [];
let visitPos = -1;
/** открытые корневые папки: [{path, name, tree:[], total}] */
const roots = [];
let zoom = 1;
let statusTimer = null;
let findBar = null;

function active() { return tabs.get(activeId) || null; }

/**
 * Переключение вкладки. touch=false — не двигать позицию в стеке посещений.
 *
 * При разделённом экране вкладка открывается в ту панель, которая сейчас в
 * фокусе, а та, что её показывала, уезжает в соседнюю. Так заметка всегда
 * появляется там, куда смотришь. Исключение — клик по вкладке, которая уже
 * на виду в другой панели: тогда меняем панели местами, иначе рядом с
 * самим собой оказалось бы пусто.
 */
function selectTab(id, touch) {
  if (!tabs.has(id)) return;
  const visibleInSecond = secondId !== null && id === secondId;
  if (secondId !== null && (visibleInSecond || paneFocus === 'second')) {
    if (active()) active().scroll = el.content.scrollTop;
    const other = secondTab();
    if (other) other.scroll2 = el.content2.scrollTop;
    secondId = activeId;
    activeId = id;
    // Новая вкладка теперь в левой панели — фокус за ней.
    setPaneFocus('main');
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
  if (b < 1024) return b + tr('unit.b');
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + tr('unit.kb');
  return (b / 1048576).toFixed(1) + tr('unit.mb');
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
    x.title = tr('btn.close');
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
  const no = mk(o.cancelText || tr('btn.cancel'), '');
  const yes = mk(okText || tr('btn.ok'), o.okClass || '');
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
 * toast(tr('status.savedEllipsis'), 'ok') молча теряли цвет — сообщение выводилось
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
 * работает и наш собственный --jazzreader-hidden), поэтому ждём кадр, но
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
  el.loadingText.textContent = text || tr('status.opening');
  el.loadingSub.textContent = sub || '';
  el.loading.hidden = false;
}

function hideLoading() {
  el.loading.hidden = true;
  el.loadingText.textContent = tr('status.opening');
  el.loadingSub.textContent = '';
}

// ------------------------------------------------------------------- вкладки

function newTab() {
  const id = ++seq;
  tabs.set(id, {
    id, path: null, name: tr('tab.new'), raw: '', html: null,
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
      tr('discard.title'),
      tr('btn.save'),
      {
        note: tr('discard.inFile') + t.name + tr('discard.hasChanges'),
        okClass: 'primary',
        cancelText: tr('discard.withoutSaving'),
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
    row.title = openInSome && !isCur ? full + tr('status.openInOtherTab') : full;
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
    status(tr('status.closedAndSkipped') + closed + tr('status.skippedDirty') + skipped
      + tr('status.saveOrDiscardFirst'), 'err');
  } else if (closed) {
    status(tr('status.tabsClosed') + closed, 'ok');
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
        tr('discard.title'),
        tr('btn.save'),
        {
          note: tr('discard.inFile') + t.name + tr('discard.hasChanges'),
          okClass: 'primary',
          cancelText: tr('discard.withoutSaving'),
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
/*
 * Контекстное меню с подменю.
 *
 * Открытые меню лежат в menuChain по порядку: корень, его подменю, подменю
 * подменю. Раньше вместо этого у каждого меню был флажок _keep, и от него
 * была беда: подменю «Вид», однажды открывшись, уже не закрывалось никогда —
 * ��. потому что флажок стоял навсегда.
 *
 * Теперь правило простое:
 *   • курсор ушёл из всех открытых меню — закрываем всё;
 *   • курсор перешёл на другой пункт-подменю — закрываем подменю этого пункта,
 *     если оно было открыто, и открываем его;
 *   • клик по пункту без подменю — закрываем всё и выполняем действие.
 *
 * Пункт-подменю хранит своё подменю в _sub и не пересоздаёт его, пока
 * цепочка жива: иначе при простом движении мыши туда-сюда подменю мигало бы.
 *
 * Элемент меню:
 *   check: true|false — галочка, пункт-переключатель в подменю «Вид»
 *   items: [...]      — подменю, раскрывается вправо по наведению
 *   off               — пункт неактивен
 */
let menuChain = [];

/*
 * «Коридор» между кнопкой, открывшей меню, и самим меню.
 *
 * Меню вызывается кликом по кнопке, а открывается под ней. Между ними
 * остаётся пустое место — и наведение мыши на это место означало «курсор вне
 * меню», то есть закрытие. На гамбургере это выглядело так: нажал, повёл
 * вниз на «Файл» — по дороге всё закрылось, выбрать было нельзя.
 *
 * Поэтому запоминаем прямоугольник кнопки-источника и, если курсор внутри
 * него или внутри прямоугольника, натянутого между ним и меню, меню НЕ
 * закрываем. Именно коридор, а не задержка: задержка на уход приходится
 * платить при каждом обычном закрытии, а коридор стоит пустого места на
 * экране и ничего не портит — под него всё равно нельзя попасть кликом.
 */
let menuCorridor = null;

function menuCorridorFor(anchorRect, menuRect) {
  if (!anchorRect || !menuRect) return null;
  const x0 = Math.min(anchorRect.left, menuRect.left);
  const x1 = Math.max(anchorRect.right, menuRect.right);
  const y0 = Math.min(anchorRect.top, menuRect.top);
  const y1 = Math.max(anchorRect.bottom, menuRect.bottom);
  return { x0, y0, x1, y1 };
}

function inCorridor(pt) {
  if (!menuCorridor) return false;
  const c = menuCorridor;
  return pt.clientX >= c.x0 && pt.clientX <= c.x1 && pt.clientY >= c.y0 && pt.clientY <= c.y1;
}

function closeAllMenus() {
  menuCorridor = null;
  for (const link of menuChain) link.menu.remove();
  menuChain = [];
  document.removeEventListener('mousedown', onMenuDown, true);
  document.removeEventListener('keydown', onMenuKey, true);
  document.removeEventListener('mouseover', onMenuHover, true);
  window.removeEventListener('blur', onMenuBlur);
}

/** Снять подменю, открытое у пункта, — не трогая остальную цепочку. */
function dropSubmenu(parentMenu, item) {
  const link = menuChain.find((l) => l.parent === parentMenu && l.item === item);
  if (!link) return;
  link.menu.remove();
  menuChain = menuChain.filter((l) => l !== link);
}

function showContextMenu(x, y, items, opts) {
  const o = opts || {};
  // Новый корень меню закрывает всё, что было открыто. Подменю — нет: оно
  // само владеет уже открытой цепочкой и просто дописывается в конец.
  if (!o.parent) closeAllMenus();

  const w = o.width || 232;
  const h = o.height || (items.length * 30 + 14);

  const m = document.createElement('div');
  m.className = 'ctxmenu';
  m.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 6)) + 'px';

  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div');
      sep.className = 'ctxmenu-sep';
      m.append(sep);
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
    // Иконка слева от надписи, в одной строке с ней. Раньше контекстное меню
    // было без значков вовсе, и экспорт из кругового меню вышел голым текстом.
    if (it.icon) {
      const ic = document.createElement('span');
      ic.className = 'ico';
      ic.innerHTML = ICONS.icon(it.icon);
      l.append(ic);
    }
    l.append(document.createTextNode(it.label));
    const hn = document.createElement('span');
    hn.className = 'ctxmenu-hint';
    hn.textContent = it.hint !== undefined ? it.hint : (it.items ? '\u203a' : '');
    b.append(l, hn);

    if (it.items) {
      b.classList.add('ctxmenu-parent');
      b.onmouseenter = () => {
        // Переход на соседний пункт-подменю: старое подменю убираем.
        for (const other of menuChain) {
          if (other.parent === m && other.item !== b) dropSubmenu(m, other.item);
        }
        if (b._sub && b._sub.isConnected) return;   // уже открыто, не мигаем
        const r = b.getBoundingClientRect();
        b._sub = showContextMenu(r.right - 4, r.top - 5, it.items, {
          width: o.subWidth || 232, parent: m, parentItem: b,
        });
      };
      // Клик по пункту-подменю ничего не выполняет: это не действие.
      b.onclick = (e) => e.stopPropagation();
    } else {
      b.onclick = () => { closeAllMenus(); it.act(); };
    }
    b._index = m.querySelectorAll('.ctxmenu-item').length - 1;
    b._items = it.items || null;
    m.append(b);
  }

  document.body.append(m);
  menuChain.push({ menu: m, parent: o.parent || null, item: o.parentItem || null });
  // Первый доступный пункт сразу подсвечен: меню открыто с клавиатуры —
  // человек должен видеть, где окажется Enter.
  menuMark(m, menuItemsOf(m).findIndex((b) => !b.disabled));
  if (!o.parent) {
    // Коридор строится один раз, по геометрии корневого меню: подменю
    // открывается от пункта ВНУТРИ меню и курсор до него уже внутри.
    menuCorridor = menuCorridorFor(o.anchorRect, m.getBoundingClientRect());
  }

  // Слушатели вешаем на весь корень, а не на каждый вызов: иначе на
  // подменю висели бы копии, и закрытие одного закрывало бы не своё.
  if (!o.parent) {
    setTimeout(() => {
      if (!menuChain.length) return;
      document.addEventListener('mousedown', onMenuDown, true);
      document.addEventListener('keydown', onMenuKey, true);
      document.addEventListener('mouseover', onMenuHover, true);
      window.addEventListener('blur', onMenuBlur);
    }, 0);
  }
  m.addEventListener('contextmenu', (e) => e.preventDefault());
  return m;
}

function onMenuDown(e) {
  // Клик внутри подменю не закрывает меню: подменю — отдельный .ctxmenu, и
  // e.target.closest('.ctxmenu') его найдёт.
  if (!e.target.closest || !e.target.closest('.ctxmenu')) closeAllMenus();
}

/*
 * Навигация по меню с клавиатуры.
 *
 *   стрелки вверх/вниз, j/k — по пунктам;
 *   стрелки вправо/влево, l/h — по разветвлениям: вправо открывает
 *     подменю, лево возвращает в родительское;
 *   Enter или Space — подтвердить;
 *   Esc — закрыть меню, а если меню нет — закрыть окно.
 *
 * И то и другое нужно: человек с клавиатуры не должен тянуться к мыши, а у
 * мыши нет клавиши. Разделители пропускаются, список закольцован, и текущий
 * пункт виден рамкой, а не только подсветкой при наведении.
 */
function menuItemsOf(menu) {
  return [...menu.querySelectorAll('.ctxmenu-item')];
}

function menuMark(menu, index) {
  const items = menuItemsOf(menu);
  items.forEach((b, k) => b.classList.toggle('cur', k === index));
  const link = menuChain.find((l) => l.menu === menu);
  if (link) link.cur = index;
  const b = items[index];
  if (b) b.scrollIntoView({ block: 'nearest' });
}

/** Соседний доступный пункт, минуя разделители и неактивные. */
function menuStep(menu, from, dir) {
  const items = menuItemsOf(menu);
  if (!items.length) return -1;
  let k = from;
  for (let n = 0; n < items.length; n += 1) {
    k = (k + dir + items.length) % items.length;
    if (!items[k].disabled) return k;
  }
  return from;
}

function menuCurrent(link) {
  const items = menuItemsOf(link.menu);
  if (link.cur != null && items[link.cur] && !items[link.cur].disabled) return link.cur;
  const first = items.findIndex((b) => !b.disabled);
  return first;
}

/** Открыть подменю пункта (как при наведении мышью). */
function menuOpenSub(item) {
  if (!item || !item._items) return false;
  item.dispatchEvent(new MouseEvent('mouseenter'));
  return !!item._sub;
}

function onMenuKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeAllMenus(); return; }
  if (!menuChain.length) return;
  // Работает только в корневом меню: подменю следуют за родительским.
  const link = menuChain[0];
  const items = menuItemsOf(link.menu);
  const cur = menuCurrent(link);
  const item = items[cur];
  const k = e.key;

  const isDown = k === 'ArrowDown' || k === 'j' || k === 'J';
  const isUp = k === 'ArrowUp' || k === 'k' || k === 'K';
  const isRight = k === 'ArrowRight' || k === 'l' || k === 'L';
  const isLeft = k === 'ArrowLeft' || k === 'h' || k === 'H';
  const isOk = k === 'Enter' || k === ' ' || k === 'Spacebar';

  if (!isDown && !isUp && !isRight && !isLeft && !isOk) return;
  e.preventDefault();
  e.stopPropagation();

  if (isDown || isUp) {
    const next = menuStep(link.menu, cur, isDown ? 1 : -1);
    menuMark(link.menu, next);
    return;
  }
  if (isRight) {
    if (item && menuOpenSub(item)) menuMark(item._sub, menuCurrent(item._sub));
    return;
  }
  if (isLeft) {
    // Закрываем самое глубокое подменю: лево возвращает на уровень выше.
    if (menuChain.length > 1) {
      const deep = menuChain[menuChain.length - 1];
      const parentLink = menuChain[menuChain.length - 2];
      dropSubmenu(parentLink.menu, deep.item);
      menuMark(parentLink.menu, parentLink.item
        ? menuItemsOf(parentLink.menu).indexOf(parentLink.item) : menuCurrent(parentLink));
    }
    return;
  }
  if (isOk) {
    if (!item) return;
    if (item._items) {
      menuOpenSub(item);
      menuMark(item._sub, menuCurrent(item._sub));
      return;
    }
    if (!item.disabled) item.click();
  }
}

/**
 * Курсор ушёл из всех открытых меню — закрываем цепочку.
 *
 * Раньше закрытия по уходу курсора не было вовсе: меню с подменю оставалось
 * висеть после того, как мышь ушла из него (в меню иконки это выглядело так,
 * будто оно залипло). Слушатель на mouseover, а не на mousemove: событий
 * меньше, а нужны именно уходы курсора.
 */
function onMenuHover(e) {
  if (!menuChain.length) return;
  for (const link of menuChain) {
    if (link.menu.contains(e.target)) return;
  }
  if (inCorridor(e)) return;
  closeAllMenus();
}

function onMenuBlur() { closeAllMenus(); }

function tabContextMenu(id, x, y) {
  const ids = [...tabs.keys()];
  const i = ids.indexOf(id);
  const count = ids.length;
  const other = count - 1;

  return showContextMenu(x, y, [
    { label: tr('tab.duplicate'), act: () => duplicateTab(id) },
    { sep: true },
    { label: tr('tab.close'), hint: 'Ctrl+W', act: () => closeTab(id) },
    { label: tr('tab.closeOthers'), hint: other ? other + tr('unit.countShort') : '', act: () => closeOthers(id), off: other < 1 },
    { label: tr('tab.closeToRight'), hint: count - i - 1 ? count - i - 1 + tr('unit.countShort') : '', act: () => closeToRight(id), off: i >= count - 1 },
    { label: tr('tab.closeToLeft'), hint: i ? i + tr('unit.countShort') : '', act: () => closeToLeft(id), off: i < 1 },
    { sep: true },
    { label: tr('tab.closeAll'), hint: count ? count + tr('unit.countShort') : '', act: () => closeAll(), off: count < 1 },
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
      label: tr('file.open'),
      hint: open ? tr('file.alreadyOpenHint') : 'Ctrl+O',
      act: () => openPath(full, { newTab: false }),
    },
    {
      label: tr('file.openBackground'),
      hint: open ? tr('file.alreadyOpenHint') : tr('status.inBackground'),
      act: () => openPath(full, { newTab: true, background: true }),
    },
    {
      label: tr('file.edit'),
      off: !!dirtyTab,
      hint: dirtyTab ? tr('file.hasChangesHint') : 'Ctrl+E',
      act: async () => {
        const t = await openPath(full, { newTab: true });
        if (!t) return;
        if (t.mode !== 'edit') { t.mode = 'edit'; renderActive(); el.editor.focus(); }
      },
    },
    { sep: true },
    {
      label: tr('file.reveal'),
      act: () => api.reveal(full),
    },
    {
      label: tr('file.delete'),
      danger: true,
      off: !!dirtyTab,
      hint: dirtyTab ? tr('file.hasUnsavedHint') : tr('file.toTrashHint'),
      act: () => trashFile(full, label),
    },
  ], { width: 250, height: 250 });
}

/** Удаление в корзину: спрашиваем и имя файла, и сам факт. */
async function trashFile(full, label) {
  const open = findTabByPath(full);
  if (open && open.dirty) {
    status(tr('trash.blockedIn') + open.name + tr('trash.blockedTail'), 'err');
    return;
  }
  const answer = await askConfirm(
    tr('trash.title') + label + '»?',
    tr('btn.toTrash'),
    {
      note: tr('trash.note'),
      okClass: 'danger',
      cancelText: tr('btn.keep'),
    }
  );
  if (answer !== true) return;
  const res = await api.trash(full);
  if (!res || !res.ok) {
    status(tr('status.deleteFailed') + ((res && res.error) || tr('err.unknown')), 'err');
    return;
  }
  // Закрываем вкладку с удалённым файлом, чтобы не повисла со старым текстом.
  if (open) await closeTab(open.id);
  // Пересобираем дерево: файл мог лежать в корне или во вложенной папке.
  await refreshRoots();
  status(tr('status.deleted') + label, 'ok');
}

/** Дублирование вкладки: та же заметка, новая вкладка сразу справа. */
async function duplicateTab(id) {
  const src = tabs.get(id);
  if (!src) return;
  if (!src.path) { status(tr('err.nothingToDuplicate')); return; }
  // findTabByPath вернёт уже открытую вкладку, поэтому читаем файл в обход
  // openPath и создаём вкладку напрямую.
  const data = await api.read(src.path).catch(() => null);
  if (!data) { status(tr('err.cannotRead') + src.name, 'err'); return; }
  const t = blankTab();
  applyData(t, data);
  t.hist = [{ path: data.path, anchor: null }];
  t.hi = 0;
  selectTab(t.id);
  // Ставим копию сразу за исходной (moveTab перерисовывает сам).
  moveTab(t.id, id);
  renderActive();
  status(tr('status.duplicated') + t.name, 'ok');
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
/*
 * Подсказки при перетаскивании.
 *
 * Пока вкладку тянут, показываем ДВА места, а не одно:
 *   • в ленте вкладок — щель, которая откроется (место, куда вкладка встанет);
 *   • в рабочей области — рамку на месте будущей правой панели.
 *
 * Обе анимированы. Раньше вместо этого была одна мгновенная полоска
 * `box-shadow: inset` на вкладке под курсором: она прыгала без всякого
 * указания, куда вкладка встанет, и как экран разделится — тоже.
 */

/** Щель в ленте вкладок на месте будущей вкладки. */
let dropGap = null;

/** Рамка на месте будущей правой панели. */
function hintSplitPlace(on) {
  const main = document.getElementById('mainPane');
  if (main) main.classList.toggle('drop-split', !!on);
  document.getElementById('split').classList.toggle('split-preview', !!on);
}

/** Показать щель перед вкладкой after (или в конце, если after === null). */
function showDropGap(afterId) {
  hideDropGap();
  const tab = afterId === null ? null : el.tabs.querySelector('.tab[data-id="' + afterId + '"]');
  dropGap = document.createElement('div');
  dropGap.className = 'tab-gap';
  // Ширину берём у соседней вкладки, чтобы щель была ровно такой, какой
  // станет вкладка. flex: 1 1 180px у .tab сделает её такой и без нас, но
  // тогда анимировать нечего: сначала 0, потом ширина — и видно, как
  // открывается место.
  const near = tab || el.tabs.lastElementChild;
  dropGap.style.flexBasis = near ? Math.round(near.getBoundingClientRect().width) + 'px' : '180px';
  if (tab) el.tabs.insertBefore(dropGap, tab);
  else el.tabs.append(dropGap);
  // Один кадр без transition, потом включаем: иначе щель не растёт, а просто
  // появляется готовой.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (dropGap) dropGap.classList.add('open');
  }));
}

function hideDropGap() {
  if (!dropGap) return;
  dropGap.remove();
  dropGap = null;
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
    hideDropGap();
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
    if (el.tabs.contains(e.target)) { hintSplitPlace(false); return; }
    if (!el.split.contains(e.target)) { hintSplitPlace(false); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    hideDropGap();          // над полем заметки щель в ленте не нужна
    hintSplitPlace(true);
  });
  window.addEventListener('drop', (e) => {
    if (dragId === null) return;
    if (el.tabs.contains(e.target)) return;
    if (!el.split.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    hideDropGap();
    const id = dragId;
    dragId = null;
    el.tabs.classList.remove('dragging-active');
    // Предпросмотр снимаем ЗДЕСЬ, а не только по dragend: после отпускания
    // мыши над чужой вкладкой dragend может не прийти (или придёт позже), а
    // класс split-preview иначе остаётся, и панель навсегда остаётся
    // контуром с пустой шапкой.
    hintSplitPlace(false);
    openSecond(id);
  });

  el.tabs.addEventListener('dragover', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const over = e.target.closest('.tab');
    for (const x of el.tabs.querySelectorAll('.tab')) x.classList.remove('drop-before', 'drop-after');
    if (!over || +over.dataset.id === dragId) { hideDropGap(); return; }
    const r = over.getBoundingClientRect();
    const before = e.clientX < r.left + r.width / 2;
    over.classList.add(before ? 'drop-before' : 'drop-after');
    // Щель открывается ПОСЛЕ той вкладки, за которой встанет перетаскиваемая.
    if (before) showDropGap(+over.dataset.id);
    else {
      const ids = [...el.tabs.querySelectorAll('.tab')].map((x) => +x.dataset.id);
      const i = ids.indexOf(+over.dataset.id);
      showDropGap(i + 1 < ids.length ? ids[i + 1] : null);
    }
  });

  el.tabs.addEventListener('drop', (e) => {
    if (dragId === null) return;
    e.preventDefault();
    hideDropGap();
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
      + (t.id === secondId ? tr('tab.secondPanelNote') : '');
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
      dot.title = tr('tab.unsavedTitle');
      d.append(dot);
    }
    const x = document.createElement('button');
    x.className = 'tclose';
    x.innerHTML = ICONS.icon('x');
    x.title = tr('tab.closeTitle');
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
    status(tr('status.openingName') + basname(p) + '…');
    // Показываем индикатор и отдаём кадр, иначе он появится уже после того,
    // как всё отрисовалось, и толку от него не будет.
    showLoading(tr('status.openingName') + basname(p) + '…');
    await nextPaint();
    const data = await api.read(p);
    if (my !== loadSeq) return null;
    showLoading(tr('status.openingName') + basname(p) + '…', fmtSize(data.size));
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
        t.html = tr('render.errorPre')
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
    status(tr('status.openFailed') + (e.message || e), 'err');
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
  if (!data) { status(tr('status.openFailedName') + basname(p), 'err'); return null; }
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
      if (!data) { status(tr('status.fileUnavailable') + basname(entry.path), 'err'); return; }
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
  el.btnBack.title = docBack ? tr('nav.backDoc') : tr('nav.backTab');
  el.btnForward.title = docFwd ? tr('nav.fwdDoc') : tr('nav.fwdTab');
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
    document.title = 'JazzReader';
    updateNavButtons();
    return;
  }
  el.statusbar.hidden = !view.statusbar;

  document.title = t.name + ' — JazzReader';
  el.fileName.textContent = t.path;
  el.fileName.title = t.path;

  const editing = t.mode === 'edit';
  el.editor.hidden = !editing;
  el.content.hidden = editing;
  // В правке — зелёная «Сохранить» и красная «Отменить» вместо одного
  // переключателя. Раньше он просто уводил из правки, оставляя изменения
  // в памяти: их можно было потерять молча, ничего не спрашивая.

  if (editing) {
    // Присваиваем только если текст действительно другой: любая перерисовка
    // заметки перезаписывала бы поле и обнуляла историю отмены.
    if (el.editor.value !== t.raw) {
      el.editor.value = t.raw;
      resetUndo(t);
    }
    // Точка отсчёта истории — текст, который в поле СЕЙЧАС. Задавать её надо
    // здесь: если отложить до первого нажатия, «до правки» окажется уже
    // исправленным текстом и отменять будет нечего.
    t.undoLast = t.raw;
  } else {
    if (t.html === null) {
      try {
        t.html = MDV.renderMd(t.raw, t.baseUrl);
      } catch (e) {
        t.html = tr('render.errorPre') + MDV.escapeHtml(String(e.message || e)) + '</pre>';
        status(tr('render.error') + (e.message || e), 'err');
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
  updateReadProgress();
  refreshTreeSelection();
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
  if (id === activeId) { status(tr('tab.alreadyLeft')); return false; }
  if (secondId !== null && tabs.has(secondId)) secondTab().scroll2 = el.content2.scrollTop;
  secondId = id;
  // Правая панель только что появилась, но фокус остаётся у левой: человек
  // тянул вкладку из правой части экрана, а не работал в новой панели.
  setPaneFocus('main');
  hintSplitPlace(false);
  renderSecond();
  renderTabs();
  status(tr('status.movedRight') + tabs.get(id).name, 'ok');
  return true;
}

/** Убрать правую панель. */
function closeSecond() {
  closeRadial();
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
  if (!ids.length) { status(tr('err.nothingToSplit')); return false; }
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
      t.html = tr('render.errorPre') + MDV.escapeHtml(String(e.message || e)) + '</pre>';
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
  dockerfile: 'Dockerfile', makefile: 'Makefile', plaintext: tr('lang.plaintext'), text: tr('lang.plaintext'),
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
    btn.innerHTML = ICONS.icon('copy') + tr('clip.copyBtnHtml');
    btn.onclick = () => {
      const text = code ? code.innerText : pre.innerText;
      navigator.clipboard.writeText(text).then(
        () => {
          btn.classList.add('ok');
          btn.innerHTML = ICONS.icon('check') + tr('clip.copiedBtnHtml');
          setTimeout(() => {
            btn.classList.remove('ok');
            btn.innerHTML = ICONS.icon('copy') + tr('clip.copyBtnHtml');
          }, 1400);
        },
        () => { btn.textContent = tr('clip.failedBtn'); }
      );
    };
    pre.append(btn);
  }
}

/** Клик по отрендеренной формуле показывает её LaTeX-исходник. */
function decorateMath(root) {
  const box = root || el.content;
  for (const m of box.querySelectorAll('.mdv-math')) {
    m.title = tr('md.latexTip');
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

/*
 * Оглавление — дерево, а не плоский список с отступами.
 *
 * Заголовки идут подряд, уровень известен по тегу (h1..h4), поэтому дерево
 * строится стеком: идём по заголовкам, отбрасываем с верху стека всё с
 * уровнем не меньше текущего, и текущий становится под последним оставшимся.
 *
 * Сворачивание нужно для длинных оглавлений: в заметке на 2000 строк их
 * десятки, и до нужного раздела невозможно добраться, не прокрутив полстолба.
 * Стрелка есть только у разделов с потомками — у листьев её рисовать нечем.
 * Состояние живёт во вкладке (t.tocClosed), поэтому переключение вкладок
 * не сбрасывает то, что человек свернул.
 *
 * Если заголовков очень много (> TOC_AUTO_COLLAPSE), на первый раз все
 * разделы свёрнуты: список в 200 строк всё равно не читают, его открывают по
 * одной ветке. Помечаем это состояние как автоматическое, чтобы при первом
 * же клике человек получил развернутое дерево, а не пустое.
 */
const TOC_AUTO_COLLAPSE = 60;

function tocNode(h, id) {
  const lvl = +h.tagName[1];
  const row = document.createElement('div');
  row.className = 'toc-row';
  row.dataset.l = String(lvl);

  // Стрелка. Пока потомков нет, она не рисуется вовсе — иначе в списке из
  // двух пунктов половина строк была бы в бесполезных значках.
  const twist = document.createElement('button');
  twist.className = 'toc-twist';
  twist.type = 'button';
  twist.innerHTML = ICONS.icon('chevron-right');
  twist.title = tr('md.collapseSection');
  twist.setAttribute('aria-expanded', 'true');
  row.append(twist);

  const a = document.createElement('a');
  a.className = 'toc-link';
  a.href = '#' + id;
  a.textContent = h.textContent;
  a.onclick = (e) => {
    e.preventDefault();
    pushHist(active(), active() ? active().path : null, id);
    scrollToAnchor(id);
    updateNavButtons();
  };
  row.append(a);

  const kidsBox = document.createElement('div');
  kidsBox.className = 'toc-kids';

  // kids — массив дочерних УЗЛОВ (не DOM-элементов), kidsBox — их контейнер
  // в разметке. Раньше оба назывались kids, и дерево падало на
  // parent.kids.push(...) — parent.kids оказывался div'ом.
  const node = { lvl, row, kids: [], twist, a, kidsBox, hasKids: false, closed: false };
  twist.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setTocNodeClosed(node, !node.closed, true);
    // Свернули ветку — её внутренние разделы тоже должны лежать, иначе при
    // обратном раскрытии они вылезут развёрнутыми.
    if (node.closed) hideSubtree(node.kids);
  };
  return node;
}

function setTocNodeClosed(node, closed, byUser) {
  node.closed = closed;
  node.kidsBox.hidden = closed;
  node.row.classList.toggle('closed', closed);
  node.twist.setAttribute('aria-expanded', closed ? 'false' : 'true');
  const t = active();
  if (!t) return;
  if (!t.tocClosed) t.tocClosed = new Set();
  const key = node.a.getAttribute('href').slice(1);
  if (closed) t.tocClosed.add(key); else t.tocClosed.delete(key);
  // Автосворачивание живёт один раз: дальше решает человек.
  if (byUser) t.tocTouched = true;
}

function buildToc() {
  const t = active();
  el.paneToc.innerHTML = '';
  spyHeads = []; spyLinks = [];
  if (!t || !t.path || t.mode === 'edit') {
    el.paneToc.innerHTML = tr('toc.noHeadingsEmpty');
    return;
  }
  const heads = [...el.content.querySelectorAll('h1, h2, h3, h4')];
  if (!heads.length) {
    el.paneToc.innerHTML = tr('toc.noHeadingsBody');
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
  }

  // Дерево стеком: верхушка стека — последний открытый предок.
  const top = [];
  const stack = [];
  for (const h of heads) {
    const node = tocNode(h, h.id);
    const lvl = node.lvl;
    while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.kids.push(node); else top.push(node);
    stack.push(node);
    spyHeads.push(h);
    // Именно строка, а не узел дерева: updateSpy вешает на этот элемент
    // класс active. С узлом было бы .active не у того элемента, а ни у
    // какого — и оглавление оставалось бы пустым с первого же кадра.
    spyLinks.push(node.row);
  }
  // Разворачиваем дерево в DOM. Контейнер потомков — СОСЕД строки, а не её
  // потомок внутри: .toc-row это flex-линия, и вложенный div встал бы в неё
  // рядом со ссылкой. Соседним он и скрывается целиком по hidden.
  const draw = (nodes, host) => {
    for (const n of nodes) {
      host.append(n.row);
      if (n.kids.length) {
        n.hasKids = true;
        host.append(n.kidsBox);
        draw(n.kids, n.kidsBox);
      } else {
        n.twist.hidden = true;   // у листа стрелки нет вовсе
      }
    }
  };
  draw(top, el.paneToc);

  // Свёрнутое состояние живёт во вкладке. Если заголовков очень много и
  // человек ещё не трогал оглавление, все разделы сворачиваются: список в
  // 200 строк всё равно не читают, его открывают по одной ветке. Пометка
  // tocTouched ставится только кликом — дальше решает человек.
  const t0 = active();
  const autoClose = heads.length > TOC_AUTO_COLLAPSE && !t0.tocTouched;
  const walk = (nodes) => {
    for (const n of nodes) {
      if (!n.hasKids) continue;
      const key = n.a.getAttribute('href').slice(1);
      const was = !!(t0.tocClosed && t0.tocClosed.has(key));
      setTocNodeClosed(n, was || autoClose, false);
      if (!n.closed) walk(n.kids);
    }
  };
  walk(top);
}

/** Свернуть ветку целиком. */
function hideSubtree(nodes) {
  for (const n of nodes) {
    n.closed = true;
    n.kidsBox.hidden = true;
    n.row.classList.add('closed');
    n.twist.setAttribute('aria-expanded', 'false');
    hideSubtree(n.kids);
  }
}

/*
 * Линия прогресса чтения.
 *
 * Прячется, пока прокручивать нечего: в начале заметки и в заметке без
 * прокрутки пустая линия ничего не сообщает. В конце заполняется целиком —
 * так видно «дочитал».
 */
function updateReadProgress() {
  const c = el.content;
  if (!c || !el.readProgress) return;
  const max = c.scrollHeight - c.clientHeight;
  const editing = el.editor && !el.editor.hidden;
  // В режиме правки прокручивается редактор, а не статья: полоса показывала
  // бы процент не того документа.
  const box = editing ? el.editor : c;
  const span = box.scrollHeight - box.clientHeight;
  const p = span > 1 ? Math.min(1, Math.max(0, box.scrollTop / span)) : 0;
  const show = !editing && (max > 4 || span > 4) && (p > 0.002 || max > 4);
  el.readProgress.classList.toggle('on', show);
  el.readProgress.style.width = (p * 100).toFixed(2) + '%';
}

/** Войти в режим правки. Кнопка в тулбаре и пункт кругового меню делают
 *  одно и то же, и обе дороги ведут сюда. */
function toggleEditMode() {
  const t = active();
  if (!t || !t.path) return;
  if (t.mode === 'edit') return;
  closeRadial();
  t.mode = 'edit';
  renderActive();
  resetUndo(t);
  el.editor.focus();
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
  if (roots.some((r) => r.path === p)) { status(tr('status.folderAlreadyOpen') + p); return; }
  status(tr('status.scanning') + basname(p) + '…');
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
  status(res.total ? tr('status.inFolder') + res.total + ' .md — ' + basname(p) : tr('status.noMdIn') + basname(p), res.total ? 'ok' : 'err');
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
    el.paneFiles.innerHTML = tr('tree.empty');
    return;
  }
  for (const r of roots) {
    const head = document.createElement('div');
    head.className = 'tree-root';
    const rm = document.createElement('button');
    rm.className = 'tree-remove';
    rm.innerHTML = ICONS.icon('x');
    rm.title = tr('tree.removeRoot');
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
          if (openInSome && !isCur) row.title = it.full + tr('status.openInOtherTab');
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
      none.textContent = q ? tr('tree.nothingFound') : tr('tree.noMdHere');
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
    status(tr('zoom.badValue') + raw, 'err');
    zoomEditing = false;
    updateZoom();
    return false;
  }
  // Без знака «%» число <= 1 читаем как долю (0.85 -> 85%), больше 1 — как
  // проценты (85 -> 85%). Иначе «1» означал бы 1% невозможного.
  const z = raw.indexOf('%') >= 0 ? n / 100 : (n <= 1 ? n : n / 100);
  if (z < ZOOM_MIN || z > ZOOM_MAX) {
    status(tr('zoom.outOfRange') + Math.round(ZOOM_MIN * 100) + '–'
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
    toast(tr('status.saved') + t.name, 'ok');
    return true;
  } catch (e) {
    status(tr('status.saveFailed') + (e.message || e), 'err');
    return false;
  }
}

async function save() {
  const t = active();
  if (!t || !t.path) return;
  if (!t.dirty) { toast(tr('status.noChanges')); return; }
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

/**
 * Форматы экспорта.
 *
 * MD и TXT — файл как есть (TXT без разметки), их видно целиком и решать
 * там нечего. HTML и PDF собираются заново, и только для них имеют смысл
 * палитра, шрифт и размер: это не оформление заметки, а оформление файла,
 * который уедет с машины.
 *
 * У каждого формата свой цвет иконки. Раньше все иконки в выбранном сегменте
 * становились одинаково голубыми, и четыре формата читались как один
 * переключатель; теперь видно, где какой.
 */
const EXPORT_FORMATS = [
  { id: 'md', label: 'MD', icon: 'file-text', plain: true, color: 'var(--blue)',
    hint: tr('export.hintSource') },
  { id: 'txt', label: 'TXT', icon: 'file-down', plain: true, color: 'var(--green)',
    hint: tr('export.hintPlain') },
  { id: 'html', label: 'HTML', icon: 'file-code', plain: false, color: 'var(--magenta)',
    hint: tr('export.hintSingleFile') },
  { id: 'pdf', label: 'PDF', icon: 'printer', plain: false, color: 'var(--orange)',
    hint: tr('export.hintPrint') },
];

/*
 * Цвет кнопки «Цветное».
 *
 * Один и тот же цвет каждый раз выглядел бы как часть интерфейса: человек
 * привыкает, что голубая кнопка значит «цветное», и перестаёт её читать.
 * Поэтому набор из палитры TokyoNight и шаг по нему: цвета каждый раз
 * разные, но не выпадают, а голубого здесь нет — он у MD.
 */
const EXPORT_TINTS = ['var(--green)', 'var(--orange)', 'var(--red)',
  'var(--yellow)', 'var(--purple)'];
let exportTintAt = 0;

function nextExportTint() {
  const c = EXPORT_TINTS[exportTintAt % EXPORT_TINTS.length];
  exportTintAt += 1;
  return c;
}

/** Своё имя шрифта JetBrains для показа в списке: в CSS оно без пробела. */
function exportFontLabel(name) {
  return name === 'JetBrainsMono' ? 'JetBrains Mono' : name;
}

/**
 * Окно экспорта.
 *
 * Отдельное окно, а не список в кольце: у форматов есть параметры, а у
 * параметров — предпросмотр, и всё это не влезает в меню. В кольце осталось
 * два действия: «Экспорт» открывает это окно, «Путь» — короткое меню про
 * путь к файлу.
 *
 * Слева настройки, справа предпросмотр: подсказки убирали, карточки стали
 * низкими, и места для предпросмотра в одной колонке не хватало — он
 * получался узкой полосой, где не видно ни заголовка, ни таблицы.
 */
function exportDialog(preset) {
  const t = active();
  if (!t || !t.path) { toast(tr('export.noNote')); return; }
  if (t.mode === 'edit' && t.dirty) { toast(tr('export.saveFirst')); return; }

  let closeModal = () => back.remove();
  const back = modalShell();
  const box = modalBox(tr('export.title'), 860, 620);
  box.classList.add('exp-box');

  // Настройки слева, предпросмотр справа.
  const body = document.createElement('div');
  body.className = 'exp-body';
  const left = document.createElement('div');
  left.className = 'exp-col exp-left';
  const right = document.createElement('div');
  right.className = 'exp-col exp-right';
  body.append(left, right);
  box.append(body);

  const first = EXPORT_FORMATS.find((f) => f.id === preset) || EXPORT_FORMATS[2];
  const state = {
    format: first.id,
    bw: false,
    size: BASE_TEXT_PX,
    font: 'JetBrainsMono',
  };
  const fmtById = (id) => EXPORT_FORMATS.find((f) => f.id === id) || first;
  // Карточка размера: к ней обращается syncAll, а она создаётся ниже.
  let sizeCard = null;

  /**
   * Одна настройка — карточка: заголовок со значением справа, контрол под ним.
   * Подсказок нет: их было четыре, и каждая отнимала строку у предпросмотра,
   * а сказать было нечего — подпись кнопки и так всё объясняет.
   */
  function addCard(label, valueEl) {
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
    left.append(row);
    row.addControl = (ctl) => { row.append(ctl); return ctl; };
    return row;
  }

  /** Ряд кнопок-переключателей: формат, палитра. */
  function segmented(options, current, onPick) {
    const wrap = document.createElement('div');
    wrap.className = 'exp-seg';
    const btns = options.map((o) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'exp-segbtn' + (o.cls ? ' ' + o.cls : '');
      b.dataset.id = o.id;
      if (o.color) b.style.setProperty('--seg', o.color);
      if (o.icon) {
        const ic = document.createElement('span');
        ic.className = 'ico';
        ic.innerHTML = ICONS.icon(o.icon);
        b.append(ic);
      }
      const tx = document.createElement('span');
      tx.textContent = o.label;
      b.append(tx);
      b.onclick = () => onPick(o.id);
      wrap.append(b);
      return b;
    });
    const sync = (id) => btns.forEach((b) => b.classList.toggle('on', b.dataset.id === id));
    sync(current);
    wrap.sync = sync;
    return wrap;
  }

  // ---------------------------------------------------------------- формат
  const fmtCard = addCard(tr('export.format'));
  const fmtSeg = segmented(EXPORT_FORMATS.map((f) => ({
    id: f.id, label: f.label, icon: f.icon, color: f.color,
  })), state.format, (id) => {
    state.format = id;
    fmtSeg.sync(id);
    syncAll();
  });
  fmtCard.addControl(fmtSeg);

  // ---------------------------------------------------------------- палитра
  const palCard = addCard(tr('export.palette'));
  const palSeg = segmented([
    { id: 'colour', label: tr('export.colour'), cls: 'tinted', color: nextExportTint() },
    { id: 'bw', label: tr('export.bw'), cls: 'bw' },
  ], state.bw ? 'bw' : 'colour', (id) => {
    state.bw = id === 'bw';
    palSeg.sync(id);
    syncAll();
  });
  palCard.addControl(palSeg);

  // ------------------------------------------------------------ размер шрифта
  const sizeOut = document.createElement('span');
  sizeOut.className = 'set-val';
  const sizeIn = document.createElement('input');
  sizeIn.type = 'range';
  sizeIn.min = '11';
  sizeIn.max = '28';
  sizeIn.step = '1';
  sizeIn.value = String(state.size);
  sizeIn.oninput = () => {
    state.size = +sizeIn.value;
    sizeOut.textContent = sizeIn.value + ' px';
    paintRange(sizeIn);
    syncAll();
  };
  sizeCard = addCard(tr('export.fontSize'), sizeOut);
  sizeCard.addControl(sizeIn);

  // ------------------------------------------------------------------ шрифт
  const fontSel = document.createElement('select');
  fontSel.className = 'exp-select';
  fontSel.disabled = true;
  const fontLoading = document.createElement('option');
  fontLoading.textContent = tr('export.loadingFonts');
  fontSel.append(fontLoading);
  fontSel.onchange = () => {
    state.font = fontSel.value || 'JetBrainsMono';
    syncAll();
  };
  const fontCard = addCard(tr('export.font'));
  fontCard.addControl(fontSel);
  const fillFonts = (names) => {
    fontSel.innerHTML = '';
    const list = (names && names.length ? names : ['JetBrainsMono']).slice();
    if (!list.includes('JetBrainsMono')) list.unshift('JetBrainsMono');
    for (const n of list) {
      const o = document.createElement('option');
      o.value = n;
      o.textContent = exportFontLabel(n);
      fontSel.append(o);
    }
    fontSel.value = state.font;
    fontSel.disabled = false;
  };
  // Шрифты читает main из реестра Windows: renderer их не перечислит.
  Promise.resolve(api.fonts()).then(fillFonts, () => fillFonts(null));

  // ------------------------------------------------------------- предпросмотр
  const cap = document.createElement('div');
  cap.className = 'exp-cap';
  cap.textContent = tr('export.preview');
  const prev = document.createElement('div');
  prev.className = 'exp-preview';
  const doc = document.createElement('article');
  doc.className = 'content exp-doc';
  prev.append(doc);
  right.append(cap, prev);

  /*
   * Один проход на любое изменение.
   *
   * Предпросмотр показывает ровно то, что уедет в файл: для MD — исходный
   * текст, для TXT — текст без разметки, для HTML и PDF — собранную заметку
   * с выбранными палитрой, шрифтом и размером.
   */
  function syncAll() {
    const f = fmtById(state.format);
    fmtSeg.sync(state.format);
    palSeg.sync(state.bw ? 'bw' : 'colour');
    const plain = !!f.plain;
    // У MD и TXT нет оформления — показывать палитру и шрифт было бы враньём,
    // и человек настраивал бы то, чего в файле нет.
    palCard.hidden = plain;
    sizeCard.hidden = plain;
    fontCard.hidden = plain;
    prev.classList.toggle('bw', !plain && state.bw);
    prev.classList.toggle('plain', plain);
    prev.style.setProperty('--exp-mono',
      '"' + String(state.font).replace(/["'\\]/g, '') + '", monospace');
    prev.style.setProperty('--exp-size', state.size + 'px');
    if (plain) {
      let pre = doc.querySelector('.exp-plain');
      if (!pre) { doc.innerHTML = ''; pre = document.createElement('pre'); pre.className = 'exp-plain'; doc.append(pre); }
      pre.textContent = state.format === 'md' ? t.raw : MDV.mdToText(t.raw);
    } else {
      doc.innerHTML = MDV.renderMd(t.raw, t.baseUrl);
    }
    ok.textContent = tr('export.doIt');
  }

  // ----------------------------------------------------------------- кнопки
  const row = document.createElement('div');
  row.className = 'modal-row';
  const cancel = document.createElement('button');
  cancel.className = 'dlgbtn';
  cancel.textContent = tr('btn.cancel');
  cancel.onclick = () => closeModal(false);
  const ok = document.createElement('button');
  ok.className = 'dlgbtn dlgbtn-primary';
  ok.onclick = run;
  row.append(cancel, ok);
  box.append(row);

  back.append(box);
  document.body.append(back);
  closeModal = wireModal(back, () => ok);
  sizeOut.textContent = sizeIn.value + ' px';
  paintRange(sizeIn);
  syncAll();

  // Enter в окне — экспорт. В списке шрифтов Enter открывает сам список, там
  // подтверждением ничего не сделать.
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      e.stopPropagation();
      run();
    }
  });

  let busy = false;

  async function run() {
    if (busy) return;
    const tab = active();
    // Пока окно открыто, вкладку могли закрыть по Ctrl+W — тогда экспортируем
    // не то.
    if (!tab || tab.path !== t.path) { closeModal(false); return; }
    if (tab.mode === 'edit' && tab.dirty) { toast(tr('export.saveFirst')); closeModal(false); return; }

    const base = t.name.replace(/\.md$/i, '');
    busy = true;
    ok.disabled = true;
    ok.textContent = tr('export.preparing');
    try {
      if (state.format === 'md') {
        download(t.name, t.raw, 'text/markdown');
        toast(tr('status.saved') + t.name, 'ok');
      } else if (state.format === 'txt') {
        const file = base + '.txt';
        download(file, MDV.mdToText(t.raw), 'text/plain');
        toast(tr('status.saved') + file, 'ok');
      } else {
        const body = MDV.renderMd(t.raw, t.baseUrl);
        const opts = { font: state.font, size: state.size, bw: state.bw };
        const res = state.format === 'html'
          ? await api.exportHtml({ title: t.name, body, opts })
          : await api.exportPdf({ title: t.name, body, opts });
        toast(tr('status.saved') + res.path + ' (' + fmtSize(res.bytes) + ')', 'ok');
        api.reveal(res.path);
      }
      closeModal(false);
    } catch (e) {
      status(tr('export.error') + (e.message || e), 'err');
      busy = false;
      ok.disabled = false;
      syncAll();
    }
  }
}

// ------------------------------------------------------------------ поиск

function openFind() {
  if (findBar) { findBar.input.focus(); return; }
  const bar = document.createElement('div');
  bar.style.cssText = 'position:absolute;top:8px;right:22px;z-index:70;display:flex;gap:5px;align-items:center;'
    + 'background:#1f2335;border:1px solid #2f3b54;border-radius:8px;padding:5px 7px;font-family:"Segoe UI",sans-serif';
  bar.innerHTML = tr('find.placeholderInput')
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
  bar.box.querySelector('.cnt').textContent = bar.marks.length + tr('find.found');
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
    { label: tr('ring.openFile'), hint: 'Ctrl+O', act: openFileDialog },
    { label: tr('ring.openFolder'), hint: 'Ctrl+Shift+O', act: openFolderDialog },
  ], { width: 232, height: 80, anchorRect: r });
};

/* ------------------------------------------------- круговое меню заметки

 * Правый клик внутри заметки открывает кольцо кнопок вокруг точки клика.
 * Состав зависит от режима, поэтому меню собирается кодом, а не разметкой:
 *   сверху   буфер обмена — копировать, вырезать, вставить;
 *   снизу    правка — карандаш в чтении, «Сохранить» и «Отмена» в правке;
 *   справа   экспорт: раскрывает обычное меню экспорта у этой кнопки;
 *   слева    «+»: открыть файл или папку.
 *
 * Копирование и вырезание работают с текущим выделением. Вставка осмысленна
 * только в правке: в чтении полем некуда, поэтому кнопка там неактивна — но
 * показана, чтобы кольцо не меняло форму от заметки к заметке.
 *
 * Меню закрывается: кликом вне, Esc, прокруткой, переходом на другую
 * заметку. На export и «+» не закрывается — вместо этого открывается второе
 * меню прямо у нажатой кнопки.
 */

/*
 * Раскладка кольца.
 *
 * Углы не заданы жёстко: пунктов в секции столько, сколько имеет смысл
 * показать, и секция центрируется по своему низу/верху. Иначе кольцо то
 * перекашивало (три кнопки сверху и одна слева снизу), то выглядело пустым.
 *
 * slot — где пункт по смыслу: верхняя секция (буфер обмена), нижняя (правка),
 * либо фиксированные позиции справа и слева.
 *
 * Мёртвых кнопок нет: то, что сейчас бесполезно, просто не показывается.
 * Раньше кнопки оставались на месте, но становились серыми и не нажимались —
 * выглядело это как «иконка сломалась».
 */
const RADIAL_LAYOUT = [
  // Правка сверху, буфер обмена снизу. Секции кольца делятся дугами, а не
  // кнопками на окружности: в круглый кружок попадать неудобно, в сектор —
  // легко. Отдельно стоящие действия занимают свои дуги целиком.
  //
  // tip хранится ключом, а не текстом: эта таблица собирается один раз при
  // загрузке скрипта, когда язык ещё не применён. С текстом подписи
  // запекались на стартовом языке навсегда и не переводились при смене.
  { act: 'mode', slot: 'top', icon: 'pencil', tipKey: 'ring.editTip' },
  { act: 'save', slot: 'top', icon: 'save', tipKey: 'ring.saveTip', cls: 'r-save' },
  { act: 'cancel', slot: 'top', icon: 'x', tipKey: 'ring.cancelTip', cls: 'r-cancel' },
  // Справа — всё, что делают с файлом целиком: экспорт и путь. Слева — только
  // открытие. Раньше «Путь» стоял слева рядом с «Открыть», и две кнопки,
  // которые делают одно и то же — показывают файл, — делили одну дугу между
  // собой; на открытие файла оставалось 39 градусов, столько же, сколько на
  // один из трёх секторов буфера обмена.
  //
  // Границы правых секторов заданы руками, а не делением дуги пополам: шов
  // пополам приходился бы ровно на 0 градусов, то есть на «строго вправо».
  // Выбор по направлению и наведение целятся именно туда, и в этой точке
  // кольцо решало бы, экспорт это или путь.
  { act: 'export', slot: 'right', from: -39, to: 9, icon: 'folder-output',
    tipKey: 'ring.exportTip', cls: 'r-export' },
  { act: 'path', slot: 'right', from: 9, to: 39, icon: 'signpost',
    tipKey: 'ring.pathTip', cls: 'r-path' },
  { act: 'copy', slot: 'bottom', icon: 'copy', tipKey: 'ring.copyTip' },
  { act: 'cut', slot: 'bottom', icon: 'scissors', tipKey: 'ring.cutTip' },
  { act: 'paste', slot: 'bottom', icon: 'clipboard-paste', tipKey: 'ring.pasteTip' },
  { act: 'open', slot: 'left', icon: 'plus', tipKey: 'ring.openTip', cls: 'r-open' },
];

let radialOpen = false;
/** Выбранное действие: по нему идёт и подсветка, и клавиатурный обход. */
let radialCur = null;
/**
 * Где стоял значок выбранного сектора — на момент, когда кольцо ещё было
 * открыто.
 *
 * Нужно меню, которое открывается под нажатой иконкой: в режиме «зажать и
 * вести» решение принимается на отпускании, и к этому моменту кольцо уже
 * закрыто. У скрытого элемента getBoundingClientRect() отдаёт нули, поэтому
 * меню и вылезало в левый верхний угол окна. Запоминаем прямоугольник, пока
 * кольцо живо.
 */
let radialDotRect = null;
/** Действия кольца в порядке по часовой стрелке от верха — для клавиатуры. */
let radialOrder = [];
/** Идёт ли «зажать и вести»: точка нажатия и признак, что кольцо уже открыто. */
let radialDrag = null;
/**
 * Правый клик при уже открытом кольце: закрыть и НЕ открывать новое.
 *
 * Отдельный флаг, потому что закрытие происходит на нажатии, а решение
 * «открыть ли кольцо» принимается на отпускании. Без флага отпускание после
 * закрытия тут же открывало второе кольцо — то есть закрытие было бесполезным.
 */
let radialCancelPress = false;

/** Радиус красной зоны отмены в центре. */
const RADIAL_KILL_R = 44;
/** Радиус значка внутри кольца. */
const RADIAL_MID = 88;
/** Внешний радиус кольца: дальше сектора не видно. */
const RADIAL_OUT = 126;
/**
 * Насколько кольцо удерживается от края окна, чтобы кольцо и подписи не срезало.
 */
const RADIAL_KEEP = 150;
/**
 * Запас, в пределах которого мышь ещё считается «у кольца».
 *
 * Подпись выбранного действия выходит за край кольца, и без запаса кольцо
 * закрывалось бы, пока человек ведёт курсор к подписи. 190px покрывают диск
 * (126px) и подпись с полями.
 */
const RADIAL_LEAVE = 190;
/** Дуги секций в градусах: 0 — право, по часовой. Сумма = 360. */
const RADIAL_ARCS = {
  top: [-141, -39],
  right: [-39, 39],
  bottom: [39, 141],
  // Слева одна секция: открытие. Раньше её делили с «Путь»-ом.
  left: [141, 219],
};
/** Насколько сдвинулся курсор, прежде чем жест признаётся перетаскиванием. */
const DRAG_PX = 14;

/** Есть ли что копировать или вырезать. */
function hasSelection() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().length) return true;
  const ed = el.editor;
  return !!(ed && !ed.hidden && ed.selectionStart !== ed.selectionEnd);
}

/**
 * Что кольцо показывает.
 *
 * Буфер обмена показывается ВСЕГДА, в любом режиме: три его сектора стоят на
 * своих местах и просто гаснут, когда действие сейчас невозможно. Иначе
 * кольцо меняло форму от выделения к отсутствию выделения, и приходилось
 * искать глазами, где сектор вообще.
 *
 * Правка, наоборот, меняется по режиму: в чтении карандаш, в правке «Сохранить»
 * и «Отмена». Зависимость тут не от наличия правок, а от самого режима.
 */
function radialVisible(act) {
  const t = active();
  const editing = !!(t && t.mode === 'edit');
  const hasFile = !!(t && t.path);
  if (act === 'copy' || act === 'cut' || act === 'paste') return true;
  switch (act) {
    case 'mode': return hasFile && !editing;
    case 'save': return editing;
    case 'cancel': return editing;
    default: return hasFile;
  }
}

/**
 * Что из показанного работает прямо сейчас.
 *
 * Копировать нечего без выделения, вырезать и вставлять некуда вне поля
 * правки. Такие сектора остаются на месте, но гаснут: место в кольце не
 * меняется, и рука, привыкшая к одному и тому же, попадает туда же.
 */
function radialEnabled(act) {
  const t = active();
  const editing = !!(t && t.mode === 'edit');
  const hasFile = !!(t && t.path);
  const sel = hasSelection();
  if (act === 'copy') return hasFile && sel;
  if (act === 'cut') return editing && sel;
  if (act === 'paste') return editing;
  return true;
}

/**
 * Точка сектора в процентах квадрата сектора.
 *
 * Квадрат сектора много больше видимого кольца — см. комментарий к
 * .radial-sector. Поэтому и точки берутся по его краю: хорда треугольника
 * оказывается за пределами кольца, и внешний край задаёт только маска.
 */
function polarPct(deg) {
  const r = deg * Math.PI / 180;
  return { x: (50 + 50 * Math.cos(r)).toFixed(3) + '%', y: (50 + 50 * Math.sin(r)).toFixed(3) + '%' };
}

/** Собрать кольцо под текущее состояние заметки. */
function buildRadial() {
  const acts = RADIAL_LAYOUT.filter((i) => radialVisible(i.act));

  // Каждая дуга делится между своими действиями поровну. Одна «Сохранить»
  // получает всю верхнюю дугу в 102 градуса, три сектора буфера обмена — по
  // 34, и место в кольце остаётся тем же при любом составе.
  const groups = new Map();
  for (const i of acts) {
    if (!groups.has(i.slot)) groups.set(i.slot, []);
    groups.get(i.slot).push(i);
  }
  for (const [slot, list] of groups) {
    const [from, to] = RADIAL_ARCS[slot];
    if (list.every((i) => i.from != null && i.to != null)) {
      // Границы заданы вручную: делить дугу поровну нельзя, иначе шов между
      // секторами встанет ровно туда, куда целится рука.
      list.forEach((i) => {
        i.a0 = i.from;
        i.a1 = i.to;
        i.mid = (i.a0 + i.a1) / 2;
      });
      continue;
    }
    const step = (to - from) / list.length;
    list.forEach((i, k) => {
      i.a0 = from + k * step;
      i.a1 = from + (k + 1) * step;
      i.mid = (i.a0 + i.a1) / 2;
    });
  }

  el.radial.innerHTML = '';
  radialOrder = acts.map((i) => i.act);
  radialCur = null;
  radialDotRect = null;
  for (const item of acts) {
    const b = document.createElement('button');
    b.className = 'radial-sector' + (item.cls ? ' ' + item.cls : '');
    b.type = 'button';
    b.dataset.act = item.act;
    // Границы сектора храним и в разметке: по ним же работает выбор по
    // направлению, и брать их каждый раз из CSS-переменных нельзя.
    b.dataset.a0 = item.a0.toFixed(3);
    b.dataset.a1 = item.a1.toFixed(3);
    const p0 = polarPct(item.a0);
    const p1 = polarPct(item.a1);
    b.style.setProperty('--p0', p0.x + ' ' + p0.y);
    b.style.setProperty('--p1', p1.x + ' ' + p1.y);
    const rad = item.mid * Math.PI / 180;
    b.style.setProperty('--mx', Math.round(Math.cos(rad) * RADIAL_MID) + 'px');
    b.style.setProperty('--my', Math.round(Math.sin(rad) * RADIAL_MID) + 'px');
    b.title = tr(item.tipKey);
    b.setAttribute('aria-label', b.title);
    /*
     * Квадрат под попадание мыши — ровно по размеру кольца.
     *
     * Маска не участвует в hit-testing: у сектора остаётся клип по углу, и
     * кнопкой считался весь треугольник до 240px. Клик в двухстах пикселях от
     * кольца запускал действие вместо того, чтобы закрыть меню. Видимую часть
     * по-прежнему рисует сектор, а ловит клики этот квадрат.
     */
    b.innerHTML = '<span class="rd-hit"></span>'
      + '<span class="rd-dot">' + ICONS.icon(item.icon) + '</span>';
    item.midRef = { x: b.style.getPropertyValue('--mx'), y: b.style.getPropertyValue('--my') };
    b.disabled = !radialEnabled(item.act);
    b.onclick = () => radialAct(item.act);
    el.radial.append(b);
  }

  const kill = document.createElement('button');
  kill.className = 'radial-kill';
  kill.type = 'button';
  kill.dataset.act = 'kill';
  kill.title = tr('ring.dismissTitle');
  kill.setAttribute('aria-label', tr('ring.dismissAria'));
  kill.innerHTML = ICONS.icon('x');
  kill.onclick = () => closeRadial();
  el.radial.append(kill);

  /*
   * Подпись одна и следует за выбором. Внутри сектора ей нельзя: у сектора
   * маска, срезающая кольцо из квадрата, и маска режет всех потомков — подпись
   * обрезалась бы по краю.
   */
  radialLabel = document.createElement('span');
  radialLabel.className = 'radial-label';
  radialLabel.id = 'radialLabel';
  el.radial.append(radialLabel);
}

/** Подпись кольца: следует за выбранным сектором. */
let radialLabel = null;

function radialSetLabel(tip, x, y) {
  if (!radialLabel) return;
  if (!tip) { radialLabel.classList.remove('on'); return; }
  radialLabel.textContent = tip;
  radialLabel.style.setProperty('--mx', x);
  radialLabel.style.setProperty('--my', y);
  radialLabel.classList.add('on');
}

/**
 * Мышью внутри кольца (с запасом на подпись и на неточность).
 *
 * В обычном режиме расстояние важно: выбор идёт по попаданию в кольцо, и мышь
 * мимо него должна означать «закрыть», как в любом меню. Запас нужен, чтобы
 * не закрывать кольцо, пока человек ведёт курсор к подписи выбранного
 * действия или слегка промахивается мимо края.
 */
function inRingBounds(x, y) {
  const box = el.radial.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return Math.abs(x - cx) <= RADIAL_LEAVE && Math.abs(y - cy) <= RADIAL_LEAVE;
}

/** Углы в (-180, 180]. */
function normDeg(d) {
  return ((d + 180) % 360 + 360) % 360 - 180;
}

/** Попадает ли угол в сектор с границами a0…a1 (дуга может переходить через ±180). */
function inArc(a, a0, a1) {
  const x = normDeg(a);
  const lo = normDeg(a0);
  const hi = normDeg(a1);
  return lo <= hi ? (x >= lo && x < hi) : (x >= lo || x < hi);
}

/**
 * Что выбрано под точкой (x, y).
 *
 * В режиме «зажать и вести» выбор идёт ТОЛЬКО ПО НАПРАВЛЕНИЮ: расстояние не
 * важно, поэтому курсор вправо выбирает экспорт, даже если он далеко за кольцом.
 * Так можно вести мышь быстро, не целясь в рамку.
 *
 * В обычном режиме расстояние важно: мышь мимо кольца должна означать «закрыть»,
 * а не «случайно выбрать».
 */
function radialPick(x, y) {
  if (!el.radial || !radialOpen) return null;
  const box = el.radial.getBoundingClientRect();
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  const dx = x - cx;
  const dy = y - cy;
  const dist = Math.hypot(dx, dy);
  const dragging = el.radial.classList.contains('dragging');

  let hit = null;
  if (dist < RADIAL_KILL_R) {
    hit = el.radial.querySelector('.radial-kill');
  } else if (dragging || dist <= RADIAL_OUT) {
    const a = Math.atan2(dy, dx) * 180 / Math.PI;
    for (const b of el.radial.querySelectorAll('.radial-sector')) {
      if (inArc(a, +b.dataset.a0, +b.dataset.a1)) { hit = b; break; }
    }
  }
  radialHighlight(hit);
  return hit;
}

/** Подсветить выбранный сектор и показать его подпись. */
function radialHighlight(hit) {
  for (const b of el.radial.querySelectorAll('.radial-sector, .radial-kill')) {
    b.classList.toggle('sel', b === hit);
  }
  radialCur = hit ? hit.dataset.act : null;
  if (hit) {
    const dot = hit.querySelector('.rd-dot');
    const q = dot ? dot.getBoundingClientRect() : null;
    if (q && q.width) radialDotRect = { left: q.left, right: q.right, top: q.top, bottom: q.bottom };
  }
  if (!hit) {
    radialSetLabel(null);
  } else if (hit.classList.contains('radial-kill')) {
    radialSetLabel(tr('btn.close'), '0px', '52px');
  } else {
    radialSetLabel(hit.title, hit.style.getPropertyValue('--mx'),
      hit.style.getPropertyValue('--my'));
  }
}

/**
 * Переход по кольцу с клавиатуры.
 *
 * Действия обходятся в порядке по часовой стрелке от верха: так список
 * укладывается в одну строку и не зависит от того, сколько градусов занимает
 * сектор. Enter и Space подтверждают выбор.
 */
function radialStep(dir) {
  const order = radialOrder;
  if (!order.length) return;
  const cur = order.indexOf(radialCur);
  const next = cur < 0
    ? (dir > 0 ? 0 : order.length - 1)
    : (cur + dir + order.length) % order.length;
  radialHighlight(el.radial.querySelector('.radial-sector[data-act="' + order[next] + '"]'));
}

function radialKeyRun() {
  const hit = radialCur === 'kill'
    ? el.radial.querySelector('.radial-kill')
    : el.radial.querySelector('.radial-sector[data-act="' + radialCur + '"]');
  const act = hit ? hit.dataset.act : null;
  closeRadial();
  if (act && act !== 'kill') radialAct(act);
}

function radialKey(e) {
  const k = e.key;
  const isNext = k === 'ArrowDown' || k === 'ArrowRight' || k === 'j' || k === 'J'
    || k === 'l' || k === 'L';
  const isPrev = k === 'ArrowUp' || k === 'ArrowLeft' || k === 'k' || k === 'K'
    || k === 'h' || k === 'H';
  const isOk = k === 'Enter' || k === ' ' || k === 'Spacebar';
  if (!isNext && !isPrev && !isOk) return false;
  e.preventDefault();
  e.stopPropagation();
  if (isOk) radialKeyRun(); else radialStep(isNext ? 1 : -1);
  return true;
}

function radialClearPick() {
  for (const b of el.radial.querySelectorAll('.radial-sector, .radial-kill')) {
    b.classList.remove('sel');
  }
}

function openRadial(x, y) {
  if (!el.radial) return;
  buildRadial();
  // Держим кольцо целиком на экране: у края заметки часть секторов уезжала бы
  // за окно, и выбрать их было бы нельзя.
  const cx = Math.max(RADIAL_KEEP, Math.min(x, innerWidth - RADIAL_KEEP));
  const cy = Math.max(RADIAL_KEEP, Math.min(y, innerHeight - RADIAL_KEEP));
  el.radial.style.left = cx + 'px';
  el.radial.style.top = cy + 'px';
  el.radial.hidden = false;
  radialOpen = true;
  // Кадр без класса .on, потом добавляем: без этого переход opacity не
  // проиграет и кольцо просто появится готовым.
  requestAnimationFrame(() => el.radial.classList.add('on'));
}

function closeRadial() {
  if (!el.radial) return;
  el.radial.classList.remove('on');
  el.radial.classList.remove('dragging');
  radialClearPick();
  radialSetLabel(null);
  el.radial.hidden = true;
  radialOpen = false;
  radialDrag = null;
}

function radialAct(act) {
  // Экспорт — отдельное окно: у форматов есть параметры и предпросмотр, и
  // они не помещаются в меню.
  if (act === 'export') { closeRadial(); exportDialog(); return; }
  if (act === 'path' || act === 'open') { radialToMenu(act); return; }
  closeRadial();
  if (act === 'mode') { toggleEditMode(); return; }
  // Именно exitEdit(true), а не save(): сектор в кольце — это «покинуть
  // правку», и выйти надо даже когда сохранять нечего. Ctrl+S остаётся
  // save(): там «Изменений нет» — правильный ответ.
  if (act === 'save') { exitEdit(true); return; }
  if (act === 'cancel') { exitEdit(false); return; }
  if (act === 'copy' || act === 'cut' || act === 'paste') { radialClipboard(act); return; }
}

/*
 * Буфер обмена.
 *
 * execCommand работает с текущим выделением и с фокусом в поле правки — то
 * есть ровно так, как ведёт себя обычный правый клик в тексте. Вставку
 * execCommand в Chromium разрешает не всегда, поэтому если она не сработала,
 * пробуем буфер обмена и вставляем текст в редактор вручную. Если и это не
 * вышло — говорим в статус, а не делаем вид, что получилось.
 */
function radialClipboard(act) {
  const ed = el.editor;
  const editing = ed && !ed.hidden;
  if (editing && document.activeElement !== ed && act !== 'paste') ed.focus();
  let ok = false;
  try { ok = document.execCommand(act); } catch { ok = false; }
  if (ok) { status(act === 'copy' ? tr('clip.copied') : act === 'cut' ? tr('clip.cut') : tr('clip.pasted'), 'ok'); return; }
  if (act === 'paste' && editing && navigator.clipboard && navigator.clipboard.readText) {
    navigator.clipboard.readText().then((txt) => {
      if (!txt) { status(tr('clip.empty'), 'err'); return; }
      const s = ed.selectionStart, e2 = ed.selectionEnd;
      ed.value = ed.value.slice(0, s) + txt + ed.value.slice(e2);
      ed.selectionStart = ed.selectionEnd = s + txt.length;
      const t = active();
      t.dirty = ed.value !== t._diskRaw;
      t.raw = ed.value;
      status(tr('clip.pasted'), 'ok');
    }).catch(() => status(tr('clip.blocked'), 'err'));
    return;
  }
  status(act === 'copy' ? tr('clip.nothingToCopy') : tr('clip.unavailable'), 'err');
}

/**
 * Export и «+» не закрывают кольцо, а раскрывают обычное меню у самого
 * сектора. Иначе кольцо исчезло бы раньше, чем палец доедет до вложенного
 * меню, и нажать было бы не на что.
 */
function radialToMenu(which) {
  const sec = el.radial.querySelector('[data-act="' + which + '"]');
  const dot = sec ? sec.querySelector('.rd-dot') : null;
  const live = dot ? dot.getBoundingClientRect() : null;
  const r = live && live.width ? live
    : radialDotRect || {
      // Совсем без кольца (например, из теста): центр экрана — внятнее, чем
      // ноль в левом верхнем углу.
      left: innerWidth / 2, right: innerWidth / 2,
      top: innerHeight / 2, bottom: innerHeight / 2,
    };
  closeRadial();
  /*
   * Меню открывается так, чтобы его ПЕРВЫЙ пункт стоял ровно под нажатой
   * иконкой: левый край меню совпадает с левым краем значка, верх — под его
   * низом. Раньше «Экспорт» уезжал вправо от значка, а «Открыть» вбок, и
   * пункты оказывались мимо того, что нажали.
   */
  const x = r.left;
  const y = r.bottom + 6;
  if (which === 'path') {
    showContextMenu(x, y, [
      { label: tr('path.copy'), icon: 'copy', act: () => copyPath() },
      { label: tr('path.reveal'), icon: 'folder-search', act: () => revealFile() },
    ], { width: 258, height: 84, anchorRect: r });
  } else {
    showContextMenu(x, y, [
      { label: tr('menu.file.openMd'), icon: 'file-text', hint: 'Ctrl+O', act: openFileDialog },
      { label: tr('menu.file.openFolderItem'), icon: 'folder-open', hint: 'Ctrl+Shift+O', act: openFolderDialog },
    ], { width: 248, height: 84, anchorRect: r });
  }
}

/*
 * Правый клик в заметке: кольцо без переключателя, режим определяется самим
 * жестом.
 *
 *   ПКМ         -> открыть меню, ЛКМ -> выбрать действие;
 *   зажать ПКМ  -> открыть меню, отпустить -> выбрать действие.
 *
 * Порядок событий в Chromium для правой кнопки: mousedown -> contextmenu ->
 * mouseup. Поэтому решение принимается на mouseup:
 *   - курсор отошёл дальше DRAG_PX — человек ВЁЛ кольцо, выбираем тем, в
 *     какую сторону он смотрит;
 *   - не двигался — обычный правый клик, открываем кольцо и ждём левой кнопки.
 *
 * Правый клик при уже открытом кольце закрывает его и ничего не открывает:
 * иначе закрыление было бесполезным — кольцо исчезало и тут же появлялось
 * снова.
 */
function radialDown(e) {
  if (e.button !== 2) return;
  // Гасим стандартное выделение мышью: пока человек ведёт курсор к кольцу,
  // он не должен выделять текст под ним.
  e.preventDefault();
  if (radialOpen) {
    radialCancelPress = true;
    closeRadial();
    return;
  }
  /*
   * Свежий жест снимает любой недособранный флаг. Раньше флаг ставил ещё и
   * обработчик вне кольца, а тот срабатывал на клике ПО САМОМУ кольцу, где
   * radialDown уже не вызывается, — и флаг оставался висеть до следующего
   * жеста. Тот следующий жест справедливо выглядел отменой и ничего не
   * делал.
   */
  radialCancelPress = false;
  if (e.target.closest('a, button, input, .code-copy, .mdv-math')) return;
  radialDrag = { x: e.clientX, y: e.clientY, opened: false };
}

function radialMove(e) {
  if (radialDrag) {
    if (!radialDrag.opened) {
      const far = Math.abs(e.clientX - radialDrag.x) > DRAG_PX
        || Math.abs(e.clientY - radialDrag.y) > DRAG_PX;
      if (!far) return;
      radialDrag.opened = true;
      openRadial(radialDrag.x, radialDrag.y);
      el.radial.classList.add('dragging');
    }
    radialPick(e.clientX, e.clientY);
    return;
  }
  // Кольцо открыто и ждёт левую кнопку: подсветка появляется сразу, как только
  // курсор вошёл в сектор, а не по клику. Уход за кольцо закрывает меню.
  if (!radialOpen) return;
  if (!inRingBounds(e.clientX, e.clientY)) { closeRadial(); return; }
  radialPick(e.clientX, e.clientY);
}

function radialUp(e) {
  const eat = radialCancelPress;
  radialCancelPress = false;
  if (!radialDrag) return;
  const d = radialDrag;
  radialDrag = null;
  if (eat) return;
  // Отпустили, не поведя мышь: обычный правый клик, кольцо ждёт левую кнопку.
  if (!d.opened) {
    openRadial(d.x, d.y);
    return;
  }
  const hit = radialPick(e.clientX, e.clientY);
  const act = hit ? hit.dataset.act : null;
  closeRadial();
  if (act && act !== 'kill') radialAct(act);
}

/*
 * Где стоит курсор и когда он последний раз двигался.
 *
 * Нужно для Ctrl+Space: кольцо должно открываться там, где человек указал
 * мышью, а если мышь давно стояла — по центру заметки.
 */
const lastMouse = { x: 0, y: 0, at: 0 };
const MOUSE_FRESH_MS = 4000;
window.addEventListener('mousemove', (e) => {
  lastMouse.x = e.clientX;
  lastMouse.y = e.clientY;
  lastMouse.at = Date.now();
}, { passive: true });

// ------------------------------------------------------- временный файл / папка

/**
 * Ctrl+N: заметка без пути — в tmpdir, чтобы можно было набрать текст и сразу
 * читать, не создавая файл в живом месте. При сохранении такой вкладки
 * предлагаем «Сохранить как…».
 */
async function newTempNote() {
  let res;
  try { res = await api.newTemp(tr('name.untitled')); }
  catch (e) { status(tr('status.tempNoteFailed') + (e.message || e), 'err'); return; }
  if (!res) return;
  if (!res.ok) { status(tr('status.tempNoteFailed') + (res.error || tr('err.word')), 'err'); return; }
  const t = await openPath(res.path, { newTab: true });
  if (t) { t.temp = true; renderTabs(); }
  status(tr('status.tempNote') + basname(res.path), 'ok');
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
  if (!parent) { status(tr('err.openFolderFirst'), 'err'); return; }
  let res;
  try { res = await api.newFolder(parent, tr('name.newFolder')); }
  catch (e) { status(tr('status.folderFailed') + (e.message || e), 'err'); return; }
  if (!res) return;
  if (!res.ok) { status(tr('status.folderFailed') + (res.error || tr('err.word')), 'err'); return; }
  await refreshRoots();
  status(tr('status.folderCreated') + res.name, 'ok');
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
    { label: tr('view.files'), check: view.files, act: () => toggleView('files') },
    { label: tr('view.toc'), check: view.toc, act: () => toggleView('toc') },
    { label: tr('view.topbar'), check: view.topbar, act: () => toggleView('topbar') },
    { label: tr('view.statusbar'), check: view.statusbar, act: () => toggleView('statusbar') },
    { sep: true },
    // Разделение удобнее всего получить перетаскиванием вкладки в поле
    // заметки, но пункт в меню нужен тоже: перетаскивать нечем, когда
    // открыта одна вкладка и вторую ещё не открывали.
    { label: tr('view.split'), hint: tr('view.splitHint'), act: splitScreen, off: tabs.size < 2 },
    { label: tr('view.closeRight'), act: closeSecond, off: secondId === null },
  ];
}

el.appBrand.onclick = (e) => {
  const r = el.appBrand.getBoundingClientRect();
  showContextMenu(r.left, r.bottom + 4, [
    {
      label: tr('menu.file'),
      items: [
        { label: tr('menu.file.new'), hint: 'Ctrl+N', act: newTempNote },
        { label: tr('menu.file.newFolder'), hint: 'Ctrl+Shift+N', act: newFolderInOpen, off: !folderForNew() },
        { sep: true },
        { label: tr('menu.file.openMd'), hint: 'Ctrl+O', act: openFileDialog },
        { label: tr('menu.file.openFolderItem'), hint: 'Ctrl+Shift+O', act: openFolderDialog },
        { sep: true },
        { label: tr('menu.file.recent'), act: recentDialog },
      ],
    },
    { label: tr('menu.view'), items: viewMenuItems() },
    { sep: true },
    { label: tr('menu.settings'), hint: 'Ctrl+,', act: settingsDialog },
  ], { width: 250, height: 190, subWidth: 240, anchorRect: r });
};
el.appBrand.oncontextmenu = (e) => {
  e.preventDefault();
  el.appBrand.click();
};

async function newFileAction() {
  let res;
  try {
    res = await api.newFile(tr('name.newNote'));
  } catch (e) {
    status(tr('status.fileFailed') + (e.message || e), 'err');
    return;
  }
  if (!res) return;
  if (res.canceled) return;
  if (!res.ok) { status(tr('status.fileFailed') + (res.error || tr('err.word')), 'err'); return; }
  noteRecent(res.path);
  await openPath(res.path, { newTab: true });
  status(tr('status.fileCreated') + basname(res.path), 'ok');
}

async function newProjectAction() {
  let res;
  try {
    res = await api.newProject(tr('name.newProject'));
  } catch (e) {
    status(tr('status.projectFailed') + (e.message || e), 'err');
    return;
  }
  if (!res || res.canceled) return;
  if (!res.ok) { status(tr('status.projectFailed') + (res.error || tr('err.word')), 'err'); return; }
  await addFolder(res.path);
  if (res.readme) noteRecent(res.readme);
  status(tr('status.projectReady') + basname(res.path), 'ok');
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
  const box = modalBox(tr('recent.title'), 440, 420);

  if (!exists.length) {
    const empty = document.createElement('div');
    empty.className = 'modal-empty';
    empty.textContent = files.length
      ? tr('recent.allGone')
      : tr('recent.empty');
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
  clear.textContent = tr('recent.clear');
  clear.disabled = !files.length;
  clear.onclick = async () => {
    await api.recentClear();
    closeModal(false);
    status(tr('recent.cleared'), 'ok');
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
  // '' — «как в системе». Конкретные языки: 'ru', 'en'.
  lang: '',
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
  // navigator.language — то же самое, чем app.getLocale() в главном процессе,
  // но берётся раньше: язык системы нужен для первого кадра, до запроса
  // настроек по IPC.
  MDV_I18N.setSystemLocale(navigator.language || (navigator.languages && navigator.languages[0]) || '');
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
  return merged;
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
  // Атрибут lang нужен не только экранным читалкам: от него зависят
  // переносы, форма курсира и правила :lang() в разметке.
  MDV_I18N.setLocale(s.lang || 'auto');
  // Язык, заданный командной строкой (--lang=ru), перекрывает настройку.
  // Главный процесс так уже сделал, но renderer читает settings.json сам и
  // без этой строки возвращался к сохранённому значению: окно и меню
  // показывали разные языки. Значение отдаёт preload, который читает argv
  // главного процесса — иначе renderer до него не доберётся.
  if (MDV_FORCED_LANG) MDV_I18N.setLocale(MDV_FORCED_LANG);
  root.lang = MDV_I18N.tag();
  // Подписи из разметки (title, aria-label, placeholder) переводим здесь же:
  // applySettings вызывается и на старте, и при каждой смене языка.
  MDV_I18N.applyDom();
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
  // Окно было 470×460, а в него набилось четыре карточки с длинными
  // подсказками: содержимое уходило под нижний край и окно приходилось
  // прокручивать. Стало просторнее — подсказки видны целиком.
  const box = modalBox(tr('settings.title'), 560, 720);

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
  addCard(tr('settings.font.label'), fontOut, tr('settings.font.hint')).addControl(font);

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
  addCard(tr('settings.width.label'), widthOut, tr('settings.width.hint')).addControl(width);

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
  addCard(tr('settings.autosave.label'), null,
    tr('settings.autosave.hint')).addControl(auto);

  /*
   * Язык интерфейса. Не select по двум пунктам, а список из трёх состояний:
   * «Как в системе» отдельно от конкретного языка, потому что это разные
   * вещи — «Русский» это требование, а «Как в системе» это отсутствие
   * требования.
   *
   * Значение уходит в общий settings.json тем же путём, что зум и ширина
   * колонки, а главному процессу по IPC-сигналу, чтобы он пересобрал своё
   * меню: там строки тоже живут, и без сигнала они остались бы на старом
   * языке до перезапуска.
   */
  const langSel = document.createElement('select');
  langSel.className = 'set-select';
  for (const [val, key] of [['', 'settings.lang.auto'], ['ru', 'settings.lang.ru'], ['en', 'settings.lang.en']]) {
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = tr(key);
    langSel.append(opt);
  }
  langSel.value = MDV_I18N.locale;
  langSel.onchange = async () => {
    // Явный выбор снимает перекрытие из командной строки: человек выбрал
    // язык сам, и он должен пережить и следующие applySettings.
    MDV_FORCED_LANG = '';
    // Значение сохраняется раньше, чем приходит сигнал: главный процесс
    // перечитывает файл, и к моменту чтения запись должна быть уже на диске.
    await previewSettings({ lang: langSel.value });
    try { await api.setLang(); } catch { /* главный процесс перечитает при старте */ }

    // Окно настроек приходится переоткрывать: подписи в нём ставятся один раз
    // при сборке, через t(), и держат язык, на котором окно открылось. Без
    // переоткрытия человек выбрал язык, окно осталось на старом — и переключатель
    // выглядит сломанным. Значения уже сохранены, так что новое окно
    // открывается с теми же настройками, просто на новом языке.
    closeModal(false);
    settingsDialog();
  };
  addCard(tr('settings.lang.label'), null, tr('settings.lang.hint')).addControl(langSel);

  /*
   * Откатывать предпросмотр больше нечего: изменения сохраняются сразу, и
   * закрытие окна — обычное закрытие. Раньше здесь стоял откат к снимку
   * «до», из-за чего клик мимо окна тихо выбрасывал правку ползунка.
   */
  const oldOnCancel = back._onCancel;

  const row = document.createElement('div');
  row.className = 'modal-row';
  // «По умолчанию», а не «Сбросить»: слово сбивало с толку, будто отменяет
  // правку. Здесь возвращаются исходные значения — как в новой установке.
  const def = document.createElement('button');
  def.className = 'dlgbtn';
  def.textContent = tr('settings.default');
  def.onclick = () => {
    const d = SETTINGS_DEFAULT;
    font.value = String(zoomToPx(d.zoom));
    width.value = String(d.columnWidth);
    autoIn.checked = d.autosave;
    langSel.value = d.lang || '';
    syncFont();
    syncWidth();
    previewSettings(Object.assign({}, currentSettings, d));
  };
  const ok = document.createElement('button');
  ok.className = 'dlgbtn dlgbtn-primary';
  ok.textContent = tr('settings.done');
  // Значения уже сохранены по ходу работы с окном, поэтому кнопка только
  // закрывает. Всё равно пишем их раз: закрытие может прийти по Esc или
  // клику мимо, и значения ползунков — источник истины.
  ok.onclick = () => {
    previewSettings({
      zoom: pxToZoom(+font.value),
      columnWidth: +width.value,
      autosave: autoIn.checked,
      lang: langSel.value,
    });
    closeModal(false);
  };
  row.append(def, ok);
  box.append(row);

  back.append(box);
  document.body.append(back);
  closeModal = wireModal(back, () => font);
}

let currentSettings = Object.assign({}, SETTINGS_DEFAULT);

/**
 * Применить и СОХРАНИТЬ настройки.
 *
 * Раньше изменения ждали кнопки «Готово», а клик мимо окна откатывал
 * предпросмотр. Окно настроек — это не форма с кнопкой, а набор
 * переключателей: человек двигает ползунок и сразу видит результат, и
 * ждать отдельного подтверждения незачем. Поэтому каждое движение сразу
 * уходит в settings.json, а закрытие окна чем угодно — просто закрытие.
 */
async function previewSettings(patch) {
  Object.assign(currentSettings, patch);
  applySettings(currentSettings);
  try {
    await api.settingsSet(currentSettings);
  } catch (e) {
    status(tr('status.settingsNotSaved') + (e.message || e), 'err');
  }
}

/**
 * Сколько вкладок с несохранёнными правками.
 *
 * Спрашивает главный процесс перед окном подтверждения выхода, чтобы
 * предупредить в нём. Обычный API, а не крючок для тестов: вопрос возникает
 * как раз тогда, когда renderer уже собирается закрываться, и дотянуться до
 * него через крючок было бы нечестно.
 */
window.mdvDirtyTabs = () => {
  let n = 0;
  for (const t of tabs.values()) if (t && t.dirty) n += 1;
  return n;
};

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
el.toTop.onclick = () => el.content.scrollTo({ top: 0, behavior: 'smooth' });

/** Выйти из правки с явным решением: сохранить или отменить. */
/*
 * Выйти из правки в чтение.
 *
 * Отдельная функция потому, что save() выходит раньше, если изменений не
 * было: он честно говорит «Изменений нет» и файл не пишет. Но выйти из
 * правки всё равно надо — иначе «Сохранить» без правок оставлял человека в
 * редакторе, и кольцо не помогало: нажать было не на что.
 */
function endEdit(t) {
  if (!t || t.mode !== 'edit') return;
  // Кольцо закрываем: оно собрано под прежний режим заметки, и оставить его
  // открытым значит показать «Сохранить» в заметке, которая уже не в правке.
  closeRadial();
  t.mode = 'read';
  t.dirty = false;
  t.html = null;
  renderTabs();
  renderActive();
}

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
    endEdit(t);
    status(tr('status.autosaved') + t.name, 'ok');
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
      tr('discard.title'),
      tr('btn.save'),
      {
        note: tr('discard.inFile') + t.name + tr('discard.tailHasChanges')
            + tr('discard.willBeLost'),
        okClass: 'primary',
        cancelText: tr('btn.discard'),
        closeIsNo: false,
      }
    );
    // null — закрыли без ответа: ничего не делаем, остаёмся в правке.
    if (answer === null) return;
    if (answer === true) {
      await save();
      endEdit(t);
      return;
    }
  }

  if (saveIt) {
    await save();
    endEdit(t);
    return;
  }

  // Отмена: возвращаем то, что реально лежит на диске.
  t.raw = t._diskRaw;
  t.dirty = false;
  t.mode = 'read';
  t.html = null;
  renderTabs();
  renderActive();
  status(tr('status.editsDiscarded'), 'warn');
}

/* ------------------------------------------------------- отмена и повтор

 * Своя история, а не Ctrl+Z самого браузера.
 *
 * Встроенная отмена работает с полем, значение которого никто не трогает
 * извне. Здесь значение поля переписывается при переходах между вкладками и
 * при выходе из правки, и этого достаточно, чтобы история Chromium
 * обнулялась: Ctrl+Z не делал ничего, и человек справедливо считал кнопку
 * сломанной.
 *
 * История живёт в вкладке (t.undo/t.redo), а не глобально: переключение
 * вкладок не должно путать правки разных заметок.
 *
 * Шаги склеиваются. Набор текста даёт по событию на букву, и Ctrl+Z,
 * отменяющий одну букву, бесполезен. Поэтому подряд идущие правки одного
 * рода (тот же inputType, без паузы) записываются как один шаг.
 *
 * Шаг хранит текст ДО правки, поэтому отмена — это просто возврат
 * предыдущего значения; redo-стек при этом пополняется текущим текстом.
 */
const UNDO_COALESCE_MS = 700;
const UNDO_MAX = 300;

function undoState(t) {
  if (!t) return null;
  if (!t.undo) t.undo = [];
  if (!t.redo) t.redo = [];
  return t;
}

/**
 * Запомнить состояние перед правкой.
 *
 * @param {object} t   вкладка
 * @param {string} tag вид правки; одинаковые подряд склеиваются в один шаг
 */
function pushUndo(t, tag) {
  if (!t || t.mode !== 'edit') return;
  const now = Date.now();
  if (t.undoLast === undefined) t.undoLast = el.editor.value;  // страховка
  const merge = t.undoTag === tag && now - t.undoAt < UNDO_COALESCE_MS;
  if (!merge && t.undoLast !== el.editor.value) {
    t.undo.push(t.undoLast);
    if (t.undo.length > UNDO_MAX) t.undo.shift();
  }
  t.redo.length = 0;
  t.undoTag = tag;
  t.undoAt = now;
  t.undoLast = el.editor.value;
}

/** Войти в правку с чистой историей: отменять нечего, правок ещё не было.
 *  Точка отсчёта — то, что сейчас в поле: первый же шаг должен знать, к
 *  чему возвращаться. */
function resetUndo(t) {
  if (!t) return;
  t.undo = [];
  t.redo = [];
  t.undoTag = '';
  t.undoAt = 0;
  t.undoPaste = '';
  t.undoLast = el.editor.value;
}

function applyEditorText(text) {
  const t = active();
  if (!t) return;
  const ed = el.editor;
  // Курсор на прежнее место, обрезанный по длине нового текста: иначе отмена
  // прыгала бы в начало заметки и теряла позицию, от которой человек отменял.
  const at = Math.min(ed.selectionStart || 0, text.length);
  ed.value = text;
  try { ed.setSelectionRange(at, at); } catch { /* поле могло быть скрыто */ }
  t.raw = text;
  t.undoLast = text;
  t.dirty = text !== t._diskRaw;
  renderTabs();
  updateReadProgress();
}

function undoEdit() {
  const t = undoState(active());
  if (!t || t.mode !== 'edit') return;
  if (!t.undo.length) { status(tr('err.nothingToUndo'), 'warn'); return; }
  t.redo.push(el.editor.value);
  applyEditorText(t.undo.pop());
  t.undoTag = '';                 // следующий набор начнёт новый шаг
  status(tr('status.undone'), 'ok');
}

function redoEdit() {
  const t = undoState(active());
  if (!t || t.mode !== 'edit') return;
  if (!t.redo.length) { status(tr('err.nothingToRedo'), 'warn'); return; }
  t.undo.push(el.editor.value);
  applyEditorText(t.redo.pop());
  t.undoTag = '';
  status(tr('status.redone'), 'ok');
}

/*
 * Вид правки для склейки шагов. «Вставить» — один шаг целиком, поэтому
 * запоминаем вставленный кусок: пока он совпадает с хвостом текста,
 * следующий input — продолжение той же вставки. Набор строки обратно
 * склеивать не надо: это просто ввод текста.
 */
el.editor.addEventListener('paste', (e) => {
  const t = undoState(active());
  const cd = e.clipboardData || window.clipboardData;
  const txt = cd && cd.getData ? cd.getData('text') : '';
  if (t && txt) t.undoPaste = txt;
});

el.editor.addEventListener('input', (e) => {
  updateReadProgress();
  const t = active();
  if (!t) return;
  let tag = 'type';
  const it = e.inputType || '';
  if (t.undoPaste) {
    tag = el.editor.value.endsWith(t.undoPaste) ? 'paste' : 'type';
    t.undoPaste = '';
  } else if (it === 'insertLineBreak' || it === 'insertParagraph') {
    tag = 'newline';
  } else if (it.indexOf('delete') === 0) {
    tag = 'delete';
  }
  pushUndo(t, tag);
  // t.raw обязан идти в ногу с полем: renderActive перерисовывает заметку и
  // присваивает полю t.raw, а несвежий t.raw затирал бы напечатанное.
  t.raw = el.editor.value;
  t.dirty = t.raw !== t._diskRaw;
  renderTabs();
});

el.btnZoomIn.onclick = () => setZoom(zoom + 0.1);
el.btnZoomOut.onclick = () => setZoom(zoom - 0.1);



/* Пункты экспорта нужны и кольцу заметки, и меню приложения, поэтому живут
 * здесь, а не внутри обработчика. */

/** Скопировать путь к открытой заметке. */
function copyPath() {
  const t = active();
  if (!t || !t.path) return;
  navigator.clipboard.writeText(t.path).then(
    () => toast(tr('status.pathCopied') + t.path),
    () => status(tr('clip.unavailableShort'), 'err')
  );
}

/** Показать заметку в проводнике Windows. */
function revealFile() {
  const t = active();
  if (!t || !t.path) return;
  api.reveal(t.path);
}

/*
 * Правый клик внутри заметки открывает круговое меню.
 *
 * Слушаем на самой заметке и на поле правки, но не на всей рабочей области:
 * правый клик по пустому месту мимо текста — это всё ещё «контекстное меню
 * вкладки» из привычки, а лишнее кольцо на пустом месте только мешает.
 *
 * Своё preventDefault здесь обязателен: иначе поверх кольца появится ещё и
 * системное меню Chromium, и два меню окажутся на одном месте.
 */
el.content.addEventListener('mousedown', radialDown);
el.editor.addEventListener('mousedown', radialDown);
document.addEventListener('mousemove', radialMove);
document.addEventListener('mouseup', radialUp);
/*
 * Системное меню на заметке подавлено: решение о кольце принимает radialUp.
 * Здесь только preventDefault — иначе поверх кольца появилось бы ещё и меню
 * Chromium.
 */
el.content.addEventListener('contextmenu', (e) => {
  if (e.target.closest('a, button, input, .code-copy, .mdv-math')) return;
  e.preventDefault();
});
el.editor.addEventListener('contextmenu', (e) => e.preventDefault());

/*
 * Закрытие кольца: клик мимо, Esc, прокрутка (оно привязано к точке клика, и
 * при прокрутке осталось бы висеть в другом месте), уход на другую заметку и
 * потеря фокуса окна.
 */
document.addEventListener('mousedown', (e) => {
  if (!radialOpen) return;
  /*
   * Правый клик — особый случай: он должен ЗАКРЫТЬ кольцо, и закрытие не
   * должно тут же открыть новое. Поэтому гасим жест флагом: решение «открыть
   * ли кольцо» принимается на отпускании, и без флага отпускание после
   * закрытия открывало бы второе кольцо поверх закрытого.
   */
  if (e.button === 2) {
    // Правый клик мимо кольца разбирает radialDown — он и ставит флаг, и
    // закрывает кольцо. Здесь только случай клика ПО САМУМУ кольцу: до
    // radialDown дело не доходит, а закрыть надо.
    if (el.radial.contains(e.target)) {
      radialCancelPress = true;
      closeRadial();
      e.preventDefault();
    }
    return;
  }
  if (el.radial.contains(e.target)) return;
  if (e.target.closest && e.target.closest('.ctxmenu')) return;
  closeRadial();
}, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (radialOpen || radialDrag) { e.stopPropagation(); closeRadial(); }
    return;
  }
  // Пока кольцо открыто, оно забирает навигацию себе: иначе стрелки уходили бы
  // в заметку под кольцом, а Enter — в поле правки.
  if (radialOpen) radialKey(e);
}, true);
el.content.addEventListener('wheel', () => closeRadial(), { passive: true });
el.editor.addEventListener('wheel', () => closeRadial(), { passive: true });
window.addEventListener('blur', () => closeRadial());

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
 
  try {
    currentSettings = Object.assign({}, currentSettings, { view: Object.assign({}, view) });
    await api.settingsSet({ view: Object.assign({}, view) });
  } catch (e) {
    status(tr('status.viewNotSaved') + (e.message || e), 'err');
  }
  return view[key];
}

function toggleToc(force) { return toggleView('toc', force); }

el.treeFilter.addEventListener('input', renderTree);

// Перетаскивание вкладок
initTabDrag();
initTabsScroll();

// --- правая панель разделения: крестик и ресайз
$('btnHideSecond').onclick = () => closeSecond();

// Клик по панели = «дальше работаю здесь»: новая вкладка откроется в ней.
// Слушаем на контейнере в фазе захвата, потому что клик часто приходится по
// самому тексту заметки, а не по кнопке.
el.split.addEventListener('mousedown', (e) => {
  setPaneFocus(el.panel2.contains(e.target) ? 'second' : 'main');
}, true);

// То же самое при прокрутке: человек читает правую панель колесом — значит
// она в фокусе, и следующую вкладку ждёт именно там.
el.panel2.addEventListener('wheel', () => setPaneFocus('second'), { passive: true });
el.content.addEventListener('wheel', () => setPaneFocus('main'), { passive: true });
// И при переходе по оглавлению/истории тоже полезно знать, куда смотреть.
el.content.addEventListener('mousedown', () => setPaneFocus('main'), true);

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
    // Ширина правой панели — это расстояние от её ЛЕВОГО края до правого края
    // области, то есть box.right минус курсор. Раньше тут стояло
    // e.clientX - box.left, и ширина росла ВМЕСТЕ с движением мыши вправо:
    // тянешь рамку вправо — правая панель становится шире, то есть едет
    // навстречу курсору, а не за ним. У боковых панелей такой ошибки не было
    // именно потому, что там считается от своего края: слева — clientX,
    // справа — innerWidth - clientX.
    const w = box.right - e.clientX;
    const max = Math.round(box.width * 0.78);
    el.panel2.style.width = Math.max(260, Math.min(max, w)) + 'px';
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
  updateReadProgress();
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
  if (other.length) status(tr('status.skippedOther') + other.length, 'err');
});

// --- меню приложения
api.onMenu((action) => {
  switch (action) {
    case 'open-file': openFileDialog(); break;
    case 'open-folder': openFolderDialog(); break;
    case 'save': save(); break;
    case 'download-md': exportDialog('md'); break;
    case 'download-html': exportDialog('html'); break;
    case 'print': api.print(); break;
    case 'find': openFind(); break;
    case 'toggle-sidebar': toggleView('files'); break;
    case 'toggle-toc': toggleToc(); break;
    // Ctrl+E только входит в правку. Выйти из неё — явными кнопками
    // «Сохранить»/«Отменить» (или Esc), чтобы правки не терялись молча.
    case 'toggle-mode': toggleEditMode(); break;
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
  // Отмена и повтор. Ловим на document, а не на поле: сочетание должно
  // работать и когда фосис ушёл мимо редактора (после правки кольца, после
  // клика по заголовку). В просмотре отменять нечего — там пропускаем,
  // чтобы браузер не съел сочетание напрасно.
  if (e.ctrlKey || e.metaKey) {
    const k = e.key.toLowerCase();
    const t = active();
    const editing = !!(t && t.mode === 'edit');
    if (k === 'z' && !e.shiftKey && editing) { e.preventDefault(); undoEdit(); return; }
    if ((k === 'y' || (k === 'z' && e.shiftKey)) && editing) { e.preventDefault(); redoEdit(); return; }
  }
  // Ctrl+Space открывает кольцо с клавиатуры. Точка — там, где стоит курсор,
  // а если мышь давно не двигалась — по центру заметки: вызывать с клавиатуры
  // и тянуться к чужому месту незачем.
  if ((e.ctrlKey || e.metaKey) && e.key === ' ') {
    e.preventDefault();
    if (radialOpen) { closeRadial(); return; }
    const now = Date.now();
    const p = (now - lastMouse.at < MOUSE_FRESH_MS && lastMouse.x) ? lastMouse : null;
    if (p) {
      openRadial(p.x, p.y);
    } else {
      const q = (el.content && !el.content.hidden ? el.content : el.editor).getBoundingClientRect();
      openRadial(q.left + q.width / 2, q.top + Math.min(q.height / 2, 320));
    }
    // Первое действие подсвечено сразу: вызвали с клавиатуры — значит
    // Enter должен сработать, не нажимая стрелку.
    radialStep(1);
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
    // Ctrl+Shift+S — «Сохранить как»: то же окно экспорта, но с готовым MD.
    // Отдельного второго пути не держим, иначе придётся поддерживать две
    // одинаковые проверки и два разных места, где экспорт может сломаться.
    if (t && t.mode === 'edit' && t.dirty) save(); else exportDialog('md');
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
  toggleView,
  secondId: () => secondId,
  paneFocus: () => paneFocus,
  setPaneFocus,
  zoom: () => zoom,
  setZoom,
  enterEdit: toggleEditMode, exitEdit, save, saveTab, undoEdit, redoEdit, resetUndo,
  radialPick, radialDragging: () => radialDrag,
  /*
   * Настоящий правый клик для проверок кольца.
   *
   * Кольцо открывается по решению mouseup, а не по событию contextmenu,
   * поэтому проверка обязана слать весь жест: mousedown → mouseup →
   * contextmenu, ровно как Chromium. Одного contextmenu мало — он теперь
   * только подавляет системное меню.
   */
  openRingIn: (elId, x, y) => {
    const target = document.getElementById(elId);
    if (!target) return Promise.resolve(false);
    for (const type of ['mousedown', 'mouseup', 'contextmenu']) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, clientX: Math.round(x), clientY: Math.round(y),
        button: type === 'contextmenu' ? 0 : 2,
      }));
    }
    return new Promise((r) => setTimeout(r, 60));
  },

  settings: () => currentSettings, previewSettings, settingsDialog,
  /* Метка последнего движения мыши: проверке нужно состарить курсор. */
  lastMouse,
  /* Что реально лежит в settings.json: проверка «сохранилось ли». */
  savedSettings: () => api.settingsGet().catch(() => null),
  openSecond, closeSecond, splitScreen, renderSecond, swapPanes, secondTab,
  setView: (patch) => { Object.assign(view, patch); applyView(); },
  settings: () => currentSettings,
  setSettings: (v) => { currentSettings = Object.assign({}, currentSettings, v); applySettings(currentSettings); },
  modalShell, modalBox, wireModal,
  clearRecents: () => api.recentClear(),
};

newTab();
renderTree();
loadSettings();
updateZoom();
status(tr('status.readyHint'));