import { Given, Then } from '@cucumber/cucumber'
import { copiedText } from '../support/copy-probe.ts'
import type { FakeTurn } from '../support/fake-api.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

/**
 * Starts a fake model that reads the README of the second repo with the Read tool in each of `prompts` prompts, and ends each
 * prompt in "Done n." (issues #195 and #206).
 */
async function readsReadme(world: DemoWorld, prompts: number): Promise<void> {
  const readme = world.foreignRepo?.readme
  if (readme === undefined) throw new Error('fake model: start with the step "a second fake GitHub repo ..."')
  const turns: FakeTurn[] = []
  for (let n = 1; n <= prompts; n++)
    turns.push(
      [
        { type: 'text', text: `Read ${n}.` },
        { type: 'tool_use', id: `toolu_e2e_read_${n}`, name: 'Read', input: { file_path: readme } },
      ],
      [{ type: 'text', text: `Done ${n}.` }],
    )
  await world.startFakeApi(turns)
}

// A model that is a script (support/fake-api.ts): Claude asks one question with the AskUserQuestion tool, the scenario
// answers it in the real dialog of the real session, and Claude then says "Noted." and stops. Put the step before the step
// that starts the session. The session runs in a config folder of its own against the fake, so it needs no login.
// The two options of the question have a description each, so the dialog shows what the mod must keep.
Given(
  'a fake model that asks {string} under the header {string} with the options {string} and {string}',
  async function (this: DemoWorld, question: string, header: string, first: string, second: string) {
    await this.startFakeApi([
      [
        { type: 'text', text: 'I have a question.' },
        {
          type: 'tool_use',
          id: 'toolu_e2e_ask',
          name: 'AskUserQuestion',
          input: {
            questions: [
              {
                question,
                header,
                multiSelect: false,
                options: [
                  { label: first, description: `Choose ${first}.` },
                  { label: second, description: `Choose ${second}.` },
                ],
              },
            ],
          },
        },
      ],
      [{ type: 'text', text: 'Noted.' }],
    ])
  },
)

// Issue #195. The model reads the README of the second repo (`a second fake GitHub repo ...`) with the Read tool, and then
// says "Read.". The session did not start there, so the repos tracker sees a repo that it did not start in. The session
// needs the tool: `and the tools "Read"`. Put the step after the one that makes the second repo.
Given('a fake model that reads the README of the second repo', async function (this: DemoWorld) {
  await readsReadme(this, 1)
})

// What the engine told the model about the tool: the answer of the dialog, as the model reads it. It proves the round trip
// of the dialog ran in the real session, and that the mod, which only listens, changed nothing in it.
Then('the fake model was told {string}', async function (this: DemoWorld, text: string) {
  const api = this.fakeApi
  if (api === undefined) throw new Error('the fake model was told: no fake model in this scenario')
  await waitUntil(() => (api.toolResults().some(r => r.includes(text)) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the fake model to be told "${text}"`,
    last: () => JSON.stringify(api.toolResults()),
  })
})

// Issue #246. What the engine told the model about a slash command: the engine puts the reply of a command in the next request
// as a `<local-command-stdout>` block, which is no tool result. The text a command printed is only in such a block when the
// stored row holds it, so this is the check that the model did not read what the screen showed (a `ui.render` rewrite draws
// text that the stored row does not hold). A reply reaches the model in the next request, so type a prompt and let Claude
// finish before these steps.
Then('a command reply to the fake model holds {string}', async function (this: DemoWorld, text: string) {
  const api = this.fakeApi
  if (api === undefined) throw new Error('a command reply to the fake model holds: no fake model in this scenario')
  await waitUntil(() => (api.commandReplies().some(r => r.includes(text)) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `a command reply to the fake model to hold "${text}"`,
    last: () => JSON.stringify(api.commandReplies()),
  })
})

// The absence of words in every command reply. It waits until the model has been sent at least one reply, or the check would
// hold for a model that was sent nothing. Put the positive step before it, so the reply that the words were left out of is
// known to be there.
Then('no command reply to the fake model holds {string}', async function (this: DemoWorld, text: string) {
  const api = this.fakeApi
  if (api === undefined) throw new Error('no command reply to the fake model holds: no fake model in this scenario')
  await waitUntil(() => (api.commandReplies().length > 0 ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: 'a command reply to reach the fake model (the check would hold for nothing)',
    last: () => JSON.stringify(api.commandReplies()),
  })
  const holding = api.commandReplies().filter(r => r.includes(text))
  if (holding.length > 0)
    throw new Error(`a command reply to the fake model holds "${text}": ${JSON.stringify(holding).slice(0, 400)}`)
})

// The copy key of the questions tracker hands its text to the engine, which writes the clipboard of the machine. This probe
// plugin answers the engine's `ui.copy` event without writing it and logs the text, so the run never touches the clipboard
// (support/copy-probe.ts). Put the step before the step that starts the session.
Given('a plugin that answers ui.copy and logs the text', function (this: DemoWorld) {
  this.installCopyProbe()
})

// What the key copied, as the probe heard it: the text of the last copy holds the words.
Then('the copy log holds {string}', async function (this: DemoWorld, text: string) {
  const probe = this.copyProbe
  if (probe === undefined) throw new Error('the copy log holds: no copy probe in this scenario')
  await waitUntil(() => (copiedText(probe.logFile)?.includes(text) ? true : undefined), {
    timeoutMs: this.config.screenTimeoutMs,
    what: `the copy log to hold "${text}"`,
    last: () => JSON.stringify(copiedText(probe.logFile) ?? null),
  })
})

// Issue #206. The model starts a background task with the Bash tool in its first prompt, and stops it with TaskStop in its
// second one. The id of the task is the engine's, so the second turn reads it from the Bash result (`FakeStep` is a function).
// The session needs both tools: `and the tools "Bash TaskStop"`. The first prompt gets the turn "Started." after the call,
// the second one "Stopped.".
Given(
  'a fake model that starts the background task {string} and stops it with TaskStop in the next prompt',
  async function (this: DemoWorld, command: string) {
    await this.startFakeApi([
      [
        { type: 'text', text: 'I will start it.' },
        { type: 'tool_use', id: 'toolu_e2e_bg', name: 'Bash', input: { command, run_in_background: true } },
      ],
      [{ type: 'text', text: 'Started.' }],
      results => {
        // Only the Bash result of the first prompt, and the engine's own words for it.
        const bash = results.find(r => r.id === 'toolu_e2e_bg')
        const taskId = bash === undefined ? undefined : /running in background with ID: (\w+)/.exec(bash.text)?.[1]
        if (taskId === undefined)
          throw new Error(`fake model: no task id in the tool results ${JSON.stringify(results)}`)
        return [
          { type: 'text', text: 'I will stop it.' },
          { type: 'tool_use', id: 'toolu_e2e_stop', name: 'TaskStop', input: { task_id: taskId } },
        ]
      },
      [{ type: 'text', text: 'Stopped.' }],
    ])
  },
)

// Issue #206. The model enters a worktree with EnterWorktree in its first prompt and leaves it with ExitWorktree (keep) in its
// second one. The session needs both tools: `and the tools "EnterWorktree ExitWorktree"`. The first prompt ends in "Entered.",
// the second in "Left.".
Given(
  'a fake model that enters the worktree {string} and leaves it in the next prompt',
  async function (this: DemoWorld, name: string) {
    await this.startFakeApi([
      [
        { type: 'text', text: 'I will enter it.' },
        { type: 'tool_use', id: 'toolu_e2e_enter', name: 'EnterWorktree', input: { name } },
      ],
      [{ type: 'text', text: 'Entered.' }],
      [
        { type: 'text', text: 'I will leave it.' },
        {
          type: 'tool_use',
          id: 'toolu_e2e_exit',
          name: 'ExitWorktree',
          input: { action: 'keep' },
        },
      ],
      [{ type: 'text', text: 'Left.' }],
    ])
  },
)

// Issue #206. The subagent case. The model spawns a subagent with the Agent tool, and the subagent starts a background task with
// its own Bash call. The fake plays the subagent too: its requests come in order, after the spawn and before the answer to it,
// because the main loop waits for the agent. The session needs both tools: `and the tools "Agent Bash"`.
Given(
  'a fake model that spawns a subagent which starts the background task {string}',
  async function (this: DemoWorld, command: string) {
    await this.startFakeApi([
      [
        { type: 'text', text: 'I will ask an agent.' },
        {
          type: 'tool_use',
          id: 'toolu_e2e_agent',
          name: 'Agent',
          input: {
            description: 'Start the task',
            prompt: 'Start the background task.',
            subagent_type: 'general-purpose',
          },
        },
      ],
      [
        { type: 'text', text: 'I will start it.' },
        { type: 'tool_use', id: 'toolu_e2e_sub_bg', name: 'Bash', input: { command, run_in_background: true } },
      ],
      [{ type: 'text', text: 'The task runs.' }],
      [{ type: 'text', text: 'The agent started it.' }],
    ])
  },
)

// Issue #247. The subagent case of a cold resume. The model spawns a background subagent, and the subagent runs one Bash command,
// which a scenario makes `gh pr create` against the fake gh. The main loop asks for its next turn at once, while
// the subagent runs, so one ordered script would give the Bash turn to the main loop (the scenario then proves nothing of a
// subagent transcript). The subagent has a script of its own, told apart by its system prompt. The session needs both tools:
// `and the tools "Agent Bash"`. A foreground spawn is not a case: this engine backgrounds the agent anyway (N20 stays open).
Given(
  'a fake model that spawns a background subagent which runs {string}',
  async function (this: DemoWorld, command: string) {
    await this.startFakeApi(
      [
        [
          { type: 'text', text: 'I will ask an agent.' },
          {
            type: 'tool_use',
            id: 'toolu_e2e_agent',
            name: 'Agent',
            input: {
              description: 'Open the PR',
              prompt: 'Open the pull request.',
              subagent_type: 'general-purpose',
              run_in_background: true,
            },
          },
        ],
        [{ type: 'text', text: 'The agent opened the PR.' }],
      ],
      [
        [
          { type: 'text', text: 'I will open it.' },
          { type: 'tool_use', id: 'toolu_e2e_sub_pr', name: 'Bash', input: { command } },
        ],
        [{ type: 'text', text: 'The PR is open.' }],
      ],
    )
  },
)

// Issue #206. The model reads the README of the second repo in each of two prompts (the Read tool), so the repos tracker sees
// the repo in turn 1 and again in turn 2. The first prompt ends in "Done 1.", the second in "Done 2.".
Given('a fake model that reads the README of the second repo in each of two prompts', async function (this: DemoWorld) {
  await readsReadme(this, 2)
})
