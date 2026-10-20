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
