@artifacts
Feature: Track the artifacts that a session publishes

  # Not @demo. It needs a Claude login that can publish artifacts, and tmux; `claude -p` has no Artifact tool.
  # It publishes a private page to claude.ai and deletes it again. After a failure, an After hook deletes it.
  Scenario: A published page is one artifact row; a delete marks it
    Given a Claude Code session with the artifact-tracking mod and the tools "Read Write Edit Skill Artifact"
    When I type "Publish the existing page e2e/features/pages/probe.html with the Artifact tool, unchanged. Then reply with its URL."
    And Claude finishes
    Then no permission dialog is open
    And the screen shows an artifact URL
    And the screen matches /tracking Artifacts 1/

    When I type "Repeat the URL of that artifact once more. Use no tools."
    And Claude finishes
    Then the screen matches /tracking Artifacts 1/
    When I type "/track"
    Then the screen matches /E2E probe page .*published/
    When I press "Escape"
    Then the screen stops showing "Esc close"

    When I type "Delete that artifact with the Artifact tool."
    And Claude finishes, and I confirm "Permanently delete" if asked
    And I type "/track"
    Then the screen matches /E2E probe page .*published .*deleted/
    And the artifact is deleted
