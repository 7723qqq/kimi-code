# TUI Design Spec

> The **single source of truth** for all dialogs / selectors / input boxes in this directory. Read this file before adding or modifying any interactive component, and check against the "Self-check List" at the end before committing.
> Reference component: `components/dialogs/model-selector.ts` (`/model`). All list-style dialogs must align their header, hint, search, and selected/current states with it.

---

## 1. Visual States

| Semantics | Spec | Constant / token |
|---|---|---|
| Selected item pointer | `❯ ` (`primary`) | `constant/symbols.ts` → `SELECT_POINTER` |
| Selected item text | `primary` + bold | `chalk.hex(colors.primary).bold` |
| Current / active item | ` ← current` at end of line (`success`) | `constant/symbols.ts` → `CURRENT_MARK` |
| Dangerous item / action | `error` (add bold when selected) | `chalk.hex(colors.error)` |
| Dangerous confirmation `[y/N]` | `warning` + bold | `chalk.hex(colors.warning)` |
| Toggle item state: on | `  enabled` after the name (`success`) | `chalk.hex(colors.success)` |
| Toggle item state: off | `  disabled` after the name (`textDim`) | `chalk.hex(colors.textDim)` |
| List / selector border | Straight `─` (`primary`), only one at the top and one at the bottom | — |
| Input box border | Rounded `╭ ╮ ╰ ╯` (`primary`) | — |

- **Do not** invent your own selection pointer (`>` / `▶` / `→` etc.); always use `SELECT_POINTER`.
- **Do not** use `● ` / `(current)` for the current item; always use `CURRENT_MARK` (end of line, `success`, preceded by one space).
- The current item and the selected item are **independent of each other**: the current item is the "value in effect now" (end-of-line marker), the selected item is the "cursor row" (pointer + highlight); both can land on the same row at once.

## 2. Colors

- Always use **semantic tokens**: `chalk.hex(colors.<token>)`. The repo's `chalk-named-color-guard` enforces this convention; **no** `chalk.red` / `chalk.gray` or other named colors.
- `ThemeStyles` (`state.theme.styles.*()`) is an optional convenience wrapper; using it or not is up to you, but colors must come from `ColorPalette` tokens.
- Available semantic tokens, see `theme/colors.ts`: `primary` `accent` `text` `textStrong` `textDim` `textMuted` `border` `borderFocus` `success` `warning` `error` `status` …
- **No key highlighting in hint lines**: the whole line is `textMuted`; do not color individual keys like `Enter` / `Esc` / `D`.

## 3. Standard List Dialog Layout

Aligned with `model-selector`, fixed line by line from top to bottom:

```
─────────────────────────────────────────  ① top border (primary, full-width ─)
 Select a model  (type to search)          ② title (primary+bold) + suffix when searchable and no query (textMuted)
 ↑↓ navigate · Enter select · Esc cancel    ③ hint (textMuted, right below the title, no key highlighting)
                                            ④ empty line
 Search: gpt                                ⑤ search line: only rendered when there is a query (` Search: ` primary + query text)
  ❯ GPT-5            openai                  ⑥ list item: pointer + name (left) + secondary column (right, textMuted)
    Kimi K2          Kimi Code ← current        current item: ` ← current` at end of line (success)
                                            ⑦ empty line
 ▼ 3 more                                   ⑧ scroll / match indicator: `▼ N more` without query, `x / y` with query
─────────────────────────────────────────  ⑨ bottom border (primary, full-width ─)
```

Hard rules:

- **Only one `─` at the top of the header**. The hint follows directly below the title; **no** extra `─` in between. The whole dialog has exactly 2 full-width `─` lines (top + bottom).
- **`(type to search)` appears only as a title suffix** (when searchable and the query is empty); the hint line must **not** repeat "type to search".
- **The `Search:` line sits below the empty line and above the list**, rendered only when there is a query.
- The hint is right below the title (no empty line in between); there is 1 empty line between the hint and the body.
- Every line is finally passed through `truncateToWidth(line, width)` so CJK / narrow terminals never overflow.

## 4. Hint Lines and Wording (English UI)

Each hint segment is shaped like "**key + description**", segments separated by ` · ` (single-space middle dot).

| Action | Key token | Description word | Full segment |
|---|---|---|---|
| Move | `↑↓` | navigate | `↑↓ navigate` |
| Page | `←→` or `PgUp/PgDn` | page | `←→ page` |
| Confirm / select | `Enter` | select | `Enter select` |
| Cancel / close | `Esc` | cancel | `Esc cancel` |
| Delete | `D` | delete | `D delete` |
| Clear search | `Backspace` | clear | `Backspace clear` |
| Switch provider | `Tab` | toggle provider | `Tab toggle provider` |
| Search (title suffix) | typing | — | `(type to search)` |

- **Key tokens are capitalized** (`Enter` / `Esc` / `Tab` / `Backspace` / `D`), **description words are all lowercase** (navigate / select / cancel / page / delete / clear); direction arrows `↑↓` / `←→` stay as-is.
- Direction arrows are always `↑↓` (not `▲/▼`).
- "Leaving the dialog" is always worded as `cancel` (do not mix in close / back / exit / dismiss). Business semantics (e.g. reject in an approval flow) are the exception.
- The hint adapts to state: for a searchable list without a query, "type to search" already appears in the title suffix, so the hint does not repeat it; with a query, the hint appends `Backspace clear`.

## 5. Tab Bar (provider switching in `/model`)

`tabbed-model-selector` wraps a flat `model-selector` with a provider tab layer, styled to match the **AskUserQuestion** tabs:

```
 Select a model  (type to search)
 Tab toggle provider · ↑↓ navigate · Enter select · Esc cancel   ← hint starts with the Tab toggle
                                            ← empty line
 All   Kimi Code   openai                   ← tab bar: active tab filled with background (primary bg + text fg + bold), others textMuted
                                            ← empty line
  ❯ ...
```

- Tab bar position: **below the hint line**, with **one empty line above and below** (separated from both the hint and the list).
- Active tab: `chalk.bgHex(colors.primary).hex(colors.text).bold(\` ${label} \`)`; inactive: `chalk.hex(colors.textMuted)`. Both have the same visible width so switching does not jitter.
- The first tab is always `All` (aggregating all providers); **it defaults to `All`**. Only when `initialTabId` is explicitly passed (e.g. `/provider` jumping after adding a new one) does it land on the specified provider tab.
- `Tab` / `Shift+Tab` cycle through tabs; the hint's first segment is `Tab toggle provider`.
- The current model is still marked with `❯` + ` ← current` within its tab; switching tabs does not lose the position.

## 6. Key Bindings

| Action | Key | Detection |
|---|---|---|
| Move | `↑` / `↓` | `matchesKey(data, Key.up/down)` |
| Page | `PgUp` / `PgDn` | `matchesKey(data, Key.pageUp/pageDown)` |
| Confirm / select | `Enter` | `matchesKey(data, Key.enter)` |
| Cancel / close | `Esc` | `matchesKey(data, Key.escape)` |
| Delete | `D` | `printableChar(data) === 'D'` (also accepts `'d'`) |
| Search | typing | `printableChar(data)` |

- **Character comparisons must go through `printableChar()`** (Kitty protocol), enforced by `printable-key-guard`; function keys use `matchesKey(data, Key.*)`.
- **`Esc` is two-stage**: with a query, clear the query first (`list.clearQuery()`); only without a query does it call `onCancel()`.
- `←` / `→` have no fixed semantics: in components without paging structure they serve as "value switching" (e.g. thinking on/off in `/model`); in lists without horizontal values like `choice-picker` they are used for paging. **Do not** use `←→` for paging in a component that also has a thinking toggle.
- **The delete key is uniformly the letter `D`** (consistent in `/provider` and `/plugins`). Letter keys require the list to be **not type-to-search** (otherwise they would be typed into the search box) — all current lists with a delete action are non-searchable; if a list needs both search and delete, the delete must use a non-printable key.

## 6.1 Mouse Click

Main-screen mode has SGR mouse capture enabled; a left click (press + release at the same point) is recognized by pi-tui and routed to the hit component (`Component.handleClick`, coordinates relative to the component itself). When adding a clickable component:

- **Implement `handleClick(event: TuiClickEvent)`**: `event = { x, y }`, where `x/y` are 0-based coordinates relative to the component. The component only responds to "click"; it does not need to handle press/release.
- **Visible buttons**: use `TuiButton` (`components/common/button.ts`, renders `[ label ]` + triggers `onClick` on click) when a visible button look is needed, or render clickable rows in `[ label ]` style.
- **Click semantics are equivalent to the keyboard**: clicking a list row = moving the cursor to that row + `Enter` to submit; clicking a message/tool call = expand/collapse (reuse `setExpanded`); clicking an approval option = submitting that option.
- **Row-number mapping**: components with custom rendering record a `Map<row number, index>` of clickable rows at render time (e.g. `optionRows`), and `handleClick` looks it up with `event.y`.
- **Trigger re-render**: when the component has no `ui` reference, notify a repaint through the optional `onToggle` callback (host injects `requestRender`).
- **Do not** implement selection/drag semantics in `handleClick` — text selection and OSC8 link activation are handled by the pi-tui layer; the component only responds to "click".

## 7. Toggle Lists and Multi-select (toggle / multi-select)

For lists where "each row can be independently toggled on/off" (e.g. installed plugins in `/plugins`, MCP server lists). Unlike single-select (where `Enter` selects, submits, and closes), toggle lists use `Space` to flip each row's state in place without closing the dialog.

```
 Plugins
 ↑↓ navigate · Space toggle · Enter details · Esc cancel
                                            ← empty line
 Installed plugins (2)                      ← section title (textStrong / bold)
  ❯ Kimi Datasource  enabled                ← selected row (❯ + primary+bold name) + state label (success)
    id kimi-datasource · 1 skill · MCP 1/1 · via code.kimi.com · official   ← secondary info line (textMuted, ` · ` separated)
    Superpowers  disabled                   ← unselected row (text name) + off-state label (textDim)
    id superpowers · 14 skills · via code.kimi.com · curated
```

Conventions:

- **`Space` toggles the current row's state** (on ↔ off), takes effect immediately, and the dialog stays open; the hint includes `Space toggle`.
- **State labels** follow the name with 2 spaces: on ` enabled` (`success`), off ` disabled` (`textDim`). Other semantics (e.g. `installed`=success, `install…`=primary) follow the same `statusStyle` source.
- `Enter` serves a different purpose in toggle lists (e.g. "view details" `Enter details`) and does not toggle.
- With multiple independent actions (toggle / details / delete / entering a submenu), the hint lists them all, key tokens capitalized: `Space toggle · Enter details · D remove` (see the capitalization rules in section 4).
- A row may have 1 secondary info line below it (id / count / source / trust level), `textMuted`, separated by ` · `.

## 8. Thinking Control (`/model` only)

Below the list, the current selected model's thinking tri-state is shown, with the fixed `[ On ] Off` segment look:

- Title: `Thinking  (←→ to switch)` (the parenthesized hint shows only in `toggle` state); other states show only `Thinking`.
- `toggle`: `[ On ]  Off` / `On  [ Off ]`, active segment `primary+bold`.
- `always-on`: `[ Always on ]`.
- `unsupported`: `[ Off ]` + `unsupported` (textMuted).
- `←` / `→` flip the draft; on submit it is normalized via `effectiveThinking()` (always-on→true, unsupported→false).

## 9. Input Boxes (Multi-field)

- Rounded box `╭ ╮ ╰ ╯` (`primary`).
- Field switching: `Tab` / `Shift+Tab` / `↑` / `↓`.
- `Enter`: non-last field → advance to the next field; last field → submit.
- Cancel: `Esc` / `Ctrl+C` / `Ctrl+D`.
- The footer follows focus dynamically: non-last field shows `Enter next`, last field shows `Enter submit`.
- Required-field validation locates fields in order (e.g. custom-registry: empty URL → focus URL, empty token → focus token), with the corresponding sub-hint state for errors.

## 10. Shared Components (Reuse First, Don't Reinvent)

| Form | Component |
|---|---|
| List cursor / search / paging state machine | `utils/searchable-list.ts` → `SearchableList` |
| Paged view | `utils/paging.ts` → `pageView` |
| Kitty printable characters | `utils/printable-key.ts` → `printableChar` / `isPrintableChar` (with guard) |
| Selection pointer / current item marker | `constant/symbols.ts` → `SELECT_POINTER` / `CURRENT_MARK` |

New list components **must reuse `SearchableList`** (cursor / search / paging) and manually align the layout, key bindings, and wording of sections 3–8 in this file.

## 11. Self-check List for New / Modified Dialogs

- [ ] Header per section 3: one `─` at the top, title (+`(type to search)` suffix), hint, empty line, `Search:` line, list, one `─` at the bottom; **no** inner `─` below the title.
- [ ] Hint is `textMuted` for the whole line, **no** key highlighting; key tokens capitalized, description words lowercase, separated by ` · `.
- [ ] Selection pointer uses `SELECT_POINTER`, current item uses `CURRENT_MARK`; no hand-rolled `>` / `▶` / `→` / `● ` / `(current)`.
- [ ] All colors come from `colors.<token>`, no named colors.
- [ ] Keys: `↑↓` move, `PgUp/PgDn` page, `Enter` confirm, `Esc` cancel (two-stage `Esc` in searchable lists: clear query first, then close), `D` delete; character comparisons go through `printableChar()`.
- [ ] "Leaving the dialog" is only worded as `cancel`, not mixed with close / back / exit / dismiss.
- [ ] Toggle lists use `Space toggle` to flip in place without closing; state labels ` enabled`(`success`) / ` disabled`(`textDim`) follow the name with 2 spaces (see section 7).
- [ ] Long lists have scroll / paging indicators (`▼ N more` or `x / y`), and empty states have clear wording (`No matches` etc.).
- [ ] Every line goes through `truncateToWidth(line, width)`; no overflow with CJK / narrow terminals.
- [ ] Reuse `SearchableList`; input boxes are rounded boxes, multi-field supports `Tab/↑↓` switching, `Enter` advances / submits on the last field.
- [ ] Has corresponding component tests (render snapshot + handleInput key behavior).
