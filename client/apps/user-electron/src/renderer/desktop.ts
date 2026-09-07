import type { RuntimeConfig } from '@mite/client-core'
import type { UserOverlayLayout, UserOverlayMode } from '../shared/overlay'

export interface ScreenSharePreview {
  name: string
  thumbnailDataUrl: string
}

export interface CaptureEntry {
  clientCaptureId: string
  sequence: number
  capturedAt: string
  filename: string
  sha256: string
  uploadIdempotencyKey: string
}

export interface CaptureManifest {
  schemaVersion: 1
  supportSessionId: string
  guideMaterialBatchId: string | null
  batchCreateIdempotencyKey: string
  batchCompleteIdempotencyKey: string
  noMaterialsEndIdempotencyKey: string | null
  captures: CaptureEntry[]
}

export interface SupportScreenshotDraft {
  draftId: string
  capturedAt: string
  bytes: Uint8Array
}

export interface UserDesktopBridge {
  getRuntimeConfig(): Promise<RuntimeConfig>
  setOverlayMode(mode: UserOverlayMode): Promise<UserOverlayLayout>
  prepareScreenShare(): Promise<ScreenSharePreview>
  capturePreview(): Promise<{ capturedAt: string; bytes: Uint8Array }>
  saveSupportScreenshotDraft(
    draftId: string,
    capturedAt: string,
    bytes: Uint8Array,
  ): Promise<SupportScreenshotDraft>
  loadSupportScreenshotDraft(
    draftId: string,
  ): Promise<SupportScreenshotDraft | null>
  deleteSupportScreenshotDraft(draftId: string): Promise<void>
  initializeCaptureSession(sessionId: string): Promise<CaptureManifest>
  saveCapture(
    sessionId: string,
  ): Promise<{ manifest: CaptureManifest; reachedLimit: boolean }>
  getCaptureManifest(sessionId: string): Promise<CaptureManifest | null>
  readCaptureFile(sessionId: string, filename: string): Promise<Uint8Array>
  setCaptureBatchId(
    sessionId: string,
    batchId: string,
  ): Promise<CaptureManifest>
  ensureNoMaterialsKey(sessionId: string): Promise<CaptureManifest>
  listCaptureSessions(): Promise<
    Array<{
      supportSessionId: string
      modifiedAt: string
      manifest: CaptureManifest | null
      error: string | null
    }>
  >
  deleteCaptureSession(sessionId: string): Promise<void>
}

export const getUserDesktopBridge = (): UserDesktopBridge | null =>
  window.miteDesktop
    ? (window.miteDesktop as unknown as UserDesktopBridge)
    : null
