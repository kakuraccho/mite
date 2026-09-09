import type {
  AcceptSupportSessionInput,
  Artifact,
  ArtifactPurpose,
  CallSupportRequestInput,
  CompleteGuideMaterialBatchInput,
  CompleteGuideRunInput,
  CreateGuideMaterialBatchInput,
  CreateGuideRunInput,
  CreateSupportRequestFromGuideRunInput,
  CreateSupportRequestInput,
  EndSupportSessionWithoutGuideInput,
  EndSupportSessionInput,
  GuideDetail,
  GuideDraft,
  GuideGenerationJob,
  GuideMaterial,
  GuideMaterialBatch,
  GuideRun,
  GuideSummary,
  LiveKitConnectionInfo,
  ResolveSupportSessionInput,
  RetryGuideGenerationJobInput,
  SaveGuideDraftInput,
  SupportRequest,
  SupportRequestStatus,
  SupportSession,
  UpdateGuideDraftInput,
  UpdateGuideRunInput,
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
    input: CreateSupportRequestInput,
    operation: IdempotentOperation,
  ): Promise<SupportRequest>
  listSupportRequests(status?: SupportRequestStatus): Promise<SupportRequest[]>
  getSupportRequest(supportRequestId: string): Promise<SupportRequest>
  callSupportRequest(
    supportRequestId: string,
    input: CallSupportRequestInput,
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  getSupportSession(supportSessionId: string): Promise<SupportSession>
  acceptSupportSession(
    supportSessionId: string,
    input: AcceptSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  getLiveKitToken(supportSessionId: string): Promise<LiveKitConnectionInfo>
  resolveSupportSession(
    supportSessionId: string,
    input: ResolveSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<{ supportRequest: SupportRequest; supportSession: SupportSession }>
  createGuideMaterialBatch(
    supportSessionId: string,
    input: CreateGuideMaterialBatchInput,
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
    input: CompleteGuideMaterialBatchInput,
    operation: IdempotentOperation,
  ): Promise<{
    batch: GuideMaterialBatch
    job: GuideGenerationJob
    supportSession: SupportSession
  }>
  getGuideGenerationJob(jobId: string): Promise<GuideGenerationJob>
  retryGuideGenerationJob(
    jobId: string,
    input: RetryGuideGenerationJobInput,
    operation: IdempotentOperation,
  ): Promise<GuideGenerationJob>
  getGuideDraft(draftId: string): Promise<GuideDraft>
  updateGuideDraft(
    draftId: string,
    input: UpdateGuideDraftInput,
  ): Promise<GuideDraft>
  saveGuideDraft(
    draftId: string,
    input: SaveGuideDraftInput,
    operation: IdempotentOperation,
  ): Promise<{ guide: GuideDetail; supportSession: SupportSession }>
  listGuides(): Promise<GuideSummary[]>
  getGuide(guideId: string): Promise<GuideDetail>
  createGuideRun(
    input: CreateGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<GuideRun>
  getGuideRun(guideRunId: string): Promise<GuideRun>
  moveGuideRun(
    guideRunId: string,
    input: UpdateGuideRunInput,
  ): Promise<GuideRun>
  completeGuideRun(
    guideRunId: string,
    input: CompleteGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<GuideRun>
  requestSupportFromGuideRun(
    guideRunId: string,
    input: CreateSupportRequestFromGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<{ guideRun: GuideRun; supportRequest: SupportRequest }>
  endSupportSession(
    supportSessionId: string,
    input: EndSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<SupportSession>
  endSupportSessionWithoutGuide(
    supportSessionId: string,
    input: EndSupportSessionWithoutGuideInput,
    operation: IdempotentOperation,
  ): Promise<SupportSession>
}
