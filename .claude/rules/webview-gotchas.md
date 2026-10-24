---
paths:
  - "apps/client/src/**"
  - "apps/client/vite.config.ts"
---

# Webview and library gotchas

- **Vite**: a dependency reached only through a dynamic `import()` goes into `optimizeDeps.include` in
  `apps/client/vite.config.ts`; otherwise the running dev server answers 504 "Outdated Optimize Dep" for it until
  restarted.
- **Resizable panels**: a host of absolutely positioned layers inside a `react-resizable-panels` `Panel` gets
  `overflow: hidden`. The Panel's content is `overflow: auto`, so an overhanging layer makes the pane scroll, and
  Monaco's wheel at its end (`alwaysConsumeMouseWheel: false`) then scrolls the whole pane.
- **Monaco CSS** loads after `index.css`, so outrank it with `:root`. Tailwind utility names that occur in sources
  (`contents`, …) also match Monaco's own class names; reset them in Monaco-scoped rules.
- **Monaco markers**: `setModelMarkers` called synchronously inside `onDidChangeMarkers` loses its change event, so
  no squiggles or overview marks appear; defer it with `queueMicrotask`.
- **WebKit colors**: a surface whose computed color is right but shows lighter on screen sits in its own compositing
  layer (Monaco's `translate3d` hints, `position: fixed`, `will-change`, scrollers), which WebKit does not
  color-match on a non-sRGB display. Take it out of its own layer or paint the color in a big shared layer, as
  `.split-diff` (`src/index.css`) and `disableLayerHinting` (`diff/splitDiff.ts`) do. Only a real Tauri window shows
  it; headless Chrome and Safari do not.
