import { contextBridge, ipcRenderer } from 'electron'
import type { MiteDesktopBridge, RuntimeConfig } from '@mite/client-core'

const bridge: MiteDesktopBridge = Object.freeze({
  getRuntimeConfig: () =>
    ipcRenderer.invoke('runtime:get-config') as Promise<RuntimeConfig>,
})

contextBridge.exposeInMainWorld('miteDesktop', bridge)
