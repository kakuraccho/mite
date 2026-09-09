import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadRuntimeConfig, type RuntimeConfig } from './runtime'

const config: RuntimeConfig = {
  role: 'FAMILY',
  apiBaseUrl: 'http://127.0.0.1:3000',
  demoToken: 'family-token',
  captureIntervalMs: 5_000,
  captureMaxCount: 360,
  appVersion: '0.1.0',
}

afterEach(() => {
  delete window.miteDesktop
  vi.restoreAllMocks()
})

describe('loadRuntimeConfig', () => {
  it('rejects with a controlled error outside the Electron preload context', async () => {
    delete window.miteDesktop

    await expect(loadRuntimeConfig()).rejects.toThrow(
      'Mite desktop bridge is unavailable',
    )
  })

  it('loads configuration through the exposed desktop bridge', async () => {
    const getRuntimeConfig = vi.fn().mockResolvedValue(config)
    window.miteDesktop = { getRuntimeConfig }

    await expect(loadRuntimeConfig()).resolves.toEqual(config)
    expect(getRuntimeConfig).toHaveBeenCalledOnce()
  })
})
