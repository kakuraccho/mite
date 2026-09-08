import { describe, expect, it } from 'vitest'
import { isWslCaptureEnvironment } from './capture-environment'

describe('isWslCaptureEnvironment', () => {
  it('recognizes WSL kernels even without WSL environment variables', () => {
    expect(
      isWslCaptureEnvironment('linux', '6.6.87.2-microsoft-standard-WSL2', {}),
    ).toBe(true)
    expect(isWslCaptureEnvironment('linux', '4.4.0-19041-Microsoft', {})).toBe(
      true,
    )
  })

  it('recognizes WSL with a custom kernel', () => {
    expect(
      isWslCaptureEnvironment('linux', 'custom', { WSL_DISTRO_NAME: 'Ubuntu' }),
    ).toBe(true)
    expect(
      isWslCaptureEnvironment('linux', 'custom', {
        WSL_INTEROP: '/run/WSL/interop',
      }),
    ).toBe(true)
  })

  it('allows native Windows even when launched with inherited WSL variables', () => {
    expect(
      isWslCaptureEnvironment('win32', '10.0', {
        WSL_DISTRO_NAME: 'Ubuntu',
        WSL_INTEROP: '/run/WSL/interop',
      }),
    ).toBe(false)
    expect(isWslCaptureEnvironment('linux', '6.12-generic', {})).toBe(false)
  })
})
