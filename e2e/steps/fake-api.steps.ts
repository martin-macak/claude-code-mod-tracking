import { Given, Then } from '@cucumber/cucumber'
import { copiedText } from '../support/copy-probe.ts'
import { waitUntil } from '../support/wait.ts'
import type { DemoWorld } from '../support/world.ts'

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
  const readme = this.foreignRepo?.readme
  if (readme === undefined) throw new Error('fake model: start with the step "a second fake GitHub repo ..."')
  await this.startFakeApi([
    [
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'toolu_e2e_read', name: 'Read', input: { file_path: readme } },
    ],
    [{ type: 'text', text: 'Read.' }],
  ])
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
