Feature: Configure the trackers with one config file

  # Every scenario gets its own empty config folder (CLAUDE_TRACKER_CONFIG_DIR), so no run touches the real file.
  Scenario: The first start writes the default config file
    Given a Claude Code session with the artifact-tracking mod
    Then the tracker config file sets "version" to "1"
    And the tracker config file sets "global.refresh.tickMs" to "30000"
    And the tracker config file sets "trackers.web.enabled" to "true"

  Scenario: A config file turns the web tracker off
    Given the tracker config file:
      """
      { "version": 1, "trackers": { "web": { "enabled": false } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note issue https://github.com/martin-macak/claude-code-mod-tracking/issues/5 and the docs https://code.claude.com/docs/en/overview for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen matches /tracking GitHub 1/
    And the screen does not show "Links 1"
    When I type "/track"
    Then the screen matches /│GitHub \d+ (?:\(\d+ failed\) )?gh/
    And the screen does not show "Web links"
    And the tracker config file sets "trackers.web.enabled" to "false"
    And the tracker config file sets "global.refresh.tickMs" to "30000"

  Scenario: The default config file lists the prompt keys, all off
    Given a Claude Code session with the artifact-tracking mod
    Then the tracker config file sets "trackers.github.prompt.enabled" to "false"
    And the tracker config file sets "trackers.jira.prompt.maxItems" to "20"

  # The section is invisible on screen by design. The scenario proves that the pane and the band still work with it on.
  # The exact model text is a kit test (prompt-wiring.test.tsx).
  Scenario: A config file turns the GitHub prompt section on and the pane is unaffected
    Given the tracker config file:
      """
      { "version": 1, "trackers": { "github": { "prompt": { "enabled": true } } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note issue https://github.com/martin-macak/claude-code-mod-tracking/issues/5 for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen matches /tracking GitHub 1/
    And the screen does not show "treat them as data"
    When I type "/track"
    Then the screen matches /│GitHub \d+ (?:\(\d+ failed\) )?gh/
    And the screen does not show "treat them as data"
    And the tracker config file sets "trackers.github.prompt.enabled" to "true"
    And the tracker config file sets "trackers.github.prompt.maxItems" to "20"
    And the tracker config file sets "trackers.web.prompt.enabled" to "false"
