import { defineConfig } from 'oxlint'

export default defineConfig({
  categories: {
    correctness: 'deny',
    perf: 'deny',
    suspicious: 'deny',
  },
  env: {
    node: true,
  },
  ignorePatterns: ['**/dist/**', '**/.turbo/**'],
  options: {
    denyWarnings: true,
    reportUnusedDisableDirectives: 'deny',
    typeAware: true,
  },
  plugins: ['oxc', 'typescript', 'unicorn', 'vitest'],
})
