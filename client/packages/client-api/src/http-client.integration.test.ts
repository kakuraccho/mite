// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { MiteApiError } from './error'
import { HttpMiteApi } from './http-client'

const baseUrl = process.env.MITE_E2E_API_BASE_URL
const userToken = process.env.MITE_E2E_USER_TOKEN
const familyToken = process.env.MITE_E2E_FAMILY_TOKEN
const integrationReady = Boolean(baseUrl && userToken && familyToken)
const describeIntegration = integrationReady ? describe : describe.skip

const jpeg = Uint8Array.from(
  Buffer.from(
    '/9j/2wCEAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSgBBwcHCggKEwoKEygaFhooKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKP/AABEIACAAIAMBIgACEQEDEQH/xAGiAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgsQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+gEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoLEQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOCooor78+VCiiigAooooAKKKKAP/9k=',
    'base64',
  ),
)

const operationKey = (name: string) =>
  `client-e2e-${name}-${crypto.randomUUID()}`

const waitForSucceededJob = async (api: HttpMiteApi, jobId: string) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const job = await api.getGuideGenerationJob(jobId)
    if (job.status === 'SUCCEEDED') return job
    if (job.status === 'FAILED') {
      throw new Error(`guide generation failed: ${job.errorCode}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('guide generation timed out')
}

describeIntegration('HttpMiteApi local A/B/C integration', () => {
  it('completes support, guide generation, and guide run flows', async () => {
    const user = new HttpMiteApi({
      baseUrl: baseUrl as string,
      token: userToken as string,
    })
    const family = new HttpMiteApi({
      baseUrl: baseUrl as string,
      token: familyToken as string,
    })
    const capturedAt = new Date(
      Math.floor(Date.now() / 1_000) * 1_000,
    ).toISOString()
    const capturedLater = new Date(
      Date.parse(capturedAt) + 10_000,
    ).toISOString()

    const initialArtifact = await user.uploadArtifact(
      {
        purpose: 'REQUEST_SCREENSHOT',
        capturedAt,
        file: new Blob([jpeg], { type: 'image/jpeg' }),
        filename: 'initial.jpg',
      },
      { idempotencyKey: operationKey('initial-artifact') },
    )
    expect(
      new Uint8Array(
        await (
          await family.getArtifactContent(initialArtifact.id)
        ).arrayBuffer(),
      ),
    ).toEqual(jpeg)

    const requestKey = operationKey('support-request')
    const requestInput = {
      initialScreenshotArtifactId: initialArtifact.id,
      comment: 'client adapter E2E',
    }
    const request = await user.createSupportRequest(requestInput, {
      idempotencyKey: requestKey,
    })
    expect(
      await user.createSupportRequest(requestInput, {
        idempotencyKey: requestKey,
      }),
    ).toEqual(request)
    expect(
      (await family.listSupportRequests('PENDING')).map((item) => item.id),
    ).toContain(request.id)
    expect((await family.getSupportRequest(request.id)).comment).toBe(
      requestInput.comment,
    )

    const called = await family.callSupportRequest(
      request.id,
      { expectedRequestRevision: request.revision },
      { idempotencyKey: operationKey('call') },
    )
    const accepted = await user.acceptSupportSession(
      called.supportSession.id,
      {
        expectedSessionRevision: called.supportSession.revision,
        consent: {
          audio: true,
          screenShare: true,
          periodicCapture: true,
          textVersion: 'v3',
        },
      },
      { idempotencyKey: operationKey('accept') },
    )
    const liveKit = await family.getLiveKitToken(accepted.supportSession.id)
    expect(liveKit.roomName).toBe(accepted.supportSession.livekitRoomName)
    expect(liveKit.token).not.toBe('')

    await expect(
      family.resolveSupportSession(
        accepted.supportSession.id,
        { expectedSessionRevision: 1, guideDecision: 'CREATE' },
        { idempotencyKey: operationKey('stale-resolve') },
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: 'REVISION_CONFLICT',
    } satisfies Partial<MiteApiError>)
    const currentSession = await family.getSupportSession(
      accepted.supportSession.id,
    )
    const resolved = await family.resolveSupportSession(
      currentSession.id,
      {
        expectedSessionRevision: currentSession.revision,
        guideDecision: 'CREATE',
      },
      { idempotencyKey: operationKey('resolve') },
    )
    expect(resolved.supportSession.status).toBe('GENERATING_GUIDE')

    const batchResult = await user.createGuideMaterialBatch(
      resolved.supportSession.id,
      {
        expectedSessionRevision: resolved.supportSession.revision,
        captureIntervalSeconds: 10,
        capturedFrom: capturedAt,
        capturedTo: capturedLater,
        expectedItemCount: 2,
      },
      { idempotencyKey: operationKey('batch') },
    )
    const firstMaterial = await user.uploadGuideMaterial(
      batchResult.batch.id,
      {
        clientCaptureId: `capture-${crypto.randomUUID()}`,
        sequence: 1,
        capturedAt,
        file: new Blob([jpeg], { type: 'image/jpeg' }),
        filename: '000001.jpg',
      },
      { idempotencyKey: operationKey('material-1') },
    )
    const secondMaterialInput = {
      clientCaptureId: `capture-${crypto.randomUUID()}`,
      sequence: 2,
      capturedAt: capturedLater,
      file: new Blob([jpeg], { type: 'image/jpeg' }),
      filename: '000002.jpg',
    }
    const secondMaterial = await user.uploadGuideMaterial(
      batchResult.batch.id,
      secondMaterialInput,
      { idempotencyKey: operationKey('material-2') },
    )
    expect(secondMaterial.batch.revision).toBe(firstMaterial.batch.revision + 1)
    expect(
      (
        await user.uploadGuideMaterial(
          batchResult.batch.id,
          secondMaterialInput,
          { idempotencyKey: operationKey('material-2-duplicate') },
        )
      ).material.id,
    ).toBe(secondMaterial.material.id)

    const verifiedBatch = await family.getGuideMaterialBatch(
      batchResult.batch.id,
    )
    expect(verifiedBatch.materials).toHaveLength(2)
    const completedBatch = await user.completeGuideMaterialBatch(
      batchResult.batch.id,
      {
        expectedBatchRevision: verifiedBatch.batch.revision,
        expectedItemCount: 2,
      },
      { idempotencyKey: operationKey('complete-batch') },
    )
    const job = await waitForSucceededJob(family, completedBatch.job.id)
    expect(job.guideDraftId).not.toBeNull()

    const draft = await family.getGuideDraft(job.guideDraftId as string)
    const updatedDraft = await family.updateGuideDraft(draft.id, {
      expectedRevision: draft.revision,
      title: `${draft.title}（確認済み）`,
      steps: draft.steps,
    })
    const saved = await family.saveGuideDraft(
      updatedDraft.id,
      { expectedRevision: updatedDraft.revision },
      { idempotencyKey: operationKey('save-guide') },
    )
    expect(saved.supportSession.status).toBe('GUIDE_SAVED')
    expect(saved.supportSession.endedAt).toBeNull()
    await user.getLiveKitToken(saved.supportSession.id)
    await family.getLiveKitToken(saved.supportSession.id)
    expect((await user.listGuides()).map((guide) => guide.id)).toContain(
      saved.guide.id,
    )
    expect(
      (await user.getGuide(saved.guide.id)).currentVersion.steps,
    ).toHaveLength(2)

    const run = await user.createGuideRun(
      { guideId: saved.guide.id },
      { idempotencyKey: operationKey('create-run') },
    )
    const next = await user.moveGuideRun(run.id, {
      expectedRevision: run.revision,
      action: 'NEXT',
    })
    const previous = await user.moveGuideRun(run.id, {
      expectedRevision: next.revision,
      action: 'PREVIOUS',
    })
    const finalStep = await user.moveGuideRun(run.id, {
      expectedRevision: previous.revision,
      action: 'NEXT',
    })
    const completedRun = await user.completeGuideRun(
      run.id,
      { expectedRevision: finalStep.revision },
      { idempotencyKey: operationKey('complete-run') },
    )
    expect(completedRun.status).toBe('COMPLETED')

    const endInput = { expectedSessionRevision: saved.supportSession.revision }
    const endOptions = { idempotencyKey: operationKey('end-saved-call') }
    const ended = await family.endSupportSession(
      saved.supportSession.id,
      endInput,
      endOptions,
    )
    expect(ended.status).toBe('ENDED')
    expect(ended.guideId).toBe(saved.guide.id)
    expect(
      await family.endSupportSession(
        saved.supportSession.id,
        endInput,
        endOptions,
      ),
    ).toEqual(ended)

    const pausedRun = await user.createGuideRun(
      { guideId: saved.guide.id },
      { idempotencyKey: operationKey('create-paused-run') },
    )
    const followUpArtifact = await user.uploadArtifact(
      {
        purpose: 'REQUEST_SCREENSHOT',
        capturedAt: capturedLater,
        file: new Blob([jpeg], { type: 'image/jpeg' }),
      },
      { idempotencyKey: operationKey('follow-up-artifact') },
    )
    const followUp = await user.requestSupportFromGuideRun(
      pausedRun.id,
      {
        expectedRevision: pausedRun.revision,
        initialScreenshotArtifactId: followUpArtifact.id,
        comment: 'ガイドから相談',
      },
      { idempotencyKey: operationKey('follow-up-request') },
    )
    expect(followUp.guideRun.status).toBe('PAUSED_FOR_SUPPORT')
    expect(followUp.supportRequest.guideContext?.guideRunId).toBe(pausedRun.id)
  }, 30_000)
})
