import type { components } from '@mite/api-client'

type Schema<Name extends keyof components['schemas']> =
  components['schemas'][Name]

export type Role = Schema<'UserRole'>
export type User = Schema<'User'>
export type ArtifactPurpose = Schema<'ArtifactPurpose'>
export type Artifact = Schema<'Artifact'>
export type SupportRequestStatus = Schema<'SupportRequestStatus'>
export type SupportRequestGuideContext = Schema<'GuideContext'>
export type SupportRequest = Schema<'SupportRequest'>
export type SupportSessionStatus = Schema<'SupportSessionStatus'>
export type GuideDecision = Schema<'GuideDecision'>
export type SupportSessionEndReason = Schema<'SupportSessionEndReason'>
export type SupportConsent = Schema<'Consent'>
export type SupportSession = Schema<'SupportSession'>
export type GuideMaterialBatchStatus = Schema<'GuideMaterialBatchStatus'>
export type GuideMaterialBatch = Schema<'GuideMaterialBatch'>
export type GuideMaterial = Schema<'GuideMaterial'>
export type GuideGenerationJobStatus = Schema<'GuideGenerationJobStatus'>
export type GuideGenerationErrorCode = Schema<'GuideGenerationErrorCode'>
export type GuideGenerationJob = Schema<'GuideGenerationJob'>
export type GuideStep = Schema<'GuideStep'>
export type GuideDraftStatus = Schema<'GuideDraftStatus'>
export type GuideDraft = Schema<'GuideDraft'>
export type GuideSummary = Schema<'GuideSummary'>
export type GuideVersion = Schema<'GuideVersion'>
export type GuideDetail = Schema<'GuideDetail'>
export type GuideRunStatus = Schema<'GuideRunStatus'>
export type GuideRun = Schema<'GuideRun'>
export type LiveKitConnectionInfo = Schema<'LiveKitTokenResponse'>['data']
export type ApiErrorCode = Schema<'ErrorCode'>
export type ApiErrorBody = Schema<'ErrorResponse'>

export type CreateSupportRequestInput = Schema<'CreateSupportRequestRequest'>
export type CallSupportRequestInput = Schema<'CallSupportRequestRequest'>
export type AcceptSupportSessionInput = Schema<'AcceptSupportSessionRequest'>
export type ResolveSupportSessionInput = Schema<'ResolveSupportSessionRequest'>
export type CreateGuideMaterialBatchInput =
  Schema<'CreateGuideMaterialBatchRequest'>
export type CompleteGuideMaterialBatchInput =
  Schema<'CompleteGuideMaterialBatchRequest'>
export type RetryGuideGenerationJobInput =
  Schema<'RetryGuideGenerationJobRequest'>
export type UpdateGuideDraftInput = Schema<'UpdateGuideDraftRequest'>
export type SaveGuideDraftInput = Schema<'SaveGuideDraftRequest'>
export type CreateGuideRunInput = Schema<'CreateGuideRunRequest'>
export type UpdateGuideRunInput = Schema<'UpdateGuideRunRequest'>
export type CompleteGuideRunInput = Schema<'CompleteGuideRunRequest'>
export type CreateSupportRequestFromGuideRunInput =
  Schema<'CreateSupportRequestFromGuideRunRequest'>
export type EndSupportSessionWithoutGuideInput =
  Schema<'EndSupportSessionWithoutGuideRequest'>

export interface RevisionedEntity {
  id: string
  revision: number
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

export interface DataEnvelope<TData> {
  data: TData
}

export type CompleteGuideReviewInput = Schema<'CompleteGuideReviewRequest'>
