# Process tracking signals (issue #33 spike)

Date: 2026-10-13.

This note records what the mod can detect for long-lived runtime artifacts.
The types contract names the core fields:
`Bash.result.backgroundTaskId`, `backgroundedByUser`, `timedOutAfterMs`,
`Monitor.result.taskId`, and notification `task.id`, `task.status`,
`task.toolUseId`
([d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L20348),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L20764),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L14624),
[d.ts](../sources/claude-code-2.1.295/types/claude-code.d.ts#L9826)).

## Signals, reliability and probe cost

| Source | Detect signal | Live state signal | Reliability | Probe cost |
| --- | --- | --- | --- | --- |
| Background Bash | `tool.call` Bash result `backgroundTaskId` | `task-notification` (`task.status`) and `TaskStop` | High | None (event only) |
| Monitor | `tool.call` Monitor result `taskId` | `task-notification` (a `<status>` when the source ends, the `<event>` text at the deadline), `TaskStop`, and the end of a workflow agent that armed it | High | None (event only) |
| Docker run / compose up | Parse Bash command (`docker run -d`, `docker compose up -d`) and stdout container id | `docker ps -a` (+ compose label filter) | Medium-high (exact when the id is the run's own output: `containerIdExact`, see "Parsing the Bash command"; or when the project is known) | Medium |
| tmux / screen | Parse Bash command (`tmux new -d -s`, `screen -dmS`) | `tmux ls`, `screen -ls` | Medium-high (exact when session name is explicit) | Low |
| Detached process | Parse Bash command (a part that ends in `&`, or `setsid -f`) and PID from an `echo $!` that prints to the tool result | `ps -p <pid> -o lstart=,command=`; with no PID, one `ps -A -o pid=,lstart=,command=` lookup by command and start time | Medium (reuse guarded by command fingerprint and start time) | Low-medium |

## What ships now, and what waits

Shipped in this change:

- Background Bash tasks.
- Monitor tasks.
- Docker container and compose project rows.
- tmux and screen session rows.
- Detached process rows, with or without `echo $!`.

## Parsing the Bash command

One Bash call often holds several commands: `docker info; docker run -d ...`
or `mkdir -p d && docker compose -p x up -d`. The parser splits the command
into simple commands first ([`core/lib/shell.ts`](../../../../plugins/artifact-tracking/core/lib/shell.ts)): on `;`, `&&`, `||`,
`|`, `&`, newlines, subshells and groups. Each part is read on its own.

- Quoted text stays one word. So `bash -c '...'`, `ssh host '...'` and
  `echo "...; ..."` start nothing local and are not tracked.
- Heredoc bodies and comments are skipped.
- `VAR=x`, `sudo`, `env`, `nice`, `nohup`, `timeout`, `gtimeout`, `ionice`, `stdbuf`, `setsid`, `caffeinate`, `doas`, `time`, `command`, `exec` and
  `builtin` in front are stripped. `timeout`, `ionice`, `stdbuf`, `caffeinate`
  and `doas` take their own options and positional words with them (`timeout
  -s KILL 5 npm run dev` is `npm run dev`). `ionice -p PID` runs no command, so
  it stays, and so does `caffeinate -t 60`. These are external programs, so they read an
  option in quotes or behind a redirection as an option: the shell removes both
  first (`ionice "-c3" cmd`, `setsid "-f" cmd`). A `time` that is quoted or
  that runs behind `sudo`, `env`, `nice`, `nohup` or another wrapper is the
  external `/usr/bin/time`: it also takes `-f FMT`, `-o FILE` and other flags,
  quoted or not.
  The reserved word `time` takes its options with it: `-p`,
  then `--`, each at most once, as bash reads them, and only when typed whole
  with no redirection right before them. So `time -p git status` is
  `git status`. `time -x git status` is the command `-x`, and so is
  `time "-p" git status` (bash: `-p: command not found`): an option in quotes
  or after a backslash is the command. So is an option behind a redirection:
  `time >/dev/null -p git status` and `time -p 2>&1 -- git status` run the
  command `-p` and the command `--` (bash 3.2 and 5.3), also with a heredoc or
  a here-string. The splitter drops the redirection from the words, so it marks
  the word behind it (`Segment.redir`). A reserved word behind a redirection
  is the command too: `time >/dev/null ! git push` fails with `!: command not
  found` (bash 3.2 and 5.3), so no reader sees `git push` (issue #259). A
  redirection behind the options, in
  front of the command, changes nothing: `time -p >/dev/null git status` is
  `git status`. A word glued to a redirection (`time -p>/dev/null git status`)
  stays one word, as for every other command, so no option is read there. The
  options of `command`, `exec` and `builtin` stay, so `command -v git` is no
  call of `git`.
- `!`, `if`, `while`, `until`, `do`, `then`, `else` and `elif` in front are
  stripped, in any order with the wrappers above: `time ! git push` and
  `! time git push` are both valid shell. A part that is only `done`, `fi` or
  `esac` is no command and makes no row, so `done &` (a backgrounded loop) has
  no row. `$!` after it is the pid of the loop shell, so no earlier background
  command takes it. A `&` behind the `}` of a group or the `)` of a subshell,
  of `(( ))` or of a substitution (`{ a; } &`, `( a; : ) &`, `x=$(a) &`) is the
  same, but `}` and `)` make no part of their own, so `splitShell` puts
  `afterBgShell` on the next part, and the parser reads that as the end of the
  last job. The flag is set for every `&` right behind a closed group,
  subshell or substitution, so also for `sleep $(a) &`, `( sleep 101 ) &` and
  `( true; sleep 101 ) &` (the last command is an external command), where `$!`
  names that command and not a shell (see "Not read" below): no earlier job
  takes the line there either. The flag stays in the shell that read the `&`. A
  substitution, a backtick pair, a subshell and a part of a pipeline are shells
  of their own, and a `&` that ends a group inside them leaves the `$!` of the
  parent alone. So `sleep 100 & x=$({ :; } &); echo $!`,
  `sleep 100 & ( { :; } & ); echo $!`, `sleep 100 & { { :; } & } | cat; echo $!`
  and `sleep 100 & cat | { { :; } & }; echo $!` print the pid of `sleep 100`
  (bash 5.3.20 and 3.2.57), and its row keeps it. A scope that closes while the
  flag still waits for a segment gives back the flag of its parent, and a
  pipeline part drops it. A group is the shell of its parent, so
  `{ { :; } & }; echo $!` names the inner shell. A process substitution sets
  `$!` in its parent whatever it holds, so the segment after
  `cat <({ :; } &) > /dev/null` is flagged (issue #263). A backgrounded builtin (`echo x &`, `cd d &`) is the same:
  its shell makes no row, and the pid line that the next `echo $!` prints is
  dropped, so the job after it gets its own pid. An `echo $!` (or a `printf`
  of `$!`) takes or drops a pid line only when its output reaches the tool
  result (`keepsStdout`, the rule of "The id of a container", issue #231).
  `echo $! > pid.txt` (also `>>`, `1>`, `&>`, `>|`, a glued `>pid.txt`),
  `echo $! | tee f`, `PID=$(echo $!)`, an `echo $!` in a redirected group and
  one after `exec > f` print no pid line, so they take none and drop none: in
  `sleep 90 & echo $! > pid.txt; echo 4242` the line `4242` is the later echo's,
  and the row gets no pid. A backgrounded `echo $! > f &` is a backgrounded
  builtin like any other: the `$!` after it names its shell. The pid lines pair
  with the echoes that print by position, and only when there is one line for
  each echo (the owner's decision, the same count rule as `pairContainerIds`).
  Any other count gives no job of the call a pid, and the probe finds the rows
  by their fingerprint. A pipe is read as no output, as for the id of a
  container, but `cat` may print the line. In
  `sleep 100 & echo $! | cat; sleep 101 & echo $!` with the lines `4242` and
  `4243` the one echo that prints stands against two lines, so neither job gets
  a pid. Before the rule the line slid onto the next job, and `sleep 101` took
  `4242`, the pid of `sleep 100`. The same rule drops the pid of a call where
  another command prints a bare number line (`sleep 90 & echo $!; echo 4243`).
  An echo counts only when `$!` is set: one before the first `&` prints an empty
  line, and `setsid -f` forks on its own and sets no `$!`, so neither counts. A
  second `echo $!` of the same job prints the same line again, counts, and gives
  its job nothing more. Every detector reads the
  command after these words, not only the detached-process one. A variable set
  in a branch applies in text order: the last write wins, as with `&&` and `||`.
  Evidence (grade: *verified-kit* for the parser, not *verified-live*): the
  tests [process-parse.test.ts:1752](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1752 "test('builtin: echo $! after a backgrounded buil"),
  [:1770](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1770 "test('builtin: the $! line of a backgrounded bui"),
  [:1780](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1780 "test('builtin: a backgrounded cd, pushd, export,") and
  [:2564](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2564 "test('if: a background command after ! and time")
  pass under `claude plugin test`, and [shell.test.ts:54](../../../../plugins/artifact-tracking/tests/shell.test.ts#L54 "test('stripLead drops reserved words and wrapper")
  covers `stripLead`. The shell fact under the builtin rule was run in `bash`
  and `zsh` outside Claude Code (macOS). `bash 3.2.57` with
  `sleep 3 & S=$!; echo x & B=$!; echo "sleep=$S builtin=$B"` printed
  `sleep=96411 builtin=96412`. `zsh 5.9` printed `sleep=98712 builtin=98713`.
  The two pids differ: `$!` after `echo x &` names the echo's shell, not the
  sleep.
- What `$!` names, and what the parser reads (issue #231). Each form ran in
  `bash 5.3.20` first. Grade for the bash facts: observed in bash 5.3.20 by a
  manual probe, not *verified-kit*. It is no `claude plugin test` run, and no
  committed test runs bash. The probe ran a `sleep` job with `&`, then the
  form, then printed the command that `ps` shows for `$!`. A form shows one of
  three things: `bash ...` (a shell that still runs: `bash -c ...`, or the
  script file), nothing (the shell or the command has exited already), or the
  external command that bash ran in place (`( sleep 5 ) &` and
  `( true; sleep 5 ) &` show `sleep 5`). The parser side is *verified-kit*: the
  tests are `group: ...`, `pipeline: ...`, `coproc: ...` and `builtin: ...` in
  `process-parse.test.ts`, and the tests `splitShell flags the segment after a
  & ...` and `splitShell keeps the flag of a & ...` in `shell.test.ts`.
  - The row gets the pid: a simple command with `&` (also with `VAR=x`,
    `nohup`, `exec`, `!`, or a redirection), the last part of a pipeline
    (`true | sleep 101 &` names `sleep 101`), a job in a group with no `&` of
    its own (`{ sleep 101 & }; echo $!`), and a job that a function starts
    when it runs (`f() { sleep 101 & }; f; echo $!`).
  - No row, and no pid for any job: `$!` names a shell, so no earlier job takes
    the line. A builtin of the set (`echo printf true false : wait read test
    [ [[ set unset export`), `cd`, `pushd` and `(( ))`, with `&`. A group (a
    group is never run in place: `{ a; } &`, `{ true; sleep 101; } &`). A
    subshell whose last command is a builtin or a compound (`( sleep 101; : ) &`,
    `( sleep 101 && true ) &`, `( sleep 101 | cat ) &`, `( : ) &`). A loop, `if`
    or `case` with `&` (`done &`). A command that is only assignments or a
    builtin with a substitution (`x=$(a) &`, `: $(a) &`). A pipeline that ends
    in a builtin or a group (`sleep 101 | true &`, `cat | { :; } &`). A `coproc`
    of a group (`coproc NAME { a; }`, `coproc NAME { true; sleep 101; }`) or of
    a builtin (`coproc :`). A subshell whose last command is an external simple
    command, and `coproc` of an external simple command, are not here: bash runs
    that command in place, so `$!` names it (see "Not read").
  - Not read. These forms are limits of the parser. The row, or an earlier job,
    can get a wrong pid, or a process has no row.
    - An external command that ends in a substitution or a process
      substitution, then `&`, is a process, and `$!` names it. Examples:
      `sleep $(cat p) &`, `sleep $((n)) &`, `` python -m http.server `cat p` & ``,
      `nohup node server.js --port $(cat p) > log 2>&1 &` and `cat <(a) &`. In
      bash 5.3.20 `$!` showed `sleep 7311` for `sleep $(echo 7311) &`, `sleep
      7312` for `sleep $((7312)) &`, `nohup sleep 7314` for `nohup sleep
      $(echo 7314) &`, and `cat /dev/fd/63` for `cat <(sleep 1) &`. Only
      `x=$(a) &` and `: $(a) &` name a shell. The parser makes no row for these
      commands, because the `&` ends an empty part (old behavior), so they get
      no pid. Since issue #231 no earlier job takes their line.
    - A subshell whose last command is an external simple command, then `&`,
      and a `coproc` of an external simple command. Bash runs that last
      command in place, with no shell around it, so `$!` is a live process that
      names that command, and the parser has no row for it. This is the same
      class as `sleep $(a) &`. Examples: `( sleep 101 ) &`,
      `( sleep 101 ) 2>&1 &`, `( ( sleep 101 ) ) &`, `( A=1 sleep 101 ) &`,
      `( true; sleep 101 ) &`, `( true && sleep 101 ) &`,
      `( false || sleep 101 ) &` and `coproc sleep 101`. In bash 5.3.20 `$!`
      showed `sleep 5` for each of them (`( sleep 0.1; sleep 5 ) &` and
      `( true; true; sleep 5 ) &` too). `$!` names a shell, or nothing once the
      shell has exited, when the last command of the list is a builtin or a
      compound: `( sleep 5; true ) &`, `( sleep 5; : ) &`,
      `( sleep 5 && true ) &`, `( sleep 5 | cat ) &`,
      `( if :; then sleep 5; fi ) &`, `( true; ( sleep 5 ) ) &`,
      `( true; { sleep 5; } ) &` and `( : ) &`. A group is never run in place:
      `{ sleep 5; } &`, `{ true; sleep 5; } &`, `coproc N { sleep 5; }` and
      `coproc N { true; sleep 5; }` name a shell, and `coproc :` shows nothing
      (its shell has exited). The rule depends on the version: `bash 3.2.57`
      (macOS `/bin/bash`) runs only a subshell of one simple command in place,
      so `( true; sleep 5 ) &` shows a shell there (it has no `coproc`). No
      earlier job takes the line in any of these. These calls give `sleep 100`
      no pid: `sleep 100 & ( sleep 101 ) & echo $!`,
      `sleep 100 & ( true; sleep 101 ) & echo $!` and
      `sleep 100 & coproc sleep 101; echo $!`.
    - A part of a backgrounded pipeline before the last one
      (`sleep 101 | true &`, `sleep 101 | sleep 102 &`) is a process too. `$!`
      names the last part, and the parser makes no row for the parts before it
      (old behavior).
    - A `&` job inside a part of a pipeline sets no `$!` in its parent
      (`sleep 3 & P=$!; { sleep 3 & } | cat; echo $P $!` prints one pid twice),
      but the parser lets the job take a line
      (`sleep 100 & { sleep 101 & } | cat; echo $!` gives `sleep 101` the
      line). A `coproc` in a part of a pipeline clears the job before it for
      the whole call: a safe miss that loses a pid and gives no wrong one.
    - A `&` job in a `( ... )`, `$( ... )` or backtick shell: the parser keeps
      the `$!` per shell (`Segment.shell`, issue #263). A shell starts with the
      `$!` of the shell around it and sets none back, so
      `sleep 100 & ( sleep 101 & ); echo $!` and
      `sleep 100 & ( coproc sleep 101 ); echo $!` keep the pid line for
      `sleep 100`, and `( sleep 101 & echo $! )` gives it to `sleep 101`.
    - A builtin outside the set (`pwd &`, `source f &`, `. ./env &`, `kill 1 &`,
      `exit 0 &`, `declare -x A=1 &`, `local x=1 &`, `trap : EXIT &`,
      `type ls &`, `eval "a" &`) runs in a subshell, and `$!` names that shell.
      The set holds these names now, so they make no row and take no line.
    - A bare redirection with `&` (`> f &`, `<f &`, `2>/dev/null &`) is a
      shell too: it flags the next segment like a backgrounded group.
    - A process substitution (`exec 3< <(a)`, `cat <(a) > /dev/null`, also
      `>(a)`) sets `$!` in the shell that holds it, whatever it holds, and
      `eval "a &"` does too (a `&` that is not part of `&&`, `>&`, `<&` or `&>`
      in a word of `eval`). They flag the next segment of that shell, so no
      earlier job takes the line. A process substitution in a part of a
      pipeline sets it in that part only and flags nothing.
    - `$!` names the subshell that runs the whole list for `a && b &`,
      `a || b &` and `time a &`. The parser gives the row no pid then
      (`Segment.bgList`, and a `time` word in front): the probe finds the
      process by its fingerprint. A pipeline (`a | b &`) is no list, and
      `a && b | c &` is one. The shell decides the rest of the cases: bash 5.3
      runs the last simple command of a function in place, so `f(){ sleep 3; };
      f &` names `sleep 3` there, while bash 3.2 and zsh name a shell for
      `f &`. The parser keeps the pid of the shell for `f &` (a limit, pinned).
- `cd` and `export` move the cwd and env for the parts after them. The Bash
  `tool.call` input has no cwd, so the hook reads `$.session.cwd()`.
- A `cd` in a list that ends with `&` runs in a background subshell and does
  not move the folder of the parts after the `&`. That holds for `cd x &`,
  `cd x && y &`, `{ cd x; } &` and `for ...; do cd x; done &`. A `{` group
  opens a list of its own (`cd x && { y & }` keeps the `cd`). A newline right
  after `&&`, `||` or `|` continues the list.
  Evidence (grade: *verified-kit* for the parser): the tests in
  `repos.test.ts` and `process-parse.test.ts` named "after a cd that runs in
  the background", and a differential run against real `bash` (macOS) of
  random `cd`, `pushd`, `&`, `&&`, `;`, newline, group, subshell and loop
  lists, which showed no difference in the folder of the last command.
- A `cd` in a part of a pipeline runs in a subshell and does not move the folder
  of the parts after the pipeline: `cd x | cat` and `cat | cd x`, the last part
  too (bash has no `lastpipe` by default). A part is a whole command, so
  `{ cd x; } | cat`, `for ...; do cd x; done | cat` and `( cd x ) | cat` are one
  part each. The parts run side by side: a `cd` in one part does not reach the
  next, and every part starts in the folder that the pipeline starts in. A `cd`
  outside a pipeline still moves the folder, and `>|` is a redirection, not a
  pipe (an escaped `>` before the `|`, as in `\>|`, is a word, so that `|` is a
  pipe). The `)` that ends a `case` pattern is no end of a subshell, so
  `( case x in x) cd x ;; esac ); cmd` keeps the folder. A `(` in front of a
  pattern is no subshell either, and the arm after a pattern is a list of its own
  (`cd x && case y in y) sleep 1 & esac` keeps the `cd`). `esac` can follow a
  compound with no `;;` (`a | { b; } esac`, `fi esac`, `done esac`): it ends the
  case, and the pipeline before it. Only the `in` of the `case` header makes a
  `(` a pattern start: a word `in` at the end of an arm (`echo logged in`) does
  not.
  Code: `splitShell` [shell.ts:299](../../../../plugins/artifact-tracking/core/lib/shell.ts#L299 "export function splitShell(command: string): Seg"), the case state
  `theCase` [:567](../../../../plugins/artifact-tracking/core/lib/shell.ts#L567 "const theCase = () => {") and the header end [:579](../../../../plugins/artifact-tracking/core/lib/shell.ts#L579 "const caseHeaderEnds = () => {"), the part move
  [:590](../../../../plugins/artifact-tracking/core/lib/shell.ts#L590 "const moveToChild = (from: number) => {") and [:601](../../../../plugins/artifact-tracking/core/lib/shell.ts#L601 "const endPipe = (keepBg = false) => {"), the close of a compound
  [:704](../../../../plugins/artifact-tracking/core/lib/shell.ts#L704 "for (let k = 0; closesAt(clean, cleanHeads, k);"), the `>|` guard [:825](../../../../plugins/artifact-tracking/core/lib/shell.ts#L825 "if (c === '|").
  Evidence (grade: *verified-kit* for the parser): the pipeline part in
  [repos.test.ts:271](../../../../plugins/artifact-tracking/tests/repos.test.ts#L271 "test('parseRepoHintsFromBash keeps the session folder after a cd in a p"), [:283](../../../../plugins/artifact-tracking/tests/repos.test.ts#L283 "test('parseRepoHintsFromBash keeps the session folder after a cd in a g"), [:300](../../../../plugins/artifact-tracking/tests/repos.test.ts#L300 "test('parseRepoHintsFromBash moves the folder fo")
  and [:311](../../../../plugins/artifact-tracking/tests/repos.test.ts#L311 "test('parseRepoHintsFromBash reads >"), and in [process-parse.test.ts:1864](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1864 "test('parseBashProcesses keeps the session folder after a cd in a p"),
  [:1876](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1876 "test('parseBashProcesses keeps the session folder after a cd in a g"), [:1893](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1893 "test('parseBashProcesses moves the folder for a"), [:1902](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1902 "test('parseBashProcesses reads >") and
  [:1915](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1915 "test('parseBashProcesses keeps the scope of $PWD"). The case arm in [repos.test.ts:325](../../../../plugins/artifact-tracking/tests/repos.test.ts#L325 "test('parseRepoHintsFromBash keeps the session folder after a cd in a case a"),
  [:343](../../../../plugins/artifact-tracking/tests/repos.test.ts#L343 "test('parseRepoHintsFromBash keeps the session folder after a cd in a case i"), [:359](../../../../plugins/artifact-tracking/tests/repos.test.ts#L359 "test('parseRepoHintsFromBash closes the subshell"), [:370](../../../../plugins/artifact-tracking/tests/repos.test.ts#L370 "test('parseRepoHintsFromBash reads a ( in front") and
  [:388](../../../../plugins/artifact-tracking/tests/repos.test.ts#L388 "test('parseRepoHintsFromBash keeps the arm after"), and in [process-parse.test.ts:1923](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1923 "test('parseBashProcesses keeps the session folder after a cd in a case a"),
  [:1936](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1936 "test('parseBashProcesses keeps the session folder after a cd in a case i"), [:1948](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1948 "test('parseBashProcesses closes the subshell aft"), [:1958](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1958 "test('parseBashProcesses reads a ( in front of a") and
  [:1968](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1968 "test('parseBashProcesses keeps the arm after a p"). `esac` after a compound, the word `in` and the part
  bookkeeping in [repos.test.ts:400](../../../../plugins/artifact-tracking/tests/repos.test.ts#L400 "test('parseRepoHintsFromBash ends the case and t"), [:408](../../../../plugins/artifact-tracking/tests/repos.test.ts#L408 "test('parseRepoHintsFromBash reads a ( after a l"),
  [:414](../../../../plugins/artifact-tracking/tests/repos.test.ts#L414 "test('parseRepoHintsFromBash ends a pipeline par"), [process-parse.test.ts:1980](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1980 "test('parseBashProcesses ends the case and the p"),
  [:1988](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1988 "test('parseBashProcesses reads a ( after a line"), [:1993](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1993 "test('parseBashProcesses ends a pipeline part at"), and the scopes in
  [shell.test.ts:292](../../../../plugins/artifact-tracking/tests/shell.test.ts#L292 "test('splitShell gives each part of a pipeline a") to [:412](../../../../plugins/artifact-tracking/tests/shell.test.ts#L412 "test('splitShell adds no scope level for a pipel"). A differential run
  against real `bash` 5.3 (macOS) of random `cd`, `pushd`, `|`, `|&`, `&`, `&&`,
  `;`, newline, group, subshell, loop and `case` lists (`;;`, `;&`, `;;&`, `(x)`
  and `a|b` patterns): 21500 random commands, 0 differences in the folder of the
  last command, and the two readers never disagree. The same commands gave 6756
  differences before the fix. The fuzz harness is a scratch script and is not in
  the repo, so only the tests above can be run again.
- A `}` right before the closing backtick of a `` `...` `` pair ends its group
  (`` `cd x; { a; }` ``). A `}` right before an opening backtick does not:
  `` }`x` `` is the word `}x`. Only a `>` or `<` that was typed, with no quote
  and no backslash, is a redirection. `\>`, `'>'` and `2\>\&1` are words, and so
  is the word after them (`printf x \> git -C /repo status` keeps every word).
  `splitShell` counts for each word how many of its first characters were typed,
  and notes whether the word held any quote or escape (an empty quote counts).
  `dropRedirections` reads a redirection from that head only. A target that was
  quoted or escaped belongs to the typed `>` before it (`>\>`, `>'f g'`). The
  `&` of `>&` and `2>&1` is part of the redirection only after a typed `>` or
  `<`. After `'>'&` or `\>&` it runs the command in the background.
  A `case` pattern is no command. Its words stand in no segment, so `cd)` moves
  no folder, and `if)`, `for)` or `done)` open or close no compound. The reader
  knows three places of a `case`: the subject, a pattern list and an arm. In a
  pattern list a `|` is no pipe, and a `{` or `}` is a word. `esac` first in a
  pattern list ends the case: `case x in esac` is an empty case, and `esac)` there
  is a syntax error in `bash`. Behind `(` or `|` it is a pattern. A keyword is a
  keyword only as typed: `'esac'`, `"esac"`, `\esac` and `esac''` (an empty quote
  counts) are patterns in every position, so they end no case. A quoted `case`,
  `if` or `!` opens no compound: `'case' x in; a` is a command named `case`, and
  `a` is no pattern word. A condition can
  open a compound: the segment `if for i in 1; do :; done; then` opens an `if`
  and a `for`, and `elif` takes one too. So the `done` closes the `for`, the `fi`
  closes the `if`, and the `&` after the `fi` backgrounds the whole `if`.
  Code: the word end before a backtick [shell.ts:834](../../../../plugins/artifact-tracking/core/lib/shell.ts#L834 "const wordEnds ="), the typed head
  [:640](../../../../plugins/artifact-tracking/core/lib/shell.ts#L640 "const typed = (ch: string) => {") and its use [:1123](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1123 "const m = REDIRECT.exec(word.slice(0, t.head))"), the `&` guard
  [:816](../../../../plugins/artifact-tracking/core/lib/shell.ts#L816 "if (c === '&' && (typedRedir === i - 1"), the compounds of a segment [:227](../../../../plugins/artifact-tracking/core/lib/shell.ts#L227 "function compoundLead(words: readonly string[],") and [:686](../../../../plugins/artifact-tracking/core/lib/shell.ts#L686 "for (const kind of lead.opens) {"), the
  pattern words [:645](../../../../plugins/artifact-tracking/core/lib/shell.ts#L645 "const endSegment = (bg: boolean) => {") and [:859](../../../../plugins/artifact-tracking/core/lib/shell.ts#L859 "if (pc?.arm === 'pattern') {"), the end of an arm
  [:946](../../../../plugins/artifact-tracking/core/lib/shell.ts#L946 "if (op.length > 1 && arm?.arm === 'arm') startPa"), the `in` and `esac` of a header and a pattern list [:610](../../../../plugins/artifact-tracking/core/lib/shell.ts#L610 "const endWord = () => {").
  Evidence (grade: *verified-kit* for the parser): a `}` before a backtick in
  [shell.test.ts:426](../../../../plugins/artifact-tracking/tests/shell.test.ts#L426 "test('splitShell ends a group at a } right befor") and [:438](../../../../plugins/artifact-tracking/tests/shell.test.ts#L438 "test('splitShell reads a } before an opening bac"), [repos.test.ts:1387](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1387 "test('parseRepoHintsFromBash ends a group at a }") and
  [process-parse.test.ts:2644](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2644 "test('parseBashProcesses ends a group at a } rig"). Quoted and escaped redirections in
  [shell.test.ts:444](../../../../plugins/artifact-tracking/tests/shell.test.ts#L444 "test('splitShell keeps a quoted or escaped redir"), [:466](../../../../plugins/artifact-tracking/tests/shell.test.ts#L466 "test('splitShell still drops a typed redirection") and [:488](../../../../plugins/artifact-tracking/tests/shell.test.ts#L488 "test('splitShell reads a & after a quoted or esc"), [repos.test.ts:1398](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1398 "test('parseRepoHintsFromBash reads a quoted or escaped > as a word', (") and
  [process-parse.test.ts:2659](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2659 "test('parseBashProcesses reads a quoted or escaped > as a word', () =>"). Case patterns in [shell.test.ts:609](../../../../plugins/artifact-tracking/tests/shell.test.ts#L609 "test('splitShell reads a case pattern as no comm"),
  [:639](../../../../plugins/artifact-tracking/tests/shell.test.ts#L639 "test('splitShell ends a case at an esac in the p"), [:650](../../../../plugins/artifact-tracking/tests/shell.test.ts#L650 "test('splitShell reads a quoted or escaped esac"), [:669](../../../../plugins/artifact-tracking/tests/shell.test.ts#L669 "test('splitShell reads a quoted or escaped case"), [:686](../../../../plugins/artifact-tracking/tests/shell.test.ts#L686 "test('splitShell opens and closes no compound fo") and [:711](../../../../plugins/artifact-tracking/tests/shell.test.ts#L711 "test('splitShell takes a stray ) in a case arm a"), [repos.test.ts:1414](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1414 "test('parseRepoHintsFromBash reads a case patter") and
  [process-parse.test.ts:2674](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2674 "test('parseBashProcesses reads a case pattern as"). Compounds in a condition in
  [shell.test.ts:718](../../../../plugins/artifact-tracking/tests/shell.test.ts#L718 "test('splitShell opens a compound of its own at"), [repos.test.ts:1445](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1445 "test('parseRepoHintsFromBash opens a compound of") and
  [process-parse.test.ts:2702](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2702 "test('parseBashProcesses opens a compound of its"). A differential run against real `bash` 5.3
  (macOS) of random lists as in the run above, now also with backtick groups,
  keyword and `cd` patterns (`cd)`, `if|x)`, `a|esac)`, `(esac)`) and compounds in
  conditions (`if`, `elif` and `while` over a loop, a group, a subshell, an `if`
  or a `case`). Each probe wrote its own folder, so every probe was compared, not
  only the last one. Five runs of 3000 to 4000 commands: 14,271 commands ran in
  `bash` and in the readers, with 0 differences, and the two readers never
  disagree. The splitter before the fix gave 319 differences in 14,274 commands
  of the same seeds (0 in the old grammar, 8 with backtick groups, 90 with
  keyword patterns, 63 with conditions, 158 with everything). Another seed with
  everything (4,601 commands) gave 0 differences after and 241 before. A
  further run compared the words of 3,000 random argument lists with quoted,
  escaped and typed `>` and `<` against the arguments that `bash` passes: 0
  differences after the fix, 2,163 before. A mutation run broke one line of the
  new bookkeeping at a time: the tests killed 33 of 34 mutants. The one that
  lives treats a `(` after a pattern word as the `(` in front of a pattern, which
  only an extended glob can show (not covered, see below).
  The fuzz harnesses are scratch scripts and are not in the repo, so only the
  tests above can be run again.
  A here-string (`<<<`) is a redirection that takes one word, glued or spaced,
  quoted or not. It is no heredoc, so the next line is a command: `cat <<<hi`
  newline `cd /x` reads both. The heredoc test skips a `<<` that stands right
  after a typed `<`, and it still starts a heredoc after a quoted or escaped `<`
  (`echo \<<<EOF` is the word `<` and a heredoc). `<>` and `n<>` are redirections
  too: their target leaves the words, so `cmd <> f` reads as `cmd`, and
  `cd <> lock /x` goes to `/x`. Only a `done`, `fi` or `esac` that was typed whole
  closes a compound, as `compoundLead` reads the other reserved words. `'done' y`,
  `\fi y`, `"esac" y` and `done'' y` are commands, as in `bash` (checked with
  commands of those names on the PATH). So the loop stays open, and it stays one
  part of its pipeline, and a `cd` in it does not reach the commands after it.
  Code: the heredoc test [shell.ts:792](../../../../plugins/artifact-tracking/core/lib/shell.ts#L792 "if (c === '<' && s[i + 1] === '<' && s[i + 2] !="), the close of a compound
  [:256](../../../../plugins/artifact-tracking/core/lib/shell.ts#L256 "function closesAt(words: readonly string[], type") and [:704](../../../../plugins/artifact-tracking/core/lib/shell.ts#L704 "for (let k = 0; closesAt(clean, cleanHeads, k);"), the redirection pattern
  [:1051](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1051 "const REDIRECT = new RegExp(String.raw`^(?<fd>${").
  Evidence (grade: *verified-kit* for the parser): here-strings in
  [shell.test.ts:749](../../../../plugins/artifact-tracking/tests/shell.test.ts#L749 "test('splitShell reads a here-string as a redire"), [repos.test.ts:1466](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1466 "test('parseRepoHintsFromBash reads the lines after a here-string', () ") and
  [process-parse.test.ts:2717](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2717 "test('parseBashProcesses reads the lines after a here-string"). Every heredoc form that the splitter knows still hides its
  body, also next to a here-string, in [shell.test.ts:778](../../../../plugins/artifact-tracking/tests/shell.test.ts#L778 "test('splitShell still skips the body of every f") and [:794](../../../../plugins/artifact-tracking/tests/shell.test.ts#L794 "test('splitShell reads a here-string and a hered"). `<>` in
  [shell.test.ts:805](../../../../plugins/artifact-tracking/tests/shell.test.ts#L805 "test('splitShell drops <> and n<> with their tar"), [repos.test.ts:1479](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1479 "test('parseRepoHintsFromBash drops the target of") and
  [process-parse.test.ts:2733](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2733 "test('parseBashProcesses drops the target of a <"). Quoted closers in
  [shell.test.ts:829](../../../../plugins/artifact-tracking/tests/shell.test.ts#L829 "test('splitShell reads a quoted or escaped done,"), [repos.test.ts:1492](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1492 "test('parseRepoHintsFromBash keeps a compound op") and
  [process-parse.test.ts:2745](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2745 "test('parseBashProcesses keeps a compound open a"). A differential run against real `bash` 5.3
  (macOS) of random lists with here-strings (glued, spaced, quoted, with a
  substitution, with a file descriptor, joined by newlines), heredocs (`<<EOF`,
  `<< EOF`, `<<'EOF'`, `<<"EOF"`, `<<-EOF`, two on a line, a command or a pipe on
  the line of the tag, bodies that look like commands), `<>` redirections and
  quoted or escaped `done`, `fi` and `esac` inside loops, branches, arms, groups
  and pipelines. Each probe wrote its own folder, as in the run above. 15,966
  commands ran in `bash` and in the readers on the old splitter, and 15,973 on the
  new one (nine runs of 3000 generated commands, two seeds, seven grammars): the
  old splitter gave 1,370 differences (461 with here-strings, 150 with `<>`, 28
  with quoted closers, 731 in the mixed runs), the new one gives 0, and the two
  readers never disagree. The heredoc-only run (1,943 commands) gave 0 before and
  after, and the grammar of the run above (2,308 and 2,312 commands) gave 0 before
  and after. A second run compared the words of 9,000 random argument lists with
  here-strings and `<>` redirections, joined by newlines too, against the
  arguments that `bash` passes: 0 differences after the fix, 3,931 before. A
  mutation run broke one line of the new code at a time: the tests killed 6 of 9
  mutants. One of the 3 that lived changed a check that the loop right after it
  repeated, and the review removed that check. The 2 others differ only for a
  second close word in one segment (`fi 'esac'`, a syntax error in `bash`).
  A heredoc tag is the next word with its quotes and backslashes removed, so
  `<<\EOF`, `<<E"O"F`, `<<$'EOF'` and `<<'EOF'` all name `EOF` and hide their
  body. The quoting rules are those of `bash`: in double quotes a backslash
  escapes only `$`, a backtick, a quote, a backslash and a newline, and a `$`
  right before a quote (`$'EOF'`, `$"EOF"`) is dropped. A `$(` or `$((` in the
  tag is part of it up to its closing `)`, as typed: `bash` does not expand the
  tag, so `<<$(echo EOF)` ends at the line `$(echo EOF)`. The scan for that `)`
  stops after 256 characters, and a substitution that never closes starts no
  heredoc. A file descriptor glued to
  `<<` (`cat 3<<EOF`, `cat {fd}<<EOF`) is part of the redirection and no word of
  the command. A variable file descriptor, a typed `{name}` right before `<`,
  `>`, `>>`, `<>` or `<<<` (`cd {fd}>f /x`, `exec {fd}<> lock`), is a redirection
  too: the `{name}` word and its target leave the words. Only an identifier
  counts, so `{1x}` and a spaced `{fd}` are words. A `<<` inside `$(( ))` or
  `(( ))` is a shift, not a heredoc tag: `x=$((1<<2))` newline `cd /x` reads both
  lines, also after a here-string (`cat <<< $((1<<2))`). The splitter marks the
  scope of such text as arithmetic. The text is arithmetic when a `)` that no
  inner `(` holds is right behind by a second `)`: `$((cd /x); y)` is a subshell
  in `$( )`, as in `bash`. A `(` in it is a grouping parenthesis, and a `$(` in it
  is a command substitution, so a heredoc there is a heredoc. The scan for the
  end of the text stops after 256 characters, so a run of unterminated `((` costs
  a bounded scan each and `splitShell` stays linear. A reserved word that was
  quoted or escaped is a command. `Segment.whole` carries the typed flag for each
  word, and `stripLead` (it takes the words with their flags, so a caller cannot
  leave them out) and `stripReserved` read it as `compoundLead` and `closesAt` do.
  `Segment.redir` is the same kind of flag for a redirection that stood right
  before the word, and `stripLead` takes it too.
  So `'done' git -C /x status` is a command named `done` (checked
  with commands of those names on the PATH): the readers see no `git`, and
  `'done' docker compose up -d` starts no project.
  Code: the heredoc test [shell.ts:792](../../../../plugins/artifact-tracking/core/lib/shell.ts#L792 "if (c === '<' && s[i + 1] === '<' && s[i + 2] !="), the tag reader
  [:514](../../../../plugins/artifact-tracking/core/lib/shell.ts#L514 "const readTag = (from: number): { text: string;") and its scan for a substitution [:498](../../../../plugins/artifact-tracking/core/lib/shell.ts#L498 "const subEnd = (open: number): number => {"), the arithmetic scan [:479](../../../../plugins/artifact-tracking/core/lib/shell.ts#L479 "const arithFollows = (from: number): boolean =>") and the scope
  flag [:899](../../../../plugins/artifact-tracking/core/lib/shell.ts#L899 "inArith() || (s[i + 1] === '(' && !/[<>]/.test(s[i - 1] ??"), the file descriptor patterns [:1046](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1046 "const FD = String.raw`(?:"), the
  typed flag per word [:31](../../../../plugins/artifact-tracking/core/lib/shell.ts#L31 "whole: boolean[]"), [:1173](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1173 "export function stripReserved(") and [:1278](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1278 "export function stripLead(seg: {").
  Evidence (grade: *verified-kit* for the parser): escaped and split tags in
  [shell.test.ts:860](../../../../plugins/artifact-tracking/tests/shell.test.ts#L860 "test('splitShell skips the body of a heredoc wit") and [:887](../../../../plugins/artifact-tracking/tests/shell.test.ts#L887 "test('splitShell reads the tag of a heredoc by t"), a substitution in the tag in [:914](../../../../plugins/artifact-tracking/tests/shell.test.ts#L914 "test('splitShell reads a command substitution in"), a file descriptor before `<<` in
  [:936](../../../../plugins/artifact-tracking/tests/shell.test.ts#L936 "test('splitShell drops the file descriptor in fr"), a variable file descriptor in [:959](../../../../plugins/artifact-tracking/tests/shell.test.ts#L959 "test('splitShell drops a variable file descripto"), the typed flag in [:991](../../../../plugins/artifact-tracking/tests/shell.test.ts#L991 "test('stripLead keeps a quoted or escaped reserv") and
  [:1012](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1012 "test('stripReserved reads the optional typed fla"), the arithmetic shift in [:1044](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1044 "test('splitShell reads << inside an arithmetic e"), [:1071](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1071 "test('splitShell still reads a heredoc next to a") and [:1093](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1093 "test('splitShell finds the end of arithmetic tex"),
  the cap of the arithmetic scan in [:1109](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1109 "const SCAN_FAMILIES: Record<string, (k: number)") and [:1125](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1125 "test('splitShell reads arithmetic text up to the"),
  and the cap of the scan in a tag in [:1139](../../../../plugins/artifact-tracking/tests/shell.test.ts#L1139 "test('splitShell reads a substitution in a hered").
  The readers: [repos.test.ts:1508](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1508 "test('parseRepoHintsFromBash skips the body of a"), [:1523](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1523 "test('parseRepoHintsFromBash drops a variable fi"), [:1536](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1536 "test('parseRepoHintsFromBash reads a quoted or escaped r") and
  [:1605](../../../../plugins/artifact-tracking/tests/repos.test.ts#L1605 "test('parseRepoHintsFromBash reads the lines after an"), and [process-parse.test.ts:2757](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2757 "test('parseBashProcesses skips the body of a her"), [:2774](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2774 "test('parseBashProcesses drops a variable file d"),
  [:2786](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2786 "test('parseBashProcesses reads a quoted or escaped r") and [:2843](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L2843 "test('parseBashProcesses reads the lines after an"). A differential run against real `bash` 5.3.20
  (macOS) of random lists with heredocs that have an escaped or split tag or a file
  descriptor (`<<\EOF`, `<<E"O"F`, `3<<EOF`, `{fd}<<-EOF`), `{fd}` redirections
  (`cd {fd}>f /x`, `exec {fd}<> lock`), quoted or escaped reserved words in front
  of a probe (`'done' git -C p1 status`, `\until`, `'!'`) and arithmetic shifts
  (`$((1<<2))`, `(( x << 2 ))`, after a here-string, in a loop header, around a
  substitution with a heredoc in it). The oracle has commands named `done`, `if`,
  `then` and so on on its PATH. A probe that such a command swallows is expected to
  be absent, so a reader that reports it fails the run (a stray probe). Seventeen
  runs of 3000 generated commands, two seeds: on the old splitter 32,925 commands
  ran in `bash` and in the readers, on the new one 32,922. The old splitter gave
  9,776 differences (783 with escaped tags or file descriptors, 408 with `{fd}`,
  3,964 with quoted reserved words, 1,475 with arithmetic, 3,146 in the mixed
  runs), the new one gives 0, and the two readers never disagree (3,632 times on
  the old one). The five grammars of the runs above (here-strings, heredocs, `<>`,
  quoted closers, and the grammar of the old fuzz) gave 0 before and after on the
  same seed. A second run compared the words of 9,000 random argument lists
  with `{fd}` redirections, a file descriptor before a heredoc, heredocs with an
  escaped tag (their body lines are calls that must never run) and the earlier forms
  against the arguments that `bash` passes: 0 differences after the fix, 6,171
  before (8,355 ran in `bash`). A mutation run broke one line of the new code at a
  time: the tests killed 28 of 28 mutants.
  Not covered: a typed `>&` with a space before its target (`cmd >& f`) keeps the
  target as a word. An extended glob in a pattern (`+(a|b))`) reads its words as
  commands in a subshell. The readers still apply every `cd` in text order, so a
  `cd` in an arm that does not match, or after a short-circuit `||`, counts.
  An arithmetic shift in the old `$[ ]` form or in
  a parameter expansion (`echo $[1<<2]`, `${x:1<<2}`) still reads `<<2` as a
  heredoc tag, so the lines after it are lost. A subscript in an assignment
  (`a[1<<2]=1`) reads `<<2` as a heredoc tag too, and so does an arithmetic
  expression of more than 256 characters. A reserved word that follows an
  assignment or a redirection (`x=1 done git -C /x status`,
  `>f done git -C /x status`) is a command in `bash`, but the readers drop it.
  A backslash escape inside a `$'...'` tag (`<<$'E\x41'`) stays unread. A `${ }`
  in a tag that holds a blank or an operator (`<<${x:-a b}`) ends the tag there,
  and a backtick substitution (``<<`echo EOF` ``) gives no tag, where `bash` takes
  the whole text as the tag. A `)` in a parameter expansion inside a command
  substitution of a tag (`<<$(echo ${x%)})`) ends the substitution too early.
  The tag is then shorter than the one `bash` reads, so the splitter never finds
  the closing line, and the commands after the real delimiter are lost (`bash`
  closes the heredoc at the line `$(echo ${x%)})`). This is a known limit.
  Grade: a manual probe, not *verified-kit*. It is no `claude plugin test` run,
  and no committed test pins it. The text was four lines: `cat <<$(echo ${x%)})`,
  `body`, `$(echo ${x%)})` and `echo after`. GNU bash 5.3.20 ran it as a script
  and printed `body` and `after`, one per line. `splitShell` (run with `node`
  v24.21.0, 2026-10-22) gave one segment: its words, as JSON, were `[["cat"]]`.
  There was no segment for `echo after`.
- The container id is a stdout line of exactly 64 hex characters. Other hex
  in the output (`docker info` prints commit ids) is not an id. A line of that
  shape is not always the id of the run: `docker ps -aq --no-trunc` and
  `docker inspect -f '{{.Id}}'` print such lines too. The parser pairs a line
  with a run by its own rule (see "The id of a container" under "Parsing the
  Bash command").
- **The id of a container (issue #231).** A row gets an id only when the id is
  the run's own output. The splitter marks each segment with where its standard
  output goes (`Segment.stdoutRedirected`, `Segment.stdoutPiped`,
  `Segment.substituted`). A run *prints* when it has none of the three marks
  (`keepsStdout`). `stdoutRedirected` is a typed `>`, `>>`, `>|`, `&>`, `&>>`,
  `>&word` or `1>` form, on the run or on the group, subshell, loop or `case`
  around it (`{ a; } > f`, `done > f`). The operator may stand glued to the last
  word: a typed `>` or `<` ends the word in front of it, as in `bash`, so
  `nginx>/dev/null`, `"nginx">f`, `{ a; }>f` and `done>f` are read like their
  spaced forms. A file descriptor in front of a `>` or `<` (`2>f`, `{fd}>f`),
  arithmetic text and an open `${ }` keep the character. The `&` of `&>` has no
  descriptor form: `12&>f` is the word `12` and the redirection `&>f`. `2>&1`,
  `2>`, `<` and `{fd}>` leave the output alone. So does a copy of fd 1 onto
  itself (`>&1`, `1>&1`, `>& 1`, `>&01`, `>&1-`, `1<&1`): `bash` saves nothing and
  changes nothing there. The target of `>& 1` is no word of the run. A copy of
  another descriptor (`>&2`, `>&-`, `>&0`) and `>& file` move the output.
  A bare `exec` with such a
  redirection (`exec > f`, `exec >> f`, `exec 1> f`, `exec &> f`,
  `exec 3>&1 >/dev/null`) moves the output of its shell for good, so it marks
  every later segment of that shell and of the subshells under it. The options
  of `exec` (`-c`, `-l`, `-a name`, `--`) matter only when a command follows:
  `exec -c > f` and `exec -a name > f` move the shell too, and `exec -c a > f`
  runs `a`. A subshell, a `$(...)`, a background list and a pipeline
  part are shells of their own: the mark ends with them. So does a group, loop,
  `if` or `case` that redirects the output (`{ exec > f; } > g; a`,
  `for ...; do exec > f; done > g; a`): it saves fd 1 and gives it back at its
  end, and the exec inside it moves the output only up to there. A group that
  redirects stderr, the input or fd 3, or that copies fd 1 onto itself (`>&1`),
  saves no fd 1, and an unredirected group is the shell itself, so
  `{ exec > f; } 2> g; a`, `{ exec > f; } >&1; a` and `{ exec > f; }; a` stay marked. `exec >&3`, which puts
  the output back, is read as one more redirection, so the later runs stay
  marked. `stdoutPiped` is a `|` or `|&` after the pipeline part that holds the
  run (`{ a; } | b` marks `a`; `echo x | a` does not). `substituted` is `$(...)`,
  backticks or an input process substitution (`<(...)`): the shell takes the
  output of the commands in it, or it goes to the pipe that the command reads.
  An output process substitution `>(...)` is none of that. Its commands read
  the pipe and write where the command around it writes, so a run in it keeps
  the output of that command (`cat > >(docker run -d nginx) </dev/null; wait`
  prints the id). The `>` of `>(...)` is the opener of the substitution, not a
  redirection of the command around it (`tee >(a) x` redirects nothing;
  `a > >(b)` does). The commands in a `>(...)` take the marks of the command
  around it: a redirected or piped group or subshell, an `exec` before it, a
  `$(...)` around it, and a redirection of fd 1 that stands before the
  substitution in the same command. When the substitution is the target of a
  redirection, bash applies the redirections from left to right, so `a` in
  `cat >f > >(a)` writes to `f`. The `>` whose target is the substitution does
  not count (`cat > >(a)`: `a` starts before that redirection takes effect). A
  redirection after the substitution (`cat > >(a) > f`) and a substitution that
  is an argument (`tee > f >(a)`, `tee >(a) > f`) are the safe side: bash starts
  the commands in it first, so they still print, but a redirection of the whole
  command marks them, and the parser takes no id for them. So does a second
  `> >(b)` after `> >(a)`: it marks `a`. A substitution in the arguments
  splits the run into segments (`docker run -d -e T=$(cat t) nginx > f` is
  `docker run -d -e T=`, `cat t` and `nginx > f`), so a redirection after it marks
  the first segment too: the splitter keeps the head of the command until an
  operator ends it. `pairContainerIds` pairs the id lines in order with the runs
  that print when the two counts match and no id repeats (two runs never print
  one id), or when one run that prints stands with lines that all say one id
  (`docker run -d --name api nginx && docker inspect -f '{{.Id}}' api`). Any other
  count says that a line came from another command, so no run takes an id. A run
  that does not print takes none, and it is left out of the count, so
  `docker run -d a > /dev/null; docker run -d b` pairs the one id line with `b`.
  A paired row has `containerIdExact: true`. It also has `containerRunAlone: true`
  when the whole Bash call is this one `docker run -d` (issue #123, the lone
  command, `isLoneRun` in `parse.ts`). Bash can put any text, an id too, on a
  bare line of the tool result: a trace (`PS4` with `BASH_XTRACEFD=1` and
  `set -x`), the message of a builtin that failed on an operand
  (`[ 0 -eq $'\n<id>\n' ]`, `sleep`, `wait`), of a failed redirection
  (`true < $'\n<id>\n'`, `: 2>&1 > $'\n<id>\n/absent'`) or of a failed
  `${y?...}` on a line of assignments, a listing (`set`, `export -f`, `env`),
  `cd -`, the report of `time`, and a substitution that the splitter cannot
  read (bash 5.3.20 and 3.2.57 printed the id for each). Nine review rounds of
  PR 285 closed one such variant each and found the next, because a list of
  commands that print nothing cannot be proven. So the parser has one rule,
  and anything else withholds the mark. The call is one simple command, one
  segment of the splitter at the top level. `docker` is its head, with no
  wrapper before `docker` (`env`, `command`, `sudo`, `time`, `nohup`, `!`) and
  no leading assignment. The command is a detached `docker run` (also `docker
  container run`). The text has no `;`, `&` or `|` (so no `&&`, no `||` and no trailing
  `&`), no redirection of any kind (no `<` and no `>`: a heredoc, a
  here-string, `2>&1`, a process substitution), no backtick, no `$(`, `${` and
  `$'`, no other `$` (a parameter) and no `*`, `?`, `[` or `~` (a glob or a tilde), and no line break that a backslash does not continue outside single
  quotes. The rule reads the raw text and follows no quote for these
  characters, so such a character in quotes counts too. Only the line break
  follows the quotes (see below).
  The cost, on purpose: `cd /x && docker run -d --name api nginx`,
  `env docker run -d --name api nginx`, `docker run -d --name api nginx > log`,
  `-v "$(pwd)":/x` and `sh -c 'a; b'` lose the mark, and the plan says
  `skipped: the run was not the whole Bash call, ...`. A newline that stands
  in quotes is no separator, but it prints: Docker echoes an argument that it
  cannot parse as it stands, so `docker run -d --name api --memory
  "<newline><id><newline>" nginx` puts `<id>` on a line of its own in
  `invalid argument` (Docker 29.9.2). A backslash continuation (an odd run of
  backslashes before the newline, outside single quotes) cannot do that: bash
  drops the pair, so a long `docker run -d \` over several lines keeps the
  mark. In single quotes a backslash is a plain character, so `--dns
  '\<newline><id>'` keeps both and prints `<id>` on a line of its own, and the
  scan of the line break follows the quotes for that. One attack stays open
  for a lone command,
  and the pairing already shuts it. A run that fails on a taken name prints the
  id of the container that holds the name, but inside a sentence
  (`docker: Error response from daemon: Conflict. The container name "/api" is
  already in use by container "<id>". You have to remove (or rename) that
  container to be able to reuse that name.`), not as a bare line. The pairing
  reads bare lines only, so the row takes no id, and a test pins the real
  message. A word that the shell fills from state outside the call (a variable of
  the environment, a glob that matches a file with a newline in its name) can
  put a newline in an argument, so the text rule withholds the mark for every
  `$`, `*`, `?`, `[` and `~`. The mark is evidence, not proof, so the checks
  of the inspect stay.
  With the
  mark the one id line can only be the run's own, so a row with this mark never comes from limit (1) to (4) below. A new sighting of
  the same row id replaces `containerId`, `containerIdExact` and `containerRunAlone`,
  also with none: the merge `{ ...old, ...row }` kept the old id before. A row of an older build has no
  mark. A row with no id and no `--name` is named by its command, so the probe
  finds no container and shows it `exited`.
  Limits, where a run still pairs and gets the mark. These are the same four in
  the README ("Container ids"), in the doc of `containerIdExact` and in the test
  "container id: known limits ..."; change all of them together. (1) A run that
  failed and printed no id, in a call where another command printed one id line
  (`docker run -d --name api nginx; docker inspect -f '{{.Id}}' web`). (2) A run
  that did not run at all, with the same one id line (`[ -n "$X" ] && docker run -d
  --name api nginx; docker inspect ...`). (3) A run with a trailing `&`: its output
  reaches the tool result when the run ends before the call does. (4) A run in a
  function body that the call runs with a redirection (`f() { docker run -d y; };
  f > log; docker ps -q --no-trunc`): the parser reads a function body as a live
  command, and the call of the function is not read as the run's. So the mark is
  strong evidence, not proof. Code that acts on an id trusts only a row with the
  mark, and must also check the container before it removes it. The one such code
  is `/track clean --yes containers` (issue #123, `trackers/processes/clean.ts`).
  It plans a step for a docker-container row that is over, has the mark and is
  not `containerGone`. A row that is over with no id, with an id that has no
  mark, with no `--name` or with no `containerRunAlone` is listed as `skipped`
  with its reason. Its apply runs one `docker container inspect --format` line of
  the id and removes the container (`docker rm <id>`, no `-f`, no `-v`) only when
  the id of the answer is the row's, the state is `exited`, no label key starts
  with `org.testcontainers`, `Created` is not before `firstSeen` less 11 minutes
  (no upper bound, because a `--name` row that runs again keeps its first
  `firstSeen`), and the container has the `--name` of the row. A row with no `--name` is never a step: its name is the short id,
  so there is no name to check, and its id can be another command's output (the limits above), so the window of `Created`
  alone cannot tell the container of the run from one that someone else made a few minutes before. The plan lists it as
  `skipped: no --name, so nothing proves that this run made the container`. A `--name` is no proof either:
  Docker keeps names unique, so a run that failed on a taken name pairs with the id of the old container that
  holds the name (limit 1), and that container passes the name check, the window of `Created` and every other
  check of the inspect (review of PR 285, P1 again; a test reproduced the `docker rm`). So a row also needs
  `containerRunAlone`, and the plan lists one without it as
  `skipped: the run was not the whole Bash call, so nothing proves that this run made the container`.
  `Created` has nanoseconds, so the
  fraction is cut to 3 digits before `Date.parse`: the mod runs in the engine's
  runtime, and only node was seen to read them. The probe marks a row
  `containerGone` by id alone (no line of `docker ps -a --no-trunc` has the id,
  even when a container of the same name is listed) and drops the mark when the id
  is listed again. A listing that the runner cut (`isStdoutTruncated`) may lack the
  line of a container that exists, so it proves no absence: it sets no mark and
  leaves each mark as it was. A live sighting of the row drops it in the merge. The apply
  also sets it after a `docker rm` and on `No such container`. A `--rm` container
  leaves no `ps -a` line, and both `inspect` and `rm` then exit 1 with `Error
  response from daemon: No such container: <id>` (study of #123, part 2, S1 L110
  to L118). The README ("Containers") lists the limits: another Docker context, a
  container started in a person's own shell, a `docker run -d` with no `--name`
  (see above), anonymous volumes.
  Evidence (grade: *verified-kit* for the parser, not *verified-live*): the
  tests "container id: ..." in `process-parse.test.ts` (the glued forms, the bare
  `exec` and the limits among them), the marks in `shell.test.ts` ("splitShell
  marks ..."), the merge in `process-container-id.test.ts` and the stored row in
  `processes-tracker.test.ts` ("a second sighting of a named container ..."),
  and for the pid line of `echo $!` the tests named `echo $!: ...` in `process-parse.test.ts`.
  The wrong pairs were seen in the real parser at `9b5fa44` before the fix: one
  `docker run -d` with four id lines took the last, an older container ([study of
  #123, part 2](https://github.com/martin-macak/claude-code-mod-tracking/issues/123#issuecomment-6412081219),
  L301 to L306), and a run redirected to `/dev/null` or captured by `$(...)` took
  the one id of `docker inspect` or `docker ps` (L401 to L409). The review of the
  fix saw the glued forms and a run after `exec > file` take a foreign id with the
  mark, and the tests above pin them. A probe with `bash` 5.3.20 gave the words
  that the tests expect: `printf '[%s]' nginx2>f b` writes `[nginx2][b]` to the
  file `f` and prints nothing, `printf '[%s]' x>(cat)` prints one word,
  `[x/dev/fd/63]`, and `exec 3>&1 >/dev/null; echo hidden; echo shown >&3` prints
  `shown` only. The same probe: `exec -c > f; echo hidden` and
  `exec -a name > f; echo hidden` write `hidden` to `f`, and `echo a 12&>f`
  writes `a 12` to `f`. The end of an exec at a redirected group was probed the
  same way: `{ exec >/dev/null; } >/dev/null; echo after` prints `after`, as
  do `for ...; do exec >/dev/null; done >/dev/null`, `if ...; fi >/dev/null`
  and `case ...; esac >/dev/null` (also an exec in the condition of the `if`).
  `{ exec >/dev/null; }; echo after`, `{ exec >/dev/null; } 2>&1; echo after`,
  `{ exec >/dev/null; } <&0; echo after` and `{ exec >/dev/null; } 3>&1; echo after`
  print nothing. So do `{ exec >/dev/null; } >&1; echo after` and its forms
  `1>&1`, `>& 1`, `>&01`, `>&1-` and `1<&1`, while `>&2`, `>&-`, `>&0`, `>&10`
  and `>&1x` (a file) print `after`. `echo hi >&1` and `exec >&1; echo hi` print
  `hi`, and `&>&1` and `>>&1` are syntax errors. The output substitution was
  probed with `bash` 5.3.20 (2026-10-27), each form as a script, with a fake
  `docker` that prints one 64-hex id line and starts nothing. The id reaches the
  stdout of the script for `cat > >(docker run -d nginx) </dev/null; wait`, and
  also with `cat 2> >(...)`, `cat &> >(...)`, `cat 2>e > >(...)`,
  `cat >&1 > >(...)`, `cat 3>f > >(...)`, `cat >f; tee >(...)`,
  `cat >f | cat > >(...)`, `echo x | tee >(...)`,
  `if cat > >(...) </dev/null; then :; fi`, `{ cat > >(...) </dev/null; } 2> f`,
  `( exec > f ); cat > >(...)` and a `>(...)` in a `>(...)`.
  It does not reach the stdout for `cat >f > >(...)`, `cat >&2 > >(...)`,
  `cat > $(echo f) > >(...)`, `cat >f $(echo x) > >(...)`,
  `cat > >(cat >/dev/null) > >(...)`, `exec > f; cat > >(...)`,
  `exec > f; tee >(...)`, `x=$(cat > >(...) </dev/null; wait)`,
  `{ cat > >(...) </dev/null; } > f`, `for ...; do cat > >(...); done > f` and
  a run in the substitution with its own `> f`.
  It does reach it where the redirection of the command comes later or the
  substitution is an argument: `cat > >(...) </dev/null > f`,
  `tee >(...) </dev/null > f` and `tee > f >(...) </dev/null`. The parser takes
  no id for these, the safe side. A `cat`, an `echo` or a pipe that prints what
  the substitution wrote also brings the id to the stdout (`cat <(...)`,
  `{ cat > >(...) </dev/null; } | cat`, `echo $(cat > >(...) ...)`). That id is
  a line of `cat`, not the output of the run, and the parser takes none. The
  parser (`parseBashProcesses` at the same commit, 54 forms) gave an id for none
  of the forms where `bash` printed none. No live Docker run
  repeated these probes after the fix.
- A foreground `nohup cmd` (no `&`) is not a detached process.

Probe facts found in manual tests:

- `screen -ls` exits 1 also when sessions exist, and prints the list to
  stdout. The exit code says nothing.
- `tmux ls` with no server exits 1 with `no server running` or
  `error connecting to` on stderr. That means no sessions.
- On macOS `python3 x` shows in `ps` as `.../Python.app/.../Python x`. The
  match compares the program name without folder, case and version digits.

Engine facts found in manual tests (Claude Code 2.1.296):

- A task notification row carries no `task` field on `session.append` or
  in the stored row. In the types `task` is a render prop only. The status
  is in the row text: `<task-id>`, `<tool-use-id>`, `<status>`. Monitor
  notices add an `<event>` tag. A Monitor that reached its deadline has no
  `<status>`: the parser reads its `<event>` instead (see "How a Monitor ends"
  below).
- At the hook boundary the row content is an array of blocks. The JSONL
  file stores the same text as one string.
- A subagent's Bash resets its cwd after every call. Only the main loop
  keeps a `cd`, and `$.session.cwd()` follows it there.
- A screen session that a subagent starts died when the subagent ended.
  tmux sessions and Docker containers survived. The probe showed the real
  state (`exited`).

## How a background task ends (issue #56, Claude Code 2.1.304)

A spike hooked `session.append`, `tool.call`, `agent.spawn` and `turn.complete` with a logging mod. It ran a background Bash task in the main loop and in subagents, in headless `claude -p` runs (grade: *verified-kit*, not *verified-live*). The rows below are saved as fixtures in [notices.ts](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts). The spike mod and its raw log are not in the repo, so the fixtures are the saved evidence. The run was on 2.1.304, newer than the newest type snapshot (2.1.302). The `d.ts 302` links show the contract. The fixtures and tests show what the engine did.

| Case | What the mod sees | Evidence |
| --- | --- | --- |
| The session is idle when the task ends | Door `prompt`, origin `task-notification`. The text is the `<task-notification>` block alone. | Fixture `IDLE_NOTICE` [notices.ts:38-50](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L38-L50 "/** The notice of an idle session: door `prompt`"). Test [processes-tracker.test.ts:621-631](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L621-L631 "test('the idle notice (door prompt) still ends t"). Types: door set [d.ts 302:10984](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10984), origin [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). |
| A turn runs when the task ends (the usual case) | Door `delivery`, origin `task-notification`. The engine stores an `attachment` row named `queued_command`. The text is the block inside a `<system-reminder>` wrapper. No `prompt` row follows. | Fixture `MID_TURN_NOTICE` [notices.ts:26-36](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L26-L36 "* Case A of "). Tests [processes-tracker.test.ts:603-609](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L603-L609 "test('case A: a notice folded into a running tur"), and the wired row shape [register.test.tsx:530-553](../../../../plugins/artifact-tracking/tests/register.test.tsx#L530-L553 "test('processes: a notice folded into a running"). Types: `attachment` row and its `name` [d.ts 302:11039-11046](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11039-L11046), `queued_command` [d.ts 302:15244](../sources/claude-code-2.1.302/types/claude-code.d.ts#L15244). |
| The queue | Door `queue`, origin `engine`, the same text. It comes at the enqueue and at the remove. It is no conversation row, so the processes tracker does not read it. | Fixture `QUEUED_NOTICE` [notices.ts:53-62](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L53-L62 "* The same n"). Test [processes-tracker.test.ts:648-661](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L648-L661 "test('a notice on another door, or one that a pe"). Types: a queue record is no row of the conversation [d.ts 302:10976-10983](../sources/claude-code-2.1.302/types/claude-code.d.ts#L10976-L10983). The origin `engine` is from the fixture only: the types give none for it. |
| A background subagent's task ends after the agent answered | The engine resumes the agent. Its prompt is the notice: door `prompt`, origin `task-notification`, `agentId`, `isMeta`. | Fixture `AGENT_RESUMED_NOTICE` [notices.ts:65-75](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L65-L75 "* A backgrou"). Test [processes-tracker.test.ts:633-646](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L633-L646 "test('a notice in the loop of a subagent ends th"). Types: `agentId` of a row [d.ts 302:11015-11021](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11015-L11021), `isMeta` [d.ts 302:11053-11056](../sources/claude-code-2.1.302/types/claude-code.d.ts#L11053-L11056). |
| A task of a foreground subagent | The Bash result has `backgroundEndsWithFinalResponse: true`. The engine ends the task at the agent's final response. No notice follows. | Fixture `BG_START_SYNC_AGENT` [notices.ts:92-107](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L92-L107 "* The answer"). Test [processes-tracker.test.ts:663-673](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L663-L673 "test('a task of a foreground subagent ends as ki"). Types: the flag, for "a synchronous subagent's command, or a headless session" [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166). |

The types and the spike differ on one point (grade: *verified-kit* against *types-only*). A notice folded into a running turn has origin `task-notification` in the spike (second row). The 2.1.302 types say it in two ways. `PromptOrigin` lists `task-notification` for a notification "delivered into a running turn" [d.ts 302:9246-9250](../sources/claude-code-2.1.302/types/claude-code.d.ts#L9246-L9250). `PromptAttachmentOrigin` says such a notification belongs to the engine [d.ts 302:8344-8352](../sources/claude-code-2.1.302/types/claude-code.d.ts#L8344-L8352). The spike saw the first on the `attachment` row. The tracker keys on that origin, so a build that stamps `engine` there would hide the notice. This is open question 38 in [open-questions](../open-questions.md).

Rules that follow:

- The tracker reads doors `prompt` and `delivery`. It matches the origin and the text, never the door alone: the person can type the same text. Code: [index.ts:70-81](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L70-L81 "// A task notice completes the task-backed row.") and the door list [index.ts:177](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L177 "row: { doors: ['prompt', 'delivery'], run: o"). Tests: a person, a peer, the queue and a model response change nothing [processes-tracker.test.ts:648-661](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L648-L661 "test('a notice on another door, or one that a pe"), typed text changes nothing [register.test.tsx:565-573](../../../../plugins/artifact-tracking/tests/register.test.tsx#L565-L573 "test('processes: notification text typed by the ")).text ?? '').toMatch(/sleep 15[^\n]*r").
- A row stores the `agentId` of the Bash call and the flag as `endsWithAgent`. `turn.complete` of that agent ends its running flagged rows as `killed`. Code: the row [types.ts:38-45](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L38-L45 "/** The subagent or workflow agent whose Bash or"), [parse.ts:330-351](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L330-L351 "/** What names the row of a task beyond its comm"), the flag read [parse.ts:471-479](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L471-L479 "const taskId = str(result?.backgroundTaskId)"), the end [rows.ts:197-205](../../../../plugins/artifact-tracking/trackers/processes/rows.ts#L197-L205 "* A loop end") and its handler [index.ts:128-135](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L128-L135 "// A loop ended: its tasks that end with it get"). Tests: [processes-tracker.test.ts:663-673](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L663-L673 "test('a task of a foreground subagent ends as ki"), every end reason [processes-tracker.test.ts:698-705](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L698-L705 "test('every end reason of an agent ends its task"), a task that already ended stays [processes-tracker.test.ts:721-733](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L721-L733 "test('the end of an agent leaves a task that alr"). Types: `agentId` of `turn.complete` [d.ts 302:13967-13974](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13967-L13974), its reasons [d.ts 302:13997](../sources/claude-code-2.1.302/types/claude-code.d.ts#L13997).
- A task of a background subagent has no flag. It survives the agent. Do not kill it: its notice comes later. Fixture `BG_START_ASYNC_AGENT` [notices.ts:124-136](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L124-L136 "/** The result for a task of a background subage"). Test [processes-tracker.test.ts:707-719](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L707-L719 "test('a task of a background subagent survives t").
- The flag is also set for a headless main loop that takes no more input. The same rule ends its rows at the main `turn.complete`. Test [processes-tracker.test.ts:735-747](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L735-L747 "test('a task of a headless main loop ends with t"), wired [register.test.tsx:555-563](../../../../plugins/artifact-tracking/tests/register.test.tsx#L555-L563 "test('processes: a task that ends with the final"). Types: [d.ts 302:21165-21166](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21165-L21166).
- A workflow agent is covered (grade: *verified-kit*, a headless `claude -p` run on Claude Code 2.1.304, 2026-10-20). In a one-agent workflow the agent ran `sleep 300` with `run_in_background`. Its `agent.spawn` input had `subagentType: 'workflow-subagent'` and `workflow: { runId, agentIndex }`. Its Bash result had `backgroundEndsWithFinalResponse: true`, and its text said the task "is terminated when you give your final response and no notification can follow that". Its `turn.complete` carried the same `agentId` with reason `answer`, and no notice followed. `/track` on the resumed session showed the row as `killed`. Not seen: when the process died (the headless session ended seconds after the agent). Fixture `BG_START_WORKFLOW_AGENT` [notices.ts:138-160](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L138-L160 "/** The id of the workflow agent that started th") holds the Bash result and the agent id. Test [processes-tracker.test.ts:675-696](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L675-L696 "test('a task of a workflow agent ends as killed"). Types: `workflow` on `agent.spawn` [d.ts 302:348-378](../sources/claude-code-2.1.302/types/claude-code.d.ts#L348-L378). The value `workflow-subagent` and the `/track` output have no fixture row: the fixture comment and this page are their only record.
- In an interactive session (tmux), a prompt that asks for a foreground subagent still got `Backgrounded agent`. Its `sleep 300` task had no flag, the footer said `1 shell still running`, `ps -A` showed `sleep 300` alive after the agent stopped, and the row stayed `running`, which is true (grade: *verified-live*). A headless `claude -p` run with a foreground subagent set the flag, and `claude -p /track --resume <session>` showed `bg  sleep 300  background task  killed` (grade: *verified-kit*). No fixture holds the interactive run. The full output is in the "Live checks" part of [PR 98](https://github.com/martin-macak/claude-code-mod-tracking/pull/98).

## How a Monitor ends (issue #118, Claude Code 2.1.304)

Before issue #118 a Monitor row ended only for a notice with a `<status>` and for `TaskStop`. Two other ends left the row `running` for ever. The facts below come from three sources. The transcript of a real session (fixtures). Headless `claude -p` runs on 2.1.304 with model haiku, a probe mod that logged `agent.spawn`, `tool.call`, `session.append` and `turn.complete`, and this branch's mod (grade: *verified-kit*; 2026-10-20). Interactive tmux runs on 2.1.305 with model haiku, once with the mod of `main` (b3723bf) and once with this branch's mod, with `/track` read from the screen (grade: *verified-live*; 2026-10-20). The probe mod, its raw logs and the tmux probe script are not in the repo, so the fixtures and this page are the saved evidence.

| Case | What the mod sees | Evidence |
| --- | --- | --- |
| The source of the Monitor ends (the command exits) | A notice with `<status>completed</status>`, a `<tool-use-id>` and the last `<event>`. The row ended before #118 and still does. | Fixture `MONITOR_STREAM_ENDED_NOTICE` [notices.ts:210](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L210 "export const MONITOR_STREAM_ENDED_NOTICE = monit"). Test [processes-tracker.test.ts:794](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L794 "test('the notice of a Monitor whose source ended"). Interactive: `main` ended the row too. |
| An output line of a Monitor that goes on | A notice with an `<event>` and no `<status>`, no `<tool-use-id>`. The row must stay `running`. | Fixture `MONITOR_EVENT_NOTICE` [notices.ts:225](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L225 "export const MONITOR_EVENT_NOTICE = monitorNotic"). Test [processes-tracker.test.ts:801](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L801 "test('an event of a Monitor that goes on leaves"). |
| The Monitor reaches its `timeout_ms` | The engine kills the Monitor and sends one notice. It has no `<status>` and no `<tool-use-id>`. The only sign is the `<event>`: `[Monitor expired after 1s with no events delivered. Re-arm it ...]`. The tracker ends the row as `completed` when the `<event>` opens with `[Monitor expired`. A line of Monitor output that opens with the same words also ends its row: no tag tells the two apart. | Fixtures `MONITOR_EXPIRY_NOTICE` [notices.ts:196](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L196 "export const MONITOR_EXPIRY_NOTICE = monitorNoti") (door `delivery`) and `MONITOR_EXPIRY_NOTICE_IDLE` [notices.ts:203](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L203 "export const MONITOR_EXPIRY_NOTICE_IDLE = {") (door `prompt`, built from the first). Code: the opening words [parse.ts:760](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L760 "const MONITOR_EXPIRED = '[Monitor expired'") and the read [parse.ts:769-777](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L769-L777 "export function processUpdateFromNotificationTex"). Tests: [processes-tracker.test.ts:780](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L780 "test('the expiry notice of a Monitor ends its ro"), the parser [process-parse.test.ts:1532](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1532 "test('processUpdateFromNotificationText reads the e"), [process-parse.test.ts:1545](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1545 "test('a status of a Monitor notice wins over the") and [process-parse.test.ts:1551](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1551 "test('processUpdateFromNotificationText reads a"). Types: the deadline text of `timeout_ms` ("You are notified at expiry and can re-arm") [d.ts 302:17108](../sources/claude-code-2.1.302/types/claude-code.d.ts#L17108). |
| A workflow agent gives its final response while its Monitor is armed | The engine stops the Monitor and sends no notice. | Two headless probe runs and one interactive run, below. Code: the id of the workflow agent [index.ts:112-115](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L112-L115 "const onSpawn: H<AgentSpawnEvent> = (ctx, ev) =>"), the flag [index.ts:103](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L103 "const endsWithAgent = ev.agentId !== undefined &") and its check [index.ts:60-67](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L60-L67 "async function isWorkflowAgent(ctx: LoadKey & Pi"). Tests: [processes-tracker.test.ts:831](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L831 "test('a Monitor of a workflow agent ends as kill") and, for the scope of the Set, [processes-tracker.test.ts:910](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L910 "test('the workflow agents are kept per load: a s"). |
| A subagent of the Agent tool gives its final response while its Monitor is armed | Nothing ends. The engine says the agent "stopped with background work of its own still running". At the deadline it resumes the agent with the expiry notice as its prompt (door `prompt`, origin `task-notification`, the agent's id, `isMeta`). | Fixture `SUBAGENT_MONITOR_EXPIRY_NOTICE` [notices.ts:278](../../../../plugins/artifact-tracking/tests/fixtures/notices.ts#L278 "export const SUBAGENT_MONITOR_EXPIRY_NOTICE = {"). Test [processes-tracker.test.ts:850](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L850 "test('a Monitor of a subagent survives the end o"). |

The probe, in short. A one-agent workflow: the agent armed three Monitors and gave its final response 8 s later. One Monitor ran `while true; do date +%s >> hb.log; sleep 1; done` (`timeout_ms` 120000). The first run:

- The Monitor was armed at 7.6 s. The agent's `turn.complete` (reason `answer`) came at 16.0 s.
- `hb.log` got 9 lines, the last one at the second of that `turn.complete`. The main loop read the file 11 s later (`wc -l` said 9, the last line unchanged). `ps` showed no loop left.
- No notice for the task came, neither with a `<status>` nor an expiry notice. The other two Monitors (a source that ended, a 1 s deadline) sent theirs while the agent was alive.
- A second run, with this branch's mod, gave the same: 9 lines, the file stopped at the agent's `turn.complete`.

The same probe with a background subagent (`run_in_background: true`) and with a subagent that the call did not set to background: the file kept growing for the whole `timeout_ms` (119 and 20 lines for 2 min and 20 s), and the expiry notice came at the deadline. The Monitor of a subagent survives the agent. A subagent of the Agent tool that is truly synchronous was not seen: the call without `run_in_background` came back at once in both runs.

What the hook sees for the workflow agent: `agent.spawn` has `workflow: { runId, agentIndex }` and `subagentType: 'workflow-subagent'` in its input, and the answer of `next(e)` has `agentId`. The Monitor result is `{ taskId, timeoutMs, persistent }`. It has no flag like `backgroundEndsWithFinalResponse`, and the start text says only "expires in 2m unless the source ends first; you get one notice at expiry". So the tracker learns the workflow agents from `agent.spawn` and flags the Monitor rows of those agents (`endsWithAgent`). `turn.complete` of the agent then ends them as `killed`: the engine stopped them, as for a flagged Bash task.

After a reload the tracker has not seen the spawn of an agent that started before it: module variables reset ([gotchas](../gotchas.md), item 10) and `agent.spawn` is not replayed. So a Monitor of an agent that the set lacks is also checked against the engine's agent list ([index.ts:60-67](../../../../plugins/artifact-tracking/trackers/processes/index.ts#L60-L67 "async function isWorkflowAgent(ctx: LoadKey & Pi")). The list names the subagents and teammates, not a workflow's agents ([d.ts 302:3262-3268](../sources/claude-code-2.1.302/types/claude-code.d.ts#L3262-L3268)), so an agent that the list does not name is a workflow's, and its Monitor gets the flag. A list that cannot be read gives no flag. Tests: [processes-tracker.test.ts:885](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L885 "test('after a reload, a Monitor of an agent that"), [processes-tracker.test.ts:897](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L897 "test('an agent list that cannot be read gives a"). Interactive check (Claude Code 2.1.305, grade: *verified-live*; one run): a copy of this branch's mod named each Monitor row after the list at the call. The agent of a workflow was not in the list (the row ended as `killed`), the agent of a background subagent was in it (the row stayed `running`), and the main loop has no agent id.

Headless check of the whole path (one `claude -p` run with a workflow agent and a background subagent, then `claude -p /track --resume <session>`; grade: *verified-kit*):

```text
main b3723bf                           this branch
  monitor  Monitor  monitor  completed    monitor  Monitor  monitor  completed   source ended
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  killed      workflow agent ended
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  completed   1 s deadline
  monitor  Monitor  monitor  running      monitor  Monitor  monitor  completed   background subagent, 8 s deadline
```

Interactive checks (Claude Code 2.1.305, tmux, model haiku, `--allowedTools Monitor,Bash,ToolSearch,Workflow,Agent`; grade: *verified-live*; 2026-10-20). One session per mod: the mod of `main` (b3723bf) and this branch's. Each session ended with `/track`, and the Processes rows below are the screen. The pane did not list the rows in the order they were armed, so the states are not mapped to the Monitors one by one. The states follow from the code: the Monitor with a `<status>` is the only one that `main` can end.

- The main loop armed three Monitors, one by one. (1) A 1 s deadline in an idle session: the turn ended, and the expiry notice resumed the session. (2) A source that ends after 2 s. (3) A 1 s deadline while a `sleep 8` Bash call ran: the notice was folded into the running turn.
- A workflow of one agent armed three Monitors, ran `sleep 8` and answered. (1) `sleep 120` with a 120 s `timeout_ms`, still armed at the agent's end. (2) A 1 s deadline. (3) A source that ends after 2 s. `/track` ran after the workflow had ended.

```text
Main loop, three Monitors
  main b3723bf                           this branch
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  completed   monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed

Workflow agent, three Monitors
  main b3723bf                           this branch
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  running     monitor  Monitor  monitor  completed
  monitor  Monitor  monitor  completed   monitor  Monitor  monitor  killed
```

On this branch the band read `Processes 3 (1 ✗)` after the workflow run: the `killed` row. `ps -A` after that run showed no `sleep 120`, so the engine had stopped the Monitor armed at the agent's end (it sent no notice). It still showed the `sleep 30` of the 1 s deadline, 26 s after it started: the deadline ends the Monitor, not the process behind it. That is one observation, not a rule.

Why the end with a workflow agent is `killed` and the deadline is `completed`. A deadline is the bound the caller set. A Monitor that the engine stops at its agent's final response was cut short, as a flagged Bash task is (issue #98), so `killed` is true. `applyAgentEnd` sets it ([rows.ts:204](../../../../plugins/artifact-tracking/trackers/processes/rows.ts#L204 "await setProcesses(ctx, rows => rows.map(r => (e")), and `sections.ts` draws `killed` red and counts it in the band ([sections.ts:21](../../../../plugins/artifact-tracking/trackers/processes/sections.ts#L21 "const failing = (r: ProcessRecord): boolean => S")). Since issue #49 a `killed` row also stays visible for `failedTtlMs` (1 h by default), and a `completed` one for `endedTtlMs` (30 min): `states.ts` puts `killed` in the failed kind. A workflow that arms many Monitors for its whole run adds one red row for each. If that proves noisy, end the Monitor kind as `completed` in `applyAgentEnd` and change the state in the test [processes-tracker.test.ts:831](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L831 "test('a Monitor of a workflow agent ends as kill").

Not known. Open question 40 holds the first five.

- A synchronous subagent, or the main loop of a headless session, with an armed Monitor: the probes did not see them (the Agent call came back at once in both runs). They get no flag, so their rows stay `running` until a notice or `TaskStop`.
- A `persistent: true` Monitor of a workflow agent. The type says it "runs until TaskStop or session end" ([d.ts 302:21567-21568](../sources/claude-code-2.1.302/types/claude-code.d.ts#L21567-L21568)). The probes armed none, so the engine may not stop it with the agent. The tracker flags it all the same, so its row ends as `killed` at the agent's end.
- The retry of a stalled workflow agent. `next` settles with the first attempt's `agentId` and the retry "is not raised again" ([d.ts 302:356-357](../sources/claude-code-2.1.302/types/claude-code.d.ts#L356-L357)). The retry has another id and no `agent.spawn`, so its Monitors get no flag and stay `running`.
- Whether the list always names a running subagent at its first Monitor call. The check after a reload relies on it: one interactive run saw the subagent listed. A subagent that the list did not name yet would get `killed` at its end while its Monitor runs on.
- A Monitor that delivered events before its deadline. Both expiry notices seen say "with no events delivered". The anchor is the shorter `[Monitor expired`, but no run has shown the text of that case.
- The count of issue #118: 47 Monitors, 43 notices with `<status>completed</status>`, 44 rows that stayed `running`. The interactive run on `main` ended a row for such a notice, so the two causes above do not explain 43 ended notices next to 44 stuck rows. The count came from a read of a transcript, not from a run. A lead, not a finding: open question 37. Every interactive run printed once that the `session.append` hook of the mod was skipped for an event because another plugin ran first. The rows still ended in these runs.

A detached process whose command names a shell variable:

- `ps` shows the command after the shell expanded it. The parser expands the variables that the same Bash call sets (a bare `L=/x`, `export L=/x`) and `$PWD`. A variable lives in the subshell that set it and in the ones below it, like the directory. Code: [parse.ts:355-369](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L355-L369 "/** `$NAME` and `${NAME}`. Group 1 is the braced"), [parse.ts:515-519](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L515-L519 "const setVar = (name: string, value"), the scopes [shell.ts:1023-1042](../../../../plugins/artifact-tracking/core/lib/shell.ts#L1023-L1042 "* Shell vari"). Tests: [process-parse.test.ts:1576-1587](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1576-L1587 "test('detached: a variable the command set is ex"), [process-parse.test.ts:1587-1592](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1587-L1592 "const braced = (name: string) => ['$', '{', name"), scopes [process-parse.test.ts:1621-1632](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1621-L1632 "test('detached: a variable lives in the subshell").
- A word the shell passes as typed is not a reference. `'$F'`, `\$F` and `"\$F"` keep the text `$F`, and `"$F"` and a bare `$F` expand. The splitter drops quotes and escapes from its words, so it also returns each word with a mark on every such `$` (`Segment.marked`). Only the expansion reads the marks. Code: [shell.ts:7-26](../../../../plugins/artifact-tracking/core/lib/shell.ts#L7-L26 "* Stands for"), the marks [shell.ts:746-765](../../../../plugins/artifact-tracking/core/lib/shell.ts#L746-L765 "word += literalDollars(s[i + 1] ?? '')"), the read [parse.ts:355-369](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L355-L369 "/** `$NAME` and `${NAME}`. Group 1 is the braced"), [parse.ts:535-536](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L535-L536 "// The marked words tell"), [parse.ts:598-599](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L598-L599 "// `marked` is the end of `seg.marked`: a word that is"), [parse.ts:633-635](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L633-L635 "// The shell expands the variables"). Tests: [process-parse.test.ts:1634-1651](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1634-L1651 "test('detached: a reference in single quotes or"), a quoted value stays literal when read [process-parse.test.ts:1653-1660](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1653-L1660 "test('detached: a literal reference in an assign"), other words keep the plain `$` [process-parse.test.ts:1662-1667](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1662-L1667 "test('detached: a literal dollar does not change"). A stored `$F` is a variable to the probe, so the live process still fits [process-probe.test.ts:137-165](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L137-L165 "test('psStillMatches: a word with a variable mat"). Without a pid it reads as `unknown` (see the last bullet), never `exited`.
- A name that the command assigns with a command substitution (`D=$(mktemp -d)`, `D=/tmp/run-$(date +%s)`, a backtick) is never expanded. The shell splitter drops the substitution from the word, so the value would read as the wrong literal `/tmp/run-`. The scan is by name over the whole command. A substitution inside quotes stays in the word and does not count. Code: [parse.ts:372-381](../../../../plugins/artifact-tracking/trackers/processes/parse.ts#L372-L381 "* Names the "). Test: [process-parse.test.ts:1605-1619](../../../../plugins/artifact-tracking/tests/process-parse.test.ts#L1605-L1619 "test('detached: a value with a command substitut").
- A variable that stays unexpanded makes the probe read that word as a pattern. A variable stands for one word: a value of several words fits nothing. A fingerprint with such a word that fits no process gives the state `unknown`, never `exited`. Code: [probe.ts:115-143](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L115-L143 "// A variable the parser could not expand: `$NAM"), the state [types.ts:16-17](../../../../plugins/artifact-tracking/trackers/processes/types.ts#L16-L17 "* `unknown`: a detached process whose command"). Tests: [process-probe.test.ts:137-165](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L137-L165 "test('psStillMatches: a word with a variable mat"), [process-probe.test.ts:200-206](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L200-L206 "test('a variable stands for one word: a value of"), [processes-tracker.test.ts:943-960](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L943-L960 "test('a variable the command does not set: the p"), [processes-tracker.test.ts:981-988](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L981-L988 "test('a detached process with echo $! and a vari"), and the state at the view [tracker-sections.test.ts:339-357](../../../../plugins/artifact-tracking/tests/tracker-sections.test.ts#L339-L357 "test('every process state has its token color: t").
- A fingerprint that names only its program and variables (`node $F`) is never searched in `ps -A`: any process of that program would fit, and the pid would be a guess. The row stays `unknown`. A word with a literal part (`$D/s.js`) is a constraint and is searched. With a pid known (`ps -p`), the loose fingerprint is enough. Code: [probe.ts:176-184](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L176-L184 "* Does the f"), [probe.ts:207-214](../../../../plugins/artifact-tracking/trackers/processes/probe.ts#L207-L214 "* Finds the "). Tests: [process-probe.test.ts:182-198](../../../../plugins/artifact-tracking/tests/process-probe.test.ts#L182-L198 "test('findDetachedPid: a fingerprint of the prog"), [processes-tracker.test.ts:923-941](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L923-L941 "test('case C: a detached process whose command n"), [processes-tracker.test.ts:962-979](../../../../plugins/artifact-tracking/tests/processes-tracker.test.ts#L962-L979 "test('a variable the mod cannot read: another pr").

Not covered: a tmux session on another socket (`-L`, `-S`), a tmux session
with no `-s` name, and a compose project named only by `name:` in its file.

Still waiting:

- Backgrounded shells that the engine itself leaks after hard termination.
  The session does not get a reliable task lifecycle event for that path, so
  the pane can show stale "running" rows until the next explicit probe.
