# Lenses

Each lens agent reads only its own section. A finding names the file and line, quotes the code, and gives a concrete fix. Report problems in the changed code only. Name the repo pattern or file you compare against.

## architecture

| Check | Look for | Typical fix |
| --- | --- | --- |
| Single responsibility | A module or function that does two jobs (parse and render, state and I/O). | Split along the seam; name the new unit. |
| Open-closed | A new case that edits a `switch` or `if` chain in several places. | A table or a registry the new case adds itself to. |
| Reuse | New code that copies an existing helper or pattern. Name it: file and symbol. | Call or extend the existing one. |
| Dependency direction | A low-level module that imports a view or the register module. | Pass the value in, or move the type down. |
| State | New state where an existing slice or store fits. | Add a field to the existing slice. |
| Boundaries | A unit you cannot test without its neighbors. | Inject the dependency (`$.process.run`, the clock). |

## quality

| Check | Look for | Typical fix |
| --- | --- | --- |
| Names | Names that do not say what the value is or does. | A name from the domain (the issue or the spec). |
| Dead code | Unused exports, params or branches. | Delete them. |
| Failure | A throw or a hang where the repo fails soft (a missing row, a short delay). | Catch at the boundary, log, return the empty case. |
| Hot path | Work in a hook that blocks the session (sync I/O, a process per event). | Queue it, cache it, or move it off the hook. |
| Idiom | Style, comment density or error handling unlike the surrounding code. | Match the neighbor; cite it. |
| Edge input | Empty, very long, unicode, relative or `~` paths, missing fields. | Guard and test the case. |

## tests

| Check | Look for | Typical fix |
| --- | --- | --- |
| Coverage | Changed behavior with no test. Name the behavior. | The test to add: name, input, expected output. |
| Fails first | A test that would pass without the change. | Assert the new behavior, not a side effect. |
| Clarity | A test name that does not state the behavior, or several reasons to fail in one test. | Rename; split. |
| Fixtures | Made-up shapes where an observed shape exists (study logs, the types file). | Use the observed shape. |
| Edge cases | Study caveats with no test. | One test per case. |

## requirements

The Trace stage of `workflow.js` covers this lens. Per item: status, correctness, accuracy against the issue text, and the code and test that prove it.
