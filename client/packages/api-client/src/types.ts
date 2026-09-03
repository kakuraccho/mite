export type Role = 'USER' | 'FAMILY'

export interface RevisionedEntity {
  id: string
  revision: number
  createdAt: string
  updatedAt: string
}

export interface User {
  id: string
  role: Role
  displayName: string
}

export type ArtifactPurpose =
  'REQUEST_SCREENSHOT' | 'GUIDE_MATERIAL' | 'GUIDE_STEP'

export interface Artifact extends RevisionedEntity {
  ownerUserId: string
  purpose: ArtifactPurpose
  mimeType: 'image/jpeg'
  sha256: string
  byteSize: number
  width: number
  height: number
  capturedAt: string
  contentUrl: string
}

export type SupportRequestStatus = 'PENDING' | 'IN_SUPPORT' | 'RESOLVED'

export interface SupportRequestGuideContext {
  guideRunId: string
  guideId: string
  guideVersionNumber: number
  stepNumber: number
  guideTitle: string
  stepInstruction: string
  stepArtifactId: string
}

export interface SupportRequest extends RevisionedEntity {
  userId: string
  familyId: string
  initialScreenshotArtifactId: string
  comment: string
  status: SupportRequestStatus
  supportSessionId: string | null
  guideContext: SupportRequestGuideContext | null
}

export type SupportSessionStatus =
  'RINGING' | 'ACTIVE' | 'GENERATING_GUIDE' | 'REVIEWING_GUIDE' | 'ENDED'

export type GuideDecision = 'CREATE' | 'SKIP'
export type SupportSessionEndReason =
  'GUIDE_SKIPPED' | 'GUIDE_SAVED' | 'GUIDE_CANCELLED' | 'NO_MATERIALS'

export interface SupportConsent {
  audio: true
  screenShare: true
  periodicCapture: true
  textVersion: 'v1'
}

export interface SupportSession extends RevisionedEntity {
  supportRequestId: string
  userId: string
  familyId: string
  livekitRoomName: string
  status: SupportSessionStatus
  guideDecision: GuideDecision | null
  guideMaterialBatchId: string | null
  guideGenerationJobId: string | null
  guideDraftId: string | null
  guideId: string | null
  consent: SupportConsent | null
  consentedAt: string | null
  startedAt: string | null
  endedAt: string | null
  endReason: SupportSessionEndReason | null
}

export type GuideMaterialBatchStatus = 'UPLOADING' | 'COMPLETED'

export interface GuideMaterialBatch extends RevisionedEntity {
  supportSessionId: string
  status: GuideMaterialBatchStatus
  captureIntervalSeconds: 5
  expectedItemCount: number
  receivedItemCount: number
  capturedFrom: string
  capturedTo: string
  completedAt: string | null
}

export interface GuideMaterial {
  id: string
  batchId: string
  clientCaptureId: string
  artifactId: string
  sequence: number
  capturedAt: string
  createdAt: string
}

export type GuideGenerationJobStatus =
  'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED'

export type GuideGenerationErrorCode =
  | 'AI_TIMEOUT'
  | 'AI_UNAVAILABLE'
  | 'AI_REFUSAL'
  | 'AI_INCOMPLETE_RESPONSE'
  | 'AI_INVALID_OUTPUT'
  | 'AI_INPUT_UNAVAILABLE'
  | 'WORKER_RESTARTED'

export interface GuideGenerationJob extends RevisionedEntity {
  batchId: string
  status: GuideGenerationJobStatus
  attempt: number
  guideDraftId: string | null
  errorCode: GuideGenerationErrorCode | null
  startedAt: string | null
  finishedAt: string | null
}

export interface GuideStep {
  position: number
  artifactId: string
  instruction: string
}

export type GuideDraftStatus = 'EDITING' | 'SAVED'

export interface GuideDraft extends RevisionedEntity {
  supportSessionId: string
  title: string
  steps: GuideStep[]
  status: GuideDraftStatus
}

export interface GuideSummary {
  id: string
  title: string
  currentVersionNumber: number
  representativeArtifactId: string
  updatedAt: string
}

export interface GuideVersion {
  versionNumber: number
  title: string
  createdBy: string
  createdAt: string
  steps: GuideStep[]
}

export interface GuideDetail extends RevisionedEntity {
  userId: string
  title: string
  currentVersionNumber: number
  representativeArtifactId: string
  currentVersion: GuideVersion
}

export type GuideRunStatus = 'IN_PROGRESS' | 'COMPLETED' | 'PAUSED_FOR_SUPPORT'

export interface GuideRun extends RevisionedEntity {
  guideId: string
  guideVersionNumber: number
  userId: string
  status: GuideRunStatus
  currentStepNumber: number
  supportRequestId: string | null
  startedAt: string
  completedAt: string | null
  pausedAt: string | null
}

export interface LiveKitConnectionInfo {
  serverUrl: string
  roomName: string
  participantIdentity: string
  token: string
  expiresAt: string
}

export type MiteEventType =
  | 'supportRequest.created'
  | 'supportRequest.updated'
  | 'supportSession.created'
  | 'supportSession.updated'
  | 'guideMaterialBatch.created'
  | 'guideMaterialBatch.updated'
  | 'guideGenerationJob.created'
  | 'guideGenerationJob.updated'
  | 'guideDraft.created'
  | 'guideDraft.updated'
  | 'guide.created'
  | 'guideRun.created'
  | 'guideRun.updated'

export interface MiteEvent<TData = unknown> {
  eventId: string
  type: MiteEventType
  occurredAt: string
  entityId: string
  revision: number
  data: TData
}

export type ApiErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'REVISION_CONFLICT'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
  | 'DUPLICATE_ACTIVE_REQUEST'
  | 'MATERIAL_CONFLICT'
  | 'FILE_TOO_LARGE'
  | 'INSUFFICIENT_MATERIALS'
  | 'INTERNAL_ERROR'
  | 'EXTERNAL_SERVICE_UNAVAILABLE'

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode
    message: string
    requestId: string
  }
}

export interface DataEnvelope<TData> {
  data: TData
}
