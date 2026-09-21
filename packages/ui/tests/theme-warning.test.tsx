import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { createElement } from 'react'
import { GitkitClient } from '@treenwang/gitkit-client'
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

describe('detecting a missing theme in development', () => {
  test('warns actionably when --background is missing', () => {
    document.documentElement.style.removeProperty('--background')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings.join('\n')).toContain('@source')
    expect(warnings.join('\n')).toContain('--background')
  })

  test('stays quiet when the theme variables are present', () => {
    document.documentElement.style.setProperty('--background', '0 0% 100%')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings).toEqual([])
  })

  test('does not check in production', () => {
    const prev = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    document.documentElement.style.removeProperty('--background')
    render(createElement(GitkitProvider, { client }, null))
    expect(warnings).toEqual([])
    process.env.NODE_ENV = prev
  })
})
