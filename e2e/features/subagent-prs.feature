Feature: List again the PRs that a subagent created after a cold resume

  # Issue #247. A cold `claude --continue` starts a new process, and its hooks hear nothing of the old calls. The mod reads the
  # transcript back (issue #202), but the Bash call of a subagent is not in it: a subagent writes its own transcript. The replay
  # reads the transcript of each subagent that an `Agent` use names, and takes the PR URL from the last line of a successful
  # `gh pr create` (a guess, kept with the mark `via: 'text'`). This scenario is the live check of that URL text in a real
  # subagent transcript, for a background subagent. A foreground subagent is not a case: this engine backgrounds the agent
  # anyway (N20 stays open). The model is a script, with a script of its own for the subagent (the main loop asks at once, so one ordered script would run the Bash call in the main loop). And the fake gh prints the URL as the real gh does and answers the PR query. The clone is on another branch than the head of the PR, and the PR goes into a base (`release/x`) that no tracked branch names,
  # so neither the discovery by head nor the discovery by base can list it: only the proof of the created PR can. The step "the
  # fake model was told" waits for the result of the subagent: its next request holds the result, which the engine wrote to the transcript first. The session runs in the default permission mode: in auto mode the spawn
  # opens a notice about the classifier, which a fake API cannot answer (issue #206). The kit tests hold every rule
  # (auto-tracker.test.ts, replay.test.ts). The step that resumes also removes the state that the mod stored for the session, which
  # a new process would carry: the replay of the transcripts is then the only source of the list.
  Scenario: A PR that a background subagent created is listed again after a cold resume
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/clone-branch"
    And the fake gh reports PR #7 "Opened by the agent" from "feat/agent-branch" into "release/x" as MERGEABLE
    And a fake model that spawns a background subagent which runs "gh pr create --title x --body y"
    And the session asks for permission in the default mode
    And a Claude Code session with the artifact-tracking mod and the tools "Agent Bash"
    When I type "Ask an agent to open the PR"
    And Claude finishes
    And the screen shows "The agent opened the PR."
    Then the fake gh answered "pr create"
    And the fake model was told "/e2e-owner/e2e-repo/pull/7"
    When the session exits and resumes cold
    And the fake gh answered "--version"
    And the fake gh has been quiet for 3 seconds
    And I type "/track"
    Then the screen matches /│[^\n]*#7[^\n]*Opened by the agent/
    And the fake gh answered no unsupported call
