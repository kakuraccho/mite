import {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  net,
  protocol,
  screen,
  session,
  type IpcMainInvokeEvent,
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
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
import { SupportScreenshotDraftStore } from './support-screenshot-draft'
import { isUserOverlayMode } from '../shared/overlay'

const scheme = userScheme
const productionOrigin = userProductionOrigin
const captureSchemaVersion = 1 as const
const maxCaptureWidth = 1920
const maxCaptureHeight = 1080
const jpegQuality = 80
let overlayController: UserOverlayController | null = null

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

interface ScreenSourceSummary {
  id: string
  name: string
  thumbnailDataUrl: string
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
  if (!isTrustedUrl(event.senderFrame?.url ?? '')) {
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

const writeAtomic = async (filename: string, contents: Uint8Array | string) => {
  const temporary = `${filename}.${randomUUID()}.tmp`
  await writeFile(temporary, contents, { flag: 'wx' })
  const handle = await open(temporary, 'r')
  await handle.sync()
  await handle.close()
  await rename(temporary, filename)
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
    () => null,
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

const fitSize = (width: number, height: number) => {
  const ratio = Math.min(
    1,
    maxCaptureWidth / Math.max(width, 1),
    maxCaptureHeight / Math.max(height, 1),
  )
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  }
}

const sourceThumbnail = async (sourceId: string) => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: maxCaptureWidth, height: maxCaptureHeight },
    fetchWindowIcons: true,
  })
  const source = sources.find((candidate) => candidate.id === sourceId)
  if (!source) throw new Error('選んだ画面が見つかりません')
  if (source.name === 'Mite' || source.name.startsWith('Mite ')) {
    throw new Error('Miteの画面は選べません')
  }
  if (source.thumbnail.isEmpty()) throw new Error('画面を取得できません')
  return source.thumbnail
}

const toJpeg = async (sourceId: string) => {
  const thumbnail = await sourceThumbnail(sourceId)
  const size = thumbnail.getSize()
  const fitted = fitSize(size.width, size.height)
  const resized =
    fitted.width === size.width && fitted.height === size.height
      ? thumbnail
      : thumbnail.resize({ ...fitted, quality: 'best' })
  return resized.toJPEG(jpegQuality)
}

let selectedSourceId: string | null = null
const captureLocks = new Map<string, Promise<unknown>>()

const listSources = async (): Promise<ScreenSourceSummary[]> => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 480, height: 270 },
    fetchWindowIcons: true,
  })
  return sources
    .filter(
      (source) => source.name !== 'Mite' && !source.name.startsWith('Mite '),
    )
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }))
}

const selectSource = async (sourceId: string) => {
  const sources = await listSources()
  if (!sources.some((source) => source.id === sourceId)) {
    throw new Error('選んだ画面が見つかりません')
  }
  selectedSourceId = sourceId
}

const capturePreview = async (sourceId: string) => {
  await selectSource(sourceId)
  const jpeg = await toJpeg(sourceId)
  return {
    capturedAt: new Date().toISOString(),
    bytes: new Uint8Array(jpeg),
  }
}

const saveCaptureUnlocked = async (supportSessionId: string) => {
  if (!selectedSourceId) throw new Error('共有する画面を選んでください')
  const manifest = await ensureManifest(supportSessionId)
  const maximum = runtimeConfig().captureMaxCount
  if (manifest.captures.length >= maximum) {
    return { manifest, reachedLimit: true }
  }

  const jpeg = await toJpeg(selectedSourceId)
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

const saveCapture = async (supportSessionId: string) => {
  const previous = captureLocks.get(supportSessionId) ?? Promise.resolve()
  const current = previous
    .catch(() => {})
    .then(() => saveCaptureUnlocked(supportSessionId))
  captureLocks.set(supportSessionId, current)
  try {
    return await current
  } finally {
    if (captureLocks.get(supportSessionId) === current) {
      captureLocks.delete(supportSessionId)
    }
  }
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
      const manifest = await readManifest(entry.name)
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
        !selectedSourceId ||
        !isTrustedUrl(request.securityOrigin) ||
        !isTrustedUrl(request.frame?.url ?? '') ||
        !request.videoRequested ||
        request.audioRequested
      ) {
        callback({})
        return
      }
      try {
        const sources = await desktopCapturer.getSources({
          types: ['window'],
          thumbnailSize: { width: 0, height: 0 },
        })
        const source = sources.find(
          (candidate) => candidate.id === selectedSourceId,
        )
        callback(source ? { video: source } : {})
      } catch {
        callback({})
      }
    },
    { useSystemPicker: false },
  )
}

const registerIpc = () => {
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
  ipcMain.handle('screen:list-sources', async (event) => {
    assertTrustedSender(event)
    return listSources()
  })
  ipcMain.handle('screen:select-source', async (event, sourceId: unknown) => {
    assertTrustedSender(event)
    if (typeof sourceId !== 'string') throw new Error('sourceId is invalid')
    await selectSource(sourceId)
  })
  ipcMain.handle('screen:capture-preview', async (event, sourceId: unknown) => {
    assertTrustedSender(event)
    if (typeof sourceId !== 'string') throw new Error('sourceId is invalid')
    return capturePreview(sourceId)
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
    return ensureManifest(sessionId)
  })
  ipcMain.handle('capture:save', async (event, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
    return saveCapture(sessionId)
  })
  ipcMain.handle('capture:get-manifest', async (event, sessionId: unknown) => {
    assertTrustedSender(event)
    if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
    return readManifest(sessionId)
  })
  ipcMain.handle(
    'capture:read-file',
    async (event, sessionId: unknown, filename: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string' || typeof filename !== 'string') {
        throw new Error('capture path is invalid')
      }
      return readCapture(sessionId, filename)
    },
  )
  ipcMain.handle(
    'capture:set-batch-id',
    async (event, sessionId: unknown, batchId: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string' || typeof batchId !== 'string') {
        throw new Error('capture identifiers are invalid')
      }
      return setBatchId(sessionId, batchId)
    },
  )
  ipcMain.handle(
    'capture:ensure-no-materials-key',
    async (event, sessionId: unknown) => {
      assertTrustedSender(event)
      if (typeof sessionId !== 'string') throw new Error('sessionId is invalid')
      return ensureNoMaterialsKey(sessionId)
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
      await rm(captureDirectory(sessionId), { recursive: true, force: true })
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
  window.once('closed', () => {
    overlayController = null
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
  registerDisplayMediaHandler()
  registerIpc()
  createWindow()
  const refreshOverlay = () => overlayController?.refresh()
  screen.on('display-metrics-changed', refreshOverlay)
  screen.on('display-added', refreshOverlay)
  screen.on('display-removed', refreshOverlay)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  overlayController?.dispose()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
