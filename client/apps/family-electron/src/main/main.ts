import { app, BrowserWindow, ipcMain, net, protocol, session } from 'electron'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeConfig } from '@mite/client-core'
import { rememberMaximizedState } from './window-state'
import {
  familyProductionOrigin,
  familyScheme,
  isTrustedRendererUrl,
} from './security'

const scheme = familyScheme
const productionOrigin = familyProductionOrigin

protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])

const isTrustedUrl = isTrustedRendererUrl

const runtimeConfig = (): RuntimeConfig => ({
  role: 'FAMILY',
  apiBaseUrl: process.env.MITE_API_BASE_URL ?? 'http://localhost:3000',
  demoToken: process.env.MITE_DEMO_TOKEN ?? '',
  captureIntervalMs: 10_000,
  captureMaxCount: 360,
  appVersion: app.getVersion(),
})

const registerAppProtocol = () => {
  const rendererRoot = path.resolve(__dirname, '../../dist/renderer')
  protocol.handle(scheme, (request) => {
    let requestUrl: URL
    let relativePath: string
    try {
      requestUrl = new URL(request.url)
      if (!isTrustedUrl(requestUrl.toString())) {
        return new Response('Not found', { status: 404 })
      }
      relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '')
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const resolvedPath = path.resolve(
      rendererRoot,
      relativePath || 'index.html',
    )
    const isWithinRendererRoot =
      resolvedPath === rendererRoot ||
      resolvedPath.startsWith(`${rendererRoot}${path.sep}`)

    if (!isWithinRendererRoot) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(resolvedPath).toString())
  })
}

const createWindow = () => {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#f4f3ed',
    title: 'Mite Family',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  rememberMaximizedState(
    window,
    path.join(app.getPath('userData'), 'window-state.json'),
  )
  window.once('ready-to-show', () => window.show())

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })

  const developmentUrl = process.env.MITE_RENDERER_DEV_URL
  if (!app.isPackaged && developmentUrl && isTrustedUrl(developmentUrl)) {
    void window.loadURL(developmentUrl)
  } else {
    void window.loadURL(`${productionOrigin}/index.html`)
  }
}

app.whenReady().then(() => {
  registerAppProtocol()
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const trusted = isTrustedUrl(webContents.getURL())
      callback(trusted && permission === 'media')
    },
  )
  ipcMain.handle('runtime:get-config', (event) => {
    if (!isTrustedUrl(event.senderFrame?.url ?? '')) {
      throw new Error('Untrusted IPC sender')
    }
    return runtimeConfig()
  })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
