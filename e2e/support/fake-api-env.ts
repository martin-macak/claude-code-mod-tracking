import { join } from 'node:path'

// What a session needs to talk to the fake Messages API (support/fake-api.ts) and to nothing else: the address, a token that
// is no secret, and a config folder of its own, so no login or setting of the person reaches the run.

/** The folder the harness makes for the session: the file that tells claude the first-run setup is done. */
export const FAKE_HOME_FILE = '.claude.json'
export const FAKE_HOME_TEXT = '{"hasCompletedOnboarding":true}\n'

/**
 * The variables of the session that runs against the fake. `env(1)` sets them for claude only, so they win over the tmux
 * server's own. The traffic that is no part of a turn (telemetry, updates) is switched off.
 */
export function fakeApiEnv(url: string, home: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: url,
    ANTHROPIC_AUTH_TOKEN: 'fake',
    CLAUDE_CONFIG_DIR: home,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  }
}

/**
 * The variables of a Claude Code session that runs the harness. A session started from inside another one inherits them,
 * and claude would then join the parent: its id, its socket, its bridge. `env(1) -u` removes them for claude only. The
 * settings that switch features on (`CLAUDE_CODE_ENABLE_*`) stay.
 */
export const PARENT_SESSION_VARS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
]

/** The path of the first-run file in a folder. */
export const homeFile = (home: string): string => join(home, FAKE_HOME_FILE)
