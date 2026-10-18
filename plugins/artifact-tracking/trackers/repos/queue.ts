import { REPOS_DEFAULTS } from './config'

/**
 * Runs repo jobs one after another, off the hook path. A job that throws or rejects does not stop the next one.
 * A key that waits is not queued twice. When `max` jobs wait, a new one is dropped.
 */
export class RepoQueue {
  private tail: Promise<void> = Promise.resolve()
  /** Keys of the jobs that wait. A job leaves the set when it starts. */
  private readonly waiting = new Set<string>()
  private count = 0

  constructor(private readonly max: number = REPOS_DEFAULTS.maxRepoQueue) {}

  /** `false` only when the queue is full. A key that already waits counts as taken care of: `true`. */
  push(key: string, job: () => Promise<void>): boolean {
    if (this.waiting.has(key)) return true
    if (this.waiting.size >= this.max) return false
    this.waiting.add(key)
    this.count++
    this.tail = this.tail.then(async () => {
      this.waiting.delete(key)
      try {
        await job()
      } catch {
        // A failed job must not stop the queue.
      } finally {
        this.count--
      }
    })
    return true
  }

  /** Resolves when every job pushed so far has ended. */
  async idle(): Promise<void> {
    while (this.count > 0) await this.tail
  }
}
