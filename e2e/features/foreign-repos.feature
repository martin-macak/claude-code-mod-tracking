Feature: Show the PRs of a branch in a second repo

  # Issue #195. The PR lane polls the branches of the session repo. It also polls a branch that the session proved in another
  # repo: the session read a file there, the repo is on a feature branch, and a PR of that branch is in Pull requests with the
  # lane marker, though the session did not create it. The model is a script that reads the README of the second repo with the
  # Read tool, and the fake gh answers the branch query of each repo, so the scenario needs no login and reaches no GitHub.
  # The second repo lives under $HOME/.cache/cc-demo: a temporary folder is noise for the repos tracker, which makes no row of
  # a repo there. Its origin names GitHub (a push goes to a local copy, and the mod never fetches), because the repos tracker
  # reads the repo from `git remote get-url origin`. The kit tests hold every rule (repos-*.test.ts, pr-lane-foreign.test.ts).
  # The scenario proves one round trip on a real session: a Read, a row in Repos, a poll of the repo, a query for its branch
  # and a row in Pull requests. The tick is the minimum (5 s), as a guard: the visit starts the poll at once.
  Scenario: A PR on a branch of a second repo that the session read lists in Pull requests
    Given the tracker config file:
      """
      { "version": 1, "global": { "refresh": { "tickMs": 5000 } } }
      """
    And a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-main"
    And a second fake GitHub repo "e2e-owner/second" on the branch "feat/second"
    And the fake gh reports PR #9 "A teammate PR" in "e2e-owner/second" from "feat/second" into "main" as MERGEABLE
    And a fake model that reads the README of the second repo
    And a Claude Code session with the artifact-tracking mod and the tools "Read"
    When I type "Read the README of the second repo"
    And Claude finishes
    Then no permission dialog is open
    And the fake model was told "Notes of the second repo."
    When I type "/track"
    Then the screen matches /│Pull requests 1 +gh · refreshed \d+s ago/
    And the screen matches /│[^\n]*e2e-owner\/second#9/
    And the fake gh answered a discovery of "e2e-owner/second"
    And the fake gh answered no unsupported call
    And the fake origin got no push
