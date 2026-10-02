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
  btnOpenFile: $('btnOpenFile'), btnOpenFolder: $('btnOpenFolder'),
  btnBack: $('btnBack'), btnForward: $('btnForward'),
  btnMode: $('btnMode'), btnSave: $('btnSave'),
  btnZoomIn: $('btnZoomIn'), btnZoomOut: $('btnZoomOut'), zoomVal: $('zoomVal'),
  dlBtn: $('dlBtn'), dlMenu: $('dlMenu'), btnSidebar: $('btnSidebar'),
  welcome: $('welcome'), wOpenFile: $('wOpenFile'), wOpenFolder: $('wOpenFolder'),
  workspace: $('workspace'), sidebar: $('sidebar'), sidebarResizer: $('sidebarResizer'),
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
  if (active()) active().scroll = el.content.scrollTop;
  activeId = id;
  if (touch !== false) {
    const i = visit.indexOf(id);
    if (i >= 0) visit.splice(i, 1);
    visit.push(id);
    visitPos = visit.length - 1;
  }
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

// ------------------------------------------------------------------ утилиты

function status(msg, kind) {
  clearTimeout(statusTimer);
  el.statusText.textContent = msg;
  el.statusbar.className = 'statusbar' + (kind ? ' ' + kind : '');
  if (kind === 'err') {
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

/** Небольшой confirm без window.confirm (его в Electron нет). */
function askConfirm(title, okText) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:500;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'background:#1f2335;border:1px solid #2f3b54;border-radius:11px;padding:20px 22px;max-width:400px;font-family:"Segoe UI",sans-serif;color:#c0caf5';
    box.innerHTML = '<div style="font-size:14px;line-height:1.6;margin-bottom:16px"></div>';
    box.firstChild.textContent = title;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
    const mk = (label, color) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'padding:7px 14px;border-radius:7px;cursor:pointer;font-size:13px;border:1px solid #2f3b54;background:' + color;
      return b;
    };
    const no = mk('Отмена', '#24283b');
    const yes = mk(okText || 'ОК', '#283457');
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); done(false); }
      if (e.key === 'Enter') { e.stopPropagation(); done(true); }
    };
    no.onclick = () => done(false);
    yes.onclick = () => done(true);
    row.append(no, yes);
    box.append(row);
    back.append(box);
    document.body.append(back);
    document.addEventListener('keydown', onKey, true);
    yes.focus();
  });
}

function toast(msg) { status(msg); }

// ------------------------------------------------------------------- вкладки

function newTab() {
  const id = ++seq;
  tabs.set(id, {
    id, path: null, name: 'Пусто', raw: '', html: null,
    dirty: false, mode: 'read', baseUrl: '', encoding: '', size: 0,
    hist: [], hi: -1, scroll: 0,
  });
  selectTab(id);
  return tabs.get(id);
}

async function closeTab(id) {
  const t = tabs.get(id);
  if (!t) return;
  if (t.dirty) {
    const ok = await askConfirm('В «' + t.name + '» есть несохранённые изменения. Закрыть вкладку?', 'Закрыть');
    if (!ok) return;
  }
  tabs.delete(id);
  if (activeId === id) {
    const rest = [...tabs.keys()];
    activeId = null;
    if (rest.length) selectTab(rest[rest.length - 1]);
    else { newTab(); }
  } else {
    renderTabs();
  }
}

function renderTabs() {
  el.tabs.innerHTML = '';
  for (const t of tabs.values()) {
    const d = document.createElement('div');
    d.className = 'tab' + (t.id === activeId ? ' active' : '');
    d.title = t.path || t.name;
    const nm = document.createElement('span');
    nm.className = 'tname';
    nm.textContent = t.name;
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
    el.tabs.append(d);
  }
  // активную вкладку видно
  const act = el.tabs.querySelector('.tab.active');
  if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function findTabByPath(p) {
  const norm = String(p).replace(/\//g, '\\').toLowerCase();
  for (const t of tabs.values()) {
    if (t.path && t.path.replace(/\//g, '\\').toLowerCase() === norm) return t;
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
  if (existing) { selectTab(existing.id); return existing; }
  try {
    status('Открываю ' + basname(p) + '…');
    const data = await api.read(p);
    const t = opts.newTab ? blankTab() : (active() && active().path ? active() : blankTab());
    applyData(t, data);
    t.hist = [{ path: data.path, anchor: null }];
    t.hi = 0;
    selectTab(t.id);
    status(data.encoding.toUpperCase() + ' · ' + fmtSize(t.size) + ' · ' + t.name, 'ok');
    return t;
  } catch (e) {
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
  el.welcome.hidden = show;
  el.workspace.hidden = !show;
  closeFind();
  if (!has) {
    // Файла нет — основная область пустая, от прежнего документа чистим.
    el.fileName.textContent = '—';
    el.content.innerHTML = '';
    el.editor.hidden = true;
    el.toTop.hidden = true;
    el.statusbar.hidden = true;
    updateNavButtons();
    return;
  }
  el.statusbar.hidden = false;

  document.title = t.name + ' — MDView';
  el.fileName.textContent = t.path;
  el.fileName.title = t.path;

  const editing = t.mode === 'edit';
  el.editor.hidden = !editing;
  el.content.hidden = editing;
  el.btnSave.hidden = !editing;
  el.btnMode.querySelector('.lbl').textContent = editing ? 'Чтение' : 'Правка';
  // eye-off в режиме правки, карандаш в режиме чтения
  el.btnMode.querySelector('.ico').innerHTML = ICONS.icon(editing ? 'eye-off' : 'pencil');
  el.btnMode.classList.toggle('active', editing);

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
    el.content.scrollTop = t.scroll || 0;
    decorateCode();
    decorateMath();
  }
  buildToc();
  updateNavButtons();
  updateZoom();
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

function decorateCode() {
  for (const pre of el.content.querySelectorAll('pre')) {
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
function decorateMath() {
  for (const m of el.content.querySelectorAll('.mdv-math')) {
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
          if (active() && active().path === it.full) row.classList.add('active');
          row.innerHTML = '<span class="fi">' + ICONS.icon('file') + '</span><span class="fn"></span><span class="sz"></span>';
          row.querySelector('.fn').textContent = it.name;
          row.querySelector('.sz').textContent = fmtSize(it.size);
          row.onclick = () => openPath(it.full, { newTab: true });
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

function updateZoom() {
  el.zoomVal.textContent = Math.round(zoom * 100) + '%';
  el.content.style.fontSize = (15 * zoom).toFixed(2) + 'px';
  el.editor.style.fontSize = (14 * zoom).toFixed(2) + 'px';
}
function setZoom(z) {
  zoom = Math.min(2.5, Math.max(0.5, z));
  updateZoom();
}

// ------------------------------------------------------------ сохранение и т.п.

async function save() {
  const t = active();
  if (!t || !t.path) return;
  if (!t.dirty) { toast('Изменений нет'); return; }
  try {
    await api.save(t.path, el.editor.value);
    t.raw = el.editor.value;
    t._diskRaw = el.editor.value;
    t.dirty = false;
    renderTabs();
    renderActive();
    toast('Сохранено: ' + t.name, 'ok');
  } catch (e) {
    status('Не удалось сохранить: ' + (e.message || e), 'err');
  }
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
el.btnNewTab.onclick = () => newTab();
el.btnOpenFile.onclick = openFileDialog;
el.wOpenFile.onclick = openFileDialog;
el.btnOpenFolder.onclick = openFolderDialog;
el.wOpenFolder.onclick = openFolderDialog;
el.btnBack.onclick = () => go(-1);
el.btnForward.onclick = () => go(1);
el.btnSave.onclick = save;
el.toTop.onclick = () => el.content.scrollTo({ top: 0, behavior: 'smooth' });

el.btnMode.onclick = async () => {
  const t = active();
  if (!t || !t.path) return;
  if (t.mode === 'edit') {
    // Возврат в чтение: правки остаются в памяти, но файл на диске не тронут.
    t.raw = el.editor.value;
    t.dirty = t.raw !== t._diskRaw;
    t.mode = 'read';
    renderActive();
    if (t.dirty) status('Правки не сохранены на диск — Ctrl+S', 'err');
  } else {
    t.mode = 'edit';
    renderActive();
    el.editor.focus();
  }
};

el.editor.addEventListener('input', () => {
  const t = active();
  if (!t) return;
  t.dirty = el.editor.value !== t._diskRaw;
  renderTabs();
});

el.btnZoomIn.onclick = () => setZoom(zoom + 0.1);
el.btnZoomOut.onclick = () => setZoom(zoom - 0.1);

el.btnSidebar.onclick = () => document.body.classList.toggle('side-hidden');

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

// --- переключение панелей сайдбара
for (const b of document.querySelectorAll('.side-btn')) {
  b.onclick = () => {
    for (const x of document.querySelectorAll('.side-btn')) x.classList.toggle('active', x === b);
    const pane = b.dataset.pane;
    el.paneFiles.hidden = pane !== 'files';
    el.paneToc.hidden = pane !== 'toc';
    el.treeFilter.closest('.side-search').hidden = pane !== 'files';
    if (pane === 'toc') updateSpy();
  };
}
el.treeFilter.addEventListener('input', renderTree);

// --- ресайз сайдбара
(() => {
  let dragging = false;
  el.sidebarResizer.addEventListener('mousedown', (e) => { dragging = true; e.preventDefault(); });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(170, Math.min(620, e.clientX));
    el.sidebar.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => { dragging = false; });
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
    case 'toggle-sidebar': document.body.classList.toggle('side-hidden'); break;
    case 'toggle-mode': el.btnMode.click(); break;
    case 'back': go(-1); break;
    case 'forward': go(1); break;
    case 'new-tab': newTab(); break;
    case 'close-tab': if (activeId !== null) closeTab(activeId); break;
    case 'next-tab': cycleTab(1); break;
    case 'prev-tab': cycleTab(-1); break;
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

/* Хук для автотестов (test/startup.js).
   Системный диалог выбора папки из теста не открыть, а без него нельзя
   проверить, что дерево вообще появляется: addFolder() писал его в скрытый
   #workspace, и «Папка» визуально ничего не делала, пока не откроешь файл.
   Основной код сюда не обращается. Через contextBridge подменить
   диалог нельзя — объекты от contextBridge заморожены, присваивание молча
   игнорируется (на этом сначала и споткнулся тест). */
window.__mdvTest = { addFolder, renderTree, renderActive, roots, tabs, closeTab };

newTab();
renderTree();
updateZoom();
status('Готово. Ctrl+O — открыть .md, Ctrl+Shift+O — открыть папку');