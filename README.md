[English](README.md) | [Русский](README_ru.md)

# JazzReader

An offline Markdown reader with LaTeX. A desktop app for Windows built on
Electron, styled after TokyoNight.

It runs entirely locally: no server, no network, no accounts. Your notes stay
plain `.md` files on your own disk — no database, no lock-in.

**The main difference from most Markdown readers:** LaTeX formulas. `$$…$$`,
`$…$`, `\[…\]`, `\(…\)`, Cyrillic inside `\text{…}`, `\frac`, `\boxed`,
`\begin{aligned}`, `\parallel`, `{,}` spacing commas, `\Longrightarrow` and more —
rendered by KaTeX, locally.

## Features

- **Markdown rendering** — `marked` v15, local.
- **LaTeX** — via KaTeX, see above.
- **Edit mode** — raw mode with every special character visible; `Ctrl+S` writes
  the file atomically (temp file plus `rename`).
- **Tabs** — every new file opens in its own tab; tabs can be reordered by drag,
  duplicated, scrolled, and closed from a right-click menu.
- **Opening** — `Ctrl+O` for a file, `Ctrl+Shift+O` for a folder, drag-and-drop
  of a file **or** a folder, plus a "Recents" dialog.
- **Folder tree** — a recursive list of **`.md` only**, grouped into
  subdirectories, with a name filter. Several folders can be open at once.
- **Table of contents** — built from `h1`–`h4`, with a scroll-spy highlighting
  the current section.
- **History** — `Alt+←` / `Alt+→` (or the arrow buttons): back/forward through
  links and sections; once a document's history runs out, the same keys cycle
  tabs like in a browser.
- **Export** — Markdown, a self-contained HTML file (KaTeX fonts inlined as
  base64), printing and PDF.
- **Search** — `Ctrl+F`, highlights every match and walks them with `Enter` or
  the arrow keys.
- **Code** — a copy button and automatic language detection.
- **Click a formula** — shows its LaTeX source in the status bar.
- **Radial menu** — right-click: open, export, path, edit, cancel, save, and the
  clipboard trio. Also works with the "hold right button and drag" mode.
- **Multiple instances** — run several copies and keep different projects in
  each.

## Keyboard shortcuts

| | |
|---|---|
| `Ctrl+O` | open a `.md` file |
| `Ctrl+Shift+O` | open a folder |
| `Ctrl+T` / `Ctrl+W` | new / close tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | next / previous tab |
| `Alt+←` / `Alt+→` | back / forward |
| `Ctrl+E` | edit mode |
| `Ctrl+S` | save (in edit mode) / download `.md` (in reading mode) |
| `Ctrl+F` | search |
| `Ctrl+B` | files pane / table of contents |
| `Ctrl+Shift+B` | table of contents |
| `Ctrl+P` | print / PDF |
| `Ctrl+Q` | quit (with a confirmation) |
| `Ctrl+Space` | radial menu (for keyboard-only use) |
| `F5` | reload the file from disk |

## Why it is built this way

**Formulas are extracted BEFORE `marked`, not rendered after it.** `marked` is a
Markdown parser and it mangles LaTeX: `\\` → `\`, `\{` → `{`, `\_` → `_`. KaTeX
cannot cope with the result, so an "after Markdown" auto-renderer produces broken
formulas. Here `src/md.js` first lifts formulas out into safe placeholders (code,
fenced and inline, is copied verbatim and never substituted), then `marked.parse()`
runs, and only afterwards are the placeholders replaced with
`katex.renderToString`.

**TikZ/circuitikz is not rendered** — KaTeX does not support it. In notes it
usually appears inside ```` ```tikz ```` blocks, so it shows up as code. Real TikZ
would need a separate LaTeX engine, i.e. a rewrite of the shell.

**Everything is local.** No CDN, no network: `marked`, `KaTeX` and the fonts live
in `src/vendor` and `src/fonts`. Offline is a requirement, so that is how it is
built.

## Building

Build on **Windows**. `.exe` files used to be cross-compiled on Linux through
wine — that worked, but the startup bug only ever showed up in the Windows build
and there was no way to check it in place (see "The silent start" below).

```bash
npm install          # installs electron + electron-builder and copies KaTeX into src/vendor
npm start            # run
npm run dist         # build Setup + Portable
npm run dist:dir     # only the unpacked dist\win-unpacked folder (fast, for debugging)
npm run icons        # rebuild the app icon from build/icon/icon.svg
```

Build output in `dist/` (measured on 1.0.14):

| file | size | what it is |
|---|---|---|
| `JazzReader-Setup-1.0.14-x64.exe` | ~72.1 MB | installer (picks a folder, desktop and Start Menu shortcuts) |
| `JazzReader-Portable-1.0.14-x64.exe` | ~71.9 MB | portable, unpack and run |

The binary is not signed, so SmartScreen will say "Windows protected your PC" →
"More info" → "Run anyway". If the exe was downloaded from a browser it carries
a Mark-of-the-Web tag, and Windows may then quietly refuse to start it from disk —
remove the tag with `Unblock-File .\JazzReader-Portable-*.exe`.

### The silent start: why the exe "did nothing"

If `JazzReader.exe` starts, the process is alive, and no window appears, that is
the bug from the very first build, 1.0.0. `main.js` called
`win.setTitleBarOverlay()` without enabling overlay in the `BrowserWindow`
constructor. Electron throws `Titlebar overlay is not enabled`, the exception
lands in `app.whenReady().then()` with no `catch`, becomes an unhandled rejection,
and `createWindow()` dies halfway through — **the window is never created at all**.
Meanwhile:

- Electron is built as a GUI-subsystem app, so `stdout`/`stderr` do not reach the
  console you launched it from — "no output in cmd" is expected, not a symptom of
  breakage;
- the process stays alive anyway (GPU, renderer, network processes), so in Task
  Manager it looks like it is working.

Why no test caught it: `renderMd`/KaTeX were checked in Node, and `main.js` was
never launched on Windows at all — the build happened on Linux, where the
`process.platform === 'win32'` branch never executes.

Now the overlay is enabled in the window constructor, and startup is wrapped so a
miss can no longer be silent:

- a log in `jazzreader.log` next to the exe (or in `userData` if the directory is
  not writable);
- `dialog.showErrorBox` plus exit code 1 if the window cannot be created;
- handlers for `uncaughtException` / `unhandledRejection`;
- the window is shown on `ready-to-show` **or** after a 6 s timeout;
- `did-fail-load` goes to the log.

The regression is covered by `test/startup.js` (`npm run test:startup`) — it
starts a real Electron and inspects the live DOM.

### Build size

The portable exe is 71.9 MB, and almost all of that is Chromium rather than the
app. Everything below was measured on 1.0.14:

| what | unpacked | note |
|---|---|---|
| `JazzReader.exe` | 180.0 MB | Electron itself — nearly all 72 MB live here |
| `locales/*.pak` (2 files) | 1.4 MB | was 55 files at 40.3 MB; cut via `electronLanguages: ["ru","en-US"]` |
| `app.asar` | 3.1 MB | **all of our code, fonts and KaTeX** |
| `ffmpeg.dll` | 2.8 MB | media codecs; **must not be removed**, see below |
| `LICENSES.chromium.html` | 8.7 MB | Chromium licences, kept |
| the rest (icudtl, .pak, GL/Vulkan) | ~36 MB | the browser itself |

That is down from 274.6 MB unpacked and 82.1 MB in the exe to 232.3 MB and 71.9 MB
(`compression: "maximum"` plus trimmed locales).

`scripts/after-pack.js` shows where this kind of thing goes: electron-builder
cannot exclude runtime files through `files` (that filter only covers the app's own
sources). The hook strips extra locales as a backstop for `electronLanguages`.

**Do not remove `ffmpeg.dll`.** Verified: Chromium loads it at startup for the
media stack, even when a Markdown reader never plays a single video. Without it
the process dies **before** `main.js` runs — no window, no log, not a byte in
`stderr`, which looks exactly like that "silent start". 2.8 MB is not worth that
risk.

### App icon

`build/icon/icon.svg` is the source: "JR" in JetBrains Mono ExtraBold, TokyoNight
colours (`#7aa2f7 → #7dcfff` horizontally on a `#16161e` plate). The icon is only
needed at build time; it does not end up in the asar.

```bash
npm run icons         # build/icon/make-icons.js
```

The generator supplies the font itself: JetBrains Mono is usually not installed on
Windows, and `font-family` alone falls back to some other monospace face, giving
different letters. `make-icons.js` inlines an `@font-face` with a woff2 from the
project as a `data:` URI and waits for `document.fonts.ready` before capturing.

The generator used to be `make-icons.sh` and needed `rsvg-convert` plus
`python3`, so it only worked on POSIX. It is still there as a second path — on a
machine with Lato the letters land differently and the metrics in the SVG need
adjusting.

The 16/20/24 px layers are drawn at a larger font size (`SMALL_SCALE`): a cap
height that small is otherwise four pixels and unreadable. The layout is pinned in
the SVG by ink metrics rather than by eye — after editing the text, run
`npm run icons` and `test/icon.test.js`.

## UI icons and fonts

UI icons are **inline SVG from [Lucide](https://lucide.dev)**; `src/icons.js` is
generated by `scripts/vendor.js` from the `lucide-static` package. The icon list
is the `USED_ICONS` constant in `vendor.js`.

They used to be Font Awesome glyphs (`&#xf07b;` and friends) from the JetBrainsMono
**Nerd** Font: they only rendered if the icon font happened to load, and the font
itself weighed 4 × ~1 MB. SVG now depends on neither the font nor the network,
paints through `currentColor`, and inherits the button's colour.

Icons in markup: `<span class="ico" data-i="folder-open"></span>` — the markup is
inserted by `MDV_ICONS.hydrate()` at startup. Dynamic icons use
`ICONS.icon('copy')`.

Inline rather than `<use href="sprite.svg#...">`: `index.html` sets a strict CSP
(`default-src 'none'`), and an external reference in `<use>` is a fetch, which
that CSP does not allow.

The font everywhere is **JetBrains Mono** (`--ui` and `--mono`): Cyrillic plus
Latin, weights 400/500/700 and 400 italic, 8 woff2 files totalling **106 KB**
against 4 110 KB for Nerd Font. The `@font-face` rules are generated into
`src/fonts.css` with `unicode-range` so the browser does not pull the Cyrillic
file for Latin characters and vice versa.

## Tests

```bash
npm test              # the whole fast suite: 247 checks
npm run test:startup  # a real window + live DOM: startup, layout, folder tree
npm run test:tabs     # editing, tabs, context menus, TOC, tree, blank tab
npm run test:all      # everything together
npm run test:ui       # smoke + audit in a real Electron window (needs xvfb)
```

Current counts: `math` 36, `icons` 71, `icon` 55, `print` 65, `quit` 20.

Some checks run against real notes and are skipped when those are not available.
Paths come from environment variables — they have no place in the repository:

| variable | what it needs |
|---|---|
| `MDV_REAL_NOTE` | one `.md` file to render (+3 checks in `math`) |
| `MDV_NOTES_DIR` | a directory of `.md` files, walked in full (`math`, `test:ui`) |
| `MDV_SAMPLE_DIR` | a directory holding `AAA.md`, `BBB.md`, `DDD.md` for `test:tabs` |
| `MDV_SAMPLE_NOTE` | one file inside `MDV_NOTES_DIR` for `test:ui` |

`test/startup.js` is the only test that starts a real window and looks into it. It
checks that `main.js` created the window, that the renderer reached `index.html`,
that `marked`/`katex` loaded, and that formulas became glyphs rather than literal
`\frac`. Against the original `main.js` this test fails with "process alive, no
window" — exactly the bug described under "The silent start".

`test/icon.test.js` decodes the PNGs itself (only `zlib`, no Python) and checks the
icon by pixels: letter geometry, margin symmetry, the TokyoNight palette, the ICO
structure, and that the small layers really are scaled up.

`test/audit.js` checks layout, fonts, formula centring, scroll-spy, the tree
filter, and the self-containment of the HTML export. `test/packaged-check.js`
attaches to the already packaged binary over CDP — it catches problems invisible
in the sources (asar paths, fonts from the archive, files lost during packaging):

```bash
node test/packaged-check.js dist/linux-unpacked/jazz-reader "file.md"
```

### What the layout regression tests catch

Both checks in `test/startup.js` were verified by re-enabling the bug — against the
original source they fail.

**Paragraph drift.** `.content > *` set `margin-left/right: auto`, while `h1-h6`,
`ul`, `ol`, `pre`, `table` and `blockquote` had their own rules with a
`margin: X 0` shorthand that cancelled the centring. On a wide window paragraphs
drifted to the centre of the column while headings and lists stayed at the left
edge — about 290 px apart. Fixed with `margin-inline: auto` plus `margin-block`
everywhere. The test widens the viewport to 1700 px via
`Emulation.setDeviceMetricsOverride` (on a narrow window `max-width` does not kick
in and the bug is invisible) and requires every block in the column to share the
same `offsetLeft`.

**`margin-block` cannot take three values.** The shorthand accepts only 1–2, and a
three-value declaration is dropped entirely — vertical spacing on headings was
already lost this way (`margin: 1.5em 0 .55em` became
`margin-block: 1.5em 0 .55em` and the headings ran together). There is a check for
this in `test/icons.test.js`.

## Editing, tabs, table of contents

**Editing.** In edit mode there is no single "Edit" toggle: instead two explicit
buttons, a green **Save** and a red **Cancel**. There used to be one toggle that
would silently leave edit mode while changes stayed in memory — you could lose them
without being asked. Exiting is now always explicit: `Esc` or "Cancel" asks if
there are unsaved changes, and declining keeps you in edit mode. `Ctrl+S` saves.

**Ctrl+Tab / Ctrl+Shift+Tab** cycle tabs **in order, wrapping around**. Both
combinations used to go to `cycleTab()`, i.e. walk the `visit` stack
(there-and-back), while what you expect is a calm step to the next or previous
tab.

There is a Windows subtlety here: `Ctrl+Tab` is a system shortcut, the OS eats it
before Chromium ever sees it, and `keydown` in the renderer **does not fire at
all**. So the interception is done by `globalShortcut` in the main process, which
sends the same action to the renderer. The registration must be released on
`will-quit` — otherwise the hotkey sticks and `Ctrl+Tab` stops working system-wide
until you reboot. Menu items deliberately carry no accelerators, so Electron does
not handle the combination twice.

**Right-click on a tab** — menu: close this tab / all others / those to the right /
those to the left / all. It works from the keyboard too (Shift+F10 and the ContextMenu
key). When closing in bulk, unsaved tabs are **not** closed: they are listed in the
status bar instead (otherwise you get five identical questions in a row and lose
edits).

**The file tree is always on the left**, with no toggle. The table of contents moved
into its own slide-out panel behind a hamburger button — it used to share one pane
with the tree, so wanting the TOC meant losing the tree.

**The open file is highlighted in the tree**: the current tab bright with a blue
bar, open in another tab dimmed with a violet one. There was a non-obvious bug
here: paths from the tree come through `path.join` (`C:\dir\file.md`) while tabs
hold forward slashes (`C:/dir/file.md`), and a naive `===` did not match them.
Everything goes through `samePath()`, which normalises the path and ignores case.

**A blank tab** shows the default placeholder as at startup. But if a folder is
already open and the tab has no file, it shows the tree instead (otherwise "Folder"
again looks like a button that does nothing). The difference is the `blank` flag on
the tab: `newTab()` sets it, `addFolder()` clears it.

### The folder tree

`renderTree()` wrote the tree into `#paneFiles` inside a **hidden** `#workspace`:
`renderActive()` is what showed the work area, and only when a file was open. The
upshot was that the "Folder" button appeared to do nothing, and the tree only
"appeared" together with the first opened file. Now `renderActive()` shows the work
area when only a folder is open, and `addFolder()` calls `renderActive()` after
`renderTree()`.

This is checked in `test/startup.js`: the test closes every tab (to reproduce the
"no file opened yet" case), calls `window.__mdvTest.addFolder()` on a real temp
directory, and requires `#workspace` to have become visible with a non-empty tree.
With the bug it fails on `workspaceHidden=true`.

A test cannot open the system folder-picker dialog, so the renderer has a
`window.__mdvTest` hook. Replacing the dialog through `contextBridge` is not
possible — objects coming from there are frozen and assignment is silently ignored.

## Layout

| File | Purpose |
|------|---------|
| `main.js` | main process: window, menu, multiple instances, launch arguments |
| `ipc.js` | all IPC handlers: read/write, `.md` tree, HTML export, encodings |
| `preload.js` | renderer → main bridge (`contextBridge`), `webUtils.getPathForFile` for drop |
| `src/md.js` | Markdown + LaTeX rendering: formula extraction, KaTeX, relative links |
| `src/app.js` | tabs, tree, table of contents, history, search, drag-and-drop |
| `src/index.html` | shell markup |
| `src/style.css` | TokyoNight theme |
| `src/vendor/` | `marked.min.js`, `katex/` (copied from npm in postinstall) |
| `src/fonts/` | JetBrains Mono: 400/500/700 + italic, Latin and Cyrillic |
| `src/icons.js` | generated SVG set of Lucide icons |
| `build/icon/` | app icon: `icon.svg`, the `make-icons.js` generator, `icon.ico`/`icon-*.png` |
| `scripts/` | `vendor.js` (icons and fonts), `after-pack.js` (slimming the build) |
| `test/` | tests; see the section above |

## License

GPL-3.0. Full text in [LICENSE](LICENSE).

JetBrains Mono is under the SIL Open Font License 1.1. Lucide icons are ISC.