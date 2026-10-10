import { describe, expect, it } from 'vitest'

import { greet } from '../src/index.js'

describe('greet', () => {
  it('greets the provided name', () => {
    expect(greet('TypeScript')).toBe('Hello, TypeScript!')
  })
})
