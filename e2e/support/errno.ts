// The errno code of an error from `node:fs` or `node:child_process`, such as `ENOENT`. Undefined for an error with no code.
export const code = (err: unknown) => (err as NodeJS.ErrnoException).code
