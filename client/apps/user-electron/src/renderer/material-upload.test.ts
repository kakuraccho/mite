import { describe, expect, it, vi } from 'vitest'
import {
  MiteApiError,
  type GuideMaterialBatch,
  type MiteApi,
  type SupportSession,
} from '@mite/client-api'
import type { CaptureManifest, UserDesktopBridge } from './desktop'
import { uploadCapturedMaterials } from './material-upload'

const timestamp = '2026-09-03T10:00:00Z'

const supportSession = (revision = 5): SupportSession => ({
  id: 'session_01',
  supportRequestId: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  livekitRoomName: 'mite-session_01',
  status: 'GENERATING_GUIDE',
  guideDecision: 'CREATE',
  guideMaterialBatchId: 'batch_01',
  guideGenerationJobId: 'job_01',
  guideDraftId: null,
  guideId: null,
  consent: {
    audio: true,
    screenShare: true,
    periodicCapture: true,
    textVersion: 'v3',
  },
  consentedAt: timestamp,
  startedAt: timestamp,
  endedAt: null,
  endReason: null,
  revision,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const batch = (status: 'UPLOADING' | 'COMPLETED'): GuideMaterialBatch => ({
  id: 'batch_01',
  supportSessionId: 'session_01',
  status,
  captureIntervalSeconds: 10,
  expectedItemCount: status === 'COMPLETED' ? 0 : 3,
  receivedItemCount: status === 'COMPLETED' ? 0 : 0,
  capturedFrom: timestamp,
  capturedTo: timestamp,
  completedAt: status === 'COMPLETED' ? timestamp : null,
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const manifest: CaptureManifest = {
  schemaVersion: 1,
  supportSessionId: 'session_01',
  guideMaterialBatchId: 'batch_01',
  batchCreateIdempotencyKey: 'batch-create-key',
  batchCompleteIdempotencyKey: 'batch-complete-key',
  noMaterialsEndIdempotencyKey: null,
  captures: [1, 2, 3].map((sequence) => ({
    clientCaptureId: `capture_${sequence}`,
    sequence,
    capturedAt: timestamp,
    filename: `${String(sequence).padStart(6, '0')}.jpg`,
    sha256: 'a'.repeat(64),
    uploadIdempotencyKey: `upload-key-${sequence}`,
  })),
}

const desktopWithManifest = (): UserDesktopBridge =>
  ({
    getCaptureManifest: vi.fn().mockResolvedValue(manifest),
    readCaptureFile: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    deleteCaptureSession: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UserDesktopBridge

describe('uploadCapturedMaterials', () => {
  it('returns the current server session when a recovered batch is already complete', async () => {
    const initial = supportSession(5)
    const current = { ...supportSession(6), status: 'REVIEWING_GUIDE' as const }
    const api = {
      getGuideMaterialBatch: vi
        .fn()
        .mockResolvedValue({ batch: batch('COMPLETED'), materials: [] }),
      getSupportSession: vi.fn().mockResolvedValue(current),
    } as unknown as MiteApi
    const desktop = desktopWithManifest()

    await expect(
      uploadCapturedMaterials({ api, desktop, session: initial }),
    ).resolves.toEqual(current)
    expect(api.getSupportSession).toHaveBeenCalledWith(initial.id)
    expect(desktop.deleteCaptureSession).toHaveBeenCalledWith(initial.id)
  })

  it('retries an in-progress response with the same image and key', async () => {
    const materials = manifest.captures.map((capture) => ({
      id: `material_${capture.sequence}`,
      batchId: 'batch_01',
      clientCaptureId: capture.clientCaptureId,
      artifactId: `artifact_${capture.sequence}`,
      sequence: capture.sequence,
      capturedAt: capture.capturedAt,
      createdAt: timestamp,
    }))
    const uploading = { ...batch('UPLOADING'), receivedItemCount: 2 }
    const verified = {
      ...batch('UPLOADING'),
      receivedItemCount: 3,
      revision: 4,
    }
    const inProgress = new MiteApiError(
      409,
      {
        error: {
          code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
          message: 'in progress',
          requestId: 'request_progress',
        },
      },
      0,
    )
    const uploadGuideMaterial = vi
      .fn()
      .mockRejectedValueOnce(inProgress)
      .mockResolvedValueOnce({ material: materials[0], batch: verified })
    const updatedSession = { ...supportSession(), revision: 6 }
    const api = {
      getGuideMaterialBatch: vi
        .fn()
        .mockResolvedValueOnce({
          batch: uploading,
          materials: materials.slice(1),
        })
        .mockResolvedValueOnce({ batch: verified, materials }),
      uploadGuideMaterial,
      completeGuideMaterialBatch: vi.fn().mockResolvedValue({
        batch: { ...verified, status: 'COMPLETED' },
        job: {},
        supportSession: updatedSession,
      }),
    } as unknown as MiteApi

    await expect(
      uploadCapturedMaterials({
        api,
        desktop: desktopWithManifest(),
        session: supportSession(),
      }),
    ).resolves.toEqual(updatedSession)
    expect(uploadGuideMaterial).toHaveBeenCalledTimes(2)
    expect(uploadGuideMaterial.mock.calls[1]?.[0]).toBe(
      uploadGuideMaterial.mock.calls[0]?.[0],
    )
    expect(uploadGuideMaterial.mock.calls[1]?.[2]).toEqual(
      uploadGuideMaterial.mock.calls[0]?.[2],
    )
  })

  it('does not retry a conflicting image and waits for the other workers to settle', async () => {
    const deferred = () => {
      let resolvePromise!: (value: unknown) => void
      const promise = new Promise((resolve) => {
        resolvePromise = resolve
      })
      return { promise, resolve: resolvePromise }
    }
    const second = deferred()
    const third = deferred()
    const conflict = new MiteApiError(409, {
      error: {
        code: 'MATERIAL_CONFLICT',
        message: 'conflict',
        requestId: 'request_error',
      },
    })
    const upload = vi.fn((input: { sequence: number }) => {
      if (input.sequence === 1) return Promise.reject(conflict)
      return input.sequence === 2 ? second.promise : third.promise
    })
    const api = {
      getGuideMaterialBatch: vi
        .fn()
        .mockResolvedValue({ batch: batch('UPLOADING'), materials: [] }),
      uploadGuideMaterial: vi.fn(
        (_batchId: string, input: { sequence: number }) => upload(input),
      ),
    } as unknown as MiteApi
    const desktop = desktopWithManifest()
    let rejected = false
    const result = uploadCapturedMaterials({
      api,
      desktop,
      session: supportSession(),
    }).catch((error: unknown) => {
      rejected = true
      throw error
    })

    await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3))
    expect(rejected).toBe(false)
    second.resolve({})
    third.resolve({})
    await expect(result).rejects.toBe(conflict)
    expect(upload).toHaveBeenCalledTimes(3)
  })
})
