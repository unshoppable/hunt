---
paths:
  - "apps/client/src/**"
---

# UI look

- Selected rows (trees, lists, dropdowns, popovers) use `--row-selected` with rounded corners: `tree-row` with
  `data-selected` for full-width rows, `rounded bg-(--row-selected)` inside padded popovers. `--row-active` is for
  pressed buttons, tabs and chat bubbles, never for a selection.
- Buttons come from `src/ui/buttons.constants.ts` and are `rounded-md` rectangles. `rounded-full` is only for `SEND_BUTTON`,
  `CLEAR_BUTTON` and `DANGER_CLEAR_BUTTON` in the prompt, `PaneToggle` and status dots.
- A bar with controls takes its height from padding: `px-3 py-2.5` around `*_SM` (28 px) buttons, `py-2` around 32 px
  buttons; no fixed `h-7`/`h-8` bars and no negative margins that pull a button to the edge. Menus use `p-1` with
  rounded items.
- Window edges keep their padding: `px-3` toolbars, `px-2` sidebar list and tab nav, traffic lights at x = 12.
- Every window's top row is a 42 px `data-tauri-drag-region` (`h-12`, `pl-23`); the traffic lights
  (`trafficLightPosition` y = 23 in `src-tauri/tauri.conf.json` and `rememberedWindowOptions` in
  `src/ui/native-window.utils.ts`) centre on it at y = H / 2 + 2.25, so change row height and y together. The root font is
  14 px: Tailwind rem sizes are 7/8 of the usual.
- Bottom info rows use `STATUS_BAR` (36 px), top rows `HEADER_BAR` (`src/ui/bars.constants.ts`). Text in bars, headers, hints,
  dialogs and errors is at least 13 px; `text-xs` and smaller only for counters, badges, chips, section labels and
  slugs. Interactive rows are at least `h-7`.
- The chat reads like a document (T3 Code), not a terminal: sans-serif Markdown in `.chat-column`, tool rows grouped
  and folded, worktree paths stripped from tool arguments; no ⏺/⎿ glyphs and no monospace prose.
- A count on a tab or button is `CountBadge` (`src/ui/TabButton.tsx`; give it a file of its own when a second place needs it): a
  raised blue SVG circle, capped at `99+`, hidden at 0; never an icon plus a number. Letter-in-circle marks are one
  SVG, because HTML text drifts 1 px on the fractional rows of the 14 px root font.
- A keychain-backed field shows its state inside the input (`••••••••<last four>` in value color, otherwise
  "Not set"), as `GithubTokenRow` does; no status labels or icons beside form fields.
- The create-action of a searchable `Dropdown` is its `searchAction` button in the 40 px search row, prefilled from
  the query; never the first list item.
- Collapsible panes use `PaneToggle`/`PaneRail` and collapse only through the toggle (`toggleOnlyPanes`); `minSize`
  comes from measured content, so an open pane never clips it. Raising a min size above a saved layout collapses that
  pane at startup: rename the group id (`hunt-panes` in `src/app/App.tsx`) instead.
- Search in a diagram highlights matches and centres the active one (Enter/⇧Enter cycle); it never hides or dims the
  rest.
- Hover details of the dependency graph go into the single `DependencyCard`, which lists outgoing edges only; never
  float popovers on several edges at once. Edges stay behind folders and files, also while hovered.
