Feature: Show a merge conflict on a tracked PR

  # Issue #106. A fake gh (e2e/fake-gh) answers every gh call of the mod, so GitHub reports a conflict on demand.
  # The clone sits on a feature branch, because PR discovery drops the default branch. Its origin is a local copy:
  # nothing in these scenarios can reach GitHub, and the mod never pushes.
  Scenario: A conflicting PR shows the conflict chip on its row
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    And the fake gh answered "--version"
    And the fake gh answered "graphql discovery"
    And the fake gh answered no unsupported call

  # The press sends a real prompt to the model, so the scenario waits for the turn to end: the Stop line is the only sign
  # that the engine took the prompt. The key does nothing until the PR lane has saved its look at the PR, so it is pressed
  # until the row says "queued". The session has no tool at all (`--tools ''` and `--strict-mcp-config`), so the model
  # cannot run git or gh, whatever the prompt asks and whatever permission mode the machine has (issue #215: the demo
  # system prompt alone did not stop it, and `gh pr view` made the fake gh fail the scenario). So the last two steps guard
  # the gh calls of the mod and of Claude Code, and the push step stays a tripwire for a scenario that gives tools. The
  # rewrite that keeps a push off GitHub is proved by the unit test of fakeGithubClone.
  Scenario: The resolve key sends its prompt and marks the row queued
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-conflict"
    And the fake gh reports PR #7 "Fix the fake conflict" from "feat/fake-conflict" into "main" as CONFLICTING
    And a Claude Code session with the artifact-tracking mod
    When I type "/track"
    Then the selected row shows "#7"
    And the screen matches /│[^\n]*#7[^\n]*✗ conflicts/
    When I press "c" until the screen matches /│[^\n]*#7[^\n]*queued/, then Claude finishes
    Then no permission dialog is open
    And the screen matches /│[^\n]*#7[^\n]*queued/
    And the fake gh answered no unsupported call
    And the fake origin got no push
