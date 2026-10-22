Feature: The questions that Claude asks are listed with their answers

  # Issue #71. The model is a script (support/fake-api.ts): it asks one question with the AskUserQuestion tool and then says
  # "Noted.". The dialog, the answer, the hook and the mod are real, and the session runs in a config folder of its own against
  # a fake Messages API, so it needs no login. The kit tests (questions-*.test.ts, questions-wiring.test.tsx) hold every
  # rule. These scenarios prove one round trip on a real session: the dialog opens, the key answers it, the model is told the
  # answer, and the mod keeps it. The engine draws the reply of a command as Markdown: the `##` of the heading, the `**` of a
  # label and the `>` of a quote are not on the screen, the list marks and the words are.

  Scenario: A question and my answer are listed by /track qa, word for word
    Given a fake model that asks "Where should the records live?" under the header "Storage" with the options "State only" and "State and store"
    And a Claude Code session with the artifact-tracking mod
    When I type "Ask me where"
    Then the screen shows "Where should the records live?"
    When I press "Enter"
    And Claude finishes
    Then the fake model was told "State only"
    When I type "/track qa"
    Then the screen shows "Q1 · turn 1 · answered"
    And the screen shows "- [x] State only: Choose State only."
    And the screen shows "- [ ] State and store: Choose State and store."

  Scenario: The pane lists the call as one summary row
    Given a fake model that asks "Where should the records live?" under the header "Storage" with the options "State only" and "State and store"
    And a Claude Code session with the artifact-tracking mod
    When I type "Ask me where"
    Then the screen shows "Where should the records live?"
    When I press "Enter"
    And Claude finishes
    And I type "/track"
    # The reply of /track is a transcript line and the model reads it: it names the group and holds no question or answer.
    Then the screen shows "artifact-tracking: Questions  1 call · /track qa prints them"
    # The rows are in the pane. The docked pane clips the description of the row, so the match allows a cut word.
    And the screen matches /Questions\s+1\s+1 call/
    And the screen matches /Q1\s+Storage → \S+\s+question\s+answered\s+T1/

  # The copy key `y` hands the call to the engine with `$.ui.copy`. A probe plugin answers that event without `next`, so the
  # engine never writes the clipboard of this machine, and the log holds the text that the key copied.
  Scenario: The copy key hands the selected call to the engine as Markdown
    Given a plugin that answers ui.copy and logs the text
    And a fake model that asks "Where should the records live?" under the header "Storage" with the options "State only" and "State and store"
    And a Claude Code session with the artifact-tracking mod
    When I type "Ask me where"
    Then the screen shows "Where should the records live?"
    When I press "Enter"
    And Claude finishes
    And I type "/track"
    Then the selected row shows "Q1"
    When I press "y"
    Then the copy log holds "Q1 · turn 1 · answered"
    And the copy log holds "- [x] **State only**: Choose State only."
    And the screen matches /Copied Q1 as Markdown/

  Scenario: Esc on the dialog is a declined call
    Given a fake model that asks "Where should the records live?" under the header "Storage" with the options "State only" and "State and store"
    And a Claude Code session with the artifact-tracking mod
    When I type "Ask me where"
    Then the screen shows "Where should the records live?"
    When I press "Escape"
    # An Esc aborts the turn, and the Stop hook does not run for an aborted turn, so the step "Claude finishes" would wait for ever.
    Then the screen shows "User declined to answer questions"
    And the screen matches /for \d+s · done/
    When I type "/track qa"
    Then the screen shows "Q1 · turn 1 · declined"
    # The words are the structured error of the result, which keeps the engine's own "Error:" mark.
    And the screen shows "Declined: Error: The user"
