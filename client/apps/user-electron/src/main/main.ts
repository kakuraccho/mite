import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  type IpcMainInvokeEvent,
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { RuntimeConfig } from '@mite/client-core'
import {
  isTrustedRendererUrl,
  userProductionOrigin,
  userScheme,
} from './security'
import { createAppBarAdapter } from './appbar'
import { UserOverlayController } from './overlay-controller'
import { writeAtomic } from './write-atomic'
import { MarkingOverlay } from './marking-overlay'
import { createCaptureSessionQueue } from './capture-session-queue'
import { SupportScreenshotDraftStore } from './support-screenshot-draft'
import { PrimaryScreenCapture } from './primary-screen-capture'
import {
  assertScreenCaptureAvailable,
  isWslCaptureEnvironment,
} from './capture-environment'
import { isUserOverlayMode } from '../shared/overlay'

const scheme = userScheme
const productionOrigin = userProductionOrigin
const captureSchemaVersion = 1 as const
const primaryScreenCapture = new PrimaryScreenCapture()
let overlayController: UserOverlayController | null = null
let userWindow: BrowserWindow | null = null
let markingOverlay: MarkingOverlay | null = null

interface CaptureEntry {
  clientCaptureId: string
  sequence: number
  capturedAt: string
  filename: string
  sha256: string
  uploadIdempotencyKey: string
}

interface CaptureManifest {
  schemaVersion: typeof captureSchemaVersion
  supportSessionId: string
  guideMaterialBatchId: string | null
  batchCreateIdempotencyKey: string
  batchCompleteIdempotencyKey: string
  noMaterialsEndIdempotencyKey: string | null
  captures: CaptureEntry[]
}

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

const assertTrustedSender = (event: IpcMainInvokeEvent) => {
  if (
    !userWindow ||
    event.sender !== userWindow.webContents ||
    event.senderFrame !== userWindow.webContents.mainFrame ||
    !isTrustedUrl(event.senderFrame?.url ?? '')
  ) {
    throw new Error('Untrusted IPC sender')
  }
}

const parseInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const runtimeConfig = (): RuntimeConfig => ({
  role: 'USER',
  apiBaseUrl: process.env.MITE_API_BASE_URL ?? 'http://localhost:3000',
  demoToken: process.env.MITE_DEMO_TOKEN ?? '',
  captureIntervalMs: parseInteger(process.env.CAPTURE_INTERVAL_MS, 5_000),
  captureMaxCount: Math.min(
    parseInteger(process.env.CAPTURE_MAX_COUNT, 360),
    360,
  ),
  appVersion: app.getVersion(),
})

const idempotencyKey = (purpose: string) =>
  `mite-${purpose}-${randomUUID()}`.slice(0, 128)

const miteDataRoot = () => {
  const localDataRoot =
    process.platform === 'win32' && process.env.LOCALAPPDATA
      ? process.env.LOCALAPPDATA
      : app.getPath('userData')
  return path.join(localDataRoot, 'Mite')
}

const capturesRoot = () => path.join(miteDataRoot(), 'captures')

const supportScreenshotDraftStore = () =>
  new SupportScreenshotDraftStore(
    path.join(miteDataRoot(), 'support-request-drafts'),
  )

const assertSafeId = (value: string, label: string) => {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

const captureDirectory = (supportSessionId: string) =>
  path.join(capturesRoot(), assertSafeId(supportSessionId, 'supportSessionId'))

const manifestPath = (supportSessionId: string) =>
  path.join(captureDirectory(supportSessionId), 'manifest.json')

const fileName = (sequence: number) =>
  `${String(sequence).padStart(6, '0')}.jpg`

const isCaptureEntry = (value: unknown): value is CaptureEntry => {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.clientCaptureId === 'string' &&
    Number.isInteger(entry.sequence) &&
    typeof entry.capturedAt === 'string' &&
    typeof entry.filename === 'string' &&
    /^\d{6}\.jpg$/.test(entry.filename) &&
    typeof entry.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(entry.sha256) &&
    typeof entry.uploadIdempotencyKey === 'string'
  )
}

const isCaptureManifest = (value: unknown): value is CaptureManifest => {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Record<string, unknown>
  return (
    manifest.schemaVersion === captureSchemaVersion &&
    typeof manifest.supportSessionId === 'string' &&
    (manifest.guideMaterialBatchId === null ||
      typeof manifest.guideMaterialBatchId === 'string') &&
    typeof manifest.batchCreateIdempotencyKey === 'string' &&
    typeof manifest.batchCompleteIdempotencyKey === 'string' &&
    (manifest.noMaterialsEndIdempotencyKey === null ||
      typeof manifest.noMaterialsEndIdempotencyKey === 'string') &&
    Array.isArray(manifest.captures) &&
    manifest.captures.every(isCaptureEntry)
  )
}

const removeTemporaryFiles = async (directory: string) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
      .map((entry) =>
        rm(path.join(directory, entry.name), { force: true }).catch(() => {}),
      ),
  )
}

const createEmptyManifest = (supportSessionId: string): CaptureManifest => ({
  schemaVersion: captureSchemaVersion,
  supportSessionId,
  guideMaterialBatchId: null,
  batchCreateIdempotencyKey: idempotencyKey('batch-create'),
  batchCompleteIdempotencyKey: idempotencyKey('batch-complete'),
  noMaterialsEndIdempotencyKey: null,
  captures: [],
})

const readManifest = async (
  supportSessionId: string,
): Promise<CaptureManifest | null> => {
  const directory = captureDirectory(supportSessionId)
  await removeTemporaryFiles(directory)
  const raw = await readFile(manifestPath(supportSessionId), 'utf8').catch(
    (error: unknown) => {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      )
        return null
      throw error
    },
  )
  if (raw === null) return null
  const parsed: unknown = JSON.parse(raw)
  if (
    !isCaptureManifest(parsed) ||
    parsed.supportSessionId !== supportSessionId
  ) {
    throw new Error('保存した画面の記録が壊れています')
  }
  const ordered = [...parsed.captures].sort((a, b) => a.sequence - b.sequence)
  if (
    ordered.some(
      (entry, index) =>
        entry.sequence !== index + 1 || entry.filename !== fileName(index + 1),
    )
  ) {
    throw new Error('保存した画面の順番が壊れています')
  }
  return { ...parsed, captures: ordered }
}

const saveManifest = async (manifest: CaptureManifest) => {
  const directory = captureDirectory(manifest.supportSessionId)
  await mkdir(directory, { recursive: true })
  await writeAtomic(
    manifestPath(manifest.supportSessionId),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

const ensureManifest = async (supportSessionId: string) => {
  const existing = await readManifest(supportSessionId)
  if (existing) return existing
  const manifest = createEmptyManifest(supportSessionId)
  await saveManifest(manifest)
  return manifest
}

const withCaptureLock = createCaptureSessionQueue()

const capturePreview = async () => {
  const jpeg = await primaryScreenCapture.jpeg()
  return {
    capturedAt: new Date().toISOString(),
    bytes: new Uint8Array(jpeg),
  }
}

const saveCaptureUnlocked = async (supportSessionId: string) => {
  const manifest = await ensureManifest(supportSessionId)
  const maximum = runtimeConfig().captureMaxCount
  if (manifest.captures.length >= maximum) {
    return { manifest, reachedLimit: true }
  }

  const jpeg = await primaryScreenCapture.jpeg(true)
  const sequence = manifest.captures.length + 1
  const filename = fileName(sequence)
  const destination = path.join(captureDirectory(supportSessionId), filename)
  await writeAtomic(destination, jpeg)

  const entry: CaptureEntry = {
    clientCaptureId: `cap-${randomUUID()}`,
    sequence,
    capturedAt: new Date().toISOString(),
    filename,
    sha256: createHash('sha256').update(jpeg).digest('hex'),
    uploadIdempotencyKey: idempotencyKey('material'),
  }
  const updated = { ...manifest, captures: [...manifest.captures, entry] }
  await saveManifest(updated)
  return { manifest: updated, reachedLimit: updated.captures.length >= maximum }
}

const readCapture = async (supportSessionId: string, filename: string) => {
  if (!/^\d{6}\.jpg$/.test(filename)) throw new Error('filename is invalid')
  const manifest = await readManifest(supportSessionId)
  const capture = manifest?.captures.find(
    (entry) => entry.filename === filename,
  )
  if (!capture) throw new Error('保存した画面が見つかりません')
  const bytes = await readFile(
    path.join(captureDirectory(supportSessionId), filename),
  )
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== capture.sha256) {
    throw new Error('保存した画面が壊れているため送信を止めました')
  }
  return new Uint8Array(bytes)
}

const setBatchId = async (supportSessionId: string, batchId: string) => {
  assertSafeId(batchId, 'batchId')
  const manifest = await ensureManifest(supportSessionId)
  if (
    manifest.guideMaterialBatchId &&
    manifest.guideMaterialBatchId !== batchId
  ) {
    throw new Error('保存した送信記録とサーバーの状態が一致しません')
  }
  const updated = { ...manifest, guideMaterialBatchId: batchId }
  await saveManifest(updated)
  return updated
}

const ensureNoMaterialsKey = async (supportSessionId: string) => {
  const manifest = await ensureManifest(supportSessionId)
  if (manifest.noMaterialsEndIdempotencyKey) return manifest
  const updated = {
    ...manifest,
    noMaterialsEndIdempotencyKey: idempotencyKey('no-materials'),
  }
  await saveManifest(updated)
  return updated
}

const listCaptureSessions = async () => {
  const root = capturesRoot()
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const sessions: Array<{
    supportSessionId: string
    modifiedAt: string
    manifest: CaptureManifest | null
    error: string | null
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9_-]{1,128}$/.test(entry.name)) {
      continue
    }
    try {
      const manifest = await withCaptureLock(entry.name, () =>
        readManifest(entry.name),
      )
      if (!manifest) continue
      const details = await stat(captureDirectory(entry.name))
      sessions.push({
        supportSessionId: entry.name,
        modifiedAt: details.mtime.toISOString(),
        manifest,
        error: null,
      })
    } catch {
      const details = await stat(captureDirectory(entry.name)).catch(() => null)
      sessions.push({
        supportSessionId: entry.name,
        modifiedAt: details?.mtime.toISOString() ?? new Date().toISOString(),
        manifest: null,
        error: '保存した画面の記録が壊れています',
      })
    }
  }
  return sessions
}

const registerAppProtocol = () => {
  const rendererRoot = path.resolve(__dirname, '../../dist/renderer')
  protocol.handle(scheme, (request) => {
    let requestUrl: URL
    let relativePath: string
    try {
      requestUrl = new URL(request.url)
      if (
        requestUrl.protocol !== `${scheme}:` ||
        requestUrl.hostname !== 'app' ||
        requestUrl.port !== '' ||
        requestUrl.username !== '' ||
        requestUrl.password !== ''
      ) {
        return new Response('Not found', { status: 404 })
      }
      relativePath = decodeURIComponent(requestUrl.pathname).replace(
        /^\/+/u,
        '',
      )
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

const registerDisplayMediaHandler = () => {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        request.frame !== userWindow?.webContents.mainFrame ||
        !isTrustedUrl(request.securityOrigin) ||
        !isTrustedUrl(request.frame?.url ?? '') ||
        !request.videoRequested ||
        request.audioRequested
      ) {
        callback({})
        return
      }
      try {
        const source = await primaryScreenCapture.sharingSource()
        callback({ video: source })
      } catch {
        callback({})
      }
    },
    { useSystemPicker: false },
  )
}

const registerIpc = () => {
  ipcMain.handle('marking:set', (event, marks: unknown) => {
    assertTrustedSender(event)
    if (!markingOverlay) throw new Error('Marking overlay is unavailable')
    markingOverlay.setMarks(marks)
  })
  ipcMain.on('marking:ready', (event) => markingOverlay?.rendererReady(event))
  ipcMain.handle('runtime:get-config', (event) => {
    assertTrustedSender(event)
    return runtimeConfig()
  })
  ipcMain.handle('overlay:set-mode', (event, mode: unknown) => {
    assertTrustedSender(event)
    if (!isUserOverlayMode(mode)) throw new Error('overlay mode is invalid')
    if (!overlayController) throw new Error('overlay is unavailable')
    return overlayController.setMode(mode)
  })
  ipcMain.handle('screen:prepare-share', async (event) => {
    assertTrustedSender(event)
    return primaryScreenCapture.prepareScreenShare()
  })
  ipcMain.handle('screen:capture-preview', async (event) => {
    assertTrustedSender(event)
    return capturePreview()
  })
  ipcMain.handle(
    'support-draft:save-screenshot',
    async (event, draftId: unknown, capturedAt: unknown, bytes: unknown) => {
      assertTrustedSender(event)
      if (
        typeof draftId !== 'string' ||
        typeof capturedAt !== 'string' ||
        !(bytes instanceof Uint8Array)
      ) {
        throw new Error('support screenshot draft is invalid')
      }
      return supportScreenshotDraftStore().save(draftId, capturedAt, bytes)
    },
  )
  ipcMain.handle(
    'support-draft:load-screenshot',
    async (event, draftId: unknown) => {
      assertTrustedSender(event)
      if (typeof draftId !== 'string') throw new Error('draftId is invalid')
      assertScreenCaptureAvailable()
      return supportScreenshotDraftStore().load(draftId)
    },
  )
  ipcMain.handle(
    'support-draft:delete-screenshot',
    async (event, draftId: unknown) => {
      assertTrustedSender(event)
      if (typeof draftId !== 'string') throw new Error('draftId is invalid')
      await supportScreenshotDraftStore().delete(draftId)
    },
  )
  ipcMain.handle('capture:initialize', async (event, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
    return withCaptureLock(sessionId, () => ensureManifest(sessionId))
  })
  ipcMain.handle('capture:save', async (event, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
    return withCaptureLock(sessionId, () => saveCaptureUnlocked(sessionId))
  })
  ipcMain.handle('capture:get-manifest', async (event, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
    return withCaptureLock(sessionId, () => readManifest(sessionId))
  })
  ipcMain.handle(
    'capture:read-file',
    async (event, sessionId: unknown, filename: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string' || typeof filename !== 'string') {
        throw new Error('capture path is invalid')
      }
      return withCaptureLock(sessionId, () => readCapture(sessionId, filename))
    },
  )
  ipcMain.handle(
    'capture:set-batch-id',
    async (event, sessionId: unknown, batchId: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string' || typeof batchId !== 'string') {
        throw new Error('capture identifiers are invalid')
      }
      return withCaptureLock(sessionId, () => setBatchId(sessionId, batchId))
    },
  )
  ipcMain.handle(
    'capture:ensure-no-materials-key',
    async (event, sessionId: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
      return withCaptureLock(sessionId, () => ensureNoMaterialsKey(sessionId))
    },
  )
  ipcMain.handle('capture:list-sessions', async (event) => {
    assertTrustedSender(event)
    return listCaptureSessions()
  })
  ipcMain.handle(
    'capture:delete-session',
    async (event, sessionId: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
      await withCaptureLock(sessionId, () =>
        rm(captureDirectory(sessionId), { recursive: true, force: true }),
      )
    },
  )
}

const createWindow = () => {
  const workArea = screen.getPrimaryDisplay().workArea
  const window = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: 4,
    height: workArea.height,
    minWidth: 1,
    minHeight: 1,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    title: 'Mite',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  userWindow = window
  if (process.platform === 'win32') window.setContentProtection(true)
  overlayController = new UserOverlayController(
    window,
    () => screen.getPrimaryDisplay(),
    createAppBarAdapter(),
  )
  overlayController.initialize()
  window.setAlwaysOnTop(true, 'floating')
  window.setMenuBarVisibility(false)

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
  window.once('ready-to-show', () => window.showInactive())
  window.once('close', () => {
    overlayController?.dispose()
  })
  window.webContents.on('did-start-loading', () => markingOverlay?.setMarks([]))
  window.webContents.on('render-process-gone', () =>
    markingOverlay?.setMarks([]),
  )
  window.once('closed', () => {
    overlayController = null
    userWindow = null
    markingOverlay?.dispose()
    markingOverlay = null
  })

  const developmentUrl = process.env.MITE_RENDERER_DEV_URL
  const rendererUrl =
    !app.isPackaged && developmentUrl && isTrustedUrl(developmentUrl)
      ? developmentUrl
      : `${productionOrigin}/index.html`
  const markingUrl = new URL(rendererUrl)
  markingUrl.searchParams.set('view', 'marking')
  markingOverlay = new MarkingOverlay(
    markingUrl.toString(),
    path.join(__dirname, '../preload/marking-preload.js'),
  )
  void window.loadURL(rendererUrl)
}

app.whenReady().then(() => {
  if (isWslCaptureEnvironment()) {
    console.warn(
      'WSLではWindowsの画面全体を撮影・共有できません。Windows側のNode.jsで npm run dev:user を実行してください。手順: docs/setup.md',
    )
  }
  registerAppProtocol()
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const trusted =
        webContents === userWindow?.webContents &&
        isTrustedUrl(webContents.getURL())
      callback(trusted && permission === 'media')
    },
  )
  registerDisplayMediaHandler()
  registerIpc()
  createWindow()
  const refreshOverlay = () => {
    overlayController?.refresh()
    markingOverlay?.refresh()
  }
  screen.on('display-metrics-changed', refreshOverlay)
  screen.on('display-added', refreshOverlay)
  screen.on('display-removed', refreshOverlay)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  markingOverlay?.dispose()
  overlayController?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
