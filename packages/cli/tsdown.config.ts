import { defineConfig } from 'tsdown'

export default defineConfig({
  clean: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  deps: { alwaysBundle: ['@imgrelay/core'] },
  publint: true,
  sourcemap: true,
  copy: [
    { from: '../../LICENSE.md', to: '.' },
    { from: '../../README.md', to: '.' },
  ],
})
