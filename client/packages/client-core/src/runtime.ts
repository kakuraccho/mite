export interface RuntimeConfig {
  role: 'USER' | 'FAMILY'
  apiBaseUrl: string
  demoToken: string
  captureIntervalMs: number
  captureMaxCount: number
  appVersion: string
}

export interface MiteDesktopBridge {
  getRuntimeConfig(): Promise<RuntimeConfig>
}

declare global {
  interface Window {
    miteDesktop?: MiteDesktopBridge
  }
}

export const loadRuntimeConfig = async (): Promise<RuntimeConfig> => {
  const bridge = window.miteDesktop
  if (!bridge) throw new Error('Mite desktop bridge is unavailable')

  const config = await bridge.getRuntimeConfig()
  if (!config.apiBaseUrl || !Number.isFinite(config.captureIntervalMs)) {
    throw new Error('Mite runtime configuration is invalid')
  }
  return config
}
