/**
 * An in-process serial queue, keyed.
 *
 * It exists only to protect store-level shared state: git fetch (which writes
 * refs and objects) and git worktree add/remove (which writes .git/worktrees).
 * Operations inside a worktree take no lock at all.
 *
 * This package assumes a single process owns the root directory, so no file
 * lock or distributed lock is needed.
 */
export class StoreMutex {
  #tails = new Map<string, Promise<unknown>>()

  get size(): number {
    return this.#tails.size
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()
    // Queue on regardless of whether the previous task succeeded, so one failure cannot wedge the queue
    const result = prev.then(fn, fn)
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key)
    })
    this.#tails.set(key, tail)
    return result
  }
}
