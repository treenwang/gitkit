// vitest's happy-dom environment already set up document; this only adds the test-wide conventions.
//
// Inject the shadcn theme variables by default, so the development-mode
// warning does not flood tests that have nothing to do with it. The test that
// specifically verifies that warning removes them itself.
import { beforeEach } from 'vitest'

beforeEach(() => {
  document.documentElement.style.setProperty('--background', '0 0% 100%')
})
