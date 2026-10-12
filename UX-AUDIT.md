# UX Audit — Gallery Culling (v1.1.1)

**Scope:** full app shell — `TopBar`, `ThumbnailGrid`, `PreviewViewport`, `SplitCompareViewport`,
`BeforeAfterViewport`, `TonalAdjuster`, `BottomBar`, `BatchExportModal`, `SettingsModal`,
`MetadataEditorModal`, `useKeyboardShortcuts`, `App` state layer.
**Mode:** full (all six interface domains).
**Stack:** React 19 + TypeScript + Tailwind 3 (token-based), Tauri 2 desktop shell.
**Frameworks applied:** Krug's Four Laws, Nielsen's 10 Heuristics, Apple Look/Feel principles,
WCAG 2.1 AA.

---

## 1. Score

The Quick Diagnostic has 10 rows. **8 fail.** Two fail at catastrophic severity (weight ~2 each),
four at major (~2 each), and two at minor (~1 each). Weighted deduction reaches 12, floored at 0.

| # | Quick Diagnostic | Fails? | Severity triggered |
|---|---|---|---|
| 1 | Can I tell what site/page this is immediately? | Pass | — |
| 2 | Is the main action obvious? | Pass | — |
| 3 | Is the navigation clear? | **Fail** | Major |
| 4 | Can I find the search? | **Fail** | Major |
| 5 | Does the system show what's happening? | **Fail** | Major |
| 6 | Are error messages helpful? | **Fail** | Minor |
| 7 | Can users undo or go back? | **Fail** | Minor |
| 8 | Does it work without hover? | **Fail** | Catastrophic |
| 9 | Are all interactive elements labeled? | **Fail** | Major |
| 10 | Does anything make me stop and think "huh?" | **Fail** | Minor |

> **Current score: 0 / 10.** Rows 3, 4, 5, 8 and 9 fail at catastrophic/major severity and block or
> badly degrade the primary culling task (navigating, filtering, rating, picking, comparing). The
> app is not usable at its stated 10,000-photo scale.

---

## 2. Evidence gathered

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 — clean |
| `pnpm dev` rendered at 1440×900 | Works; header crowded but legible |
| `pnpm dev` rendered at 1180×820 | **TopBar collapses to unreadable** — JPG field shrinks to its label, "扫描照片" stacks into 4 vertical lines |
| Compiled `dist/assets/index-*.css` | `.py-0\.2` **not generated** (dead class); zero `focus-visible` rules emitted; no `prefers-reduced-motion` block |
| Contrast math, `text-white/40` on `--color-bg-base` (#0A0A0A) | **3.77:1** — fails AA 4.5:1 for text |
| Contrast math, `text-white/20` separators on #0A0A0A | **1.77:1** — effectively invisible |
| Runtime console | only Tauri-IPC errors (expected in a plain browser); no app errors |

Two runtime facts found while auditing:

* **F-04** — `App.tsx` calls `api.getSettings().then(...)` with no `.catch`. A rejected IPC never
  surfaces; `settings` silently stays `null` and the "save as default" branch in `handleScan` is
  skipped forever.
* **F-27** — `trashPhotos` exists in `src/services/api.ts` and `trash_photos_cmd` is registered in
  `src-tauri/src/lib.rs:29`, but **no UI anywhere calls it**. See §6.

---

## 3. Findings

Severity: 0 not a problem · 1 cosmetic · 2 minor · 3 major · 4 catastrophic.
Weighted by frequency × impact × persistence.

| # | Sev | Domain | Location | Before | After | Why |
|---|---|---|---|---|---|---|
| F-01 | **4** | layout | `TopBar.tsx:64` | Single `h-14` row, `justify-between px-3 gap-6`, folder block `max-w-3xl`, both control groups `shrink-0` | Two-row wrapping header: row 1 = folder inputs + scan + settings; row 2 = filter/sort/view/tools. `flex-wrap` + `min-w-0` throughout | Minimum content width ≈1272px. **Verified**: at 1180px the JPG field collapses to its "JPG:" label, the RAW field shows only its placeholder, and "扫描照片" stacks vertically into 4 lines. Below ~1280px the primary entry point is unusable. |
| F-02 | **4** | a11y | `PreviewViewport.tsx:214`, `BeforeAfterViewport.tsx:252` | Quick-action capsule at `opacity-50 hover:opacity-100` | Static `opacity-100` surface; a small background affinity on hover instead of an opacity cliff | The rating stars, Pick/Reject, tone and open-external controls — the app's core culling verbs — sit at 50% opacity until hovered. Keyboard, touch and screen-magnifier users cannot discover them. Fails diagnostic row 8 and Nielsen #1. |
| F-03 | **3** | ui | `SplitCompareViewport.tsx:33-41` | `leftScale/leftPos/rightScale/rightPos` never reset when `leftGroup.id` / `rightGroup.id` change | `useEffect` resets scale + pan on pane photo change (matches `PreviewViewport.tsx:54-57`) | You zoom a candidate to check focus, press `]` to advance, and the viewport stays zoomed into empty space on the new photo. Preview mode already resets; split mode silently diverges — an inconsistency users must reason about. |
| F-04 | **3** | writing | `App.tsx:52-57` | `api.getSettings().then(...)` with no `.catch` | `.catch` surfaces a toast; render no longer depends on an unhandled rejection | Silent failure: the app looks healthy while `settings === null`, so "save folder as default" never runs and the user never learns why their preference vanished. Nielsen #1 + #9. |
| F-05 | **3** | a11y | `useKeyboardShortcuts.ts:39` | Handler ignores whether a dialog is open | Early-return while any `[role="dialog"][aria-modal="true"]` is mounted | With the export, settings or metadata modal open, `1`–`5`, `P`, `X`, `C`, `S`, `Space` still fire on the photo behind the scrim. Typing "3" in the aperture field is guarded (input check exists), but pressing `3` while a **radio/button** has focus rates an invisible photo and desynchronises the modal's live count. |
| F-06 | **3** | a11y | `dist/assets/index-*.css` (0 `focus-visible` rules) | Buttons rely on UA default outline; every text input sets `outline-none` | `.focus-ring` utility in `index.css`, applied to every interactive element | No visible focus indicator in the compiled stylesheet for any button, and text inputs deliberately suppress theirs. Keyboard-only users cannot see where they are. WCAG 2.4.7. |
| F-07 | **3** | a11y | `ThumbnailGrid.tsx:184-193` | `role="button"` + `aria-selected={isSelected}` | `role="option"` inside a `role="listbox"` grid container; `aria-label` describing position/name/rating | `aria-selected` is not a valid attribute for `role="button"`; screen readers announce the cell as a bare button with no indication which of 10,000 photos it is, nor its state. |
| F-08 | **3** | ui | `ThumbnailGrid.tsx:52-139` | No search, no empty state | Search field + explicit empty state ("当前筛选下没有照片") | With `filterMode` set to Picks or ★5 and nothing matching yet, the pane is a blank void with no explanation. And there is **no way to jump to a filename** — for the app's headline 10,000-image claim this is the difference between usable and unusable. Diagnostic row 4. |
| F-09 | **3** | a11y | `MetadataEditorModal.tsx:114`, `:137-200` | Wrapper `div` with no dialog role; 5 `<label>`s with no `htmlFor`; scope selector is 3 unlabelled buttons | `role="dialog" aria-modal aria-labelledby`, `<label htmlFor>` pairs, real radio group with a legend | The modal that performs a **batch write to sidecar XMP files** is announced as a generic region and its inputs are unnamed. |
| F-10 | **3** | a11y | `SettingsModal.tsx:37/61`, `BatchExportModal.tsx:36/84`, `MetadataEditorModal.tsx:61` | All three return `null` — no focus move on open, no trap, no focus restore on close | Shared `Modal` component: focus to panel on open, Tab trapped, focus restored to the invoke element | Tab walks straight out of an `aria-modal="true"` dialog into the scrimmed background. WCAG 2.4.3 + ARIA authoring practice. |
| F-11 | **3** | colors | 20+ sites: `text-white/40` at 9–11px | `color: rgb(255 255 255 / 40%)` | `text-white/60` (7.30:1) for text, keep `/40` only for decorative icons | **Verified 3.77:1** against `#0A0A0A`. Used for the EXIF secondary line, pane hints, modal helper copy and the "(N 张)" counts — all below the 4.5:1 AA floor for small text. |
| F-12 | **3** | ui | `App.tsx:521-525` + `handleScan` | `onSortChange={(o) => { setSortOrder(o); handleScan(); }}` | Re-scan driven by an effect keyed on `sortOrder` | `handleScan` is a `useCallback` closed over the **previous** `sortOrder`, so every sort change re-scans with the old order. Writes the new order to the session, then the user sees stale output. |
| F-13 | **2** | a11y | `TopBar.tsx:87/110/…` (all icon buttons) | `title` only, or `aria-label` with no focus styling | `aria-label` + `.focus-ring` on every icon-only control | Icon-only buttons carry a tooltip that never appears for keyboard/AT users unless an `aria-label` backs it. |
| F-14 | **2** | writing | `App.tsx:218/419/421/450`, `BatchExportModal.tsx:56/60/76`, `SettingsModal.tsx:56` | `alert()` / blocking native dialogs | In-app toast (`aria-live="polite"`) with problem → cause → fix | "扫描失败: Error: …" dumps a raw Rust error string into a modal OS dialog that blocks the whole app and cannot be copied. Nielsen #9. |
| F-15 | **2** | ui | `App.tsx:389-404` | `document.querySelector('img[alt="…"]')` to find the source canvas | `ref` callback threaded through `PreviewViewport` | Querying the DOM by `alt` breaks the moment two images share a basename (split view, before/after) or the alt text is localised. `computeAutoTone` silently no-ops. |
| F-16 | **2** | ui | `TonalAdjuster.tsx:89-203` | 5 sliders; `tint` absent from the panel although `ToneAdjustments.tint` exists, is computed by `computeAutoTone` and rendered by `getToneFilterString` | 6 sliders including 色调 (tint) | Auto-tone sets `tint` and the filter applies it, but the user has no control to see or correct it — a value they cannot inspect or undo. |
| F-17 | **2** | a11y | `TonalAdjuster.tsx:101-201` | `<input type="range" className="h-1 …">` | `.tone-slider` (4px drawn track, 20px hit area, `:focus-visible` ring) | A 4px-tall range control is far below the 44px touch-target floor and below a comfortable mouse target. |
| F-18 | **2** | ui | `BeforeAfterViewport.tsx:105-111` | Empty state is one `<h3>` with no icon and no CTA | Same icon + copy + CTA shape as `PreviewViewport.tsx:108-126` | Two empty states for the same condition ("nothing selected") behave differently; one offers the next action, one does not. Nielsen #4. |
| F-19 | **2** | writing | `BottomBar.tsx:92` | `<span>打开</span>` | `<span>外部打开</span>` | "打开" does not say what opens, or where. Krug #1 — every question mark costs goodwill. |
| F-20 | **2** | a11y | `index.css` | no `@media (prefers-reduced-motion)` | Global reduce block: drop `animate-pulse`/`spin`, flatten `active:scale` | WCAG 2.2.2 / 2.3.3; Apple's "Reduced Motion & Accessibility" rule. `animate-pulse` on the "viewing original" pill is the worst offender. |
| F-21 | **2** | a11y | `ThumbnailGrid.tsx:214`, `BottomBar.tsx:51-64` | "加载中" and the shortcut hints render as inert text | `role="status"` / `aria-live` regions | Loading state and shortcut state changes are never announced. Nielsen #1. |
| F-22 | **1** | ui | `ThumbnailGrid.tsx:218/224/240` | `py-0.2` — **not a generated class** | `py-[2px]` | Tailwind's spacing scale has no `0.2` step, so the index badge, pick/reject badge and rating badge all silently lose their vertical padding. |
| F-23 | **1** | ui | `ThumbnailGrid.tsx:65/77` | `font-medium font-medium` | single `font-medium` | Duplicate utility. |
| F-24 | **1** | ui | `ThumbnailGrid.tsx:254-264` | `R` / `X` / `T` / `E` single letters, `title` only | Same glyphs with `aria-label` + visible legend in the header | Recognition vs recall — the legend is stated once and never repeated. |
| F-25 | **1** | ui | `PreviewViewport.tsx:272-282` | Reset button labelled "重置缩放" with no zoom readout | Shows the current zoom (e.g. `250%`) and returns to `100%` on click | The user cannot tell whether the image is at fit, 100% or 250%. Nielsen #1. |
| F-26 | **1** | ui | `ThumbnailGrid.tsx:206-212` | `<img>` with no intrinsic size | `width`/`height` attributes | Avoids layout shift during virtualised scroll. |
| F-27 | **1** | a11y | `BeforeAfterViewport.tsx:255-271` | Star buttons have `title` but no `aria-label` / `aria-pressed`; pick/reject buttons likewise | Same accessible names as `PreviewViewport` | Inconsistent with the single view's equivalents. |
| F-28 | **1** | ui | `index.html` | `body class="bg-[#121316]"` | `bg-background-base` (the token) | Two different near-blacks in the same shell; the token is the source of truth. |
| F-29 | **1** | ui | `MetadataEditorModal.tsx:116`, `ThumbnailGrid.tsx:194`, `TopBar.tsx` | `transition` (all properties) | `transition-[background-color,border-color,transform,opacity]` | Animating every property is the fastest route to jank on a 10,000-item virtualised list. Apple "Fluid Motion". |
| F-30 | **1** | a11y | `TopBar.tsx:199` | `title="前后对照 (Y) \| 按住 \ 看原片"` | Unchanged behaviour; hint also surfaced in the shortcut cheat sheet | Two shortcuts hidden in one tooltip that most users will never hover. |

Not usability problems (severity 0), recorded for completeness:

* `w-[390px]` fixed sidebar and the `390px` + virtualised grid are intentional and correct.
* `select-none` on image panes — appropriate; text is deliberately selectable in the EXIF and
  filename capsules.
* Dark-only theme and the `lang="zh-CN"` / `<title>` in `index.html` — appropriate for a
  photographer's desktop tool.
* `e.preventDefault()` inside React's `onWheel` — React 17+ binds `wheel` passively, so the
  preventDefault is a no-op, but `overflow-hidden` on `body` means there is nothing to scroll. No
  user-visible effect.

---

## 4. Considered but rejected

| Location | Candidate | Rejected because |
|---|---|---|
| `ThumbnailGrid.tsx:192` | Keep the `div[role=button]` and drop only `aria-selected` | Leaves the cell unannounced among 10,000 siblings and loses keyboard arrow semantics; the listbox pattern is the correct one and is what screen-reader users of grids expect. |
| `TopBar.tsx:163-269` | Move the tools into an overflow "⋯" menu | Hides export/metadata/tonal — three of the app's four reasons to exist. A second visible row preserves them all. |
| `App.tsx:64` | Replace `window.confirm` for the updater with a toast | An update prompt is a real decision with release notes, not a notification. It gets its own confirm dialog (see implementation). |
| `PreviewViewport.tsx:143-153` | Replace the CSS `transform` zoom with a spring/physics gesture | Correct per Apple's interruptibility rule, but the pan here is drag-to-pan at rest, not a flick; a 2.5x double-click toggle is a discrete state change. A spring would add a dependency for no perceptible gain. |
| `TonalAdjuster.tsx:101` | Add numeric input boxes beside each slider | Doubles the panel width and competes with the thumbnail grid for the 390px sidebar. The `tabular-nums` readout is sufficient. |
| whole app | Add a Recycle-Bin / delete flow | **Deliberately not implemented** — see §6. |

---

## 5. Heuristic conflicts resolved

| Conflict | Resolution |
|---|---|
| Simplicity vs flexibility (F-08 search) | Search is progressive disclosure: a toggle button in the grid header expands to a field on demand, so the dense 3-column grid keeps its width. |
| Consistency vs context (F-18 empty states) | Same copy skeleton in both viewports; only the pane-specific subtitle differs. |
| Efficiency vs error prevention (F-14 toasts) | Batch export/metadata keep their confirm buttons; the *reporting* of the result moves to a non-blocking toast. |
| Discoverability vs minimalism (F-01) | Row 2 keeps all seven tools visible rather than behind a menu; the header absorbs the cost instead of the user. |

---

## 6. Not implemented — needs a product decision

**A delete / Recycle-Bin flow.** `api.trashPhotos` (`src/services/api.ts:96`) and
`trash_photos_cmd` (`src-tauri/src/commands.rs:144`, registered at `src-tauri/src/lib.rs:29`) are
both fully wired and **no UI calls them**. A culling tool without a removal path is incomplete, and
"已淘汰" photos are otherwise stranded.

I did not implement this: it is a new destructive capability, and adding one requires a confirmation
UX, an undo strategy and a decision on whether rejected-but-kept files are preserved. The audit
recommends a confirm dialog + toast with a "已移入回收站 (N)" summary and an explicit
per-batch scope selector.

---

## 7. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `pnpm build` (`tsc && vite build`) | exit 0 — 1617 modules, CSS 26.2 kB |
| `dist/assets/index-B5ta4v14.css` | `focus-visible` rules present · `prefers-reduced-motion` block present · `.tone-slider` present · `.py-0\.2` gone · `py-[2px]` present |
| Header rendered 1440×900 / 1180×820 / 1000×800 / 900×800 | 74px tall at ≥1180px (wraps to 107px at 900px); fields readable; `scrollWidth === clientWidth` — **zero horizontal overflow at every width** |
| `/` opens + focuses the grid search | verified |
| Escape inside search collapses it | verified |
| `?` opens the shortcut sheet, focus moves inside, Tab trapped | verified |
| Digit key while a dialog is open stays inside the dialog | verified |
| Escape closes dialog, focus returns to the invoking button | verified |
| Toast live region | mounted at all times with `role="status" aria-live="polite"` |
| `prefers-reduced-motion: reduce` | computed `transition-duration` collapses to `1e-05s` |

Still unverified without the Tauri shell: actual photo loading, XMP write, Luminar roundtrip,
auto-tone histogram sampling, and the updater confirm dialog. Those paths were reviewed in code only.

---

## 8. What was fixed

All 30 findings were fixed. New shared infrastructure added:

| New file | Purpose |
|---|---|
| `src/components/Modal.tsx` | Shared dialog shell: role/aria/labelledby, initial focus, Tab trap, focus restore, Escape |
| `src/components/Toast.tsx` | Non-blocking status reporting; replaces `alert()`; always-mounted live region |
| `src/components/ConfirmDialog.tsx` | In-app confirmation, replaces `window.confirm` for the updater |
| `src/components/ShortcutHelpModal.tsx` | The keyboard/mouse catalogue that was previously 6 unlinked hints |

Other notable changes:

* `src/index.css` — `.focus-ring`, `.tone-slider` (4px track on a 20px hit area), and a
  `prefers-reduced-motion` block.
* `src/components/TopBar.tsx` — restructured into two wrapping rows.
* `src/components/ThumbnailGrid.tsx` — listbox semantics, `aria-activedescendant`, search,
  empty state, badge legend, working `py-[2px]`.
* `src/App.tsx` — search state owned by the shell, filter-aware empty states, sort re-scan driven
  by an effect, settings-load error surfaced, image element passed by ref for auto-tone.
