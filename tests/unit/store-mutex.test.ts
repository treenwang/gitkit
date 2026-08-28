import { describe, expect, test } from 'bun:test'
import { StoreMutex } from '../../src/exec/store-mutex'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('StoreMutex', () => {
  test('同 key 的任务串行执行，不重叠', async () => {
    const m = new StoreMutex()
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`)
      await tick(ms)
      events.push(`${name}:end`)
      return name
    }
    await Promise.all([m.run('k', job('a', 20)), m.run('k', job('b', 1))])
    expect(events).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
  })

  test('不同 key 的任务可并发', async () => {
    const m = new StoreMutex()
    const events: string[] = []
    const job = (name: string, ms: number) => async () => {
      events.push(`${name}:start`)
      await tick(ms)
      events.push(`${name}:end`)
    }
    await Promise.all([m.run('k1', job('a', 20)), m.run('k2', job('b', 1))])
    expect(events[0]).toBe('a:start')
    expect(events[1]).toBe('b:start')
  })

  test('返回值透传', async () => {
    const m = new StoreMutex()
    expect(await m.run('k', async () => 42)).toBe(42)
  })

  test('抛错后队列不卡死，后续任务照常执行', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await m.run('k', async () => 'ok')).toBe('ok')
  })

  test('队列排空后不残留 key，避免内存泄漏', async () => {
    const m = new StoreMutex()
    await m.run('k', async () => 1)
    await tick(5)
    expect(m.size).toBe(0)
  })
})
