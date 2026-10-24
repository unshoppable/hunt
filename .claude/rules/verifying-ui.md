---
paths:
  - "apps/client/**"
---

# Verifying UI changes

`npm run check` covers logic only. A UI change is verified in a running page.

- **Headless**: a temporary `src/__preview/<name>.tsx` with a root `<name>.html` (delete both before committing), or
  `index.html` itself, on the running Vite dev server (port 1420), driven by headless Chrome over CDP with a real
  wait, not `--virtual-time-budget`. Stub IPC with `mockIPC` (`@tauri-apps/api/mocks`) or with
  `Page.addScriptToEvaluateOnNewDocument` setting `window.__TAURI_INTERNALS__` (plus
  `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`); mocked rows need the full `SessionView`/`createEmptyChat()`
  shape, or the tree paints blank. Seed the store through the module URL the page loaded (with its `?t=` after HMR),
  never a bare `import('/src/state/store.ts')`, which creates a second store. Enable
  `Emulation.setFocusEmulationEnabled` for focus-dependent behaviour (quick suggestions, commit on blur).
- **Input**: Monaco reads EditContext, so click `.view-lines` and send CDP key events with `key`, `code`, `text` and
  `windowsVirtualKeyCode`. Send app shortcuts that Chrome takes itself (⌘R, ⌘E) as in-page `KeyboardEvent`s, and mouse
  back/forward (Chrome navigates its own history) as an in-page `MouseEvent` with `button` 3/4.
- **Monaco probes**: `editor._getViewModel().viewLayout.getWhitespaces()` for zone heights,
  `model.getAllDecorations()` for squiggles; a view zone or decoration outside the shown lines has no DOM node.
- **Real app**: only the WKWebView shows native chrome, color management and window timing. Click with JXA
  `CGEventCreateMouseEvent` (System Events `click at` fails with -25208; the first click on a non-key window only
  activates it), send keys with System Events, capture with `screencapture -x -R` (points in, 2× pixels out). Native
  file drops arrive only as `onDragDropEvent`: drag from a Finder window on the same display with CGEvent. A Monaco
  helper created at mount survives Fast Refresh; `touch apps/client/index.html` forces a full reload.
- **Color and layer questions** need a real Tauri window: a throwaway Tauri app that loads
  `http://localhost:1420/index.html`, answers the app's commands from Rust and runs probe JS with
  `WebviewWindow::eval`. `window.__TAURI_INTERNALS__` is not configurable there, so `invoke` cannot be mocked from JS.
- **Live state and timings**: a temporary probe that `fetch`es to a small local Node log server (the WKWebView console
  is not reachable from the CLI); appended to `app/App.tsx` it hot-refreshes without a reload.
- **Agent protocol**: spawn `@agentclientprotocol/claude-agent-acp` with `node`, send `initialize` and `session/new`
  over stdio and read `session/update`, to tell a UI bug from what the adapter sends.
- **Language servers**: a probe script must answer the server's own requests (`client/registerCapability`,
  `workspace/configuration`), or the first request blocks forever.
