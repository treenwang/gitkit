import { describe, expect, test } from 'vitest'
import { StoreMutex } from '../../src/exec/store-mutex'

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('StoreMutex', () => {
  test('tasks with the same key run serially and never overlap', async () => {
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

  test('tasks with different keys run concurrently', async () => {
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

  test('return values pass through', async () => {
    const m = new StoreMutex()
    expect(await m.run('k', async () => 42)).toBe(42)
  })

  test('a throw does not wedge the queue and later tasks still run', async () => {
    const m = new StoreMutex()
    await expect(m.run('k', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await m.run('k', async () => 'ok')).toBe('ok')
  })

  test('no key is left behind once the queue drains, so nothing leaks', async () => {
    const m = new StoreMutex()
    await m.run('k', async () => 1)
    await tick(5)
    expect(m.size).toBe(0)
  })
})
