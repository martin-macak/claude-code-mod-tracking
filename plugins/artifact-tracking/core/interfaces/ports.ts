// Ports: async closures over `$`. Only hooks/register.tsx sees `$`. Types only.
// The type is split, so each consumer takes only its part (ISP).
// Spec: docs/superpowers/specs/2026-10-18-arch-hardening-design.md, sections 5.4 and 5.13.

import type { Json, StoredItem, ToolStatus, TurnLedger } from '../../types'
import type { PreviewState } from './preview'
import type { FilterState, HiddenState, QuickState } from './view'

/** The engine's timer handle. */
export interface Timer {
  cancel(): void
}

/** The only env names the mod reads. Each is a literal engine call in register.tsx. */
export type EnvName = 'HOME' | 'XDG_CONFIG_HOME' | 'CLAUDE_TRACKER_CONFIG_DIR' | 'CLAUDE_CONFIG_DIR'

/** Options of one run of the engine's process runner. */
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

/** Epoch milliseconds. Production: `Date.now`. Tests: a fake. */
export type Now = () => number

/**
 * Runs one command by argument vector, no shell. In production a closure over the engine's process runner.
 * Rejects when the command cannot start (not on PATH) or runs past its timeout.
 * A non-zero exit resolves.
 */
export type Runner = (argv: readonly string[], init?: RunOpts) => Promise<RunResult>

/** What the engine's process runner gives once the child exits. A non-zero exit resolves. */
export interface RunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly isStdoutTruncated?: boolean
  readonly isStderrTruncated?: boolean
}

/** What the engine's file stat gives. */
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

/** One transcript message as the engine's session gives it. */
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

/** One agent loop of this session as the engine's agent list gives it. */
export interface AgentInfo {
  readonly id: string
  /** The `<name>@<team>` address of a teammate. */
  readonly teammateId?: string
  readonly description?: string
  readonly type?: string
  /** `pending`, `running`, `waiting`, `idle`, `completed`, `failed` or `killed`. */
  readonly status: string
}

/**
 * What a copy to the clipboard of a surface came to, as the engine says it (`UiCopyResult`). `isCopied: false` carries the
 * engine's closed reason: `no-surface`, `no-clipboard` or `refused`. The terminal writes by OSC 52, which gives no answer
 * back: a terminal that drops it still reads `isCopied: true`.
 */
export type CopyResult = { readonly isCopied: true } | { readonly isCopied: false; readonly reason: string }

/** One open pane as the engine's pane list gives it. */
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

/** The code host remote of the session repo. */
export interface RepoRemote {
  readonly host: string
  readonly owner: string
  readonly repo: string
}

/** A repo on a code host, as a person names it. The same fields as `RepoRemote`, writable. */
export type RepoRef = { host: string; owner: string; repo: string }

/**
 * One atom of the state contract (spec 5.13). `update` reads, applies `fn` and writes, with a version check
 * and a retry. A read of an atom never written gives its empty value.
 */
export interface AtomPort<T> {
  get(): Promise<T>
  update(fn: (cur: T) => T): Promise<T>
}

/**
 * The `trackers` StateFamily: one member per slot id. The id is a parameter, the ref stays literal inside the closure.
 * A member never written reads `undefined`.
 */
export interface SlotPort {
  get(id: string): Promise<Json | undefined>
  update(id: string, fn: (cur: Json | undefined) => Json): Promise<Json>
}

/** The `shown` StateFamily: rows shown beyond the cap, one member per section id. A member never written reads 0. */
export interface ShownPort {
  get(id: string): Promise<number>
  update(id: string, fn: (cur: number) => number): Promise<number>
}

/**
 * The state contract: `items`, `tools` and the `trackers` family (L3, decision D14), then the pane state of L6
 * (spec 5.13): the ids the person opened, the selected row id, the rows shown past each cap and the help view.
 */
export interface StatePorts {
  readonly items: AtomPort<StoredItem[]>
  readonly tools: AtomPort<Record<string, ToolStatus>>
  readonly slot: SlotPort
  readonly expanded: AtomPort<string[]>
  readonly selected: AtomPort<string | null>
  readonly shown: ShownPort
  readonly help: AtomPort<boolean>
  /** `/track show-all`: shows the rows the TTL hides, until `/clear`. */
  readonly hidden: AtomPort<HiddenState>
  /**
   * Issue #63, L3: the view the person chose with `g` or `/track view`, as a view id. `null`: none chosen, so the pane uses
   * `global.ui.view`. A value that is no view id reads as none. Session scope, reset by `/clear`, never written to the config file.
   */
  readonly view: AtomPort<string | null>
  /** Issue #63, L3: `t` (touched only). Session scope, reset by `/clear`. */
  readonly filters: AtomPort<FilterState>
  /**
   * Issue #276: `e` (quick view), one flag for each form of the pane. Session scope: a close and a reopen keep it, `/clear` resets
   * it, and it is never written to the config file or the store.
   */
  readonly quick: AtomPort<QuickState>
  /**
   * Issue #138: the ids of the rows the person marked with `m`. `x` and the digits act on the marked rows. Session scope: the
   * pane clears it when it closes and `/clear` resets it. Never written to the config file or the store.
   */
  readonly marks: AtomPort<string[]>
  /** Issue #69: what each main-loop turn tracked. The TurnLedger writes it, Persistence stores it. */
  readonly turns: AtomPort<TurnLedger>
  /**
   * Issue #57, L2: the preview the pane shows in place of the table, or `null`. A row id, its owner and a mode: never the
   * content, which sits in module memory. Session scope: the pane clears it at close and `/clear` resets it. Never written to
   * the config file or the store.
   */
  readonly preview: AtomPort<PreviewState | null>
}

/** What stopping a background task gave: the engine stopped it, or it did not, and says why. */
export type StopResult = { readonly stopped: true } | { readonly stopped: false; readonly reason: string }

/**
 * Stops one background task by its id: the engine's TaskStop tool. Narrow on purpose: no other tool, no other input. It
 * never rejects. A tracker gets it only when it declares `stopsTasks`.
 */
export interface TasksPort {
  stop(taskId: string): Promise<StopResult>
}

/** The plugin store: the plugin's key-value store. Persistence is its only writer. */
export interface StorePort {
  get(key: string): Promise<Json | undefined>
  set(key: string, value: Json): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

export interface Ports {
  readonly clock: {
    /** Engine time. Timers, debounces and the tick use it, so the kit's mock clock drives them. */
    now(): Promise<number>
    /** `Date.now`, for record stamps. */
    wall(): number
    /** The engine call returns the handle at once. A refused timer never fires. */
    after(ms: number, fn: () => void): Timer
    /** A refused period ends the interval (E18). */
    every(ms: number, fn: () => void): Timer
    /**
     * A timer of the mod's own runtime, not of the engine. It makes no engine dispatch, so no hook can refuse it: it fires
     * even when `after` is refused and says nothing (issue #193). Production: `setTimeout`. The fake clock drives it with
     * `after` and `every`, and no `refuse` touches it.
     */
    wake(ms: number, fn: () => void): Timer
  }
  /** The engine's process runner. */
  readonly run: (argv: readonly string[], opts: RunOpts) => Promise<RunResult>
  readonly fs: {
    read(path: string): Promise<string>
    write(path: string, text: string): Promise<void>
    exists(path: string): Promise<boolean>
    /** null on any refusal. `resolve` asks for `realPath`. */
    stat(path: string, opts?: { resolve?: boolean }): Promise<FsStat | null>
  }
  /** Where the mod lives: the folder that holds `.claude-plugin/plugin.json`. Read when asked: a read may throw. */
  readonly plugin: { readonly root: string }
  /** Literal names only. */
  readonly env: { get(name: EnvName): Promise<string | undefined> }
  /** For the file tracker. */
  readonly settings: { read(): Promise<Json> }
  readonly store: StorePort
  readonly session: {
    id(): Promise<string>
    cwd(): Promise<string>
    repo(): Promise<RepoRemote | null>
    messages(): Promise<readonly SessionRow[]>
  }
  readonly agents: { list(): Promise<readonly AgentInfo[]> }
  /**
   * Submits a prompt as a turn of the session (the engine's prompt submit call): it runs once the session is idle, and the model reads
   * it as sent by the mod. It returns at once and never rejects: a call that waits for it from a hook that runs inside a
   * turn would hang. Call it from a press only, never from a timer or a render.
   * `onRefused` hears, later, that the prompt did not enter: a hook dropped it, or the call failed. The engine answers once
   * the prompt entered the session or queued behind the running turn, not when that turn ends. A prompt that entered
   * calls nothing.
   */
  readonly prompt: { submit(text: string, onRefused?: (reason: string) => void): void }
  /** The engine's TaskStop, for `/track clean --yes tasks` (issue #122). Only a tracker that declares `stopsTasks` reaches it. */
  readonly tasks: TasksPort
  /** Closures per atom, refs inline. */
  readonly state: StatePorts
  readonly ui: {
    open(): Promise<boolean>
    /** Asks the engine to move the ring to the element `key`. True when the ring moved, false when the engine refused. */
    focus(key: string): Promise<boolean>
    panes(): Promise<readonly PaneInfo[]>
    /** Call from event handlers and the tick only, never from a render. */
    invalidate(): void
    toast(text: string): void
    /**
     * Puts `text` on the clipboard of a surface (the engine's `ui.copy`). The text is verbatim: newlines and all. `surface`
     * is the one a press came from (`UiPressArgument.surface`): a session can be drawn on several, and the copy must reach
     * the clipboard of the person who pressed. Left out, the engine takes the first surface the session draws on. It rejects
     * when the engine refuses the call. Call it from a press, never from a render.
     */
    copy(text: string, surface?: string): Promise<CopyResult>
  }
  readonly log: (line: string) => void
}
