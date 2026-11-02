Feature: The Jira capture from acli commands

  # Issue #226. #149 made a Bash call of `acli jira workitem view KEY` a sighting of the Jira item. The kit tests carry its
  # acceptance criteria. This scenario shows it in a real session: the model is a script (the fake Messages API,
  # support/fake-api.ts), so no model turn is paid and no login is needed, and acli is a fake (support/fake-acli.ts), so no
  # Jira site, no account and no network is used. The tool hook, the allow rule, the capture, the refresh through `acli` and the
  # pane are the real ones. The session runs in the default permission mode: the allow rule of the tool, and not the mode of the
  # machine, must spare the dialog.

  Scenario: A Bash call of acli jira workitem view tracks the work item, and the pane shows its title from the fake
    Given a fake acli logged in to "e2e.atlassian.net" with the work item "ABC-1" "The fake work item" of type "Task" in status "In Progress" of category indeterminate
    And a fake model that runs the command "acli jira workitem view ABC-1"
    And the session asks for permission in the default mode
    And a Claude Code session with the artifact-tracking mod and the tool "Bash(acli jira workitem view:*)"
    When I type "Look at the work item"
    And Claude finishes
    Then no permission dialog is open
    And the fake acli answered "jira workitem view" for "jira workitem view ABC-1"
    When I type "/track"
    Then the pane shows "ABC-1"
    And the pane shows "The fake work item"
    And the fake acli answered "jira auth status"
    And the fake acli answered no unsupported call
