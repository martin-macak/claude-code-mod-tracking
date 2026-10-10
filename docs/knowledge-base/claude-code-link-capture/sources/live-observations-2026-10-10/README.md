# Live observations, Claude Code 2.1.295, 2026-10-10

Not a verbatim snapshot. These are scripts, inputs and recorded outputs from runs of the 2.1.295 binary against a local fake API. The page [`../../README.md`](../../README.md) cites them as "observed".

The binary under test was `~/.local/share/claude/versions/2.1.295`. `claude` on PATH was already 2.1.296 on the day. No run touched a real model or account: `ANTHROPIC_BASE_URL=http://127.0.0.1:8799` and `ANTHROPIC_AUTH_TOKEN=fake`, with an empty `CLAUDE_CONFIG_DIR` and all `CLAUDE_CODE_*` variables removed from the child environment.

## Files

| Path | What it is |
| --- | --- |
| `fake-api.mjs` | Local Messages API. Answers every request with one text file (`REPLY_FILE`), or plays a list of turns with text and `tool_use` blocks (`REPLY_SEQ`). |
| `pty-run.py` | Runs the REPL in a pseudo terminal (50 x 140), types prompts, saves the raw bytes. Sets `FORCE_HYPERLINK=1` so the renderer draws OSC 8. |
| `osc8-spans.py` | Reads a capture and prints each OSC 8 span: URL, `id` param, label. A new open ends the span before it. |
| `corpora/c1..c5` | The Markdown the fake model replied with. `c5` holds raw ESC and BEL bytes. |
| `ground-truth/c1..c5.tsv` | The spans the renderer drew for each corpus (URL, `id`, label). One line per distinct id and URL. |
| `scan-file.mts`, `diff-scanner.py` | Run the example scanner on a corpus and compare its links with the ground truth. `python3 diff-scanner.py c2`. |
| `seq-tool-osc8.json`, `seq-subagent.json` | The turn lists for the `-p` runs (a Bash call that prints OSC 8; an Agent call). |
| `row-logger/` | A scratch mod that logs every `session.append` row, `turn.complete` and `session.start` to `/tmp/row-logger.json`. |
| `rows/*.json` | Its output for three `-p` runs. Attachment rows are logged by name only. |
| `logs/debug-classic-sessionstart.txt` | `--debug-file` lines that show `sec-default` bypassing a user mod's `classic.SessionStart` hook. |
| `logs/repl-links-after-clear.txt` | Visible output of `/links` before and after `/clear` in the REPL, with the example mod loaded. |

## Reproduce

```bash
E=docs/knowledge-base/claude-code-link-capture/sources/live-observations-2026-10-10
CL=~/.local/share/claude/versions/2.1.295
mkdir -p /tmp/cfg /tmp/proj
cp $E/corpora/c2-syntax.md /tmp/reply.txt
PORT=8799 REPLY_FILE=/tmp/reply.txt node $E/fake-api.mjs &
CFG_DIR=/tmp/cfg python3 $E/pty-run.py /tmp/out.bin /tmp/proj "hi"     # renderer capture
python3 $E/osc8-spans.py /tmp/out.bin | diff - <(cut -f1,2,3 $E/ground-truth/c2.tsv) # same spans
python3 $E/diff-scanner.py c2                                          # scanner against the renderer
```

For a `-p` run with the row logger, set `CLAUDE_CONFIG_DIR`, `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` as above, `REPLY_SEQ=$E/seq-tool-osc8.json` on the server, and run `$CL -p go --plugin-dir $E/row-logger --permission-mode bypassPermissions`.

## Reading the renderer from the binary

The Markdown renderer is JavaScript inside the Bun executable. `strings -n 20 "$CL" > strings.txt` makes it greppable. Identifiers are minified, so search for text that survives minification. These anchors found what the page uses:

| Anchor to grep | What it shows |
| --- | --- |
| `def(){return}` next to `lheading(` | The renderer's tokenizer overrides. `def` returns `undefined`, so reference definitions are never parsed. |
| `gfm:!0,hooks:null,pedantic:!1` | The `marked` defaults: GFM is on. |
| `case"link":{let u=e.title?` | The code that draws a link token: `mailto:`, title, label, `OSC 8` or `text (url)`. |
| `[A-Za-z0-9][\w-]*\/[A-Za-z0-9][\w.-]*)#(\d+)` | The `owner/repo#12` rule, and `/issues/` or `/-/issues/` beside it. |
| `linkSchemes:d,stripPromptTags` | The `Markdown` component's `linkSchemes` prop. Without it no scheme is filtered. |
| `FORCE_HYPERLINK` | Terminal detection for OSC 8. |

Line numbers differ per build and are not given. The code is Anthropic's. Only these anchors are kept here.
