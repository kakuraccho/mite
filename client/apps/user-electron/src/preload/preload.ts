import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopMark, DesktopGuidance } from '../shared/marking-overlay'
import type { RuntimeConfig } from '@mite/client-core'
import type { UserOverlayLayout, UserOverlayMode } from '../shared/overlay'

interface CaptureEntry {
  clientCaptureId: string
  sequence: number
  capturedAt: string
  filename: string
  sha256: string
  uploadIdempotencyKey: string
}

interface CaptureManifest {
  schemaVersion: 1
  supportSessionId: string
  guideMaterialBatchId: string | null
  batchCreateIdempotencyKey: string
  batchCompleteIdempotencyKey: string
  noMaterialsEndIdempotencyKey: string | null
  captures: CaptureEntry[]
}

const bridge = Object.freeze({
  prepareSpeakerVolume: () =>
    ipcRenderer.invoke('audio:prepare-speaker') as Promise<void>,
  onOverlayCollapsed: (listener: () => void) => {
    const handler = () => listener()
    ipcRenderer.on('overlay:collapsed', handler)
    return () => ipcRenderer.removeListener('overlay:collapsed', handler)
  },
  setGuidance: (guidance: DesktopGuidance | null) =>
    ipcRenderer.invoke('guidance:set', guidance) as Promise<void>,
  setMarkings: (marks: DesktopMark[]) =>
    ipcRenderer.invoke('marking:set', marks) as Promise<void>,
  getRuntimeConfig: () =>
    ipcRenderer.invoke('runtime:get-config') as Promise<RuntimeConfig>,
  setOverlayMode: (mode: UserOverlayMode) =>
    ipcRenderer.invoke('overlay:set-mode', mode) as Promise<UserOverlayLayout>,
  prepareScreenShare: () =>
    ipcRenderer.invoke('screen:prepare-share') as Promise<{
      name: string
    }>,
  capturePreview: () =>
    ipcRenderer.invoke('screen:capture-preview') as Promise<{
      capturedAt: string
      bytes: Uint8Array
    }>,
  saveSupportScreenshotDraft: (
    draftId: string,
    capturedAt: string,
    bytes: Uint8Array,
  ) =>
    ipcRenderer.invoke(
      'support-draft:save-screenshot',
      draftId,
      capturedAt,
      bytes,
    ) as Promise<{
      draftId: string
      capturedAt: string
      bytes: Uint8Array
    }>,
  loadSupportScreenshotDraft: (draftId: string) =>
    ipcRenderer.invoke('support-draft:load-screenshot', draftId) as Promise<{
      draftId: string
      capturedAt: string
      bytes: Uint8Array
    } | null>,
  deleteSupportScreenshotDraft: (draftId: string) =>
    ipcRenderer.invoke(
      'support-draft:delete-screenshot',
      draftId,
    ) as Promise<void>,
  initializeCaptureSession: (sessionId: string) =>
    ipcRenderer.invoke(
      'capture:initialize',
      sessionId,
    ) as Promise<CaptureManifest>,
  saveCapture: (sessionId: string) =>
    ipcRenderer.invoke('capture:save', sessionId) as Promise<{
      manifest: CaptureManifest
      reachedLimit: boolean
    }>,
  getCaptureManifest: (sessionId: string) =>
    ipcRenderer.invoke(
      'capture:get-manifest',
      sessionId,
    ) as Promise<CaptureManifest | null>,
  readCaptureFile: (sessionId: string, filename: string) =>
    ipcRenderer.invoke(
      'capture:read-file',
      sessionId,
      filename,
    ) as Promise<Uint8Array>,
  setCaptureBatchId: (sessionId: string, batchId: string) =>
    ipcRenderer.invoke(
      'capture:set-batch-id',
      sessionId,
      batchId,
    ) as Promise<CaptureManifest>,
  ensureNoMaterialsKey: (sessionId: string) =>
    ipcRenderer.invoke(
      'capture:ensure-no-materials-key',
      sessionId,
    ) as Promise<CaptureManifest>,
  listCaptureSessions: () =>
    ipcRenderer.invoke('capture:list-sessions') as Promise<
      Array<{
        supportSessionId: string
        modifiedAt: string
        manifest: CaptureManifest | null
        error: string | null
      }>
    >,
  deleteCaptureSession: (sessionId: string) =>
    ipcRenderer.invoke('capture:delete-session', sessionId) as Promise<void>,
})

contextBridge.exposeInMainWorld('miteDesktop', bridge)
