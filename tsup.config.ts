import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // 类型声明由 tsc -p tsconfig.build.json 生成：
  // tsup 的 rollup-plugin-dts 与 TS 5.9 不兼容。
  dts: false,
  clean: true,
  target: 'node18',
  sourcemap: true,
  external: ['@octokit/rest'],
})
