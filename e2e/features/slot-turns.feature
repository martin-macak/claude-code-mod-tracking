Feature: The rows of processes, repos, agents and worktrees have turns

  # Issue #206. #133, #201, #203, #204 and #205 put the turn of the call on the rows that the trackers keep in a slot of their own.
  # The kit and `fakePorts` proved the rules. These scenarios show them in a real session: the model is a script (the fake
  # Messages API, support/fake-api.ts), so no model turn is paid and no login is needed, and the tools, the hooks, the turn
  # numbers, `/track turn n` and the pane are the real ones. The scenarios wait for events (the end of a turn, the screen),
  # never for a fixed time. A background task is stopped by the scenario or by the end of the session.
  # `/track turn n` calls a row that a later turn named again `again`, and its header counts it as `seen again`.

  Scenario: A process row is new in the turn that started it, and seen again in the turn that stopped it
    Given a fake model that starts the background task "sleep 600" and stops it with TaskStop in the next prompt
    And a Claude Code session with the artifact-tracking mod and the tools "Bash TaskStop"
    When I type "Start the task"
    And Claude finishes
    Then no permission dialog is open
    When I type "/track turn 1"
    Then the screen shows "1 new"
    And the screen matches /new +background task sleep 600 +created/
    # The TaskStop of the model is a sighting of the row (issue #204). The engine's id of the task is in the call.
    When I type "Stop the task"
    And Claude finishes
    And I type "/track turn 2"
    Then the screen shows "1 seen again"
    And the screen matches /again +background task sleep 600 +created/
    When I type "/track"
    Then the selected row shows "sleep 600"
    And the screen matches /│  type: background task/
    And the screen matches /│  turns: first 1 · last 2/

  Scenario: A repo row is new in the turn that visited it, and seen again in the next turn that visits it
    Given a fake GitHub repo "e2e-owner/e2e-repo" with the clone on the branch "feat/fake-main"
    And a second fake GitHub repo "e2e-owner/second" on the branch "feat/second"
    And a fake model that reads the README of the second repo in each of two prompts
    And a Claude Code session with the artifact-tracking mod and the tools "Read"
    When I type "Read the README of the second repo"
    And Claude finishes
    Then no permission dialog is open
    When I type "/track turn 1"
    Then the screen matches /new +main e2e-owner\/second feat\/second +read/
    When I type "Read it again"
    And Claude finishes
    And I type "/track turn 2"
    Then the screen shows "seen again"
    And the screen matches /again +main e2e-owner\/second feat\/second +read/
    When I type "/track"
    Then the selected row shows "e2e-owner/second"
    And the screen matches /│  type: main/
    And the screen matches /│  turns: first 1 · last 2/

  # The case that the kit could not run (the kit drops `agentId` on `$.tool.call`): the Bash call of a subagent. The row it makes
  # lands in the turn that spawned the agent, with the agent's own row. The session runs in the default permission mode: in auto
  # mode the spawn opens a notice about the classifier, which a fake API cannot answer.
  Scenario: A process row that a subagent started lands in the turn that spawned the agent
    Given a fake model that spawns a subagent which starts the background task "sleep 120"
    And the session asks for permission in the default mode
    And a Claude Code session with the artifact-tracking mod and the tools "Agent Bash"
    When I type "Ask an agent to start the task"
    And Claude finishes
    # The agent runs in the background: the first Stop comes before the agent ends. Wait for the turn that its end starts, or the
    # next command is typed into a prompt that is busy.
    And the screen shows "The agent started it."
    And the screen matches /✻ .* for .* done .*shell still running/
    And I type "/track turn 1"
    Then the screen shows "2 new"
    And the screen matches /new +claude-code-mod-tracking ✓ Start the task/
    And the screen matches /new +background task sleep 120 +created/
    When I type "/track"
    Then the selected row shows "this session"
    When I press "Tab" 2 times
    Then the selected row shows "sleep 120"
    And the screen matches /│  turns: first 1 · last 1/

  Scenario: A worktree row is new in the turn that entered it, and seen again in the turn that left it
    Given a fake model that enters the worktree "slot-wt" and leaves it in the next prompt
    And the session asks for permission in the default mode
    And a Claude Code session with the artifact-tracking mod and the tools "EnterWorktree ExitWorktree"
    When I type "Enter the worktree"
    And Claude finishes
    Then no permission dialog is open
    When I type "/track turn 1"
    Then the screen shows "1 new"
    And the screen matches /new +slot-wt worktree-slot-wt +created/
    When I type "Leave the worktree"
    And Claude finishes
    And I type "/track turn 2"
    Then the screen shows "1 seen again"
    # ExitWorktree names the worktree again (issue #205). The action keep leaves the worktree, so the pane has its row.
    And the screen matches /again +slot-wt worktree-slot-wt +created/
    When I type "/track"
    Then the selected row shows "claude-code-mod-tracking"
    When I press "Tab"
    Then the selected row shows "slot-wt"
    And the screen matches /│  turns: first 1 · last 2/
