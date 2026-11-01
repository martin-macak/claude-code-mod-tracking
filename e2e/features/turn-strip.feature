Feature: The strip under an answer says what the turn tracked

  # Issue #69, P2. `global.ui.turnStrip` is off by default. Each scenario writes its own config file (its own empty config
  # folder), starts one real session and runs one real turn that tracks links. The engine puts the plugin names in front of
  # the text line, so the steps match the end of it. The kit tests (turn-strip-wiring.test.tsx) hold every rule.

  Scenario: With the strip off, which is the default, a turn that tracked links adds no line under the answer
    Given a plugin that marks the end of a turn
    And a Claude Code session with the artifact-tracking mod
    Then the tracker config file sets "global.ui.turnStrip" to "\"off\""
    When I type "Note https://one.example/a and https://two.example/b for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen matches /turn 1 \+2 new/
    # The band names the turn when its items arrive, before the turn ends, and `Claude finishes` (the Stop hook) returns before
    # the `turn.complete` hook of the mod has returned. The event to wait for is the end of that hook chain: the probe plugin
    # adds a mark to the text that the chain returns, and the engine draws the mark and the strip line, if there is one, as
    # one row (issue #197). So the line would be on the screen when the mark is, and its absence then proves something.
    # The mark orders the text line only, not the TurnDuration strip of `interactive`: that strip shows counts, and this
    # scenario never draws it.
    When the end of the turn has drawn
    Then the screen does not show "/track turn 1"

  Scenario: A text strip puts one line under the answer of a turn that tracked links
    Given the tracker config file:
      """
      { "version": 1, "global": { "ui": { "turnStrip": "text" } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a and https://two.example/b for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen shows "+2 new · /track turn 1"
    # The line names the command that lists the turn: it prints the turn the line is about.
    When I type "/track turn 1"
    Then the screen shows "Turn 1 · answer"
    And the tracker config file sets "global.ui.turnStrip" to "\"text\""

  # The duration line is the engine's, on the terminal. On the fullscreen layout the strip has an open Button and a click
  # on it opens the turn in the pane and marks its entries, as the band key `9` does for the newest turn (issue #232). A second
  # click on the same turn clears the marks: the band draws no Button while the pane is shown, the strip does. The click is a
  # synthetic SGR click (bytes sent with tmux), not a real mouse (design study S10).
  Scenario: An interactive strip draws the counts and an open Button on the duration line, and a click on it opens the turn
    Given the tracker config file:
      """
      { "version": 1, "global": { "ui": { "turnStrip": "interactive" } } }
      """
    And a Claude Code session with the artifact-tracking mod
    When I type "Note https://one.example/a and https://two.example/b for later. Reply ok."
    And Claude finishes
    Then no permission dialog is open
    And the screen matches /^ {2}\+2 new open/
    And the screen does not show "+2 new · /track turn 1"
    When I click the open Button of the strip until the pane selects the row showing "one.example" and marks 2 rows
    Then the screen does not show "Keys go to the prompt."
    And the screen shows "Tab ↑↓ move"
    And the screen shows "View: list · 2 marked"
    When I click the open Button of the strip again until the pane marks no row
    Then the screen does not show "2 marked"
