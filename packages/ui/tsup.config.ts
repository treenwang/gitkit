import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/hooks.ts', 'src/components.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  sourcemap: true,
  external: ['react', 'react-dom', '@tanstack/react-query', 'radix-ui', 'lucide-react'],
})
