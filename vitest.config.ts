import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}/src/index.ts`, import.meta.url))

// Resolve cross-package imports straight to source, matching the paths in
// tsconfig.base.json. Tests should not depend on dist — having to build before
// you can run them is coupling with nothing to show for it.
const alias = {
  '@treenwang/gitkit': src('core'),
  '@treenwang/gitkit-client': src('client'),
  '@treenwang/gitkit-server': src('server'),
}

// The integration tests really run git (clone, push, rebase), an order of
// magnitude slower than the unit tests. The 5s default produces false failures
// on a cold CI cache.
const timeouts = { testTimeout: 60_000, hookTimeout: 60_000 }

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          include: ['packages/{core,client,server}/tests/**/*.test.ts'],
          environment: 'node',
          ...timeouts,
        },
      },
      {
        // The browser-side package runs in happy-dom
        resolve: { alias },
        esbuild: { jsx: 'automatic' },
        test: {
          name: 'ui',
          include: ['packages/ui/tests/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          setupFiles: ['./packages/ui/tests/setup.ts'],
          ...timeouts,
        },
      },
    ],
  },
})
