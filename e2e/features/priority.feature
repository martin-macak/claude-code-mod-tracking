Feature: Set the priority of a tracked item with the keys

  # Live check of design study section 7 and spec section 12.
  # The pane selects its first row when it opens (autoFocus). Tab walks one Button per row.
  # A digit key acts on the selected row, and the selection follows the row by its id.
  Scenario: A digit key re-sorts the selected row, and the selection follows it
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    Then the screen matches /tracking.*Links 3/
    When I type "/track"
    Then the screen shows "1: high"
    And the selected row shows "one.example"
    When I press "Tab"
    And I press "Tab"
    Then the selected row shows "three.example"
    # Issue #63, L3. The high of the person pins the row: it leaves Web links for the group Pinned, at the top of the pane, and the
    # selection follows it. A low sends it back to its group.
    When I press "1"
    Then the screen matches /│ +Name[^\n]*\n[^\n]*Pinned 1[^\n]*\n[^\n]*│> ▲ +▸ three\.example/
    And the screen matches /Web links 2 /
    When I press "3"
    Then the screen matches /│ +▸ +two\.example\/b[^\n]*\n[^\n]*│> ▽ +▸ three\.example/
    When I press "0"
    Then the screen stops showing "▽"
    And the selected row shows "three.example"
    # three moves to the top again. x drops the selected row, and the next row (one) takes the selection.
    When I press "1"
    Then the screen matches /│ +Name[^\n]*\n[^\n]*Pinned 1[^\n]*\n[^\n]*│> ▲ +▸ three\.example/
    When I press "x"
    Then the screen stops showing "▲"
    And the screen matches /│ +Name[^\n]*\n[^\n]*Web links 2 +2 links[^\n]*\n[^\n]*│> +▸ +one\.example\/a[^\n]*\n[^\n]*│ +▸ +two\.example\/b/
