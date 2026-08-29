import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { GitkitClient } from '@aaxis/gitkit-client'
import { GitkitProvider } from '../src/context'

const client = new GitkitClient({ baseUrl: '/g', sessionId: 's' })
const original = console.warn
let warnings: string[]

beforeEach(() => {
  warnings = []
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')) }
})
afterEach(() => {
  console.warn = original
  document.documentElement.style.setProperty('--background', '0 0% 100%')
})

describe('开发期主题缺失检测', () => {
  test('缺少 --background 时给出可操作的警告', () => {
    document.documentElement.style.removeProperty('--background')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings.join('\n')).toContain('@source')
    expect(warnings.join('\n')).toContain('--background')
  })

  test('主题变量存在时不警告', () => {
    document.documentElement.style.setProperty('--background', '0 0% 100%')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings).toEqual([])
  })

  test('生产环境不检测', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    document.documentElement.style.removeProperty('--background')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings).toEqual([])
    process.env.NODE_ENV = prev
  })
})
