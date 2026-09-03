import { describe, expect, it } from 'vitest'
import { isTrustedRendererUrl } from './security'

describe('isTrustedRendererUrl', () => {
  it('開発用originはhostとportの完全一致だけを許可する', () => {
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/index.html')).toBe(true)
    expect(isTrustedRendererUrl('http://127.0.0.1:51740/index.html')).toBe(
      false,
    )
    expect(isTrustedRendererUrl('http://127.0.0.1:5174.evil.test')).toBe(false)
  })

  it('配布版はmite-family schemeとapp hostだけを許可する', () => {
    expect(isTrustedRendererUrl('mite-family://app/index.html')).toBe(true)
    expect(isTrustedRendererUrl('mite-family://other/index.html')).toBe(false)
    expect(isTrustedRendererUrl('https://app/index.html')).toBe(false)
    expect(isTrustedRendererUrl('not a url')).toBe(false)
  })
})
