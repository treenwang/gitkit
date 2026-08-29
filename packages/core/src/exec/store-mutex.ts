/**
 * 按 key 分键的进程内串行队列。
 *
 * 只用于保护 store 级共享状态：git fetch（写 refs 与对象）与
 * git worktree add/remove（写 .git/worktrees）。worktree 内部的操作一律无锁。
 *
 * 本包假设单进程独占 root 目录，因此不需要文件锁或分布式锁。
 */
export class StoreMutex {
  #tails = new Map<string, Promise<unknown>>()

  get size(): number {
    return this.#tails.size
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve()
    // 无论前一个任务成功还是失败都继续排队，避免队列卡死
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
