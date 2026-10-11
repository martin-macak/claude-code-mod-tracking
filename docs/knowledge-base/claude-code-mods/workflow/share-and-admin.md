# Share a mod, and administer mods

How to publish a mod through a marketplace, what the installer sees, how versions and updates work, and which managed settings an administrator uses to control mods. Pinned to Claude Code 2.1.295; admin content comes from the public docs snapshot of 2026-10-09 ([docs: admin](../sources/code-claude-com-2026-10-09/mods/admin.md)).

## Share

A mod is a plugin. Sharing a mod is sharing a plugin that has a hooks module. ([docs: create:362](../sources/code-claude-com-2026-10-09/mods/create.md#L362))

| Audience | Way |
| --- | --- |
| A few people | Send the folder or a `.zip`. They run `claude --plugin-dir`. ([docs: publish](../sources/code-claude-com-2026-10-09/plugins/publish.md#L70)) |
| A team | Own marketplace (a repository with `marketplace.json`). Register it in the repo's settings for everyone. |
| An organization | Managed settings. See [Admin](#admin-managed-settings). |
| Anyone | Public marketplace repository, or submit to Anthropic's directory. |

### The minimal marketplace file

The shortest marketplace is the mod's own repository. Save `.claude-plugin/marketplace.json` beside `plugin.json`. One entry; `source` is the repository root. ([ref:91-99](../sources/claude-code-2.1.295/reference.md#L91), [docs: publish:87-103](../sources/code-claude-com-2026-10-09/plugins/publish.md#L87))

```json
{
  "name": "<marketplace>",
  "owner": { "name": "<author>" },
  "plugins": [{ "name": "<mod>", "source": "./" }]
}
```

- Keep the entry `name` equal to the `plugin.json` `name`. If they differ, installing by the manifest name fails with `Plugin "<name>" not found in marketplace`. ([docs: create-marketplace:144](../sources/code-claude-com-2026-10-09/plugins/create-marketplace.md#L144))
- Marketplace names `inline`, `skills-dir`, `synced` are reserved. Names that imitate Anthropic's are refused. ([docs: marketplace-reference:39](../sources/code-claude-com-2026-10-09/plugins/marketplace-reference.md#L39))
- A mod written in a session first needs a copy out of the session's mods folder. That copy becomes the repository. ([ref:101](../sources/claude-code-2.1.295/reference.md#L101))
- One `claude plugin validate <mod>` reads the marketplace file, the manifest and the hooks module. *Observed output:* [validate-test-debug.md](validate-test-debug.md#marketplace-file-and-readme-advice).
- Do not start the plugin `name` with `claude-`. `validate` fails names that look like Anthropic's. ([docs: create:369](../sources/code-claude-com-2026-10-09/mods/create.md#L369))
- Say in the README which Claude Code version you tested. The API changes between releases. ([docs: create:369](../sources/code-claude-com-2026-10-09/mods/create.md#L369))

### The install line

Put this in the README, in a code block, with what follows it (`y` to add the marketplace, then a scope). ([ref:85-89](../sources/claude-code-2.1.295/reference.md#L85))

```text
/plugin install <mod> --marketplace <owner>/<repo>
```

| Form | Needs |
| --- | --- |
| `/plugin install <mod> --marketplace <owner>/<repo>` in a session | Claude Code 2.1.275 or later |
| `claude plugin install <mod> --marketplace <owner>/<repo>` in a shell | 2.1.292 or later |
| `claude plugin marketplace add <owner>/<repo>`, then `claude plugin install <mod>@<marketplace>` | Older versions |

([docs: publish:109-116](../sources/code-claude-com-2026-10-09/plugins/publish.md#L109)) `validate` prints this line as advice when the README lacks it, and `<owner>/<repo>` stays a placeholder until you validate the folder that holds `marketplace.json`.

The line is a terminal's. A local session started by the desktop app's Code tab answers that the command is not available. A mod installed from a terminal at user scope still loads there, and its `ui.render` hooks draw for the `desktop` surface. ([ref:105](../sources/claude-code-2.1.295/reference.md#L105))

### What the installer sees

In order ([ref:103](../sources/claude-code-2.1.295/reference.md#L103)):

1. `Add marketplace?` naming `github:<owner>/<repo>`. Answer `y`. A known marketplace skips this.
2. The plugin details. The user scope comes first. Choose with Enter.
3. For a mod with `userConfig` options: a screen that sets them.
4. For a hooks-module-only mod: a tick and `Installed <mod>. Plugin is now active.` Hooks run in that session at once, with no reload. Under user scope they run in each later session.

Errors: `Marketplace file not found at <path>` (no `marketplace.json`; the question stays up) and `Plugin "<mod>" not found in marketplace "<marketplace>"`. The source can be a GitHub `owner/repo`, a git URL, or a folder path.

Before installing, a careful user can list what the mod does without running it: clone it, then `claude plugin validate <dir>` and read `hooks:` / `calls:`. ([docs: overview:85](../sources/code-claude-com-2026-10-09/mods/overview.md#L85)) For a component inventory use `claude --plugin-dir <dir> plugin details <name>`. ([docs: security:105](../sources/code-claude-com-2026-10-09/plugins/security.md#L105))

### Scopes

| Scope | Enabled for | Recorded in |
| --- | --- | --- |
| user | You, in every project | `~/.claude/settings.json` `enabledPlugins` |
| project | Everyone who clones the repo | `.claude/settings.json` (commit it). Each collaborator still runs `claude plugin install <name>@<marketplace> --scope project` once. |
| local | You, in this repo only | `.claude/settings.local.json` |

Local overrides project, project overrides user. ([docs: install:138-150](../sources/code-claude-com-2026-10-09/plugins/install.md#L138)) A project-scope plugin in a directory the person has not trusted loads nothing until they answer the trust prompt. ([docs: admin:81](../sources/code-claude-com-2026-10-09/mods/admin.md#L81))

### Versions, caching, and updates

- The version is how Claude Code detects an update. If it is unchanged, `claude plugin update` says `already at the latest version` and the cache stays. ([docs: loading:268-274](../sources/code-claude-com-2026-10-09/plugins/loading.md#L268))
- Resolution order: manifest `version`, then marketplace-entry `version`, then the source's commit SHA (12 chars). A `./` entry in a git-hosted marketplace uses the commit SHA. ([docs: loading:280-295](../sources/code-claude-com-2026-10-09/plugins/loading.md#L280))
- With `version` set in `plugin.json`, **bump it on each release**. Otherwise users keep the old copy. ([docs: publish:172](../sources/code-claude-com-2026-10-09/plugins/publish.md#L172))
- Installed plugins are cached under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. ([docs: security:109](../sources/code-claude-com-2026-10-09/plugins/security.md#L109)) Your edits do not reach an installed copy until a new version and a reinstall or update. ([docs: create:371](../sources/code-claude-com-2026-10-09/mods/create.md#L371))
- A plugin from a **local-path** marketplace is loaded in place: it reads current files at each session start, whatever its version. ([docs: loading:278](../sources/code-claude-com-2026-10-09/plugins/loading.md#L278), [ref:76](../sources/claude-code-2.1.295/reference.md#L76))
- Update now: `claude plugin update <plugin>@<marketplace>`. It ends with `Restart to apply changes.`; in a session run `/reload-plugins`. Auto-update is **off** for third-party marketplaces by default, on for official ones. ([docs: install:353-372](../sources/code-claude-com-2026-10-09/plugins/install.md#L353))
- Tag a release when other plugins constrain your version: `claude plugin tag` makes `{name}--v{version}`. ([docs: publish:174](../sources/code-claude-com-2026-10-09/plugins/publish.md#L174)) The full release flow, with the zip artifact: [release.md](release.md).
- Never rename a published plugin. Use a `renames` map in the marketplace. ([docs: publish:182](../sources/code-claude-com-2026-10-09/plugins/publish.md#L182))
- The CLI has `claude plugin list`, `details`, `enable`, `disable`, `uninstall`, `update`, `configure`, `tag`, `prune`. ([cli-help](../sources/claude-code-2.1.295/cli-help.txt))

## Admin: managed settings

All of this is **public docs**; it is not in the types file. Source: [docs: admin](../sources/code-claude-com-2026-10-09/mods/admin.md), settings table at [docs: reference:300-310](../sources/code-claude-com-2026-10-09/mods/reference.md#L300). Mods are on by default from 2.1.286 (desktop) and 2.1.287 (terminal). `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is ignored from 2.1.287 at any value. ([docs: admin:11,51](../sources/code-claude-com-2026-10-09/mods/admin.md#L51)) The public mods reference says "as of v2.1.290". ([docs: reference:9](../sources/code-claude-com-2026-10-09/mods/reference.md#L9))

### Policy matrix

| Goal | Setting | Source |
| --- | --- | --- |
| No installed mod runs; settings hooks untouched | `pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly = true` | [admin:26-47](../sources/code-claude-com-2026-10-09/mods/admin.md#L26) |
| No mods and no hooks at all, managed hooks too | `disableAllHooks: true` in managed settings | [admin:142](../sources/code-claude-com-2026-10-09/mods/admin.md#L142) |
| Only the organization's mods | `allowManagedModsOnly`, plus install your mods so they "count as yours" | [admin:143](../sources/code-claude-com-2026-10-09/mods/admin.md#L143) |
| Any mod from approved marketplaces | Marketplace restrictions + `disableSideloadFlags: true` | [admin:144](../sources/code-claude-com-2026-10-09/mods/admin.md#L144) |
| Any mod, checked by your own mod | Install your mod, list it with `sec-default@builtin` in `prependPlugins` | [admin:145](../sources/code-claude-com-2026-10-09/mods/admin.md#L145) |

```json
{
  "pluginConfigs": {
    "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } }
  }
}
```

| Setting | Effect | Where read |
| --- | --- | --- |
| `allowManagedModsOnly` | Refuses users' mods, including `--plugin-dir` and mods Claude wrote in a session. Settings hooks, status lines, `/goal` keep working. Built-in mods keep running. | Managed settings only |
| `allowModsToOverrideDenyRules` | Lets a user's mod approve a call that a `deny` rule refuses. Unset: deny rules hold. | Managed settings only |
| `allowManagedHooksOnly` | Wider: only the organization's mods and built-in mods load; also blocks hooks in users' own settings files. | Managed |
| `disableAllHooks` | Widest. In managed settings, stops mods in every installed plugin (yours too) and every settings hook. | Any settings file |
| `disableSideloadFlags` | Rejects `--plugin-dir`, `--plugin-url` (and, per the CLI reference, `CLAUDE_CODE_PLUGIN_DIRS` folders), also `--agents`, `--mcp-config`. Stops session-written mods. Exit 1 at startup. | Managed |
| `prependPlugins`, `appendPlugins` | Plugin ids (`name@marketplace`) that run before / after every user mod. A managed `prependPlugins` list replaces the default: it must name `sec-default@builtin` to keep the guard. | Managed. User settings only on a machine with no managed settings and no Team/Enterprise sign-in. |
| `pluginConfigs` | `userConfig` values, keyed by id | User or managed |
| `--safe-mode` | Turns installed mods off for a session, yours too | CLI flag |

Rules for the guard's options ([admin:216-221](../sources/code-claude-com-2026-10-09/mods/admin.md#L216)):

- The options are read only under the id `cc-plugin-sec-default@builtin`. `prependPlugins` accepts `sec-default@builtin`; `pluginConfigs` does not.
- Only managed settings count. The same entry in user, project, local or `--settings` files does nothing.
- The guard must load. If you set `prependPlugins`, name it in the list.
- The guard fails closed: unreadable managed settings refuse every user mod.

### The built-in guard (`sec-default`)

- Loads ahead of every user mod when the machine has managed settings or the user is signed in on a Team or Enterprise plan. A user on an API key or Bedrock/Vertex/Foundry gets it only with managed settings. ([admin:58-63](../sources/code-claude-com-2026-10-09/mods/admin.md#L58))
- It protects what the organization manages: managed hooks' input and decisions, the system prompt, managed `CLAUDE.md`, settings reads, managed MCP tools. It adds no other restriction. ([admin:64-65](../sources/code-claude-com-2026-10-09/mods/admin.md#L64))
- It makes three moves: continue past the user tier (`next.to(e, 'append')`), refuse a user-tier caller, or pass. Source: `github: anthropics/claude-code@e47cc82 mods/sec-default/hooks/register.ts`.
- Deny rules and managed `PreToolUse` hooks bind Claude's tool calls. They do **not** bind a mod's own `$.fs` / `$.process` calls. With `Read(.env)` denied, a mod can still `$.fs.read` it. ([admin:66](../sources/code-claude-com-2026-10-09/mods/admin.md#L66))
- `$.http.fetch` obeys network policy. A program started by `$.process.run` does not. ([admin:78](../sources/code-claude-com-2026-10-09/mods/admin.md#L78))

### Mods that count as "the organization's"

All three must hold ([admin:233-237](../sources/code-claude-com-2026-10-09/mods/admin.md#L233)):

1. Managed `enabledPlugins` sets the plugin to `true`.
2. Managed settings name its marketplace as a **directory** on the machine, by absolute path (`extraKnownMarketplaces` with `"source": { "source": "directory", "path": ... }`).
3. The marketplace lists the plugin by a **relative path**, so it loads in place.

Anything copied into the cache (GitHub, git, URL, npm source) counts as a user's, even if enabled by managed settings. Make the directory writable only by an administrator. Managed settings from the claude.ai admin console carry the keys but cannot place the directory. ([admin:239,268](../sources/code-claude-com-2026-10-09/mods/admin.md#L239))

```json
{
  "extraKnownMarketplaces": { "acme-tools": { "source": { "source": "directory", "path": "/opt/acme/claude-plugins" } } },
  "enabledPlugins": { "acme-guard@acme-tools": true },
  "prependPlugins": ["acme-guard@acme-tools", "sec-default@builtin"],
  "pluginConfigs": { "cc-plugin-sec-default@builtin": { "options": { "allowManagedModsOnly": true } } },
  "disableSideloadFlags": true
}
```

Confirm with `claude --debug`: `hooks module acme-guard@acme-tools loaded ... tier prepend` for yours; `refused by cc-plugin-sec-default: mods are limited to your organization's by policy (allowManagedModsOnly)` for a user mod. `tier user` plus `prependPlugins names ..., which is not an enabled managed plugin with a hooks module; skipped` means it did not count. ([admin:186-190,299-300](../sources/code-claude-com-2026-10-09/mods/admin.md#L186))

### Policy mods and `plugin.register`

A mod in `prependPlugins` can hook `plugin.register`. It gets `e.tier` (`prepend`, `user`, `append`, `builtin`) and `e.uses.calls` (`process.run`, not `$.process.run`), and answers `{ refuse: 'reason' }` or `next(e)`. It can hook any `$` call by its name (`on('fs.write', ...)`) and read `next.origin.plugin`. ([admin:312-358](../sources/code-claude-com-2026-10-09/mods/admin.md#L312))

- A throwing or slow check **fails open** (the hook is skipped). To fail closed, add `.catch` that returns `{ refuse }` for `e.tier === 'user'`. ([admin:368-393](../sources/code-claude-com-2026-10-09/mods/admin.md#L368))
- The worker thread that runs installed mods unloads **all** non-built-in mods, yours included, after three crashes. `/reload-plugins` brings them back. ([admin:362](../sources/code-claude-com-2026-10-09/mods/admin.md#L362))
- `claude --safe-mode` runs without installed mods, yours too.
- Real example: `sec-default` hooks `plugin.register` with `{ tier: 'user' }` and a `.catch` that refuses. (`github: anthropics/claude-code@e47cc82 mods/sec-default/hooks/register.ts`)

### Telemetry streams

`telemetry.log` / `telemetry.mark` hooks pick a stream with `to`: `"collector"` is the customer's OpenTelemetry collector; `"anthropic"` is Anthropic's own analytics and is for plugins built into the CLI. A bare `telemetry.*` hook or an `anthropic` matcher in a user plugin is a `validate` error. `validate` lists the streams under `hooks telemetry for:`. ([ref:31](../sources/claude-code-2.1.295/reference.md#L31)) *Observed:* [validate-test-debug.md](validate-test-debug.md#telemetry-streams-a-live-failure).

## Security notes

- A mod is **not sandboxed**. It runs JavaScript inside Claude Code with the installer's permissions: files, processes, network, env vars, settings (API keys), every prompt and tool call, model calls on the user's plan. ([docs: overview:64-84](../sources/code-claude-com-2026-10-09/mods/overview.md#L64), [docs: security:31,39](../sources/code-claude-com-2026-10-09/plugins/security.md#L31))
- The sandbox isolates Claude's Bash commands. A process a mod starts runs outside it. ([docs: overview:79](../sources/code-claude-com-2026-10-09/mods/overview.md#L79))
- A mod can approve a tool call before the permission prompt (`tool.check`). It can approve a call an `ask` rule would prompt for. It cannot change the permission prompt's text. ([docs: admin:67,80](../sources/code-claude-com-2026-10-09/mods/admin.md#L67))
- Review before install: read `hooks:` and `calls:` from `validate`. Watch `$.fs.*`, `$.process.*`, `$.http.fetch`, `$.env.get`, `$.settings.read`, `$.env.set`, `$.mcp.call`, `$.model.complete`, `$.prompt.submit`, `$.session.send`, and hooks `tool.call`, `prompt.submit`, `session.append`, `tool.check`. ([docs: admin:104-133](../sources/code-claude-com-2026-10-09/mods/admin.md#L104))
- `validate` reads the source statically. It "refuses to load a mod that uses the mods API in a way this command can't read". ([docs: admin:117](../sources/code-claude-com-2026-10-09/mods/admin.md#L117)) That means the `calls:` list is a floor for what the mod can do through `$`, but the mod's own JavaScript and the processes it starts are not audited. *(inference)*
- With auto-update on for a marketplace, reviewed files can change on disk. ([docs: security:35](../sources/code-claude-com-2026-10-09/plugins/security.md#L35))

## See also

- [develop.md](develop.md): load modes, reload, types
- [validate-test-debug.md](validate-test-debug.md): the validate output in full
- [../examples/README.md](../examples/README.md): `sec-default` and `telemetry` sources
- [../reference/limits-and-diagnostics.md](../reference/limits-and-diagnostics.md)
- [../concepts/dispatch-and-guards.md](../concepts/dispatch-and-guards.md): `.catch`, tiers, `next.to`
