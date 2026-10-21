Feature: Drive the /track pane with the keys

  # Spec section 5.10 and section 7. One focus Button per row: Tab walks the rows, and a letter key acts on the selected row.
  # The pane draws the selected row with ">" after its border. Anchor on the border: the transcript beside it holds the prompt.
  Scenario: Tab moves the selection and x dismisses the selected row
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    When I press "Tab"
    Then the selected row shows "two.example"
    When I press "x"
    Then the screen matches /Web links 2 links/
    And the selected row shows "three.example"

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
    Then the screen shows "Row keys (act on the selected row)"
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
    Then the screen matches /Web links 40 links/
    And the screen matches /│ +Label +URL/
    And the screen shows "more below"
    And the screen shows "r: refresh"
    And the selected row shows "a1.io/x"
    When I press "Tab" 30 times
    Then the selected row shows "a31.io/x"
    And the screen matches /Web links 40 links/
    And the screen shows "more above"
    And the screen shows "more below"
    And the screen shows "r: refresh"
    When I press "Tab" 9 times
    Then the selected row shows "a40.io/x"
    And the screen shows "more above"
    And the screen stops showing "more below"
    And the screen matches /Web links 40 links/
    And the screen shows "r: refresh"

  # Issue #109, the owner's wish: with fewer rows than the body holds, the footer keys sit at the bottom of the pane, not under
  # the last row. The e2e terminal is 120 columns wide, so the pane is docked and its body has a fixed height. An inline pane
  # is as tall as its tree, so the footer stays under the last row there (README "Known limits"). The regex wants at least ten
  # blank pane rows between the last link and the footer keys.
  Scenario: A short list keeps the footer keys at the bottom of a docked pane
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    And I type "/track"
    Then the selected row shows "one.example"
    And the screen matches /│.*three\.example\/c.*\n(.*│ *\n){10,}.*│r: refresh/
    When I press "Tab"
    Then the selected row shows "two.example"
    And the screen matches /│.*three\.example\/c.*\n(.*│ *\n){10,}.*│r: refresh/

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
    Then the screen matches /Web links 40 links/
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
    Then the screen matches /Web links 2 links/
    And the selected row shows "three.example"
    And the focus ring is on "▸"
    When I press "Up"
    Then the selected row shows "one.example"

  # Issue #129, the key keeps its work. A click on `r: refresh` with the keys in the prompt also refreshes. The pane shows
  # the age of the refresh when it draws and does not draw it again by itself, so "just now" comes from a refresh that
  # finished a moment before the draw. The 3 seconds of waiting make the first draw say "Ns ago". A fake gh answers the
  # calls of the mod: nothing here can reach GitHub.
  Scenario: A click on r: refresh with the keys in the prompt gives the pane the keys and still refreshes
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-refresh"
    And the fake gh reports PR #7 "Refresh the fake PR" from "feat/fake-refresh" into "main" as MERGEABLE
    And a Claude Code session with the artifact-tracking mod
    When I wait for 3 seconds
    And I type "/track"
    Then the screen matches /│Pull requests gh · refreshed \d+s ago/
    When I press "C-x"
    And I press "Tab"
    Then the screen shows "Keys go to the prompt."
    When I click "r: refresh" in the pane to give it the keys
    Then the screen matches /│Pull requests gh · refreshed just now/
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
