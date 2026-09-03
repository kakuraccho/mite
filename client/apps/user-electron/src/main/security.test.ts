import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from './security'

describe('isTrustedRendererUrl', () => {
  it('accepts only the exact development origin', () => {
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/index.html')).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:51730/index.html')).toBe(
      false,
    )
    expect(isTrustedRendererUrl('http://127.0.0.1:5173.evil.test')).toBe(false)
  })

  it('accepts only the packaged app host', () => {
    expect(isTrustedRendererUrl('mite-user://app/index.html')).toBe(true)
    expect(isTrustedRendererUrl('mite-user://other/index.html')).toBe(false)
    expect(isTrustedRendererUrl('https://app/index.html')).toBe(false)
  })
})
