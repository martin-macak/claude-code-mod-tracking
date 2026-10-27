Feature: Drive the /track pane with the keys

  # Spec section 5.10 and section 7. One focus Button per row: Tab walks the rows, and a letter key acts on the selected row.
  # The pane draws the selected row with ">" after its border (docked) or after a space past its border (inline). Anchor on the
  # border: the transcript beside a docked pane holds the prompt.
  Scenario: Tab moves the selection and x dismisses the selected row
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "Tab"
    Then the selected row shows "two.example"
    When I press "x"
    Then the screen matches /Web links 2 +2 links/
    And the selected row shows "three.example"

  # Issue #138. `m` marks the selected row and the view line counts the marks. `x` then asks about the marked rows, and a second
  # `x`, pressed once the pane shows the question, dismisses them. The selection goes to the row that stays.
  Scenario: m marks rows, x asks about them and a second x dismisses them
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "m"
    Then the screen shows "1 marked"
    When I press "Tab"
    And I press "Tab"
    Then the selected row shows "three.example"
    When I press "m"
    Then the screen shows "2 marked"
    When I press "x"
    Then the screen shows "Dismiss 2 marked rows? x again: yes"
    And the screen shows "x: confirm 2"
    And the screen matches /Web links 3 +3 links/
    When I press "x"
    Then the screen matches /Web links 1 +1 links/
    And the screen stops showing "marked"
    And the selected row shows "two.example"

  Scenario: Enter expands a leaf into its detail, and h shows the help view
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "Enter"
    Then the screen matches /│.*link: https:\/\/one\.example\/a/
    When I press "Enter"
    Then the screen stops showing "link: https://one.example/a"
    When I press "h"
    Then the screen shows "Row keys (act on the selected or marked rows)"
    And the screen shows "Config file:"
    And the screen shows "Version:"
    When I press "h"
    Then the screen stops showing "Row keys"
    And the selected row shows "one.example"

  Scenario: A long section ends in an N more row
    Given the tracker config file:
      """
      { "version": 1, "global": { "ui": { "sectionRows": 5 } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://a.example/1, https://b.example/2, https://c.example/3, https://d.example/4, https://e.example/5, https://f.example/6 and https://g.example/7 for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the screen shows "2 more"
    And the selected row shows "a.example"
    # Tab walks the four rows below the selected one, then the fifth Tab reaches the N more Button. Every key waits for
    # the focus that the key before it moved. A slow redraw must not swallow a key (issue #104). The selection follows the
    # focus over the rows. The N more Button holds no selection, so its reverse video shows the focus.
    When I press "Tab"
    Then the selected row shows "b.example"
    When I press "Tab"
    Then the selected row shows "c.example"
    When I press "Tab"
    Then the selected row shows "d.example"
    When I press "Tab"
    Then the selected row shows "e.example"
    When I press "Tab"
    Then the focus ring is on "2 more"
    When I press "Enter"
    Then the screen stops showing "2 more"
    And the screen matches /│ +▸ +g\.example\/7/

  # Issue #108. A letter that is no key goes to the prompt box and the pane loses the keyboard. The pane says so. ctrl+x Tab
  # gives the keyboard back, and the ring starts on the selected row, so Up goes to the row above it.
  Scenario: The pane says when the keys go to the prompt, and ctrl+x Tab gives them back
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the screen does not show "Keys go to the prompt."
    And the screen shows "Tab ↑↓ move"
    # Every key waits for the focus that the key before it moved (issue #104). Up waits for the ring too: the ring comes
    # back with the keys, and a key sent before it is drawn can be lost.
    When I press "Tab"
    Then the selected row shows "two.example"
    When I press "Tab"
    Then the selected row shows "three.example"
    When I press "j"
    Then the screen shows "Keys go to the prompt."
    And the selected row shows "three.example"
    When I press "C-x"
    And I press "Tab"
    Then the screen stops showing "Keys go to the prompt."
    And the focus ring is on "▸"
    When I press "Up"
    Then the selected row shows "two.example"

  # Issue #108. A click is a press: a click on the arrow of a row selects the row and opens it.
  Scenario: A click on the arrow of a row selects the row and opens it
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I click the arrow of the row showing "three.example"
    Then the selected row shows "three.example"
    And the screen matches /│.*link: https:\/\/three\.example\/c/
    And the focus ring is on "▾"
    When I press "Up"
    Then the selected row shows "two.example"

  # Issue #109: the engine scrolls a pane tree as a whole, so rows taller than the pane pushed the title, the header and the
  # footer keys out of view. The pane draws a window of the rows instead: the three stay on one screen, and Tab walks every
  # row while the window follows the selected row. The e2e terminal is 120 columns wide, so the pane is docked.
  Scenario: A list taller than the pane keeps the title, the header and the keys in view
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://a1.io/x, https://a2.io/x, https://a3.io/x, https://a4.io/x, https://a5.io/x, https://a6.io/x, https://a7.io/x, https://a8.io/x, https://a9.io/x, https://a10.io/x, https://a11.io/x, https://a12.io/x, https://a13.io/x, https://a14.io/x, https://a15.io/x, https://a16.io/x, https://a17.io/x, https://a18.io/x, https://a19.io/x, https://a20.io/x, https://a21.io/x, https://a22.io/x, https://a23.io/x, https://a24.io/x, https://a25.io/x, https://a26.io/x, https://a27.io/x, https://a28.io/x, https://a29.io/x, https://a30.io/x, https://a31.io/x, https://a32.io/x, https://a33.io/x, https://a34.io/x, https://a35.io/x, https://a36.io/x, https://a37.io/x, https://a38.io/x, https://a39.io/x, https://a40.io/x for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the screen matches /Web links 40 +40 links/
    And the screen matches /│ +Name +Description/
    And the screen shows "more below"
    And the screen shows "r: refresh"
    And the selected row shows "a1.io/x"
    When I press "Tab" 30 times
    Then the selected row shows "a31.io/x"
    And the screen matches /Web links 40 +40 links/
    And the screen shows "more above"
    And the screen shows "more below"
    And the screen shows "r: refresh"
    When I press "Tab" 9 times
    Then the selected row shows "a40.io/x"
    And the screen shows "more above"
    And the screen stops showing "more below"
    And the screen matches /Web links 40 +40 links/
    And the screen shows "r: refresh"

  # Issue #109, the owner's wish: with fewer rows than the body holds, the footer keys sit at the bottom of the pane, not under
  # the last row. The e2e terminal is 120 columns wide, so the pane is docked and its body has a fixed height. An inline pane
  # is as tall as its tree, so the footer stays under the last row there (README "Known limits"). The regex wants at least ten
  # blank pane rows between the last link and the bottom area. Issue #138: the docked body has 18 rows or more, so the bottom
  # area is the selected-row line, the view line (a second row where the keys wrap), the health line and the footer keys.
  Scenario: A short list keeps the footer keys at the bottom of a docked pane
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the screen matches /│.*three\.example\/c.*\n(.*│ *\n){10,}.*│Selected: [^\n]*\n.*│View: list[^\n]*\n(.*│[^\n]*\n)?.*│Health: [^\n]*\n.*│r: refresh/
    When I press "Tab"
    Then the selected row shows "two.example"
    And the screen matches /│.*three\.example\/c.*\n(.*│ *\n){10,}.*│Selected: [^\n]*\n.*│View: list[^\n]*\n(.*│[^\n]*\n)?.*│Health: [^\n]*\n.*│r: refresh/

  # Issue #138, PR 2: the adaptive status area. With 18 body rows or more the pane draws a summary row above the table (the words of
  # the band), and the selected-row line and the health line in the footer Box, around the view line. The docked pane of a
  # 120x36 terminal has about 30 body rows. The selected-row line follows the selection. The health line names the tools of the
  # trackers that run and counts the problems of the help view. The github and jira trackers are the ones that declare tools (`gh`,
  # `acli`) and the host decides what those say (installed or not, logged in or not), so the config turns them off: no tool is
  # live, the line is the problem count alone, and the scenario gives the same answer on every machine. The names of the tools
  # on the line are a kit test (tests/pane-status-area.test.ts).
  Scenario: A docked pane shows the summary, the selected row and the health beside the view line and the keys
    Given the tracker config file:
      """
      { "version": 1, "trackers": { "github": { "enabled": false }, "jira": { "enabled": false } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the pane is docked
    And the screen matches /│Links 3\s*$/
    And the screen matches /│Selected: one\.example/
    And the screen matches /│Health: no problems\s*$/
    And the screen shows "View: list"
    And the screen shows "r: refresh"
    When I press "Tab"
    Then the selected row shows "two.example"
    And the screen matches /│Selected: two\.example/

  # Issue #138, PR 2. The form follows the engine body: 18 rows or more draw the status area, inline as well (a 100x60 terminal
  # gives the inline pane 18 body rows), and below that the pane keeps the view line and the footer (100x40 gives 11 rows).
  # At both sizes the footer keys stay in view.
  Scenario Outline: The status area shows from 18 body rows and not below, at <cols>x<rows>
    Given a terminal of <cols> columns by <rows> rows
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the pane is inline
    And the screen shows "View: list"
    And the screen shows "r: refresh"
    And the screen matches /tracking\s+Links 3/
    And the screen <check> "Health:"

    Examples:
      | cols | rows | check          |
      | 100  | 60   | shows          |
      | 100  | 40   | does not show  |

  # Issue #109, review finding m2. The ring sits on a position among the Buttons. Enter on an N more row puts the new rows in
  # before it, so its position holds the stop of a row that the window hides, and no row would show the ring. The pane asks for
  # the ring on the selected row again. The e2e terminal is 120 columns wide, so the pane is docked with a window of 26 rows.
  Scenario: Enter on an N more row of a windowed pane puts the ring back on the selected row
    Given the tracker config file:
      """
      { "version": 1, "global": { "ui": { "sectionRows": 30 } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://a1.io/x, https://a2.io/x, https://a3.io/x, https://a4.io/x, https://a5.io/x, https://a6.io/x, https://a7.io/x, https://a8.io/x, https://a9.io/x, https://a10.io/x, https://a11.io/x, https://a12.io/x, https://a13.io/x, https://a14.io/x, https://a15.io/x, https://a16.io/x, https://a17.io/x, https://a18.io/x, https://a19.io/x, https://a20.io/x, https://a21.io/x, https://a22.io/x, https://a23.io/x, https://a24.io/x, https://a25.io/x, https://a26.io/x, https://a27.io/x, https://a28.io/x, https://a29.io/x, https://a30.io/x, https://a31.io/x, https://a32.io/x, https://a33.io/x, https://a34.io/x, https://a35.io/x, https://a36.io/x, https://a37.io/x, https://a38.io/x, https://a39.io/x, https://a40.io/x for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the screen matches /Web links 40 +40 links/
    And the screen shows "more below"
    And the selected row shows "a1.io/x"
    When I press "Tab" 29 times
    Then the selected row shows "a30.io/x"
    When I press "Tab"
    Then the focus ring is on "10 more"
    When I press "Enter"
    Then the focus ring is on "▸"
    And the selected row shows "a30.io/x"
    And the screen shows "▼ 10 more below"

  # Issue #115. A click on a Button runs its press and leaves the keys where they were. With the keys in the prompt (the
  # composer is empty: ctrl+x Tab hands them over), the click must also give them to the pane, so Down moves the
  # selection and not the prompt history. The pane asks the engine for them, and the ring comes with them.
  Scenario: A click on a row gives the pane the keys when they are in the prompt
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click the arrow of the row showing "two.example"
    Then the selected row shows "two.example"
    And the screen stops showing "Keys go to the prompt."
    And the focus ring is on "▾"
    When I press "Down"
    Then the selected row shows "three.example"

  # Issue #115, the refusal. The engine gives no keys while the composer holds text (issue #108, case C). The click still
  # selects and opens the row. The hint stays, the text stays in the prompt, and nothing else happens: no error, no loop.
  Scenario: A click on a row keeps the hint and the text in the prompt when the engine refuses the keys
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "j"
    Then the screen shows "Keys go to the prompt."
    When I click the arrow of the row showing "three.example"
    Then the selected row shows "three.example"
    And the screen matches /│.*link: https:\/\/three\.example\/c/
    And the screen shows "Keys go to the prompt."
    And the screen matches /^❯\s+j\s*$/

  # Issue #129. A click on a footer key is a press too, and it moves no focus. With the keys in the prompt it must also
  # give them to the pane, so Down and Up move the selection and not the prompt history. The key still does its work.
  # `r` refreshes (the fake gh scenario below shows it). `x` dismisses the row, selects the next one and asks for the ring
  # on it: the ring is refused while the prompt has the keys, so the keys must come first.
  Scenario: A click on a footer key gives the pane the keys when they are in the prompt
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "r: refresh" in the pane to give it the keys
    Then the screen stops showing "Keys go to the prompt."
    When I press "Down"
    Then the selected row shows "two.example"
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "x: dismiss" in the pane to give it the keys
    Then the screen matches /Web links 2 +2 links/
    And the selected row shows "three.example"
    And the focus ring is on "▸"
    When I press "Up"
    Then the selected row shows "one.example"

  # Issue #129, the key keeps its work. A click on `r: refresh` with the keys in the prompt also refreshes. The pane shows the
  # age of the refresh when it draws and does not draw it again by itself. So the scenario shows the refresh by two ages: some
  # seconds before the click, and younger after it. Issue #165: the first PR discovery of the mod stamps the age, and it runs
  # at the start of the session, not at a fixed time after it. On a loaded machine it ran after the 3 seconds that the scenario
  # used to wait, while `/track` opened, and the first drawing said "just now". The scenario now waits for the discovery call
  # of the fake gh, and then for the log to be quiet: the mod stamps before it calls, so a drawing that comes 2 seconds after
  # the last call says "2s ago" or more, whatever the speed of the machine. The click then makes the age younger. A fake gh
  # answers the calls of the mod: nothing here can reach GitHub.
  Scenario: A click on r: refresh with the keys in the prompt gives the pane the keys and still refreshes
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-refresh"
    And the fake gh reports PR #7 "Refresh the fake PR" from "feat/fake-refresh" into "main" as MERGEABLE
    And a Claude Code session with the artifact-tracking mod
    When the fake gh answered "graphql discovery"
    And the fake gh has been quiet for 2 seconds
    And I type "/track"
    Then the screen matches /│Pull requests \d+ +gh · refreshed \d+s ago/
    When I note how old the last refresh on the screen is
    And I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "r: refresh" in the pane to give it the keys
    Then the last refresh on the screen is younger than the one noted
    And the screen stops showing "Keys go to the prompt."
    And the fake gh answered no unsupported call

  # Issue #129. The same for an N more row: the click shows the next rows and gives the pane the keys.
  Scenario: A click on an N more row gives the pane the keys when they are in the prompt
    Given the tracker config file:
      """
      { "version": 1, "global": { "ui": { "sectionRows": 5 } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://a.example/1, https://b.example/2, https://c.example/3, https://d.example/4, https://e.example/5, https://f.example/6 and https://g.example/7 for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "a.example"
    And the screen shows "2 more"
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "2 more" in the pane to give it the keys
    Then the screen stops showing "2 more"
    And the screen matches /│ +▸ +g\.example\/7/
    When I press "Down"
    Then the selected row shows "b.example"

  # Issue #129, a dim footer key. With nothing tracked no row is selected, so `x: dismiss` is dim and does no work. It is a
  # Button all the same: a click on it moves no focus, so with the keys in the prompt it must give them to the pane too.
  Scenario: A click on a dim footer key gives the pane the keys when they are in the prompt
    Given a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the screen shows "x: dismiss"
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "x: dismiss" in the pane to give it the keys
    Then the screen stops showing "Keys go to the prompt."

  # Issue #140. The ring sits on `c: resolve` of a conflicted PR row. The help view has no `c`, so `h` must put the ring on
  # `h: back`, and the next Tab walks on from there: with no ring the Tab would start from the first Button. The second `h`
  # gives the ring back to the selected row. Tab walks the footer in key order: r, h, x, 1, 2, 3, 0, c, f. A fake gh answers
  # the calls of the mod: nothing here can reach GitHub. Issue #155: it runs twice. At 120x36 the pane is docked beside the
  # transcript, at 100x40 it is inline under it, with a space between the border and the ">" gutter of the selected row.
  # The step `the pane is <placement>` says which one each example expects: a size that did not take effect fails there.
  Scenario Outline: h moves the ring from a tracker key to h: back, and the second h gives it back to the selected row at <cols>x<rows>
    Given a terminal of <cols> columns by <rows> rows
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the selected row shows "#7"
    And the pane is <placement>
    And the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    When I press "Tab" until the focus ring is on "c: resolve"
    Then the focus ring is on "c: resolve"
    When I press "h"
    Then the screen shows "Row keys (act on the selected or marked rows)"
    And the focus ring is on "h: back"
    When I press "h"
    Then the screen stops showing "Row keys"
    And the selected row shows "#7"
    And the focus ring is on "▸"
    When I press "Tab" until the focus ring is on "c: resolve"
    Then the focus ring is on "c: resolve"
    When I press "h"
    Then the focus ring is on "h: back"
    When I press "Tab"
    Then the focus ring is on "x: dismiss"
    And the fake gh answered no unsupported call

    Examples:
      | cols | rows | placement |
      | 120  | 36   | docked    |
      | 100  | 40   | inline    |

  # Issue #105 (PR #137). At 100x40 the pane is inline and its body holds 11 rows. The help view with 3 config problems, the
  # path of the config file on two rows and the footer fill them, so the compact form lists no problem and counts them:
  # `3 problems: /track help`. `Pane keys` and the footer `h: back` are in one frame. The help footer has the core keys only:
  # with a PR row selected it kept the dim `c: resolve  f: files` of that row, wrapped to a second row and pushed `Pane keys`
  # out of view. Issue #200: the footer also draws `g`, `a`, `t`, `p` and `m` dim, which takes a second row at 96 cells. The tracker
  # groups share one row of the help view (issue #265), so the view and the 2-row footer still fit. The config has 3 problems:
  # a value below its min (breaker threshold), two above their max (sectionRows and chunkSize). The count line needs the path
  # of the config file to wrap onto two rows. The path is 84 to 96 cells wide for that (the body is 96 cells and
  # `Config file: ` takes 13). The step sets it to 90 whatever the temporary folder of the system is, `/var/folders/...` of a
  # Mac or `/tmp`. Run it alone with `--tags @inline-help`.
  @inline-help
  Scenario: With 3 config problems the inline help view shows the pane keys, the count and the footer together
    Given a terminal of 100 columns by 40 rows
    And the tracker config file path is 90 cells wide
    And the tracker config file:
      """
      { "version": 1, "global": { "tools": { "breaker": { "threshold": 0 } }, "ui": { "sectionRows": 99999 } }, "trackers": { "github": { "chunkSize": 5000 } } }
      """
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the selected row shows "#7"
    And the pane is inline
    And the screen shows "c: resolve"
    When I press "h"
    Then the screen matches /Pane keys[\s\S]*3 problems: \/track help[\s\S]*h: back[\s\S]*m: mark/
    And the screen stops showing "c: resolve"
    And the fake gh answered no unsupported call

  # Issue #200. The help view has no view line, so its letters `g`, `a`, `t`, `p` and `m` had no Button: a press typed the letter into
  # the prompt and took the keyboard from the pane. The footer draws them dim now: a press does nothing and the pane keeps the
  # keys. The proof is causal: the `h` after the five letters is a pane key. It closes the help view only when the pane still has
  # the keyboard; a keyboard in the prompt would take the `h` as a letter and the help view would stay. The ring stays on the dim
  # Button that had it when `h` opens the help view, and the second `h` leaves it on the same Button of the view line.
  @help-view-keys
  Scenario Outline: In the help view g, a, t, p and m keep the keyboard in the pane, and the ring stays on its Button, at <cols>x<rows>
    Given a terminal of <cols> columns by <rows> rows
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the selected row shows "#7"
    And the pane is <placement>
    When I press "Tab" until the focus ring is on "g: view"
    And I press "h"
    Then the screen shows "Row keys (act on the selected or marked rows)"
    And the screen shows "m: mark"
    And the focus ring is on "g: view"
    When I press "g"
    And I press "a"
    And I press "t"
    And I press "p"
    And I press "m"
    Then the screen does not show "Keys go to the prompt."
    When I press "h"
    Then the screen stops showing "Row keys"
    And the selected row shows "#7"
    And the focus ring is on "g: view"
    And the screen does not show "Keys go to the prompt."
    And the fake gh answered no unsupported call

    Examples:
      | cols | rows | placement |
      | 120  | 36   | docked    |
      | 100  | 40   | inline    |

  # Issue #199. `p` shows the plan of `/track clean` in the pane, in the place of the rows, and changes nothing. The session has no
  # tool, so no task runs and the plan is the empty one: the title and `Nothing to stop or remove.`. The kit cannot show the ring or
  # the paint, so this run does. The plan view has no view line, so `g` is a dim Button there: the letter must not reach the prompt
  # and take the keys from the pane. If it did, the next `p` would go to the prompt too and the row would not come back. At 100x40
  # the pane is inline and its body holds 11 rows, so this also shows the plan view and its footer in that body. Run it alone with
  # `--tags @plan-view`.
  @plan-view
  Scenario: p shows the clean plan with the ring on p: back, g does nothing there, and p again returns to the row
    Given a terminal of 100 columns by 40 rows
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the selected row shows "#7"
    And the pane is inline
    And the screen shows "p: clean plan"
    When I press "p"
    Then the screen shows "Clean plan. Nothing changed."
    And the screen shows "Nothing to stop or remove."
    And the screen shows "p: back"
    And the pane stops showing "#7"
    And the focus ring is on "p: back"
    When I press "g"
    Then the screen shows "Clean plan. Nothing changed."
    When I press "p"
    Then the selected row shows "#7"
    And the pane stops showing "Clean plan. Nothing changed."
    And the screen shows "p: clean plan"
    And the focus ring is on "▸"
    And the fake gh answered no unsupported call

  # Issue #140. `x` on the only row takes the row and every tracker key out of the footer. The ring sat on `c: resolve`, a
  # Button that is gone, so it would land on none. The mod asks for the first footer Button once the drawing without the row
  # is on screen. The scenario reads the ring and the row text, not the gutter of the selected row, so it runs inline as well.
  # Issue #165: the `/track` line of the transcript still says `#7` after the pane dropped the row, so the wait for the row
  # to go reads the pane only (`the pane stops showing`), not the whole screen.
  Scenario: x on the last row puts the ring on r: refresh
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    When I press "Tab" until the focus ring is on "c: resolve"
    And I press "x"
    Then the pane stops showing "#7"
    And the focus ring is on "r: refresh"
    And the fake gh answered no unsupported call

  # Issue #193. A press waits for the drawing and then for a pause of 10 ms on the engine clock (`RING_PAUSE_MS`, issue #156)
  # before it asks for the ring. A hook of another plugin can refuse that timer: it never fires and the engine says nothing.
  # The probe plugin denies `clock.after` of 10 ms and passes every other delay, so no other timer of the mod is dropped
  # (1000 ms is also a default of the mod). With no drawing after the frame, only the wake of the mod (a `setTimeout` 250 ms
  # behind the engine timer) ends the pause. Without it the press waits until the pane closes and the ring stays where it was.
  # The step `the timer refuser has refused a timer` proves the refusal took place. The step `the debug log shows` proves that
  # the wake ended the wait, and not a stray drawing (a tick, a status change): only the wake writes that line. The keys behind
  # an `x` that waits are a kit test (`pane-session.test.ts`): a key pressed from tmux comes after the wake.
  Scenario: h moves the ring to h: back although another plugin refuses the timer of the ring pause
    Given a plugin that refuses clock.after of 10 ms
    And the session writes a debug log
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    When I press "Tab" until the focus ring is on "c: resolve"
    And I press "h"
    Then the screen shows "Row keys (act on the selected or marked rows)"
    And the timer refuser has refused a timer
    And the focus ring is on "h: back"
    And the debug log shows "pane ring pause: the engine timer of 10 ms did not fire"
    And the fake gh answered no unsupported call

  Scenario: x on the last row puts the ring on r: refresh although another plugin refuses the timer of the ring pause
    Given a plugin that refuses clock.after of 10 ms
    And the session writes a debug log
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    When I press "Tab" until the focus ring is on "c: resolve"
    And I press "x"
    Then the pane stops showing "#7"
    And the timer refuser has refused a timer
    And the focus ring is on "r: refresh"
    And the debug log shows "pane ring pause: the engine timer of 10 ms did not fire"
    And the fake gh answered no unsupported call

  # Issue #63, L3. The pane opens in the view of `global.ui.view`, by list. `g` takes the next view of `global.ui.views`: by
  # status. The group titles change with the view (a web link has no state, so by status it is the group "No status"), the view
  # line names the view, the row that was selected stays selected, and the ring goes with it to the new handle. A second `g`
  # goes to flat, one group of every row. The keys sit on the view line: the footer keeps its keys.
  Scenario: g moves the pane from by list to by status, and the group titles change
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the screen matches /Web links 3 +3 links/
    And the screen shows "View: list"
    And the screen shows "g: view"
    When I press "Tab"
    Then the selected row shows "two.example"
    When I press "g"
    # The transcript still holds the text of /track, so the old title is not a sign: the border `│` of the pane is.
    Then the screen matches /│No status +3/
    And the screen shows "View: status"
    And the selected row shows "two.example"
    And the focus ring is on "▸"
    # Every row Button draws "▸", so the step above passes with the ring on any row. By status the order is one, three, two.
    # The ring is on two, the last row: Up goes to three. A ring left at the old place (the second Button, now three) would go
    # to one.
    When I press "Up"
    Then the selected row shows "three.example"
    When I press "Down"
    Then the selected row shows "two.example"
    When I press "g"
    Then the screen shows "View: flat"
    And the screen matches /│All +3/
    And the selected row shows "two.example"
