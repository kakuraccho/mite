import type {
  Artifact,
  ArtifactPurpose,
  GuideDetail,
  GuideDraft,
  GuideGenerationJob,
  GuideMaterial,
  GuideMaterialBatch,
  GuideRun,
  GuideSummary,
  LiveKitConnectionInfo,
  SupportConsent,
  SupportRequest,
  SupportRequestStatus,
  SupportSession,
} from './types'

export interface IdempotentOperation {
  idempotencyKey: string
}

export interface ArtifactUploadInput {
  purpose: Extract<ArtifactPurpose, 'REQUEST_SCREENSHOT'>
  capturedAt: string
  file: Blob
  filename?: string
}

export interface GuideMaterialUploadInput {
  clientCaptureId: string
  sequence: number
  capturedAt: string
  file: Blob
  filename?: string
}

export interface MiteApi {
  uploadArtifact(
    input: ArtifactUploadInput,
    operation: IdempotentOperation,
  ): Promise<Artifact>
  getArtifactContent(artifactId: string): Promise<Blob>
  createSupportRequest(
    input: { initialScreenshotArtifactId: string; comment: string },
    operation: IdempotentOperation,
  ): Promise<SupportRequest>
  listSupportRequests(status?: SupportRequestStatus): Promise<SupportRequest[]>
  getSupportRequest(supportRequestId: string): Promise<SupportRequest>
  callSupportRequest(
    supportRequestId: string,
    input: { expectedRequestRevision: number },
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  getSupportSession(supportSessionId: string): Promise<SupportSession>
  acceptSupportSession(
    supportSessionId: string,
    input: { expectedSessionRevision: number; consent: SupportConsent },
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  getLiveKitToken(supportSessionId: string): Promise<LiveKitConnectionInfo>
  resolveSupportSession(
    supportSessionId: string,
    input: {
      expectedSessionRevision: number
      guideDecision: 'CREATE' | 'SKIP'
    },
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  createGuideMaterialBatch(
    supportSessionId: string,
    input: {
      expectedSessionRevision: number
      captureIntervalSeconds: 5
      capturedFrom: string | null
      capturedTo: string | null
      expectedItemCount: number
    },
    operation: IdempotentOperation,
  ): Promise<{ batch: GuideMaterialBatch; supportSession: SupportSession }>
  getGuideMaterialBatch(
    batchId: string,
  ): Promise<{ batch: GuideMaterialBatch; materials: GuideMaterial[] }>
  uploadGuideMaterial(
    batchId: string,
    input: GuideMaterialUploadInput,
    operation: IdempotentOperation,
  ): Promise<{ material: GuideMaterial; batch: GuideMaterialBatch }>
  completeGuideMaterialBatch(
    batchId: string,
    input: { expectedBatchRevision: number; expectedItemCount: number },
    operation: IdempotentOperation,
  ): Promise<{
    batch: GuideMaterialBatch
    job: GuideGenerationJob
    supportSession: SupportSession
  }>
  getGuideGenerationJob(jobId: string): Promise<GuideGenerationJob>
  retryGuideGenerationJob(
    jobId: string,
    input: { expectedJobRevision: number },
    operation: IdempotentOperation,
  ): Promise<GuideGenerationJob>
  getGuideDraft(draftId: string): Promise<GuideDraft>
  updateGuideDraft(
    draftId: string,
    input: {
      expectedRevision: number
      title: string
      steps: GuideDraft['steps']
    },
  ): Promise<GuideDraft>
  saveGuideDraft(
    draftId: string,
    input: { expectedRevision: number },
    operation: IdempotentOperation,
  ): Promise<{ guide: GuideDetail; supportSession: SupportSession }>
  listGuides(): Promise<GuideSummary[]>
  getGuide(guideId: string): Promise<GuideDetail>
  createGuideRun(
    input: { guideId: string },
    operation: IdempotentOperation,
  ): Promise<GuideRun>
  getGuideRun(guideRunId: string): Promise<GuideRun>
  moveGuideRun(
    guideRunId: string,
    input: { expectedRevision: number; action: 'NEXT' | 'PREVIOUS' },
  ): Promise<GuideRun>
  completeGuideRun(
    guideRunId: string,
    input: { expectedRevision: number },
    operation: IdempotentOperation,
  ): Promise<GuideRun>
  requestSupportFromGuideRun(
    guideRunId: string,
    input: {
      expectedRevision: number
      initialScreenshotArtifactId: string
      comment: string
    },
    operation: IdempotentOperation,
  ): Promise<{ guideRun: GuideRun; supportRequest: SupportRequest }>
  endSupportSessionWithoutGuide(
    supportSessionId: string,
    input: {
      expectedSessionRevision: number
      reason: 'GUIDE_CANCELLED' | 'NO_MATERIALS'
    },
    operation: IdempotentOperation,
  ): Promise<SupportSession>
}
