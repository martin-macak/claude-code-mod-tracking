Feature: Set the priority of a tracked item with the keys

  # Live check of design study section 7: the kit cannot move the focus ring with Tab.
  # The ring walks each row's mark, then its x: Tab 5 times lands on the mark of the third row.
  Scenario: A digit key re-sorts the picked row, and the focus ring follows it
    Given a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a, https://two.example/b and https://three.example/c for later. Reply ok."
    And Claude finishes
    Then the screen matches /tracking.*Links 3/
    When I type "/track"
    Then the screen shows "1: high"
    When I press "Tab"
    And I press "Tab"
    And I press "Tab"
    And I press "Tab"
    And I press "Tab"
    And I press "1"
    Then the screen matches /Web links 3 links[^\n]*\n[^\n]*│▲ +three\.example/
    When I press "3"
    Then the screen matches /│ +two\.example\/b[^\n]*\n[^\n]*│▽ +three\.example/
    When I press "0"
    Then the screen stops showing "▽"
    # three moves to the top again. Tab from its new place reaches its own x, so Enter drops it, not another row.
    When I press "1"
    Then the screen matches /Web links 3 links[^\n]*\n[^\n]*│▲ +three\.example/
    When I press "Tab"
    And I press "Enter"
    Then the screen stops showing "▲"
    And the screen matches /Web links 2 links[^\n]*\n[^\n]*│ +one\.example\/a[^\n]*\n[^\n]*│ +two\.example\/b/
