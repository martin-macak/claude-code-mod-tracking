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
