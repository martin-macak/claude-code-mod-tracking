@demo
Feature: Track the work a session mentions

  Scenario: Mentioned GitHub items and links show in the band and the /track pane
    Given the caption "Mention GitHub items and links in a prompt"
    And a Claude Code session with the artifact-tracking mod
    When I type "Note PR https://github.com/martin-macak/claude-code-mod-tracking/pull/15, issue https://github.com/martin-macak/claude-code-mod-tracking/issues/5 and the docs https://code.claude.com/docs/en/overview for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen matches /tracking GitHub 2 · Links 1/
    And I pause for 2.5 seconds

    Given the caption "The band counts PRs with failing checks"
    When I type "Also note https://github.com/martin-macak/claude-code-mod-tracking/pull/16. Reply ok."
    And Claude finishes
    Then the screen matches /tracking GitHub 3 \(1 ✗\) · Links 1/
    And I pause for 2.5 seconds

    Given the caption "/track opens the pane with live state from gh"
    # The pane shows the refresh age at render time and never re-renders it. A short wait
    # makes it open on "Ns ago", so only the r refresh below can show "just now".
    When I wait for 2 seconds
    And I type "/track"
    Then the screen shows "✗ checks"
    And the screen shows "closed"
    And the screen shows "Web links"
    And the screen matches /│GitHub gh · refreshed \d+s ago/
    And I pause for 4 seconds

    Given the caption "r refreshes every item, Esc closes the pane"
    When I press "r"
    Then the screen matches /│GitHub gh · refreshed just now/
    And I pause for 2 seconds
    When I press "Escape"
    Then the screen stops showing "Esc close"
    And the screen matches /tracking GitHub 3 \(1 ✗\) · Links 1/
    And I pause for 2.5 seconds
