Feature: /track clean --yes tasks stops a real background task

  # Issue #209. #122 built `/track clean --yes tasks` over the kit and a fake engine. These scenarios run it in a real session:
  # the model is a script (the fake Messages API, support/fake-api.ts), so no model turn is paid, and the engine, the Bash and
  # Monitor tools, TaskStop, the hooks and the process table are the real ones. Each scenario starts its own task and checks that
  # task only: it kills nothing else. The command of each task has a number of its own, so the process table names it alone.

  Scenario: Auto mode: --yes tasks stops a real background task, the row reads killed and the log has one entry
    Given the session runs in auto permission mode
    And a plugin that logs the origin of TaskStop calls
    And a fake model that starts the background task "sleep 3209"
    And a Claude Code session with the artifact-tracking mod and the tools "Bash TaskStop"
    When I type "Start the task"
    And Claude finishes
    Then no permission dialog is open
    And the process "sleep 3209" is running
    When I type "/track clean"
    Then the screen matches /sleep 3209: stop/
    When I type "/track clean --yes tasks"
    Then the screen matches /sleep 3209: done/
    And the process "sleep 3209" is gone
    # The plugin made this TaskStop (issue #204): the log shows the live origin and tool_use_id.
    And the TaskStop log has 1 line
    And the TaskStop log line 1 has origin plugin "artifact-tracking"
    And the TaskStop log line 1 has a tool_use_id that starts with "toolu_plugin_"
    When I type "/track clean --log"
    Then the screen shows "Clean log, newest first (1 entry):"
    And the screen matches /manual +tasks +task:\w+ +stop +done/
    When I type "/track"
    Then the screen matches /sleep 3209 +background task +killed/

  Scenario: Default mode, the control: --yes tasks stops a real background task
    Given the session asks for permission in the default mode
    And a fake model that starts the background task "sleep 3210"
    And a Claude Code session with the artifact-tracking mod and the tools "Bash TaskStop"
    When I type "Start the task"
    And Claude finishes
    Then the process "sleep 3210" is running
    When I type "/track clean --yes tasks"
    Then the screen matches /sleep 3210: done/
    And the process "sleep 3210" is gone
    When I type "/track clean --log"
    Then the screen shows "Clean log, newest first (1 entry):"

  Scenario: A Monitor task: --yes tasks stops it, the row reads killed and the log has one entry
    Given the session runs in auto permission mode
    And a plugin that logs the origin of TaskStop calls
    And a fake model that starts a Monitor on "sleep 3211"
    And a Claude Code session with the artifact-tracking mod and the tools "Monitor TaskStop"
    When I type "Watch it"
    And Claude finishes
    Then the process "sleep 3211" is running
    When I type "/track clean"
    Then the screen matches /Monitor: stop/
    When I type "/track clean --yes tasks"
    Then the screen matches /Monitor: done/
    And the process "sleep 3211" is gone
    And the TaskStop log has 1 line
    And the TaskStop log line 1 has origin plugin "artifact-tracking"
    And the TaskStop log holds "Successfully stopped task"
    And the TaskStop log holds "local_bash"
    When I type "/track"
    Then the screen matches /Monitor +monitor +killed/
    When I type "/track clean --log"
    Then the screen shows "Clean log, newest first (1 entry):"

  # The contrast for the plugin's TaskStop: the log shows what origin the engine gives the TaskStop of the model.
  Scenario: The TaskStop of the model has the origin of the engine
    Given the session runs in auto permission mode
    And a plugin that logs the origin of TaskStop calls
    And a fake model that starts the background task "sleep 3212" and stops it with TaskStop in the next prompt
    And a Claude Code session with the artifact-tracking mod and the tools "Bash TaskStop"
    When I type "Start the task"
    And Claude finishes
    And I type "Stop the task"
    And Claude finishes
    Then the process "sleep 3212" is gone
    And the TaskStop log has 1 line
    And the TaskStop log line 1 has origin plugin "engine"
    And the TaskStop log line 1 has a tool_use_id that starts with "toolu_e2e_stop"
