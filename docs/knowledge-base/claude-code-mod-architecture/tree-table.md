# TreeDataTable

Research for the first part of [issue #55](https://github.com/martin-macak/claude-code-mod-tracking/issues/55): one UX component that draws every tree in the pane and owns its interactions. The index is [README.md](README.md). Grades: [AGENTS.md](AGENTS.md#grades). `d.ts:N` links to the 2.1.302 snapshot.

The page gives prior art, what the engine allows, constraints and options. Recommendations are marked. The design spec decides.

Short answer:

- **Keys.** Tab and Shift+Tab walk the rows through the engine focus ring (`verified-live`). Up and Down only scroll while the tree is taller than the pane. A hotkey is one lowercase letter or digit. No other key reaches a pane.
- **One table.** Since [issue #63](https://github.com/martin-macak/claude-code-mod-tracking/issues/63) (L1) the pane draws one header row for every group of rows, over columns that every tracker shares ([§5.5a](#55a-one-table-with-shared-columns-issue-63-l1)).
- **Window.** A pane cannot pin a header or a footer, but the mod can keep the tree as tall as the body: it draws the rows that fit and every other row as a bare focus stop, and a `ui.focus` hook that selects the row moves the window (`verified-live`, [§3.2](#32-keyboard), issue #109). A docked pane also pins the footer to the last row of its body (`verified-live`, the same rows). The focus ring sits on a position among the Buttons, not on a key, so every row must keep its stop in the same order.
- **Selection.** A `ui.focus` hook may write a `selected` atom. A render hook may not (`verified-kit`). Live, the highlight follows Tab on the first frame and the ring stays on the same `Button` (`verified-live`). Make the selection sticky: write `selected` only for row keys.
- **Hotkeys.** A hotkey acts on the selected row and does not move the ring (`verified-live`). Read the selection from state at press time.
- **Size.** A pane tree has hard budgets. Past about 250 rows with real `Box` keys, or about 470 rows with 200-character titles, the page loses its Buttons without a refusal (`verified-live`, same rows as the kit). The engine logs the cut once, but the mod cannot read the log. A row cap is required. A refused tree is blank and keyboard-dead.
- **Cost.** One Tab costs one engine repaint and one full-tree hook render: about 58 ms to a settled screen at 300 rows, 221 ms at 1300 (`verified-live`).
- **Layout.** Alignment, colors and clipping all work with `Box` and `Text`. Cell width needs a measure function that the mod ships itself (`verified-live`).

## 1. What the issue asks

The definition of done lists six items for the component, plus one rule.

| # | Requirement | Short name |
| --- | --- | --- |
| 1 | Every tree row is expandable | U1 |
| 2 | A header row shows column headers | U2 |
| 3 | A column has a fixed size or sizes to its content, and aligns left, right or center | U3 |
| 4 | A cell has a foreground and a background color | U4 |
| 5 | The user moves between rows with the keyboard | U5 |
| 6 | A caller registers any key on a row to run an action (for example `x`) | U6 |
| 7 | Every tree in the pane uses TreeDataTable | U7 |

The issue also says: "New UX is a goal: the pane may look and behave differently after this work."

## 2. The pane today

The renderers and their code are in [current-architecture §10](current-architecture.md#10-the-ui-today). The status of each requirement, from the code at commit d391552:

| Req | Status | Evidence |
| --- | --- | --- |
| U1 expandable rows | partial | Only Jira items and nodes, the worktree root and the master agent fold (`H/ui/view.ts:287, :327`, `H/ui/auto-view.ts:57, :122`). Every other row is `foldable: false`. `PaneRow` has no children or detail field. The builders drop folded children, not the renderer. The toggle is a plain `+`/`-` Button (`H/ui/pane.tsx:74-79`). State is the `ui.folded` atom. |
| U2 header row | missing | No header row. A section has a title and a note only (`H/ui/pane.tsx:164-168`). `Cell` has no label (`H/ui/view.ts:63`). |
| U3 sizing and alignment | partial | Fixed: a numeric width per layout, with a wide and a narrow variant at 70 columns (`H/ui/view.ts:142, :155-219`). Fill: a cell without width grows. Content sizing: missing, every width is a literal. Alignment: missing, every cell is left-aligned. Truncation per cell exists. |
| U4 colors | partial | Foreground only, from a closed set `ok, warn, bad, dim, plain` mapped to `green, yellow, red, dimColor` (`H/ui/pane.tsx:30-37`). Only `status` and `extra` take a tone. No `backgroundColor` anywhere in `hooks/ui/`. Raw color names, not theme keys. |
| U5 keyboard rows | partial | Only through the focus ring over Buttons. A row is reachable if it holds a Button: priority mark, fold or `x`. Process rows hold none. Selection is the non-reactive module variable `focusedRow`. |
| U6 key registry | partial | A hard-coded footer: `r` and `1 2 3 0` (`H/ui/pane.tsx:23-28, :190`). `PaneActions` is a fixed type with five methods. The `x` Button has no hotkey. |
| U7 one component | partial | One drawer serves all ten sections, but it is bound to `PaneRow`, `Cell` and `CellName`. A closed eight-case switch draws the cells. Two other renderers (`textOf`, the band) read the same model. Interaction logic is split across `view.ts`, `pane.tsx` and `register.tsx:1446-1500`. |

Each row holds up to three Buttons today: the priority mark, the fold toggle and `x`. A Tab walk therefore visits up to three stops per row.

## 3. What the engine allows

### 3.1 Elements and layout

| Fact | Grade | Evidence |
| --- | --- | --- |
| The terminal element table is `Box, Text, Button, Input, Select, Link, Code, Markdown, Client, Raster, Image`. No Table, Tree, Grid or List element exists on any surface. | `types-only` | [d.ts:3897-3918](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3897-L3918), [d.ts:3891-3972](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3891-L3972) |
| `Box` has `width`, `height`, `minWidth`, `minHeight`, `flexGrow`, `flexShrink`, `alignItems`, `justifyContent`, `gap`, `columnGap`, `backgroundColor`, `overflow`, `display`. It has no `maxWidth` and no `flexBasis`. | `types-only` | [d.ts:928-1023](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L928-L1023) |
| `Text` has no width and no align. Width must sit on a `Box`. | `types-only` | [d.ts:13154-13220](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L13154-L13220) |
| `gap`, `margin*` and `padding*` take `Space` (`number` or `xs..xl`). A number means cells on every surface. A step name differs per surface. | `types-only` | [d.ts:12508](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L12508), [d.ts:990-1020](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L990-L1020) |
| A `Button` child is a string or a `Text`. Any other element, including `Box`, is refused. A whole-row Button cannot hold fixed-width Box cells. | `types-only` | [d.ts:1105-1107](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1105-L1107) |
| A `Button` `hotkey` is one digit or one lowercase letter. Two clashing hotkeys: the later one wins. | `types-only` | [d.ts:1112-1121](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1112-L1121) |
| `Button.action` binds only an existing engine keybinding action. | `types-only` | [d.ts:1130](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1130) |
| `Pane` render props include `bodyColumns` (95 docked at 120 columns, 96 inline at 100) and `scroll` (`SiteScroll`). A taller tree scrolls as a whole. | `types-only`, `verified-live` | [d.ts:10732-10777](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L10732-L10777), [d.ts:12336-12349](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L12336-L12349) |
| `justifyContent` `flex-start`, `center` and `flex-end` on a fixed-width `Box` place the `Text` child at offset 0, 5 and 10 of 12. The result is the same in dock and inline placement. | `verified-live` | Capture of a row of three `Box width=12` cells: plain text `ab` at columns 0, 18, 36. |
| `Text wrap="truncate-end"` clips inside a fixed-width `Box` and draws `ABCDEFG…` in 8 cells. Without `wrap` the text wraps and the row grows to four lines. | `verified-live` | Same capture. |
| `Box backgroundColor` fills the whole fixed width and the whole row height. `Text backgroundColor` paints only its own characters. A row `Box` with a background paints its children as one band, including mixed-width children. | `verified-live` | `ESC[48;2;0;0;255mbox10` followed by five padded blue cells; `ESC[48;2;0;0;255mbghex` paints 5 cells. |
| `bold underline` on `Text` draws SGR `1;4`. `inverse` draws SGR `7`. | `verified-live` | Same captures. |

### 3.2 Keyboard

The mod cannot bind Tab or the arrows. No pane-level key event exists and there is no raw-key subscription in a hooks module. Only a `Client` surface module has `onKey`.

| Fact | Grade | Evidence |
| --- | --- | --- |
| **Tab walks every Button in document order. Shift+Tab walks back.** The window scrolls one row at a time to keep the ring in view, in dock and in inline placement. | `verified-live` | 40-row grid, docked, tmux 120x37: Tab to `Go 30` shows rows 1-30. Tab to `Go 31` shows rows 2-31. Tab to `Go 40` shows rows 11-40. Inline (100 columns, body 10 rows) follows the ring the same way. |
| **Up and Down scroll the window while the tree overflows.** The ring stays where it was. They move the ring only when the whole tree fits, in ring order, not in spatial order. Left and Right do nothing. | `verified-live` | With the ring on the close mark, Down logged `S:by1 off1`, `off2`, `off3` and Up logged `S:by-1 off2`. The ring did not move. A 36-Button, 3-row tree: Down, Down, Down moved the ring to `k-c`, `k-d`, `k-e`. |
| The ring also stops on a `display:'none'` Button (nothing inverted, a dead stop) and on the engine's close mark `✕`. The first Tab after open lands on a hidden Button if one exists. | `verified-live` | First Tab logged `F:hidden-z/person` with nothing inverted. |
| Enter presses a ring Button even when it has scrolled out of view. | `verified-live` | Ring on `Go 05`, End key moves the window to rows 12-40, Enter logs `P:row-05`. |
| The engine's own keep-in-view scroll raises no `ui.scroll` and no re-render. `e.props.scroll.offset` in a render hook can be stale until the next render. | `verified-live` | After 44 Tabs the log held only `F:` lines. The next render logged `off18`. |
| `autoFocus` works on a `Button`, also for a row that is off screen (the pane opens already scrolled). | `verified-live` | `autoFocus` on row 35: the pane opens with rows 7-35 visible. |
| **`autoFocus` on the first row `Button` puts the ring there at open, so the first Tab goes to the second row.** Without `autoFocus` the ring starts on nothing, the first Tab lands on the first row `Button` (not on the close mark), and the first Shift+Tab goes to the close mark. The ring order is the rows, the footer `Button`s, then the close mark. | `verified-live` | `/tbl 300 0 auto sticky`, before any Tab: `row=#0 ring='>' highlight_bg=['68']`, header `sel=r0`. `events.log`: `F el=r0 origin=plugin`, then the first Tab `F el=r1 origin=person`. Without `auto`: `F el=r0 origin=person`, first Shift+Tab `F el=-`. `Button.autoFocus`: [d.ts:1165-1174](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1165-L1174). Spike [`tbl`](../claude-code-mods/sources/spikes-2026-10-17/tbl/). |
| **The pane header and footer are not sticky.** A status line in either is out of view while the window is scrolled between them. A hotkey `Button` in the footer still fires. The mod keeps them in view with a window over its rows, and a docked pane pins the footer to the last row of its body (the rows after this table, issue #109). | `verified-live` | The `last action` status sat in the header `Text` and in the footer. `events.log` lines `A …` were the reliable signal. |
| **A hotkey press does not move the ring.** `x` and `y` fire from whichever `Button` holds the ring, also the close mark or a footer `Button`. | `verified-live` | `events.log`: `P el=fx`, `A last action: x on row 4`, `R … sel=r4`, no `F` line. With the ring on a footer `Button`: `P el=fy`, `A last action: y on row 0`. |
| **A `Client` region gets the keyboard only after a mouse click.** Tab skips it. `$.ui.focus` on its key is denied (`no element of its own is drawn under that key`). `ClientProps` has no `autoFocus`. After a click it receives every key and Esc gives the focus back. | `verified-live` | [d.ts:1532-1600](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1532-L1600), [d.ts:1626-1628](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1626-L1628). A synthetic SGR click (`\x1b[<0;30;6M`) focused it; letters, arrows, Tab and Enter then reached `surface.onKey`. |
| **A pane hotkey fires wherever its Button is**: scrolled out below or above the window, in the footer, or inside a `display:'none'` Box. Pane hotkeys are gated by pane focus only. The band rule (a bare digit arms only Buttons wholly in view) does not apply to a pane. | `verified-live` | `q` (row 35, below), `z` (hidden Box), `w` (visible) and `f` (footer, below) all logged `P:<key>`. Band rule: [d.ts:10692](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L10692). |
| **No letter or digit is reserved.** All 36 hotkeys `a-z` and `0-9` fired on a focused plugin pane. Shift folds to lowercase. | `verified-live` | `keys.py` sent each character with `tmux send-keys -l`. All 36 logged `P:k-<char>`. The composer stayed empty. |
| Other printable keys leave the pane. The character goes to the composer and the pane loses focus. `!` opens shell mode. `?` opens the shortcut overlay and keeps the pane focused (the body shrinks from 30 to 24 rows). `/` drops focus. | `verified-live` | Header flipped to `foc=0`. |
| The engine binds Tab, Shift+Tab, Up, Down, Enter, Esc, PageUp, PageDown, Home, End and the `ctrl+x` chords on a focused pane. `ctrl+x Tab` toggles pane focus. | `verified-live`, `public-docs` | Home gave `S:by-48 off0`; End gave `S:by48`. Public docs: [interface.md:532-545](../claude-code-mods/sources/code-claude-com-2026-10-09/mods/interface.md#L532-L545). |
| A resize that switches dock to inline (120 to 100 columns) dropped pane focus. | `verified-live` | Render log `foc1` then `foc0`. |
| **A render hook that reads `e.props.isFocused` runs again when the pane gains or loses the keys.** The next frame already has the new value. | `verified-live` | [Issue #108](https://github.com/martin-macak/claude-code-mod-tracking/issues/108). Claude Code 2.1.304, tmux 120x37 docked, three web links, the mod loaded from the branch. The row the hook draws as selected had a `48;5;68` background and the ring (SGR 7) on its `▸`. The key `j` went to the prompt: the next frame had no `48;5;68`, a dim `>` and the hint line `Keys go to the prompt.` above the tree. ctrl+x Tab: `48;5;68` and the ring were back and the hint was gone. A resize from 120 to 100 columns also dropped the keys and drew the hint. Confirms the `foc=1` then `foc0` rows above. |
| **A click on a blank part of the pane gives it the keys. A click on a `Button` only presses it.** | `verified-live` | Same run, keys in the prompt, synthetic SGR clicks (`tmux send-keys -l` of `ESC[<0;30;7M` then `ESC[<0;30;7m`). Click on the `▸` of a row: the row opened and was selected, the hint stayed and the highlight stayed dim. Click at column 60 on a blank row of the body: the hint was gone, the `48;5;68` highlight was back and the ring sat on the selected row. |
| **`autoFocus` on the handle of the selected row puts the ring there when the keys come back.** A redraw does not take the ring from a footer `Button`. | `verified-live` | Same run. Three rows, the third selected, `j`, then ctrl+x Tab: the ring was on the `▸` of `three.example/c` and Up went to `two.example/b`. The same after a second `/track` on the open pane with the second row selected: Down went to the third row, not to the first. With the ring on the footer `x: dismiss` (three Tabs), `r` redrew the pane and the ring stayed on `x: dismiss`. [Issue #108](https://github.com/martin-macak/claude-code-mod-tracking/issues/108) asked for this fix in `ux/tree-data-table/table.ts`. |

**Windowed rows (issue #109).** The mod keeps the tree as tall as the body (`scroll.bodyRows` less the footer and the gap above it) and draws only the rows that fit. The rows below record the live spike that decided how a person reaches the other rows. The spike was a scratch mod with one section of 12 or 36 rows, run on Claude Code 2.1.304 in tmux at 100x40 (inline, body of 11 rows). Its `ui.focus` hook called `next(e)` and wrote `selected` for a row key. Its render derived the window from `selected` and a remembered first row. The remembered row is kept in memory by the mod: a render hook may not write state.

| Fact | Grade | Evidence |
| --- | --- | --- |
| **A tree that fits the body never scrolls.** The title, the header, the rows and the footer stay in one frame, whatever the number of rows behind the window. `scroll.offset` stays 0. | `verified-live` | 12 rows, body 11: `│ Web links 12 links`, `│         Ref Label`, 7 rows, a blank row, `│ r: r: refresh  h: h: help  Esc close`. Every render line of the run ends in `off=0`. |
| **PageUp, PageDown, Home, End and the wheel still raise `ui.scroll` when the tree fits.** `by` is `bodyRows` for a page key and `contentRows` for Home and End. When the tree fits the two are equal, so a hook cannot tell End from PageDown. | `verified-live` | `S by=11 off=0 body=11 content=11 origin=person` (PageDown), `S by=-11 …` (PageUp), `S by=11 …` (End), `S by=-11 …` (Home). |
| **The ring sits on a position among the Buttons, not on a key.** When a redraw changes the order of the Buttons, the ring keeps its position and lands on another Button. This is the engine fact behind the README limit "Focus after a background change". | `verified-live` (the position), `inference` (the exact landing) | A variant drew one hidden row above and one below the window, each a row Button in a `Box` with no height. Tab walked `r6`, `r7` (the window moved), `r8` (it moved again), then `F el=fr`: the hidden row `r9` was in the drawing and the walk skipped it. After the `r7` step SGR 7 sat on the `▸` of `#7`. After the `r8` step no row had SGR 7. The first move added a stop at the end of the list. The second removed one at the start and added one at the end. So the ring stayed at its position and sat on `r9` (inference from the missing SGR 7 and the next Tab). |
| **A `Button` in a `Box` with `height: 0`, `overflow: 'hidden'` and `flexShrink: 0` takes the ring** (Tab, Shift+Tab, Up, Down) and raises `ui.focus` with its key. It draws nothing, and the engine does not scroll to it. | `verified-live` | `F el=r7 origin=person next=0ms deny=- wrote=r7`, then a render with `off=0`. The `Box` needs `flexShrink: 0`, as the first probe of [issue #63](https://github.com/martin-macak/claude-code-mod-tracking/issues/63#issuecomment-6295033639) found. |
| **Every row outside the window as one such stop keeps the order, so the keyboard walks all rows.** Tab, Shift+Tab, Up and Down move the ring onto the next stop. The `ui.focus` hook writes `selected`, the next render moves the window onto that row, and the ring stays on it. No `$.ui.focus` call and no redirect is needed. | `verified-live` | 12 rows, body 11, 14 Tabs: `F el=r1` to `F el=r11`, then `fr`, `fh` and `el=-` (the close mark). The window followed to rows 5 to 11. Shift+Tab back: `fh fr r11 r10 r9 r8 r7 r6 r5 r4 r3 r2 r1`. Down, Down, Up, Up from `r1`: `r2 r3 r2 r1`. From `r7` to `r11` SGR 7 and the 48;5;68 background sat on the same row. |
| **The ring order is every row stop, the footer Buttons, then the close mark.** Tab goes on from the close mark to the first stop. Down skips the close mark. | `verified-live` | `F el=fh`, `F el=-`, `F el=r1` with Tab. `F el=fr`, `F el=fh`, `F el=r1` with Down. |
| **A `ui.scroll` hook that does not call `next` can move the selection and the ring itself.** It writes `selected` and calls `$.ui.focus({ requestId, key })` for the new row, inside the hook. The call returns `{}` and raises `ui.focus` with origin `plugin`. | `verified-live` | 36 rows. PageDown: `S moved selection 0 -> 11 nested-focus=ok`, `F el=r11 origin=plugin`, the window showed rows 5 to 11. PageDown: `11 -> 22`, rows 16 to 22. PageUp: `22 -> 11`, rows 11 to 17. |
| `next({ ...e, element })` in a `ui.focus` hook to land the ring on another stop, and an edge `Button` ("N more below") answered by a nested `$.ui.focus` from the `ui.focus` hook, were not needed and were not run. | `types-only` | [d.ts:4154-4164](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L4154-L4164) says `next({ ...e, element })` lands the ring on another element the plugin drew. A stop that is not drawn yet cannot take it. |
| **A docked body has a fixed height, and the footer can sit on its last row.** The root `Box` takes `minHeight: bodyRows`. The footer sits in a `Box` with `flexGrow: 1`, `flexShrink: 0` and `justifyContent: 'flex-end'`, which replaces the footer as the last child of the root, so the root gets no new child and no gap row. The title and the rows stay at the top. | `verified-live` | Claude Code 2.1.304, tmux 120x37, 3 links, the mod loaded with `--plugin-dir`. The close mark is on row 1 of the pane column, the footer on row 32 (1 + 31 body rows), and one blank row that the engine keeps is below it. The same with the keys in the prompt (hint on row 2, footer on row 32) and in the help view (footer on row 32). With 36 links the frame is the one before the pin: 26 rows, `▼ 10 more below`, the footer on row 32. |
| **An inline frame is as tall as its tree.** A `minHeight` there would stretch every inline pane, so the mod pins the footer only where `Pane.placement` is `dock`. | `verified-live`, `types-only` | Inline 100x40, 3 links: the frame has 7 body rows (title, header, 3 rows, a blank row, the footer), not 11. [d.ts:10761-10765](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L10761-L10765): "Inline the frame fits the tree." |
| **The hint line of a pane with no keys is part of the body.** The window leaves the rows of the hint (one, or two in a body narrower than 50 cells) to the line. | `verified-live` | Inline 100x40, 12 links, then `j`: the hint, the title, the header, 5 rows, `▼ 7 more below`, a blank row and the footer are the 11 rows of the body. Without the fix the tree took 12 and the footer left the view. |
| **Tab onto an "N more" row keeps the ring there after the redraw.** The `autoFocus` of [issue #108](https://github.com/martin-macak/claude-code-mod-tracking/issues/108) on the selected row does not pull it away. | `verified-live` | `global.ui.sectionRows` 8, 30 links, inline 100x40. 7 Tabs: the `>` on `site8` and the row `22 more` in view. The 8th Tab: SGR 7 on `22 more`, the window unchanged. |
| **Without a new request, the ring stays on its position after Enter on an "N more" row, and that position is a row stop above the window.** The next Tab selects the row after it and the window moves onto that row, so one row is skipped. | `verified-live` (the screen), `inference` (the cause) | Same run, before the mod asked for the ring again: Enter on `22 more`: 8 rows more, the window on rows 12 to 16 and `14 more`, no SGR 7 in the frame. The old position of the ring is now a hidden row. One Tab: the ring and the `>` on `site10`. The ring keeps its position, as the position fact above says. |
| **After Enter on an "N more" row, a `ui.focus` request for the selected row puts the ring on that row.** The mod clears its "N more" mark and asks for the ring on the selected row, as after `x`. The window follows the selected row, and the next Tab moves one row. | `verified-live` | The e2e scenario "Enter on an N more row of a windowed pane puts the ring back on the selected row" (Claude Code 2.1.304, tmux 120 columns, so docked, `global.ui.sectionRows` 30, 40 links): 29 Tabs select `a30`, the 30th puts the ring on `10 more`, Enter shows the rest. With the change the ring is on the `▸` of `a30` (SGR 7), the `>` stays on `a30`, and the window ends in `▼ 10 more below`. Without the change the same step timed out: no SGR 7 in the frame. |
| **`h` and `x` on the last row take Buttons away, and the engine keeps the ring at its position and tells the mod nothing.** `h` takes the rows away, so every footer Button moves up by the number of rows, and the ring lands on the Button that holds its old position. A ring on `c: resolve` is past the last Button of the help view and lands on none. The mod must ask for the ring after the frame that holds the new state (`$.ui.focus` lands on the frame the engine holds, and the next frame shifts it again). Any draw after the write is not enough: the draw that the dismissal caused still held the row. | `verified-live` | Claude Code 2.1.306, tmux 100x40 (inline) and 120x36 (docked), model haiku, the mod loaded from the branch with `--plugin-dir`, the e2e fake `gh` with one conflicted PR row ([issue #140](https://github.com/martin-macak/claude-code-mod-tracking/issues/140)). **Without the change**, one row: Tab ×8 puts the ring on `c: resolve`, `h` leaves no reverse video in the frame, one more Tab gives `r: refresh` (the first Button). Tab ×1, `h`: the ring is on `h: back`. Tab ×2 (`h: help`), `h`: `x: dismiss`. Tab ×3 (`x: dismiss`), `h`: `1: high`. **With a request sent at once after the write**: `c: resolve`, `h`: `x: dismiss`, one off, because the request landed on the old frame. **With the request after the frame that has `help` set** (no other wait; three runs of the same steps agreed): `c: resolve`, `h`: `h: back`, one Tab: `x: dismiss`. The second `h`: the `▸` of the PR row. `h: help` and `x: dismiss` keep their Button through both views. **`x` on the only row**: with the request after any draw that began after the arming it landed one off (`h: help`); after the frame that no longer holds the row it is `r: refresh` for a ring on the row and on `c: resolve`, and a ring on `x: dismiss` stays. The frame need not be empty: rows that were hidden behind an "N more" can take the place of the last drawn row, and the selection is cleared all the same (`inference`, kit test only). **A request in the same turn as that frame is too early too** (Claude Code 2.1.306, tmux 120x36, the e2e scenarios): a variant that took the Buttons from the frame and asked at once failed both the scenario for `h` and the scenario for `x` on the last row. In the `x` scenario the ring sat on `h: help` and the step timed out waiting for `r: refresh`. One read of an atom before the request: `h: help` again. A pause of one macrotask before the request: the `x` scenario passed. The shipped code reads the state after the frame and before it asks, and it passed both, so those reads stay until the pause is explicit. The e2e scenarios "h moves the ring from a tracker key to h: back, and the second h gives it back to the selected row" and "x on the last row puts the ring on r: refresh" (without the fix, the second one: no reverse video, timed out). |
| **A body under 7 rows cannot hold the window.** The window shows at least one unit, so the title, the header, one row, the two hints, the gap and the footer need 7 rows. In a body of 6 the tree is one line taller than the body, so the engine scrolls the title or the footer out of view. The mod still answers the wheel and the page keys (the selection moves, not the scroll of the engine), and Tab walks every row because every row keeps its stop. | `verified-kit` (the count), `inference` (the engine scroll) | `table-window.test.ts` "the floor of the window": at 7 rows the drawing takes 7 lines, at 6 rows it takes 7 lines. That the engine then scrolls follows from the evidence of [issue #109](https://github.com/martin-macak/claude-code-mod-tracking/issues/109) for a tree taller than the body. |

**Built (issue #109; the choices below are `inference` from the rows above, the owner decided only to window the rows):** the pane windows its rows by the selected row, with the stops above. The hints ("N more above", "N more below") are dim text, not Buttons: a Button that appears and disappears with the window would change the order of the Buttons, and the ring would sit on another Button (the position fact above). PageUp, PageDown and the wheel move the selection by a page less one row, or by the rows of the tick, through the `ui.scroll` hook. Home and End do the same as a page key. On a docked pane the footer also sits on the last row of the body when the rows are fewer than the body holds (the owner's wish in [issue #63](https://github.com/martin-macak/claude-code-mod-tracking/issues/63)); an inline pane is as tall as its tree, so there it stays under the last row. A hint line above the tree (no keys, [issue #108](https://github.com/martin-macak/claude-code-mod-tracking/issues/108)) takes its rows off the body that the table gets. After Enter on an "N more" row the pane asks for the ring on the selected row. A section with no row at the top of the list (a title and a note) is not a row, so no hint counts it and Tab cannot reach it: the window starts at the top again whenever the selected row still shows.

**Live, the real pane on this change** (`verified-live`; Claude Code 2.1.304, tmux, model haiku, the mod loaded with `--plugin-dir`, an empty config folder, web links from one prompt). Inline 100x40, 12 links, at open:

```text
╭────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│ Web links 12 links                                                                               │
│     Label                   URL                                                                  │
│ >   ▸ site1.example/page1   site1.example/page1                                                  │
│     ▸ site2.example/page2   site2.example/page2                                                  │
│     ▸ site3.example/page3   site3.example/page3                                                  │
│     ▸ site4.example/page4   site4.example/page4                                                  │
│     ▸ site5.example/page5   site5.example/page5                                                  │
│     ▸ site6.example/page6   site6.example/page6                                                  │
│   ▼ 6 more below                                                                                 │
│                                                                                                  │
│ r: refresh  h: help  x: dismiss  1: high  2: normal  3: low  0: auto  Tab ↑↓ move  Esc close     │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

After 11 Tabs the ring and the `>` sit on the last row, the window shows rows 7 to 12 and `▲ 6 more above`, and the footer is in view. The 12th Tab moves the ring onto `r: refresh`. Docked 120x37 with 36 links, at open: the title, the header, 26 rows, `▼ 10 more below`, a blank row and the footer. After 30 Tabs the `>` and the ring are on `site31.example/page31`, with `▲ 6 more above` and `▼ 5 more below`. A resize to 120x25 shrank the window to 13 rows and kept the selected row in view. An open row with a long link wrapped its detail lines over 6 rows: the window gave up rows for them and the footer stayed in view. `x` on a row selected the next row and the ring followed it. PageDown and PageUp moved the selection by 4 rows in a window of 5. At 100x40 the help view still shows `Pane keys` first and the footer last, in one frame.

### 3.3 Selection state

| Fact | Grade | Evidence |
| --- | --- | --- |
| A `ui.focus` hook may call `update($, selected, ...)`. A Pane render that reads the atom shows the new highlight on the next draw, with no `redraw()` call. | `verified-kit` | Spike [`kit-focus`](../claude-code-mods/sources/spikes-2026-10-17/kit-focus/): row `row-b` got `backgroundColor: 'blue'` and a `>` marker after `$.ui.focus(...)`. A move to `row-c` moved it. An engine stop (no element) cleared it. |
| A `ui.render` hook that writes state is refused with a clear message. | `verified-kit` | `state.set: denied: it was made while ui.render is being dispatched`. Doc: [d.ts:3488-3489](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3488-L3489). |
| The `ui.focus` hook runs before the ring moves. If the hook writes state before `next(e)` and core then denies the move, or the kit bottom throws, the selection stays written. Fix: call `next(e)` first and write only when `r.deny === undefined`. | `verified-kit` | Variant test: `deny` left the selection unwritten. A write before `next` left `row-b` blue after `no implementation for ui.focus`. |
| A `get` made while a render hook draws subscribes that instance. A later `set` draws it again. | `types-only` | [d.ts:3463-3464](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3463-L3464) |
| `ui.focus` can redirect: `next({ ...e, element })` lands the ring on another of the plugin's elements. Not run. | `types-only` | [d.ts:4154-4164](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L4154-L4164) |
| **Live: the highlight follows Tab, and the ring stays on the same `Button` after the redraw.** The highlight shows on the first frame after the redraw. One Tab raises exactly one `ui.focus` event. The hook runs `next(e)` first, then writes `selected` when there is no deny. The write triggers one hook render. No second `ui.focus` follows that render, which is the evidence the ring did not jump. | `verified-live` | `events.log` after Tab 5: `F el=r4 origin=person next=0ms upd=18ms deny=- wrote=r4`, then `R rows=300 … sel=r4 foc=1`; no `F` line follows. Colored capture read with `an.py`: line 8 `row=#4 ring='>' highlight_bg=['68']` (the ring is SGR 7, the `Box` background 48;5;68). Same for Tab 1 (`#0`) and after Enter (`#5`). Over 20 Tabs at 300 rows: 21 person focus events and 23 renders (1.10 renders per focus event, one toggle included). `next(e)` mean 0.3 ms, max 1 ms. Under tmux `blue` paints 48;5;68. [d.ts:4154-4164](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L4154-L4164). Answers the first half of [Q1](open-questions.md#1-unknowns). |
| **A hotkey acts on the selected row.** The `onPress` closure reads the `selected` atom at press time. | `verified-live` | `events.log`: `A last action: x on row 4`. |
| **The literal hook loses the selection on a stop that is not a row.** Writing `e.element ?? null` writes `null` on the close mark (it has no `element`: [d.ts:14570](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L14570)) and writes the footer key (`fd`) on a footer `Button`. Neither matches a row, so the highlight vanishes and a hotkey reports `x on no row`. | `verified-live` | Shift+Tab from `r0`: `F el=- origin=person … wrote=null`, header `sel=null`, only the close mark ✕ inverted, then `last action: x on no row (selected=null)`. Shift+Tab again: `F el=fd … wrote=fd`, header `sel=fd`, `x on no row (selected=fd)`. |
| **A sticky variant keeps the selection.** Write `selected` only when `e.element` matches the row-key pattern (`/^r\d+$/`). The highlight then stays on the last row, and `x` and `y` act on it while the ring sits on the footer or the close mark. This is a design choice (`inference`) and the only mode in which the footer hotkeys always have a target. | `verified-live` | `/tbl 300 0 sticky`: `F el=- … wrote=-`, `F el=fd … wrote=-`; header stays `sel=r0`, highlight stays on `#0`; then `A last action: x on row 0` and `y on row 0`. |
| **Enter toggles detail rows and keeps the ring.** The label goes from `>` to `v` under the same key. No `ui.focus` follows. The next Tab goes to the next row `Button` (`r5`), skipping the detail rows because they hold no `Button`. Two one-line detail rows cost 5 nodes, 2 strings and 70 characters. | `verified-live` | `events.log`: `P el=r4`, `T toggle r4`, `R rows=300 nodes=3318 str=1205 chars=21603 … sel=r4`; the render before showed `nodes=3313 str=1203 chars=21533`. `an.py`: `row=#4 ring='v' highlight_bg=['68']`. Next Tab: `F el=r5`. |
| **Live, L6 pane: the selection follows the row id, the ring stays at its key, and a hotkey acts on the selection.** (1) `autoFocus` on the first row `Button` raises a `ui.focus` at open, so the mod writes `selected` and draws the `>` gutter on the first row before any key. (2) A background change that inserts a row above the ring moves the ring onto another row, because the handle `r<n>` is the position. `selected` is a row id, so the `>` gutter stays on the old row. (3) `x`, `1`, `2`, `3` and `0` act on `selected`, not on the ring. After `x` or a digit key the mod focuses the handle of the next row, so the ring is on the selection again. (4) `r` (a data refresh) leaves the ring where it was. (5) After the chord ctrl+x Tab gives the pane the keys again, no `Button` has the ring. The first Tab then lands on the first row and writes `selected`. The README limit "Focus after a background change" is this row. No `j` and `k` fallback was added (spec section 12). | `verified-live` | Read the ring from `tmux capture-pane -e` (SGR 7 on the focused `Button` text); `capture-pane -p` shows only the gutter. Three web links, Claude Code 2.1.303, docked. **Open:** `│>   ▸ one.example/a …` with the ring on its `▸` before any key. **Tab:** `│>   ▸ two.example/b …`, ring on its `▸`. **ctrl+x Tab:** no ring. A prompt adds a Jira row while the pane has no keys, then ctrl+x Tab: `│    ▸ ISS-1  ISS-1 … track-only` above `Web links 3 links`, `│>   ▸ two.example/b …` (selection by id), no ring. **`x`:** `Web links 2 links`, `│    ▸ one.example/a …`, `│>   ▸ three.example/c …`, ring on `three.example/c`. **Tab:** ring on the footer `r: refresh`, `>` still on `three.example/c`. **Insert above the ring** (Tab ×3 put the ring on `three.example/c`, key `r2`; the next reply of the model ended with a Jira URL, which became row `r2`): ring on `│    ▸ ISS-3  ISS-3 … track-only`, gutter `│> ▲ ▸ three.example/c …` (now `r3`). `x` removed `three.example/c`, not `ISS-3`; then `│>   ▸ one.example/a …` held the ring and the gutter; Tab moved both to `│>   ▸ acme.atlassian.net/brow… …`. **`1` on a row:** `│> ▲ ▸ three.example/c …` moved to the top of the section and kept the ring and the gutter; `r` kept the ring on `one.example/a`. |
| **Live, L6 pane inline and after `/track clear`.** (1) At 100 columns the pane seats inline: a full-width box under the transcript, with the close mark top right. It draws the same header rows, `>` gutter, footer and keys as docked, and Tab, Shift+Tab, `h` and `x` work the same. (2) Inline at 40 rows the pane body holds 11 lines. The help view with its footer took 13 rows in its full form, so run 641b6f2 saw it open scrolled to keep the focused footer `Button` `h: back` in view, with its first two lines (`Pane keys`, `r  refresh`) above the view. PageUp showed them and scrolled the footer away: a taller tree scrolls as a whole. Fixed in [PR #96](https://github.com/martin-macak/claude-code-mod-tracking/pull/96) (issue #92): the pane reads the body height from `scroll.bodyRows` and draws the help view in a compact form (no gap, several keys to a line: two in that PR, three since [PR #97](https://github.com/martin-macak/claude-code-mod-tracking/pull/97)) when the full form, the gap and the footer need more rows than the body has. At 100x40 inline `Pane keys` is the first line and the footer `h: back` is the last, in one frame (the fixed run below). Docked at 120 columns the help view shows whole and is unchanged. (3) After `/track clear` with a row selected, no `>` gutter, ring or background is left. A new row draws unselected while the prompt has the keys. After ctrl+x Tab the ring and the `>` land on the first row (`autoFocus`). (4) `selected` outlived `/track clear`: the same URL tracked again came back with the `>` gutter and the background, and `autoFocus` stayed off. Fixed after this run: `/track clear` now sets `selected` to `null` and empties `expanded` (kit "pane: /track clear forgets the selection and the open rows; a row tracked again starts plain"). The fix was not run live again. | `verified-live` | Claude Code 2.1.303, tmux 100x40 and 120x40, web links, head 641b6f2. Inline: `╭──…──────✕─╮`, `│ >   ▸ example.com/alpha example.com/alpha`, footer `│ r: refresh  h: help  x: dismiss  1: high  2: normal  3: low  0: auto  Esc close`. Help, inline: the first line shown is `│   h  help`; docked, it starts with `Pane keys`. After `/track clear`: `│ No tracked items yet.`, and `an.py` finds no SGR 7 and no `48;5;68`. The same URL tracked again, no key pressed: `│ >   ▸ example.org/zeta` on `48;5;68`. `x` on the last row put the ring on the footer `h: help` (the ring sits on a position). **Help, inline, after [PR #96](https://github.com/martin-macak/claude-code-mod-tracking/pull/96)** (`verified-live`; Claude Code 2.1.304, tmux 100x40, model haiku, the mod loaded from the branch with `--plugin-dir`, a temporary config dir; frame of the pane): `│ Pane keys`, `│   r  refresh  h  help`, `│ Row keys (act on the selected row)`, `│   x  dismiss  1  high`, `│   2  normal   3  low`, `│   0  auto`, `│ Config file:`, `│ /var/folders/…/cc-tracker-config-…/config.json` (the path wrapped onto its own row), `│ r: refresh  h: back  x: dismiss  1: high  2: normal  3: low  0: auto  Esc close`. The compact view takes 9 rows in a body of 11. Docked at 120x40 the same run showed the full view: one key to a line, a gap, then the footer. That run had no `Version:` line. Two later changes add rows to the help view: issue #65 a `Version:` line, and issue #50 the row keys of the GitHub tracker (a group title and a line of keys). For the same path and a started mod, two keys to a line then took 12 rows with the footer in a body of 11, so `Pane keys` scrolled out of view again (kit test `tests/pane.test.tsx`, the live path; found in the rebase of PR #97). The compact form now puts three keys to a line: 10 rows for the view and 11 with the footer, which fills the body exactly. The full view takes 17 rows with the gap and the footer (kit tests `tests/help.test.ts`, `tests/pane.test.tsx`). **Help, inline, after [PR #97](https://github.com/martin-macak/claude-code-mod-tracking/pull/97)** (`verified-live`; Claude Code 2.1.304, tmux 100x40, model haiku, the mod loaded from the branch with `--plugin-dir`, a temporary config dir, two web links; frame of the pane, 11 rows between the borders): `│ Pane keys`, `│   r  refresh  h  help`, `│ Row keys (act on the selected row)`, `│   x  dismiss  1  high     2  normal`, `│   3  low      0  auto`, `│ github`, `│   c  resolve  f  files`, `│ Config file:`, `│ /var/folders/…/cc-tracker-config-…/config.json` (the path wrapped onto its own row), `│ Version: 0.1.0`, `│ r: refresh  h: back  x: dismiss  1: high  2: normal  3: low  0: auto  Esc close`. `Pane keys` is the first line and the footer the last, in one frame, with no scroll: a view that fills the body exactly shows whole. **Help, inline, with 3 config problems, after issue #105** (`verified-live`; Claude Code 2.1.306, tmux 100x40, model haiku, the mod loaded from the branch with `--plugin-dir`, a temporary config dir with a path of 86 cells and 3 problems; frame of the pane, 11 rows between the borders): `│ Pane keys (Tab, Shift+Tab, Up, Down move between rows)`, `│   r  refresh  h  help`, `│ Row keys (act on the selected row)`, `│   x  dismiss  1  high     2  normal   3  low      0  auto`, `│ github`, `│   c  resolve  f  files`, `│ Config file:`, `│ /var/folders/…/cc-tracker-config-…/config.json` (the path wrapped onto its own row), `│ Version: 0.1.0`, `│ 3 problems: /track help`, `│ r: refresh  h: back  x: dismiss  1: high  2: normal  3: low  0: auto  Tab ↑↓ move  Esc close`. Three keys to a line and the count line took 12 rows with the footer, so the compact form took the row keys on one line (five to a line, the most the body needs). `/track help` in the same session printed the three problems under `Problems`. Answers part of [Q29](open-questions.md#1-unknowns). The review of that PR found the state the frame did not cover: with a GitHub row selected, the help footer kept the dim `c: resolve  f: files` of that row and wrapped to a second row at 96 cells, so `Pane keys` scrolled out again. The help footer now has the core keys only, as with no row selected (kit test `tests/pane-session.test.ts`). |

### 3.4 Colors

| Fact | Grade | Evidence |
| --- | --- | --- |
| Accepted and painted: `#rrggbb`, `#rgb`, `rgb(r,g,b)`, `ansi256(n)`, the basic names (`red green blue yellow cyan magenta white black gray redBright`) and all theme keys. Names and theme keys resolve to the theme palette, not to SGR 30-37. | `verified-live` | Truecolor session: `red` gave `38;2;229;72;77`, `#ff0000` gave `38;2;255;0;0`, `ansi256(208)` gave `38;5;208`. |
| Accepted but drawn with no color, and no error: `orange`, `bogus`, `Red`, `brightRed`, `hsl(...)`, `ansi256(300)`. | `verified-live` | SGR `39` / `49`. |
| **A string with a colon (`ansi:red`) makes the engine refuse the whole Pane tree.** The pane draws blank. | `verified-live` | Transcript line: `hooks: ui.render (Pane) refused: Text prop "color" must be a color (a theme key, a name, or hex); the engine drew its own`. |
| Under tmux (`TMUX` set) Claude Code quantizes every color to the 256-color palette, even with `terminal-features RGB` and `COLORTERM=truecolor`. Run with `env -u TMUX` to get `38;2;r;g;b`. `e2e/` runs `claude` inside tmux, so ANSI assertions there see `38;5;N`. | `verified-live` | `#ff0000` gave `38;5;196` in tmux and `38;2;255;0;0` outside. |
| `Text` gains `weight`, `size`, `mono`, `tabular`, `dir` in 2.1.302. `bold` is deprecated and read as `semibold`. The terminal draws `semibold` and `bold` as bold. It ignores `size`, `mono` and `tabular`. For `dir` the d.ts says only that a terminal that reorders text itself draws the `Text` as without `dir`. Claude Code's terminal is not named (`inference`: no effect). | `types-only` | [d.ts:13164-13220](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L13164-L13220), [d.ts:13186](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L13186), [d.ts:13205](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L13205) |

### 3.5 Cell width

| Fact | Grade | Evidence |
| --- | --- | --- |
| No measure API exists in the d.ts. The only hit for `measure` is `session.measure`. | `types-only` | A grep of the snapshot for `stringWidth`, `wcwidth` and `measure`. |
| The renderer measures with `Bun.stringWidth(s, { ambiguousIsNarrow: true })` and writes cells with `Bun.ant.CellSegmenter`. East Asian Wide and Fullwidth are 2. Ambiguous is 1. Emoji clusters (RGI, VS16, ZWJ, flag, keycap, skin tone) are 2. Controls, joiners and combining marks are 0. Any other cluster sums its code points. A tab expands to 8-column stops. | `verified-live` | 16 live rows on a `Box width=8` with `wrap="truncate-end"`: `★▲▽●✓✗a…` (Ambiguous is 1), `日本語…` (wide is 2), `😀😀😀…`, `a       b` (a tab took 9 cells). The binary embeds Bun 1.4.4. |
| A hooks module has no `Bun`, `process` or `Buffer`. `Intl.Segmenter` and the Unicode property escapes (including `/\p{RGI_Emoji}/v`) exist. | `verified-kit` | Test child printed `typeof Bun` as `undefined`. |
| A 65-line `cellWidth` (`Intl.Segmenter`, three Unicode-property regexes, a 126-range Wide table) matched the live renderer on 24 of 24 strings, run inside a real `ui.render` hook. | `verified-live` | Probe: `Box width = cellWidth(text) + 3` for 24 strings. Every row showed the whole text, three spaces, then a pipe character. |
| **The helper's `/v` regexes need `target: es2024`.** At `target: es2023`, `tsc` 7.0.2 stops with `TS1501` on the two `/…/v` literals (`ZERO` and `RGI_EMOJI`). The plugin's own `tsconfig.json` has `target: es2023` today, so it must move to `es2024` when `cellWidth` lands (`lib` can stay `es2023`). The alternative keeps `es2023`: build the regexes with `new RegExp(src, 'v')`, which `tsc` accepts at `es2023`. Whether the engine's loader accepts the constructor form at run time was not run (`inference`: it is the same flag). | `verified-kit` | Spike [`width-spike`](../claude-code-mods/sources/spikes-2026-10-17/width-spike/), `npx -y -p typescript@7.0.2 tsc -p`, `module: esnext`, `moduleResolution: bundler`, `strict`, `lib: ["es2023"]`. `target: es2023`: `cell-width.ts(43,137): error TS1501: This regular expression flag is only available when targeting 'es2024' or later.` and `cell-width.ts(44,36): error TS1501: …`, exit 1. `target: es2024`: no output, exit 0. A file with `new RegExp('[\\p{Default_Ignorable_Code_Point}\\p{Control}]', 'v')` at `es2023`: no output, exit 0. Ties to [D13](open-questions.md#2-decisions-for-the-design-spec). |
| The helper differs from `Bun.stringWidth` on 5,519 of 1,112,064 single code points (4,861 are unassigned code points: Unicode version drift). On 100,000 realistic mixed strings it differed 0 times. It missed 2 of 31 curated sequences (decomposed Hangul L+V, L+V+T). On 20,000 malformed strings it differed 141 times. | `verified-kit` | Compared against npm `bun@1.4.3`, not the embedded 1.4.4. |
| Terminals disagree about emoji clusters. A ZWJ farmer emoji is 2, 4, 5 or 6 cells depending on the terminal. | `public-docs` | Mitchell Hashimoto, "Grapheme Clusters and Terminal Emulators". |

**Three width rules.** Width code in the wild follows one of three rules. They agree on ASCII and plain CJK. They differ on emoji clusters and on marks that join. All three rows are `public-docs`. The library names come from the research for this slug. A check with `gh api` on 2026-10-17 (`observed`) found `unicode-segmentation` and `unicode-width` in ratatui's `Cargo.toml`, `Intl.Segmenter` and `get-east-asian-width` in `string-width`'s `index.js`, `cell_len` in Rich's `cells.py`, and the `StringWidthWc` doc comment in `charmbracelet/x/ansi`. None of the three was run here except the renderer's own rule, which is rule 2 (`verified-live`, above).

| # | Rule | How it measures | Used by | ZWJ family emoji |
| --- | --- | --- | --- | --- |
| 1 | Per code point (`wcwidth`) | Sum of per-code-point widths. Wide and Fullwidth are 2. Combining marks and ZWJ are 0. No clusters. | Rich `cell_len`. Go `ansi.StringWidthWc` in `charmbracelet/x/ansi` ("treats the text as a sequence of wide characters and runes"). | 6 to 8, because each pictograph counts 2 |
| 2 | Cluster, then East Asian Width | Split into [UAX #29](https://www.unicode.org/reports/tr29/) grapheme clusters. Take the width from [UAX #11](https://www.unicode.org/reports/tr11/) (Wide and Fullwidth 2, Ambiguous narrow). An emoji cluster is 2. | `string-width`, Ink `widest-line`, `Bun.stringWidth`, ratatui (`unicode-segmentation` plus `unicode-width`) | 2 |
| 3 | The terminal clusters | The terminal groups clusters itself when DEC private mode 2027 is on (`CSI ? 2027 h`). An application asks with `DECRQM`. | Terminals that implement mode 2027, per the [Contour terminal Unicode core spec](https://github.com/contour-terminal/terminal-unicode-core) | 2, as the terminal decides |

- UAX #11 section 5 says an Ambiguous character "should be treated as narrow" when context cannot be established. The renderer's `ambiguousIsNarrow: true` follows that.
- **Why the renderer follows rule 2.** Its Bun measures per cluster (`verified-live`). A mod that measures by rule 1 (or by `String.length`) misaligns every row that holds an emoji cluster.
- **What it means for a mod.** Match rule 2 in `cellWidth`. Do not trust the terminal to follow it: a terminal that follows rule 1 or has mode 2027 off draws an emoji cluster in another width than the renderer counted. The mod cannot detect that. Keep emoji out of fixed-width cells.
- Rule 2 is not one implementation. Bun differs from `string-width@8` on Indic clusters, Thai SARA AM and halfwidth voiced marks. The live renderer summed the code points of those clusters, so the "first visible scalar" shortcut came out one cell short on 3 of 24 rows.

### 3.6 Size limits of a pane tree

The d.ts names the bounds (20,000 nodes, 32 levels, 100,000 characters serialized) in the `ClientElements` doc as "every tree's bounds" ([d.ts:1439-1440](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L1439-L1440)). The wording is general. The kit confirms 20,000 nodes and 32 levels for an ordinary `Pane` tree (`verified-kit`). It shows no serialized-size bound there: a 685 KB tree drew. The 100,000 that bites a `Pane` is the drawn-text budget. Why the serialized bound does not show for a `Pane` is `inference`.

| Limit | Behavior | Grade |
| --- | --- | --- |
| Nodes plus string children: 20,000 | Over it, the tree is refused. The engine draws its own. Message: `ui.render (Pane) refused: more than 20000 nodes; the engine drew its own`. | `verified-kit` |
| Depth: 32 | Over it: `deeper than 32`. | `verified-kit` |
| Text: the first 100,000 characters count | **Past it the tree is not refused.** Later rows draw empty (`… N more characters, not drawn`) and their Buttons and Links vanish. The kit and the mod see no error. The engine logs `<plugin>: ui.render (<Component>): <n> characters of text are drawn up to the first <m>`: the debug log always, the transcript while a plugin folder hot-reloads ([reference.md 302:155](../claude-code-mods/sources/claude-code-2.1.302/reference.md#L155)). | `verified-kit` (rows lose Buttons), `types-only` (the log line) |

What counts toward the 100,000: a `Box` key, a `Button` label, a `Link` href plus label, and visible text. A `Button` key and a `Text` key do not count.

Measured on the kit, with 17-character titles:

| Tree shape | Result |
| --- | --- |
| 500 flat rows with header and detail row | 11,020 of 20,000 counted values. Passes. 685 KB of JSON. |
| Rows per tree before the node refusal | flat with detail 908, flat without 1,051, real `/track` shape with detail 666, without 740 |
| First row that loses its Buttons, real row shape, short Box keys | row 686 without detail rows, row 522 with them |
| First row that loses its Buttons, real Box key format `cell-<name>-gh:github.com/acme/web#N` | row 248 without detail rows, row 223 with them |

A real `/track` row costs 21 nodes and 6 strings. A detail row adds 3. The current pane would lose Buttons past roughly 250 items.

**Live results** (`verified-live`, tmux 120 by 40 docked, spike [`tbl`](../claude-code-mods/sources/spikes-2026-10-17/tbl/), answers [Q2](open-questions.md#1-unknowns)). A row has five cells, one focus `Button` and short or no `Box` keys. That shape costs 11 nodes and 4 string children per row, 15.03 counted per row.

| Question | Answer | Evidence |
| --- | --- | --- |
| Do the limits apply to 600 rows with 40 to 80 character titles? | Neither is reached. 9,029 of 20,000 counted and 43,254 of 100,000 characters (about 72 per row). The pane draws whole: the ring reaches `r599` and the footer `Button`s exist. The engine logs nothing. | Kit: `PROBE tbl-r600-t0 DRAWN nodes=6623 strings=2406 nodes+strings=9029 chars=43254 buttons=603 rowButtons=600 lastRowButton=r599`. Live header of `/tbl 600 0 sticky`: `rows=600 tl=0 nodes=6613 str=2403 chars=43152 btn=600` (the kit counts 10 more nodes for its wrapper). Shift+Tab walks the close mark, `fd`, `fy`, `fx`, `r599`. |
| Does the 20,000-node refusal behave live as in the kit? | Yes. The count is nodes plus string children. 1300 rows (19,516 counted) draw. 1400 rows (21,016 counted) are refused: the pane body is blank apart from the engine's close mark, and Tab reaches only that mark. The mod's render hook completes without error and cannot see the refusal. The engine reports it in the transcript and the debug log, twice (the open render and the Tab render). | Kit: `tbl-r1300-t0 DRAWN … nodes+strings=19529`, `tbl-r1400-t0 REFUSED … ui.render (Pane) refused: more than 20000 nodes; the engine drew its own`. Live: `/tbl 1400 0 sticky` header `nodes=15413 str=5603`, `R … build=54ms`; `screen-1400.txt` has an empty body with only ✕. Transcript: `⏺ hooks: ui.render (Pane) refused: more than 20000 nodes; the engine drew its own`. Debug log: `[WARN] ui.render (Pane): a hook returned a tree that does not validate (more than 20000 nodes); drawing the engine's own`. [reference.md 302:155](../claude-code-mods/sources/claude-code-2.1.302/reference.md#L155). |
| Do rows past the 100,000-character cut lose their `Button`s, as in the kit? | Yes. 600 rows with 200-character titles: `Button`s survive to `r469` (kit `r469`). 600 rows with natural titles and the legacy long `Box` keys (`row-gh:github.com/acme/web#N`, `cell-<name>-…`): to `r354` (kit `r354`). Rows past the cut get no `Button`s and cannot be reached by keyboard. The footer `Button`s `fx`, `fy` and `fd`, and with them the hotkeys, disappear too, because the footer sits after the rows. The engine ends the drawing at the cut with `… N more characters, not drawn`. | `t200`: kit `lastRowButton=r469 CUT`; live Shift+Tab from the close mark gave `F el=-`, then `F el=r469`, and no `fd`, `fy` or `fx` stop. End shows `#469 for tenant`, then `… 189 more characters, not drawn`. Long keys: kit `chars=25527 buttons=355 lastRowButton=r354 CUT`; live End shows `#354`, then `… 58 more characters, not drawn`. The visible text was only 43k, so `Box` keys count. |
| What does the text count include, and what does the engine log? | `Text` strings, `Button` labels and `Box` keys. 127,920 = 127,201 body text + 600 `Button` labels (`>`) + 119 header and footer text. The spike's own `chars=` header counted body `Text` only and understated the total. The log line is once per load and component. | Debug log: `[WARN] hooks: ui.render (Pane): 127920 characters of text are drawn up to the first 100000`, with a `$.ui.log` copy. Transcript: `⏺ hooks: ui.render (Pane): 127920 characters of text are drawn up to the first 100000`. The prefix is `hooks:`, not the plugin name. After the second overflow (the long-key run) the debug log still held one cut `[WARN]`, from the `t200` run. |

So a mod cannot rely on the engine's log line, even in development: it fires once. A cap of about 300 rows in total is far inside both budgets (4,529 counted and 21,635 characters at 300 rows). The budgets bite only above about 1,330 rows (nodes) or 1,390 rows (text) with this row shape. They bite earlier with long titles, long `Box` keys, several `Button`s per row or open detail rows. The row cap and the guard must still exist as a safety net.

## 4. Prior art

All entries are `public-docs` read on 2026-10-17, not run. The sources are the Textual, ratatui, `tui-treelistview`, Bubbles, Ink, `ink-table` and AG Grid documentation.

| Component | Column | Cell style | Expansion | Cursor | Keys |
| --- | --- | --- | --- | --- | --- |
| Textual `DataTable` | label, width (`None` fits content, grow-only), key | Rich `Text` per cell, CSS component classes | none (a separate `Tree` widget has `expand`, `collapse`, `toggle_node`) | `cursor_type` cell, row, column, none | class-level `BINDINGS` of `Binding(key, action, description, show, key_display, priority, id)`, `check_action` (True, False, None = shown, hidden, dimmed), `set_keymap` by `id`, a Footer generated from active bindings |
| ratatui `Table` | `Constraint` enum with a solver (`Min`, `Max`, `Length`, `Percentage`, `Ratio`, `Fill`) | `Style` on table, row, cell; row, column and cell highlight styles | none | app-owned `TableState` | none; the app matches `KeyCode` |
| `tui-treelistview` 0.2.2 | `ColumnDef::tree` (exactly one tree column) and `ColumnDef::data`; `ColumnWidth{min, ideal, max}`, `fixed`, `flexible` | per-column renderer | `TreeModel` trait and one flat `TreeProjection` shared by navigation and rendering | selection in the projection | `TreeAction`, `TreeIntent`, optional `keymap` feature |
| Bubbles `table` | `Column{Title, Width}`; `Width <= 0` hides; cut with `…` | `Styles{Header, Cell, Selected}` | none | `cursor` | `KeyMap` of `key.Binding(WithKeys, WithHelp, WithDisabled)`; `help.KeyMap` gives `ShortHelp` and `FullHelp` |
| Ink and `ink-table` | `max(header, cells) + 2*padding`, measured with `.length` (wrong for wide characters) | replaceable `header`, `cell`, `skeleton` components | none | none | `useInput`, `useFocus`, `useFocusManager`; no registry |
| AG Grid | `ColDef` with `width`, `minWidth`, `maxWidth`, `flex`; `defaultColDef`; a separate `autoGroupColumnDef` for the tree column | `cellStyle` as object or function | `getDataPath`, `groupDefaultExpanded`, `isGroupOpenByDefault`, `setRowNodeExpanded` | `rowSelection` | callbacks (`suppressKeyboardEvent`, `navigateToNextCell`); no registry |

What to copy:

- A column is a small declarative record: id, header, width spec, optional cell formatter. Style, cursor style and key bindings stay separate from it.
- Exactly one tree column, with min, ideal and max width (`tui-treelistview`).
- Key bindings as data with tri-state enablement and an id for override (Textual), and a help footer generated from the active set (Bubbles).
- `defaultColDef` for shared column defaults, and `cellStyle` as an object or a function (AG Grid).
- Expansion and cursor live in app-owned state, apart from the model (ratatui, `tui-treelistview`).

What the engine prunes: a hotkey is one character, no arrow keys reach a pane, and a `Button` cannot hold `Box` cells. All grades in this table are `public-docs` for the library facts and `inference` for the "copy" choices.

## 5. Options and trade-offs

### 5.1 Row navigation (U5)

| Option | How it works | For | Against |
| --- | --- | --- | --- |
| **N1: one focus Button per row** | Each row has one small Button, the row handle. Tab and Shift+Tab walk the rows. Enter presses the handle. | Built on verified behavior (`verified-live`). Visible in the kit as `findAll Button`. The engine scrolls to keep the ring in view. | Arrow keys do not walk rows on a tall table (they scroll). The behavior flips when rows are added and the tree fits. Each extra Button per row adds a Tab stop. A `display:'none'` Button is a dead stop. |
| **N2: hotkey cursor** | Footer or hidden Buttons with hotkeys (for example `j` and `k`) move a `selected` atom. Row actions are other hotkeys that act on `selected`. | No dependence on the ring. Works on a tall table. All parts are verified: a hotkey fires wherever its Button is (`verified-live`), no letter is reserved (`verified-live`), `onPress` may write state ([d.ts:3488-3489](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3488-L3489)). | The combination was not run (`inference`). Two cursors exist (ring and `selected`) unless the handler also moves the ring. The hotkey letters come from a pool of 36. Hints must be visible. |
| **N2b: hotkeys that move the ring** | As N2, but `j` and `k` call `$.ui.focus({requestId, key})` to move the ring to the next or previous row handle. The `ui.focus` hook then writes `selected`. | One cursor: the ring. Selection follows it. | `$.ui.focus` works only while the pane holds the keys, and only for a Button, Input or Select the plugin drew ([d.ts:2576-2591](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L2576-L2591), [d.ts:14515-14532](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L14515-L14532)). The mod already uses it in a best-effort way (`H/register.tsx:1278`). Not run with a taller-than-pane tree (`inference`). |
| **N3: `Client` region with `onKey`** | A `Client` surface module reads every key and posts it to the hooks module. | Any key, including arrows. | Needs a mouse click for focus (`verified-live`). Esc never arrives. No `$` inside. Terminal and desktop only. Not a keyboard-first design. |

**Decided (D2, 2026-10-17):** N1, a Tab ring with one focus `Button` per row. A `ui.focus` hook writes a `selected` atom and the highlight follows it. Enter toggles expand. N2b (`j` and `k`) is not part of the decision. The live run shows that N1 works as drawn ([§3.3](#33-selection-state)).

**Recommendation (inference), before the decision:** N1 as the base, with N2b as an optional addition. The ring is the cursor. A `ui.focus` hook copies the ring position to `selected` after `next(e)`. Do not promise Up and Down row navigation. Reject N3 for keyboard use. Offer it, if ever, as a mouse-driven extra.

Also: set `autoFocus` on the first or the selected row handle, so the first Tab does not land on a dead stop. Live, `autoFocus` on the first row `Button` gives the ring and the selection at open, so the footer hotkeys have a target at once. The first Tab then goes to the second row ([§3.2](#32-keyboard)). The selection write comes from the `origin: plugin` focus event, so the same `ui.focus` hook handles it.

### 5.1a Click, focus and arrows (issue #108)

[Issue #108](https://github.com/martin-macak/claude-code-mod-tracking/issues/108) reports that Up, Down and a click do not select a row in some states. The owner decision of 2026-10-20 fixed four things and asked for two spikes. Spec decision D2 stays as it is.

**Shipped.**

- A press on a row (a click on its `▸`, or Enter) selects the row and asks for the ring on it, as `x` and the digits do. Live, a click on the `▸` of a row moved the highlight and the ring to that row and opened it (`verified-live`, [§3.2](#32-keyboard)).
- The highlight follows `Pane.isFocused`. With no keys the row has no background and a dim `>`, and one dim line above the tree says that the keys go to the prompt and that ctrl+x Tab gives them back (`verified-live`, [§3.2](#32-keyboard)). The help view gets no such line: it fills the body of a short inline pane to the row.
- The footer ends with `Tab ↑↓ move` before `Esc close`, where the hint adds no row. The core footer is 79 cells and 92 with the hint, so with the core keys alone the hint shows in a body of 92 cells or more and stays one line in a body of 95 or 96 cells. In a body of 79 to 91 cells it would cost a row, so it is left out, and the compact help view is not forced. The keys of a tracker (for example `o: open`) widen the footer and raise these widths, so the rule reads the keys that are drawn, not a fixed number. The first title of the help view names Tab, Shift+Tab, Up and Down at every width. It adds no row, so the compact help view still fits the 11-row body at 100x40 (`verified-live`: `Pane keys (...)` first, the footer last, one frame).
- `autoFocus` goes on the handle of the selected row when a drawn row is selected, else on the first row ([§3.2](#32-keyboard)).

**Spike, option 3: one `Button` per row.** Not shipped.

| Question | Answer | Grade | Evidence |
| --- | --- | --- | --- |
| Does the engine take a `Button` whose children are `Text`? | Yes, on the terminal and the desktop surface. | `verified-kit` | A scratch copy of the mod drew each row as `Button key=r<n>` with one padded `Text` per cell. `ui.mount` on both surfaces gave one such `Button` per row, with the row text as its shown text. |
| Can a cell keep its `Link`? | No. The hook throws and the pane falls back to its one-line notice. | `verified-kit` | `JSX element <Button key="r0"> holds strings and Text, not <Link>`, also with the `Link` inside a `Text`. A URL cell would turn into plain text. |
| Does a click anywhere on the row press it? | Yes. A click on the URL cell, on the gutter and on the blank cells at the end of the row pressed the row. | `verified-live` | Claude Code 2.1.304, tmux 120x37, three links. Click on the URL cell of the second row: `▾`, the `link:` detail line and the highlight. Click on the gutter of the first row: the same. |
| How does the row look? | The ring inverts the whole row, so it is the highlight while the pane has the keys. A first draft padded one cell too many: the row wrapped and every row took two lines. Pad the last cell to its width and no more. | `verified-live` | In `tmux capture-pane -e` the text with SGR 7 on was the whole line `>   ▾ two.example/b   two.example/b`. |
| What does it cost? | Cell `Link`s go. Per-cell `Box` colors become `Text` colors. Spec rule G19 (every cell is `Box width` plus `Text`) changes. Select and toggle stay tied: a click on a row always toggles it too. | `inference` | The rows above. |

**Recommendation (inference):** do not ship option 3 now. Option 2 already makes a click on the arrow select. Option 3 is the only way a click on the text selects, and it costs the cell links and the G19 cell rule. Ship it only if the owner wants a click on the text to select.

**Spike, option 5: a `ui.scroll` hook that turns an arrow into a row move.** Not shipped. It would reverse D2 and the spec non-goal "arrow-key row navigation".

| Question | Answer | Grade | Evidence |
| --- | --- | --- | --- |
| Does the hook see an arrow, and can it tell it from a wheel tick and a page key? | Yes. An arrow has `origin.kind 'person'` and no `pointer`. A wheel tick has a `pointer`. A page key has `by` equal to `±bodyRows`. Keys that arrive together are summed in `by`. | `verified-live` | Debug log of a 44-row tree in a 31-row body: `by=1`, then `by=2` for three quick Downs, `by=-31 body=31` for PageUp. A test for `by` of 1 or -1 missed the summed press. A test for a `by` smaller than `bodyRows` in size caught every arrow. |
| Can the hook move the ring? | Yes. It answers `{}` with no `next` and calls `$.ui.focus({ requestId, key })` with the handle of the next row. The `ui.focus` hook then writes `selected`. | `verified-live` | Same run, 40 links. 34 Down presses from the top put the highlight and the ring on `w35.example/p35`. |
| Does the window follow a ring that `$.ui.focus` moved? | Yes, as it does for Tab. | `verified-live` | After those 34 presses the view held `w5` to `w35` and the ring was on its last row, with no scroll call from the hook. |
| What happens at the ends? | The hook clamps. At the last row Down leaves the ring where it is. The footer `Button`s are out of reach of the arrows: Tab reaches them. PageUp and PageDown still scroll the window and leave the ring. | `verified-live` | Eight more Downs left `w40.example/p40` selected. PageUp showed the top of the list with `w40` selected and out of view. |
| What does it cost? | One engine call, a state write and a redraw per press. A heuristic for the arrow (a `by` smaller than `bodyRows` in size) that fails when `bodyRows` is tiny. It reverses D2. | `inference` | The rows above. |

**Recommendation (inference):** the owner decides. The windowing of [issue #109](https://github.com/martin-macak/claude-code-mod-tracking/issues/109) makes the tree fit the body, so the engine's own arrows walk the ring, and then option 5 has nothing to do. Ship option 5 only if that windowing does not land. The spike also answers the part of [Q21](open-questions.md#1-unknowns) about `$.ui.focus` on a taller-than-pane tree: it moved the ring and the window followed. The `j` and `k` hotkeys were not run.

### 5.1b A click gives the pane the keys (issues #115, #129 and #130)

[Issue #115](https://github.com/martin-macak/claude-code-mod-tracking/issues/115) found that a click on the `▸` of a row, with the keys in the prompt, selected the row and left the keys in the prompt. Up and Down then walked the prompt history. The cause and the fix, with grades:

| Question | Answer | Grade | Evidence |
| --- | --- | --- | --- |
| Why does a press leave the keys in the prompt? | A press on a `Button` runs its `onPress` and moves no focus. The mod then asked for the ring with `$.ui.focus`, and the engine refuses that for a pane that has no keys. | `verified-live` | Claude Code 2.1.304, tmux 120x40, a temporary toast on the answer of the port after a click on `two.example` with the prompt holding the keys: `{"deny":"that site does not hold th…"}` (the toast cut the text). [d.ts:2576-2591](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L2576-L2591) says the same: "A site not holding the keys ... is `{ deny }`". |
| What gives a pane the keys? | `$.ui.open` with `focus: true` on the pane that is open. It is a request: the surface grants it only while the prompt has the keys over an empty composer. | `verified-live`, `types-only` | [d.ts:7566-7573](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L7566-L7573). Live: the call answered `isPlaced: true`, the hint `Keys go to the prompt.` went and the ring was in the pane. 8 clicks in a row on varied rows (open and closed, selected and not) each ended with the clicked row selected, the ring on its arrow, no hint, and Down moved the selection to the next row with no `History` in the prompt box. |
| What does the engine do when the composer holds text? | It refuses the keys. The pane stays without them, the selection is written, the hint stays, the text stays. `ui.focus` is refused too. No error shows. | `verified-live` | `abc` in the prompt box, a click on the arrow of `three.example`: the row was selected and toggled, `Keys go to the prompt.` stayed, `❯ abc` stayed, no ring. Up then showed `History 10/10` (the keys are still in the prompt). |
| Does the press need to know that the pane has no keys? | Yes, or it would call `ui.open` on every press. The pane reads `Pane.isFocused` in each drawing, and a focus change draws it again (section 3.2), so the drawing of the pressed Button is current. Only a drawing that says `false` makes a press ask. A session can be drawn on several surfaces, each with its own value, so the Buttons of a drawing carry that drawing's value (`inference`, from a review of the PR) and the last drawing of another surface does not decide. | `verified-live` | With the keys in the pane, a click raised no `ui.open` (the debug log held the same number of `ui.open` lines before and after the click) and moved the selection and the ring. |
| Is the order of the writes important? | The order of the press is not enough. Write `selected`, ask for the keys, ask for the ring: still the old row can end up selected. When the pane gets the keys, the engine puts the ring on the `autoFocus` handle of the frame it holds. That frame can be older than the press: the ring lands on the old row and the `ui.focus` hook of that landing (origin `plugin`) writes that row into `selected`. The hook can run before, during or after the ring request of the press. The engine skips the plugin's own hook for that request as a re-entry (`skipped: re-entry`) while the first hook still runs. A write of `selected` after the request (the first fix) covers the first two orders and not the third. So the hook takes the origin: `PaneSession.focused` ignores a landing of origin `plugin` that no refocus asked for while a drawn row is selected, and the person's Tab, arrows and click (origin `person`) still select. | `verified-live` | (1) Debug log of a first try with no write after the request (`one` is the old row, `two` the pressed row): `toggle two lastFocused=false`, `wrote selected=two, opening`, `open -> true`, `draw focused=false selected=one` (stale), `hook ui.focus in el=r0 origin plugin`, `focused() el=r0 -> id=one`, `draw focused=true selected=two`, `hook ui.focus skipped: re-entry (the plugin's own code raised it)`, `port ui.focus r1 -> {}`, `draw focused=true selected=one`. The screen: `>` on `one.example/a`, ring on `two.example/b`. (2) The third order, with the write after the request (Claude Code 2.1.305, tmux 120x40, the e2e harness with one click per step and the keys in the prompt before each): 1 of 112 clicks ended with the ring on the clicked row and `>` on the old row. The click on `three.example` changed its arrow from `▾` to `▸` in 185 ms, the hint went, and `>` stayed on `two.example/b`, the row the Down before it had selected, for the 20 s of the check. The other 111 clicks ended with the clicked row selected, and every arrow changed within 233 ms (median 108 ms). The click helper of the harness, which clicks again when the row is not selected, failed 2 of 8 sessions of 20 clicks on the same event. (3) With the origin rule: 6 sessions of 60 clicks, 360 clicks on varied rows, and 6 clicks in the empty prompt box. No click left the old row selected, every arrow changed within 210 ms (median 95 ms), and each Down moved the selection to the next row. |

**Shipped (#115):** `Refocus.to(p, m, id, press)` in `hooks/pane-refocus.ts`. `PaneSession` builds a `Press` for each Button press from the drawing of the pressed Button: `keys` is true when that drawing said `isFocused` is `false`. The press runs detached, so `press.still()` tells the ask whether the pane closed since the press began: `ui.open` would open a pane the person just closed (`inference`, from a review of the PR), so a press that began before a closing asks for no keys. The `ui.focus` hook passes `e.origin.kind` to `PaneSession.focused(p, element, origin)`, which holds the rule of the table above. The kit pins the order, the refusal, the failed call, the closing, the three orders of the landing (finished, started, later than the return of the request) and the origin rule (`tests/pane-session.test.ts`), and the wiring of the port (`tests/pane.test.tsx`). The kit cannot give a pane the keys, so "Down then moves the selection" is pinned by the e2e scenarios in `e2e/features/pane.feature` and by the live run above.

**Shipped (#129):** the footer keys (`r`, `h`, `x`, the digits and the keys of a tracker) and the `N more` row ask for the keys too. They are Buttons, so a click on them moves no focus either. Grade `verified-live`: the e2e scenarios `A click on a footer key gives the pane the keys when they are in the prompt` (`r`, then `x`), `A click on an N more row gives the pane the keys when they are in the prompt` and `A click on r: refresh with the keys in the prompt gives the pane the keys and still refreshes` (`e2e/features/pane.feature`, Claude Code 2.1.306, tmux 120x40, SGR mouse bytes). On `main` all three fail at the click step: the key ran (an `N more` click showed the two rows), and `Keys go to the prompt.` stayed on the screen. With the change, two runs of the three scenarios passed (55 steps each). `Refocus.askKeys(p, press)` is public. `PaneSession` asks before the work of a footer press, not after: `x` and the digits end in a ring request, which the engine refuses while the prompt has the keys, and `r` may run long. A press asks once: `pressed` hands `Refocus.to` a press that asks no more. A dim footer key does no work, but it is a Button too: a click on it calls `actions.keys`, and the press asks for the keys alone. Every call of `Refocus` takes a `Press`, so a caller written later cannot leave the closing check out. `N more` asks after it writes `shown`, as a row press asks after its writes. With a row selected, `Refocus.to` asks for the keys and then for the ring on that row (issue #109 puts the ring back onto the selected row), so the press asks once. A click that comes at once after the chord that took the keys away can be lost (`verified-live`: a trace of the draws and the handler calls showed no call of the handler in the 10 s that followed). So the step of the e2e harness waits 300 ms before it clicks, as the live click runs of #115 did, and clicks again only while the hint still shows.

**Shipped (#130):** a press that began before `PaneSession.closed()` does nothing after it. The `Press` is taken when the person presses, before the press waits in the work chain. `Refocus.to` checks it at the start, in the write of `selected` (an atom `update` reads, applies its function and writes, and a retry applies the function again to the value that the closing wrote, so the function returns the old value after a closing: `unlessClosed`) and before the ring request, which would set `pending` after `closed()` cleared it. The toggle write of `expanded` and the `h` write of `help` use `unlessClosed` too. The refocus of a scroll (`PaneSession.scrolled`, the wheel and the page keys of issue #109) takes a press as well: it reads `selected` first, and the pane may close in that read. A key that waited in the chain through a closing and a reopening returns at once, because it reads `selected` and by then that is a row of the next pane. The kit pins each check (`tests/pane-session.test.ts`): a call held open, the pane closed, the call let go. A call that ran before the closing cannot be taken back (`ui.open`, `dismiss`, `setPriority`).

### 5.2 Where the selection lives

| Option | Effect |
| --- | --- |
| A `selected` atom written by the `ui.focus` hook after `next(e)` | The highlight is reactive and survives a re-render (`verified-kit`). A hot reload keeps it, because `$.state` survives a reload (`types-only`, [d.ts:3460-3461](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L3460-L3461)). |
| A module variable (today's `focusedRow`) | No redraw on change, so no highlight. Lost on reload. |
| Written only from `onPress` | The selection changes on activation, not on Tab. |

**Recommendation (inference):** the atom. It replaces `focusedRow` and `focusRows` (`H/register.tsx:169, :171`). Make the write **sticky**: write `selected` only for a ui.focus event whose `element` is a row key. A footer or close-mark stop leaves it alone ([§3.3](#33-selection-state), `verified-live`). The row-key scheme (short, matchable) then doubles as the selection filter. Stable row-handle keys (`row-<id>`) are possible only if the ring survives a re-sort; today's `mark:<i>:<level>:<id>` keys embed position because the ring must land on a new key after a re-sort (`H/ui/view.ts:510-516`). The ring survives the redraw that a `selected` write causes (`verified-live`). A re-sort is not run ([Q1](open-questions.md#1-unknowns)).

### 5.3 Key registry (U6)

The engine bounds "any key". A pane can bind only one lowercase letter or digit per Button, plus an existing engine action through `Button.action`. Enter, Space, the arrows, punctuation and `ctrl` chords are not available. Typing one of the punctuation keys leaves the pane. The issue's example `x` fits.

Registry rules that follow from the evidence:

1. A key is exactly one of `a-z` or `0-9`. Fold uppercase to lowercase.
2. A key is unique per pane. The engine lets the later Button win without a warning (`verified-live`), so the registry must throw at build time.
3. No letter is reserved (`verified-live`). The registry needs no deny list.
4. A row-scoped action acts on the selected row through one footer Button. A hotkey is unique per pane, so it cannot sit on every row. The action reads the selected row from state **at press time**, not from a closure captured at draw (`verified-live`: a hotkey press does not move the ring). The footer is not sticky in a pane, so a status line there is hidden while the window scrolls. Mirror feedback elsewhere.
5. Each action has a state: enabled, disabled or hidden (Textual `check_action`, Bubbles `WithDisabled`).
6. A visible help row is derived from the active actions. Prefer it to a `display:'none'` Box, whose Button is still a dead Tab stop.
7. An action takes ports or callbacks, never `$`. `$` may go only to same-file `function` declarations ([tracker-plugins §2](tracker-plugins.md#2-what-the-engine-allows)).

**Decided (D1, 2026-10-17):** one pane-wide registry of `a-z` and `0-9`. A tracker registers a key and an action on the selected row. A duplicate fails at build. The keys show in a footer, one footer `Button` per key.

### 5.4 Expansion (U1)

- **Every row expandable.** A leaf expands into a detail line (long title, extra fields). The row handle Button toggles it on Enter, so one Button serves navigation and expansion. State: the `ui.folded` atom of row ids, inverted to `expanded` so that the default is collapsed.
- **Only rows with children or detail expand.** Cheaper in nodes. It does not meet U1 literally.

Expansion costs nodes. A detail row adds 3 counted values. The default must be collapsed or the budget in [§3.6](#36-size-limits-of-a-pane-tree) breaks first.

**Recommendation (inference):** every row expandable, collapsed by default, with the toggle on the row handle. Enter toggles an `expanded` atom and does not disturb the ring (`verified-live`, [§3.3](#33-selection-state)). Leaf detail rows can be plain `Text` with no `Button`, and Tab skips them. The budget guard must count open rows (about 5 nodes and 70 characters per two one-line details). Decided (D2): every row is expandable, and a leaf expands into tracker-defined detail rows.

### 5.5 Columns, header and sizing (U2, U3)

A column spec: `{ id, header, width, align, role?, priority, cell(row) }`. Width is one of `fixed(n)`, `content(min, max)` or `flex(min)`. Exactly one column has `role: 'tree'` and carries the indent and the fold glyph.

A solver, in order (`inference`, assembled from verified parts):

1. Flatten the visible rows once.
2. Per column, take `max(cellWidth(header), cellWidth(cell))` over the visible rows. The tree column adds `depth * indent + 2` for the fold glyph.
3. Clamp to `[min, max]`. `Box` has no `maxWidth`, so the clamp is the mod's job.
4. If the sum exceeds `e.props.bodyColumns`, drop columns by priority (this replaces the `isWide` gate at 70 columns), then shrink content columns toward their minimum.
5. The flex column takes the rest with `flexGrow` and `minWidth`.
6. Draw every cell as `<Box width={n}><Text wrap="truncate-end">`. The renderer stays the final clipper, so a mis-measure costs one ellipsis, not a broken row.

Rules:

- Align a numeric column with `justifyContent="flex-end"` inside the fixed `Box` (`verified-live`).
- Normalize cell text first: replace tabs, newlines, control characters and ANSI with spaces. `cellWidth` counts none of them, and the renderer expands a tab to 8-column stops.
- Keep emoji and VS16 glyphs out of aligned cells. Terminals disagree about them.
- Keep a grow-only width memo per column between refreshes, so folding does not make the other columns jump. Reset it on an explicit refresh (`inference`, from Textual's grow-only content width).
- The header is a normal first row with the same widths, drawn `weight="bold"` or `underline`. A tree column header spans the whole first column without indent.
- Use the shipped glyph set (`★ ▲ ▽ ● ✓ ✗ … · ↳ →`). All are 1 cell in the renderer. Add no Ambiguous-width glyph.

**The header is not sticky.** The pane scrolls as a whole ([d.ts:10760-10767](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L10760-L10767)), so a header row scrolls away. Options:

| Option | Trade-off |
| --- | --- |
| Accept a non-sticky header. Draw one header row per section. | Cheapest. A section already has a title line. |
| Window the rows and keep the header outside the window | Needs `e.props.scroll`, whose offset is stale between renders ([§5.7](#57-budget-guard-and-windowing)). |
| Move the table into a `Client` region | Sticky header possible, but a click is needed for focus. |

**Recommendation (inference):** a non-sticky header row per section in the first version. **Decided (D11, 2026-10-17):** one non-sticky header row per section. Live, the footer is not sticky either ([§3.2](#32-keyboard)): a status line in the header or the footer is hidden while the window sits between them.

**Replaced by issue #63, L1 (2026-10-21):** the pane has one header row for the whole table, not one per section ([§5.5a](#55a-one-table-with-shared-columns-issue-63-l1)). D11 stands for the rest: the header is not sticky, and the window keeps it in view.

### 5.5a One table with shared columns (issue #63, L1)

The sections of the trackers have no columns of their own any more. Every row writes the same columns, and one solver sizes them over the rows of every group. `SectionSpec` lost `columns`. A tracker writes cells by `ColumnId` and badges in `TreeRow.extras` (`inference` for the design, `verified-kit` and `verified-live` for the layout below).

| Column | Width | Priority | Header | Holds |
| --- | --- | --- | --- | --- |
| `control` | `fixed(2)` | | none | The level marker (`★ ▲ ▽`). |
| `name` | `content(6, 24)`, tree | | `Name` | The key of the row, with the indent and the fold glyph. |
| `description` | `flex(10)` | | `Description` | The title, the URL, the branch or the path. |
| `type` | `content(max 12)` | 2 | `Type` | The kind: branch of a PR, issue type, origin. |
| `status` | `content(max 10)` | | `Status` | The state word, with its color token. |
| `extras` | `content(max 14)` | 1 | none | Badges: the cells of `TreeRow.extras`, one `Text` each, a space between. |

- **Drop order.** A pane too narrow for the columns drops the highest priority number first: `type`, then `extras`. Control, name, description and status stay. At 96 body cells all six show. At 49 and at 40 the type and the extras are gone (`verified-kit`, `tests/shared-columns.test.ts`).
- **Badges.** A badge is a `Cell` with no Button, so it takes no Tab stop. A badge that fits is drawn whole. The first one that does not fit is cut to the room left (two cells at least), and the rest are left out. Enter on a row lists each badge that the column cut, one detail line each, under the label `extras` (`verified-kit`, `tests/table.test.ts`). A PR row has the merge chip, the checks and the hint, in that order.
- **One solution.** The width memo is keyed by `table/column`, and the solver reads the rows of every group, drawn or not. A window that moves over the rows never changes a width, and the cells of two groups stand under one header.
- **Group title.** One line: the title (bold), the number of the top-level rows of the group, `(n failed)` in the error color when the band of the section counts failures, then the note. The `/track` text prints `title  note` as before and no count (`verified-kit`, `tests/list-text-golden.test.ts`, byte for byte).
- **Window budget.** The table header is one line that no group owns. The budget is the body less the footer, the gap above it and that line. A group that shows a row costs its title line, not a title and a header, so a body of 11 rows keeps one more row for each group after the first than before (`verified-kit`, `tests/table-window.test.ts`). The floor does not change: header, group title, one row, two hints, the gap and the footer need 7 rows.
- **Caps.** The rows opened with "N more" are keyed by the id of the group, `<view>:<group>` (`list:prs` in the by-list view).

Live check, Claude Code 2.1.306, tmux, the mod loaded from the branch with `--plugin-dir`, model haiku, the e2e fake gh, a PR in conflict, a worktree made by Claude and a background `sleep` (`verified-live`). Frames of the pane:

**Docked, 120x37** (the pane is 49 cells wide: the type and the extras columns are gone; the body is 31 rows, the footer sits on its last rows):

```text
│                                                   ✕
│     Name                       Description   Status
│Worktrees 1 git · 1 live · checked 18s ago
│>    ▾ claude-code-mod-tracking feat/f…-frame
│       ▸ demo-wt                worktr…emo-wt
│
│Pull requests 1 gh · refreshed 47s ago
│     ▸ #7                       Draw the fak… open
│
│Processes 1 1 tracked
│     ▸ bg                       sleep 900     running
│  … 20 blank rows …
│r: refresh  h: help  x: dismiss  1: high  2: normal
│3: low  0: auto  Tab ↑↓ move  Esc close
│
```

**Inline, 100x40** (the body is 11 rows: the header, the title of the first group with its rows and the next group, a hint, the gap and the footer; the process row is the "1 more below"):

```text
╭────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│      Name                       Description                  Type         Status                 │
│ Worktrees 1 git · 1 live · checked 18s ago                                                       │
│ >    ▾ claude-code-mod-tracking feat/fake-frame                                                  │
│        ▸ demo-wt                worktree-demo-wt                                                 │
│                                                                                                  │
│ Pull requests 1 gh · refreshed 47s ago                                                           │
│      ▸ #7                       Draw the fake PR             feat/f…frame open    ✗ conflicts ✓… │
│   ▼ 1 more below                                                                                 │
│                                                                                                  │
│ r: refresh  h: help  x: dismiss  1: high  2: normal  3: low  0: auto  Tab ↑↓ move  Esc close     │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

**Inline, 100x40, after three Tabs** (the window follows the selected row: the header and the footer stay, the groups above scroll out):

```text
╭────────────────────────────────────────────────────────────────────────────────────────────────✕─╮
│      Name                       Description                  Type         Status                 │
│ Pull requests 1 gh · refreshed 51s ago                                                           │
│   ▲ 2 more above                                                                                 │
│      ▸ #7                       Draw the fake PR             feat/f…frame open    ✗ conflicts ✓… │
│                                                                                                  │
│ Processes 1 1 tracked                                                                            │
│ >    ▸ bg                       sleep 900                    background … running                │
│                                                                                                  │
│ r: refresh  h: help  x: dismiss  1: high  2: normal  3: low  0: auto  Tab ↑↓ move  Esc close     │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

The extras column cuts `✗ conflicts ✓ checks` of a conflicted PR at 14 cells, so only the chip and the start of the checks show. The detail lines of the row hold both. In the docked pane (49 cells) the type goes first and the extras go too when a long name takes the room, so the chip and the checks are not on the row there. The band still counts the conflict. Whether 14 cells is enough, and whether the notes keep their counts, is [Q35](open-questions.md#1-unknowns).

### 5.6 Colors (U4)

- Use theme keys for meaning (`success`, `warning`, `error`, `claude`, `inactive`, `subtle`). They follow the person's theme. The mod uses raw `green`, `yellow`, `red` today.
- Use raw hex only when an exact color matters. It quantizes under tmux.
- Put `backgroundColor` on the fixed-width cell `Box` to fill the cell. Use a row `Box` background or `inverse` for the selected row, not a `Text` background.
- Whitelist the color tokens in the component. A colon string kills the whole pane. A typo draws unstyled with no error.
- Use `weight`, not the deprecated `bold`.

### 5.7 Budget guard and windowing

Windowing or a row cap is required, not optional ([§3.6](#36-size-limits-of-a-pane-tree)).

| Option | Effect |
| --- | --- |
| Window the rows by `e.props.scroll` (`bodyRows`, `offset`) | The engine's keep-in-view scroll on Tab raises no `ui.scroll` and no render, so the offset is stale. A window computed from it can lag the ring. Risky (`inference`). |
| Cap rows per section and add a "N more" row that expands on press | State is explicit (an atom). No dependence on the scroll offset. |
| Fold by default | Shrinks the tree. Does not bound it. |
| Short Box keys, clipped titles in the data | The painter's `truncate-end` does not reduce the budget, so clip in the data. Short keys cut the count: a `Box` key counts, a `Button` key does not. |
| A guard in the component that counts nodes and characters before it returns the tree | Turns a cut the mod cannot see (the engine logs it, the mod cannot read the log) into a visible degrade. |

**Recommendation (inference):** the row cap with a "N more" row, short Box keys, clipped titles and the guard. Do not window by scroll offset. **Decided (D12, 2026-10-17):** a row cap per section with an "N more" row, short element keys and a budget guard.

**Windowing by selection (issue #109).** D12 rejected a window computed from `scroll.offset`. The pane windows its rows by the selected row instead. The row cap and the guard stay, and a window over the capped rows keeps the title, the header and the footer in view ([§3.2](#32-keyboard), windowed rows). It reads `scroll.bodyRows` and the selection, never `scroll.offset`.

What the live runs add (`verified-live`, [§3.6](#36-size-limits-of-a-pane-tree)):

- **The guard must run before the tree is returned.** A refused tree leaves the pane blank and keyboard-dead, and the mod gets no error. Count nodes **plus** string children, not nodes alone, and leave margin. Fall back to a smaller tree (the row cap) instead of relying on the engine.
- **Count everything the engine counts:** `Text` strings, `Button` labels and children, `Box` keys and `Link` hrefs. The spike's `chars=` header counted body `Text` only and understated the engine total.
- **Place the footer and the hotkey `Button`s before the rows,** or keep the rows far below the cut, so a text cut cannot remove the key registry (*inference*). The engine's log line fires once per load, so the mod cannot rely on it.
- **Cost.** Each selection write draws the whole tree again, so the cost is O(total rows). A Tab settles in about 29 ms at 100 rows, 58 ms at 300, 109 ms at 600 and 221 ms at 1300. There was no visible lag at 100 or 300 rows. Keep the pane under about 300 rows in total. At 100 rows per section (300 in total) a Tab settles in about 60 ms. A cap of 100 in total would settle in about 30 ms. Do not render every tracker's full list. The figures are in [mods ui: redraw cost](../claude-code-mods/reference/ui.md#redraw-cost).

### 5.8 One model, three renderers (U7)

The pane, the `/track` text and the band read the same sections today, and each lists the fields in its own order (`cellsFor` vs `textOf`; four band-part counters). If the component owns a column spec, the text and the band can derive from it. That removes the duplication list in the inventory: ten `PaneRow` literals with the same defaults, three hand-written fold implementations, four band counters.

## 6. API sketch (recommendation)

The shape below is `inference`. It is a sketch, not a contract.

```mermaid
classDiagram
  class TreeDataTable {
    +render(model, view, el) Tree
    +addColumn(ColumnDef)
    +addAction(RowAction)
    +helpRows() Row[]
  }
  class ColumnDef {
    +id string
    +header string
    +width Width
    +align start_center_end
    +role tree_or_data
    +priority number
    +cell(row, ctx) Cell
  }
  class Width {
    fixed(cells)
    content(min, max)
    flex(min)
  }
  class Cell {
    +text string
    +fg Color
    +bg Color
    +weight string
    +dim boolean
    +wrap string
    +href string
  }
  class RowAction {
    +id string
    +hotkey a_z_or_0_9
    +label string
    +scope row_or_table
    +state(row) enabled_disabled_hidden
    +run(ports, row)
  }
  class TreeModel {
    +idOf(row) string
    +children(row) Row[]
    +detail(row) Cell[]
  }
  class ViewState {
    +expanded Set
    +selected string
    +shown Map
  }
  TreeDataTable o-- ColumnDef
  TreeDataTable o-- RowAction
  TreeDataTable ..> TreeModel : reads
  TreeDataTable ..> ViewState : reads
  ColumnDef --> Width
  ColumnDef ..> Cell : makes
```

The component takes the element table (`Box`, `Text`, `Button`, `Link`) and callbacks. It never takes `$`, as `H/ui/pane.tsx:1-2, :11` does today. `ViewState` is two atoms (`expanded`, `selected`) plus a `shown` count per section.

The key flow, with the ring as the cursor:

```mermaid
sequenceDiagram
  participant P as Person
  participant E as Engine
  participant F as ui.focus hook
  participant S as selected atom
  participant R as ui.render hook
  P->>E: Tab
  E->>F: ui.focus {element: row-handle-7, origin: person}
  F->>E: next(e): the ring moves
  E-->>F: result without deny
  F->>S: update(selected, row 7)
  S-->>R: a subscribed render is drawn again
  R->>R: read selected, draw the row Box with a background
  P->>E: x (hotkey)
  E->>R: onPress of the footer Button x
  R->>R: run(ports, selected row)
```

Costs to know: the hook ordering is "next first, write second" ([§3.3](#33-selection-state)), and a state write at the redraw rate re-draws every subscribed render.

## 7. Test strategy

| What | Where | Grade |
| --- | --- | --- |
| `cellWidth`, the column solver, the registry rules (duplicate hotkey, key charset) | Pure unit tests. Vectors generated by `Bun.stringWidth` (`ambiguousIsNarrow: true`) | `verified-kit` for the helper |
| The tree shape, the highlight after a `ui.focus`, a Buttons-per-row check (a cut row has none), the node and character guard | Kit: `ui.mount`, `await ui.drawn()`, `ui.press({key})`, `ui.findAll({type: 'Button'})` | `verified-kit` |
| The focus ring, Tab and arrow behavior, hotkeys, scroll, paint, colors | Live run in tmux. The kit cannot drive them | `verified-live` |

Gotchas for tests:

- `Mounted.drawn()` is async ([d.ts:16321](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L16321)). A test that forgets `await` sees JSON `{}` and asserts on nothing.
- The test body cannot call `$.fs`. The `Engine` type has no `fs` noun ([config-manager §3](config-manager.md#3-what-the-engine-allows)).
- A kit tree that draws a cut row still passes `claude plugin validate`. Validate never renders.
- `e2e/` runs inside tmux, so ANSI assertions see 256-color indices.

## 8. Gotchas

- Up and Down flip between "scroll" and "move the ring" as the tree grows past the pane height.
- The first Tab after open lands on a hidden Button if one exists. Set `autoFocus` or avoid `display:'none'` Buttons.
- A resize that flips dock to inline drops pane focus. Refocus with `ctrl+x Tab` only after you check `e.props.isFocused`.
- Existing label truncation cuts UTF-16 code units: `H/scan/refs.ts:114`, `H/scan/artifact-url.ts:30` and `H/process/parse.ts:9` use `.slice(0, N)`. A cut through a surrogate pair leaves a lone half, drawn as U+FFFD ([d.ts:7562](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L7562)). Sixty CJK characters are 120 cells. Truncate by grapheme or leave clipping to the renderer.
- A hotkey `onPress` must read the selected row from state at press time. A hotkey press does not move the ring.
- The literal `ui.focus` hook (`e.element ?? null`) loses the selection on the close mark and on a footer `Button`. Write only for row keys.
- A refused tree (over 20,000 nodes plus strings) leaves the pane blank and keyboard-dead, and the mod sees nothing. The text cut removes the footer `Button`s with the rows.
- The `cellWidth` helper's `/v` regexes need `target: es2024` (`TS1501` at `es2023`), or `new RegExp(src, 'v')`.
- A local binding named `next` inside any hook is refused as a shadow of the continuation. `atom({ plugin: CONST, key })` is refused. `$` cannot be assigned to a module variable. In the kit, mounting a Pane with a `ui.focus` hook needs the bottom stub `on('ui.focus', () => ({}))`.
- Do not copy `ink-table`'s `String(value).length` widths.
- Do not use `string-width`'s "first visible scalar" rule for non-emoji clusters. Claude Code's Bun sums the code points. Devanagari conjuncts, Thai SARA AM and halfwidth voiced marks came out one cell short live with that rule.
- `console`: the d.ts gives a `console` to a surface (`Client`) module and none to a hooks module ([d.ts:15449-15456](../claude-code-mods/sources/claude-code-2.1.302/types/claude-code.d.ts#L15449-L15456)). The kit child printed `typeof console` as `object`. Do not rely on either.
- `$.ui.resolve(e)` returns a union of surface tables. Narrow with `if (e.surface !== 'terminal') return next(e)` before you destructure `Client`.
