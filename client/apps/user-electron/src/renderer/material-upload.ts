import {
  MiteApiError,
  type MiteApi,
  type SupportSession,
} from '@mite/client-api'
import type { CaptureManifest, UserDesktopBridge } from './desktop'

export interface MaterialUploadProgress {
  completed: number
  total: number
}

export interface UploadCapturedMaterialsOptions {
  api: MiteApi
  desktop: UserDesktopBridge
  session: SupportSession
  onProgress?: (progress: MaterialUploadProgress) => void
}

const uploadInGroupsOfThree = async (tasks: Array<() => Promise<void>>) => {
  let nextIndex = 0
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const taskIndex = nextIndex
      nextIndex += 1
      await tasks[taskIndex]?.()
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(3, tasks.length) }, () => worker()),
  )
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  )
  if (failure) throw failure.reason
}

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const uploadWithRetry = async (operation: () => Promise<void>) => {
  const retryDelays = [1_000, 2_000, 4_000] as const
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation()
      return
    } catch (error) {
      const defaultDelay = retryDelays[attempt]
      if (defaultDelay === undefined) throw error
      if (error instanceof MiteApiError) {
        if (error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS') {
          await wait((error.retryAfterSeconds ?? 1) * 1_000)
          continue
        }
        if (error.status < 500) throw error
      }
      await wait(defaultDelay)
    }
  }
}

const endForNoMaterials = async (
  api: MiteApi,
  desktop: UserDesktopBridge,
  session: SupportSession,
) => {
  const manifest = await desktop.ensureNoMaterialsKey(session.id)
  if (!manifest.noMaterialsEndIdempotencyKey) {
    throw new Error('終了処理の記録を用意できません')
  }
  const ended = await api.endSupportSessionWithoutGuide(
    session.id,
    {
      expectedSessionRevision: session.revision,
      reason: 'NO_MATERIALS',
    },
    { idempotencyKey: manifest.noMaterialsEndIdempotencyKey },
  )
  await desktop.deleteCaptureSession(session.id)
  return ended
}

const createBatch = async (
  api: MiteApi,
  desktop: UserDesktopBridge,
  session: SupportSession,
  manifest: CaptureManifest,
) => {
  const first = manifest.captures[0]
  const last = manifest.captures.at(-1)
  try {
    const result = await api.createGuideMaterialBatch(
      session.id,
      {
        expectedSessionRevision: session.revision,
        captureIntervalSeconds: 5,
        capturedFrom: first?.capturedAt ?? null,
        capturedTo: last?.capturedAt ?? null,
        expectedItemCount: manifest.captures.length,
      },
      { idempotencyKey: manifest.batchCreateIdempotencyKey },
    )
    await desktop.setCaptureBatchId(session.id, result.batch.id)
    return result
  } catch (error) {
    if (
      error instanceof MiteApiError &&
      error.code === 'INSUFFICIENT_MATERIALS' &&
      manifest.captures.length === 0
    ) {
      return { endedSession: await endForNoMaterials(api, desktop, session) }
    }
    throw error
  }
}

export const uploadCapturedMaterials = async ({
  api,
  desktop,
  session: initialSession,
  onProgress,
}: UploadCapturedMaterialsOptions): Promise<SupportSession> => {
  let session = initialSession
  let manifest =
    (await desktop.getCaptureManifest(session.id)) ??
    (await desktop.initializeCaptureSession(session.id))

  let batchId = session.guideMaterialBatchId ?? manifest.guideMaterialBatchId
  if (
    session.guideMaterialBatchId &&
    manifest.guideMaterialBatchId &&
    session.guideMaterialBatchId !== manifest.guideMaterialBatchId
  ) {
    throw new Error('保存した送信記録とサーバーの状態が一致しません')
  }

  if (!batchId) {
    const created = await createBatch(api, desktop, session, manifest)
    if ('endedSession' in created) return created.endedSession
    session = created.supportSession
    batchId = created.batch.id
    manifest = await desktop.setCaptureBatchId(session.id, batchId)
  } else if (!manifest.guideMaterialBatchId) {
    manifest = await desktop.setCaptureBatchId(session.id, batchId)
  }

  const current = await api.getGuideMaterialBatch(batchId)
  if (current.batch.status === 'COMPLETED') {
    await desktop.deleteCaptureSession(session.id)
    return api.getSupportSession(session.id)
  }
  if (current.batch.expectedItemCount !== manifest.captures.length) {
    throw new Error('保存した画面の枚数と送信記録が一致しません')
  }

  const received = new Set(
    current.materials.map((item) => item.clientCaptureId),
  )
  let completed = received.size
  onProgress?.({ completed, total: manifest.captures.length })
  const missing = manifest.captures.filter(
    (capture) => !received.has(capture.clientCaptureId),
  )
  const tasks = missing.map((capture) => async () => {
    const bytes = await desktop.readCaptureFile(session.id, capture.filename)
    const copy = Uint8Array.from(bytes)
    await uploadWithRetry(async () => {
      await api.uploadGuideMaterial(
        batchId,
        {
          clientCaptureId: capture.clientCaptureId,
          sequence: capture.sequence,
          capturedAt: capture.capturedAt,
          file: new Blob([copy], { type: 'image/jpeg' }),
          filename: capture.filename,
        },
        { idempotencyKey: capture.uploadIdempotencyKey },
      )
    })
    completed += 1
    onProgress?.({ completed, total: manifest.captures.length })
  })
  await uploadInGroupsOfThree(tasks)

  const verified = await api.getGuideMaterialBatch(batchId)
  if (
    verified.batch.receivedItemCount !== manifest.captures.length ||
    verified.materials.length !== manifest.captures.length
  ) {
    throw new Error('一部の画面を送信できていません')
  }
  const completedBatch = await api.completeGuideMaterialBatch(
    batchId,
    {
      expectedBatchRevision: verified.batch.revision,
      expectedItemCount: manifest.captures.length,
    },
    { idempotencyKey: manifest.batchCompleteIdempotencyKey },
  )
  await desktop.deleteCaptureSession(session.id)
  return completedBatch.supportSession
}
