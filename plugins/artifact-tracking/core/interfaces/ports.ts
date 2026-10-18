// Ports: async closures over `$`. Only hooks/register.tsx sees `$`. Types only.
// The type is split, so each consumer takes only its part (ISP).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.4 and 5.13.

import type { ToolStatus } from '../../types'
import type { Json, StoredItem } from './items'

/** The engine's timer handle. */
export interface Timer {
  cancel(): void
}

/** The only env names the mod reads. Each is a literal `$.env.get` call in register.tsx. */
export type EnvName = 'HOME' | 'XDG_CONFIG_HOME' | 'CLAUDE_TRACKER_CONFIG_DIR' | 'CLAUDE_CONFIG_DIR'

/** Options of one `$.process.run`. */
export interface RunOpts {
  /** Absolute, or relative to the session cwd. Absent: the session cwd. */
  readonly cwd?: string
  /** Variables set over the host environment. */
  readonly env?: Readonly<Record<string, string>>
  /** Text written to standard input, then closed. */
  readonly stdin?: string
  /** Kill the child after this time. */
  readonly timeoutMs?: number
}

/** What `$.process.run` gives once the child exits. A non-zero exit resolves. */
export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly isStdoutTruncated?: boolean
  readonly isStderrTruncated?: boolean
}

/** What `$.fs.stat` gives. */
export interface FsStat {
  /** Of what the path leads to. A link is followed. */
  readonly kind: 'file' | 'dir' | 'other'
  /** Bytes, for a file. */
  readonly size: number
  /** Last modification, epoch ms. */
  readonly mtimeMs: number
  /** The path itself is a symbolic link. */
  readonly isLink: boolean
  /** Where a link lands. */
  readonly realPath?: string
}

/** One transcript message as `$.session.messages()` gives it. */
export interface SessionRow {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly toolUses: readonly {
    readonly tool_use_id: string
    readonly tool: string
    readonly input: Readonly<Record<string, unknown>>
    readonly result?: unknown
  }[]
  readonly toolResults?: readonly {
    readonly tool_use_id: string
    readonly text: string
    readonly isError: boolean
    readonly result?: unknown
  }[]
}

/** One agent loop of this session as `$.agent.list()` gives it. */
export interface AgentInfo {
  readonly id: string
  /** The `<name>@<team>` address of a teammate. */
  readonly teammateId?: string
  readonly description?: string
  readonly type?: string
  /** `pending`, `running`, `waiting`, `idle`, `completed`, `failed` or `killed`. */
  readonly status: string
}

/** One open pane as `$.ui.panes()` lists it. */
export interface PaneInfo {
  readonly id: string
  readonly title: string
  /** The pane the surface shows. */
  readonly isShown: boolean
  /** The person gave it the keyboard. */
  readonly isFocused: boolean
  /** False while it waits undrawn. */
  readonly isPlaced: boolean
}

/** The GitHub remote of the session repo. */
export interface RepoRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
}

/**
 * One closure pair per atom of the state contract (spec 5.13). A family takes the id as a parameter.
 * The ref stays literal inside each closure. A read of an atom never written gives its empty value.
 */
export interface StatePorts {
  readonly items: { get(): Promise<readonly StoredItem[]>; set(next: readonly StoredItem[]): Promise<void> }
  readonly trackers: { get(id: string): Promise<Json | undefined>; set(id: string, next: Json): Promise<void> }
  readonly tools: {
    get(): Promise<Readonly<Record<string, ToolStatus>>>
    set(next: Readonly<Record<string, ToolStatus>>): Promise<void>
  }
  readonly expanded: { get(): Promise<readonly string[]>; set(next: readonly string[]): Promise<void> }
  readonly selected: { get(): Promise<string | null>; set(next: string | null): Promise<void> }
  readonly shown: { get(id: string): Promise<number | undefined>; set(id: string, next: number): Promise<void> }
  readonly help: { get(): Promise<boolean>; set(next: boolean): Promise<void> }
}

export interface Ports {
  readonly clock: {
    /** Engine time. Timers, debounces and the tick use it, so the kit's mock clock drives them. */
    now(): Promise<number>
    /** `Date.now`, for record stamps. */
    wall(): number
    after(ms: number, fn: () => void): Promise<Timer>
    every(ms: number, fn: () => void): Promise<Timer>
  }
  /** `$.process.run`. */
  readonly run: (argv: readonly string[], opts: RunOpts) => Promise<RunResult>
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    stat(path: string): Promise<FsStat | null>
  }
  /** Literal names only. */
  readonly env: { get(name: EnvName): Promise<string | undefined> }
  /** For the file tracker. */
  readonly settings: { read(): Promise<Json> }
  readonly store: {
    get(key: string): Promise<Json | undefined>
    set(key: string, value: Json): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<readonly string[]>
  }
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    repo(): Promise<RepoRemote | null>
    messages(): Promise<readonly SessionRow[]>
  }
  readonly agents: { list(): Promise<readonly AgentInfo[]> }
  /** Closures per atom, refs inline. */
  readonly state: StatePorts
  readonly ui: {
    open(): Promise<boolean>
    focus(key: string): Promise<void>
    panes(): Promise<readonly PaneInfo[]>
    /** Call from event handlers and the tick only, never from a render. */
    invalidate(): Promise<void>
    toast(text: string): void
  }
  readonly log: (line: string) => void
}
