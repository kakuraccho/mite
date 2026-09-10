import type {
  ArtifactUploadInput,
  GuideMaterialUploadInput,
  IdempotentOperation,
  MiteApi,
} from './api'
import { MiteApiError } from './error'
import type {
  AcceptSupportSessionInput,
  ApiErrorBody,
  Artifact,
  CallSupportRequestInput,
  CompleteGuideMaterialBatchInput,
  CompleteGuideRunInput,
  CancelGuideRunInput,
  CreateGuideMaterialBatchInput,
  CreateGuideRunInput,
  CreateSupportRequestFromGuideRunInput,
  CreateSupportRequestInput,
  DataEnvelope,
  EndSupportSessionWithoutGuideInput,
  EndSupportSessionInput,
  GuideDetail,
  GuideDraft,
  CompleteGuideReviewInput,
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

export interface HttpMiteApiOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

const artifactCacheMaxBytes = 32 * 1024 * 1024
const artifactCacheMaxEntries = 32
const artifactCacheLifetimeMs = 60_000

const encodeId = (id: string) => encodeURIComponent(id)

const isApiErrorBody = (value: unknown): value is ApiErrorBody => {
  if (!value || typeof value !== 'object' || !('error' in value)) return false
  const error = value.error
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    'message' in error &&
    'requestId' in error,
  )
}

export class HttpMiteApi implements MiteApi {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: typeof globalThis.fetch
  // Scope cached bytes to this API instance (and therefore its endpoint/token).
  // Keep them in memory only; authenticated HTTP responses remain no-store.
  readonly #artifacts = new Map<string, { blob: Blob; expiresAt: number }>()
  readonly #artifactRequests = new Map<string, Promise<Blob>>()
  #artifactBytes = 0

  constructor(options: HttpMiteApiOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async #request<TData>(
    path: string,
    init: RequestInit = {},
    operation?: IdempotentOperation,
  ): Promise<TData> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    headers.set('Authorization', `Bearer ${this.#token}`)
    if (operation) headers.set('Idempotency-Key', operation.idempotencyKey)
    if (typeof init.body === 'string') {
      headers.set('Content-Type', 'application/json')
    }

    const response = await this.#fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
    })

    const contentType = response.headers.get('content-type') ?? ''
    const body: unknown = contentType.includes('application/json')
      ? await response.json()
      : null

    if (!response.ok) {
      if (isApiErrorBody(body)) {
        const retryAfter = response.headers.get('retry-after')
        const retryAfterSeconds = retryAfter ? Number(retryAfter) : null
        throw new MiteApiError(
          response.status,
          body,
          Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
        )
      }
      throw new Error(`Mite API request failed with HTTP ${response.status}`)
    }

    if (!body || typeof body !== 'object' || !('data' in body)) {
      throw new Error('Mite API returned an invalid success response')
    }

    return (body as DataEnvelope<TData>).data
  }

  async uploadArtifact(
    input: ArtifactUploadInput,
    operation: IdempotentOperation,
  ): Promise<Artifact> {
    const form = new FormData()
    form.set('purpose', input.purpose)
    form.set('capturedAt', input.capturedAt)
    form.set('file', input.file, input.filename ?? 'screenshot.jpg')
    return this.#request(
      '/v1/artifacts',
      { method: 'POST', body: form },
      operation,
    )
  }

  async getArtifactContent(artifactId: string): Promise<Blob> {
    const now = Date.now()
    for (const [id, entry] of this.#artifacts) {
      if (entry.expiresAt <= now) {
        this.#artifactBytes -= entry.blob.size
        this.#artifacts.delete(id)
      }
    }
    const cached = this.#artifacts.get(artifactId)
    if (cached) {
      this.#artifacts.delete(artifactId)
      this.#artifacts.set(artifactId, cached)
      return cached.blob
    }
    const pending = this.#artifactRequests.get(artifactId)
    if (pending) return pending
    const request = this.#fetchArtifactContent(artifactId)
      .then((blob) => {
        if (blob.size <= artifactCacheMaxBytes) {
          while (
            this.#artifacts.size >= artifactCacheMaxEntries ||
            this.#artifactBytes + blob.size > artifactCacheMaxBytes
          ) {
            const oldest = this.#artifacts.entries().next().value
            if (!oldest) break
            this.#artifacts.delete(oldest[0])
            this.#artifactBytes -= oldest[1].blob.size
          }
          this.#artifacts.set(artifactId, {
            blob,
            expiresAt: Date.now() + artifactCacheLifetimeMs,
          })
          this.#artifactBytes += blob.size
        }
        return blob
      })
      .finally(() => this.#artifactRequests.delete(artifactId))
    this.#artifactRequests.set(artifactId, request)
    return request
  }

  async #fetchArtifactContent(artifactId: string): Promise<Blob> {
    const response = await this.#fetch(
      `${this.#baseUrl}/v1/artifacts/${encodeId(artifactId)}/content`,
      { headers: { Authorization: `Bearer ${this.#token}` } },
    )
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null)
      if (isApiErrorBody(body)) throw new MiteApiError(response.status, body)
      throw new Error(`Artifact request failed with HTTP ${response.status}`)
    }
    return response.blob()
  }

  createSupportRequest(
    input: CreateSupportRequestInput,
    operation: IdempotentOperation,
  ): Promise<SupportRequest> {
    return this.#request(
      '/v1/support-requests',
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  async listSupportRequests(
    status?: SupportRequestStatus,
  ): Promise<SupportRequest[]> {
    const query = status ? `?status=${encodeURIComponent(status)}` : ''
    const data = await this.#request<{ items: SupportRequest[] }>(
      `/v1/support-requests${query}`,
    )
    return data.items
  }

  getSupportRequest(supportRequestId: string): Promise<SupportRequest> {
    return this.#request(`/v1/support-requests/${encodeId(supportRequestId)}`)
  }

  callSupportRequest(
    supportRequestId: string,
    input: CallSupportRequestInput,
    operation: IdempotentOperation,
  ): Promise<{
    supportRequest: SupportRequest
    supportSession: SupportSession
  }> {
    return this.#request(
      `/v1/support-requests/${encodeId(supportRequestId)}/call`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getSupportSession(supportSessionId: string): Promise<SupportSession> {
    return this.#request(`/v1/support-sessions/${encodeId(supportSessionId)}`)
  }

  acceptSupportSession(
    supportSessionId: string,
    input: AcceptSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<{
    supportRequest: SupportRequest
    supportSession: SupportSession
  }> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/accept`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getLiveKitToken(supportSessionId: string): Promise<LiveKitConnectionInfo> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/livekit-token`,
      { method: 'POST', body: '{}' },
    )
  }

  resolveSupportSession(
    supportSessionId: string,
    input: ResolveSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<{
    supportRequest: SupportRequest
    supportSession: SupportSession
  }> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/resolve`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  createGuideMaterialBatch(
    supportSessionId: string,
    input: CreateGuideMaterialBatchInput,
    operation: IdempotentOperation,
  ): Promise<{ batch: GuideMaterialBatch; supportSession: SupportSession }> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/guide-material-batches`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getGuideMaterialBatch(
    batchId: string,
  ): Promise<{ batch: GuideMaterialBatch; materials: GuideMaterial[] }> {
    return this.#request(`/v1/guide-material-batches/${encodeId(batchId)}`)
  }

  uploadGuideMaterial(
    batchId: string,
    input: GuideMaterialUploadInput,
    operation: IdempotentOperation,
  ): Promise<{ material: GuideMaterial; batch: GuideMaterialBatch }> {
    const form = new FormData()
    form.set('clientCaptureId', input.clientCaptureId)
    form.set('sequence', String(input.sequence))
    form.set('capturedAt', input.capturedAt)
    form.set('file', input.file, input.filename ?? `${input.sequence}.jpg`)
    return this.#request(
      `/v1/guide-material-batches/${encodeId(batchId)}/materials`,
      { method: 'POST', body: form },
      operation,
    )
  }

  completeGuideMaterialBatch(
    batchId: string,
    input: CompleteGuideMaterialBatchInput,
    operation: IdempotentOperation,
  ): Promise<{
    batch: GuideMaterialBatch
    job: GuideGenerationJob
    supportSession: SupportSession
  }> {
    return this.#request(
      `/v1/guide-material-batches/${encodeId(batchId)}/complete`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getGuideGenerationJob(jobId: string): Promise<GuideGenerationJob> {
    return this.#request(`/v1/guide-generation-jobs/${encodeId(jobId)}`)
  }

  retryGuideGenerationJob(
    jobId: string,
    input: RetryGuideGenerationJobInput,
    operation: IdempotentOperation,
  ): Promise<GuideGenerationJob> {
    return this.#request(
      `/v1/guide-generation-jobs/${encodeId(jobId)}/retry`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  async listSessionGuideDrafts(sessionId: string): Promise<GuideDraft[]> {
    const data = await this.#request<{ items: GuideDraft[] }>(
      `/v1/support-sessions/${encodeId(sessionId)}/guide-drafts`,
    )
    return data.items
  }

  completeGuideReview(
    sessionId: string,
    input: CompleteGuideReviewInput,
    operation: IdempotentOperation,
  ): Promise<{ guides: GuideDetail[]; supportSession: SupportSession }> {
    return this.#request(
      `/v1/support-sessions/${encodeId(sessionId)}/complete-guide-review`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getGuideDraft(draftId: string): Promise<GuideDraft> {
    return this.#request(`/v1/guide-drafts/${encodeId(draftId)}`)
  }

  updateGuideDraft(
    draftId: string,
    input: UpdateGuideDraftInput,
  ): Promise<GuideDraft> {
    return this.#request(`/v1/guide-drafts/${encodeId(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  saveGuideDraft(
    draftId: string,
    input: SaveGuideDraftInput,
    operation: IdempotentOperation,
  ): Promise<{ guide: GuideDetail; supportSession: SupportSession }> {
    return this.#request(
      `/v1/guide-drafts/${encodeId(draftId)}/save`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  async listGuides(): Promise<GuideSummary[]> {
    const data = await this.#request<{ items: GuideSummary[] }>('/v1/guides')
    return data.items
  }

  getGuide(guideId: string): Promise<GuideDetail> {
    return this.#request(`/v1/guides/${encodeId(guideId)}`)
  }

  createGuideRun(
    input: CreateGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<GuideRun> {
    return this.#request(
      '/v1/guide-runs',
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getGuideRun(guideRunId: string): Promise<GuideRun> {
    return this.#request(`/v1/guide-runs/${encodeId(guideRunId)}`)
  }

  moveGuideRun(
    guideRunId: string,
    input: UpdateGuideRunInput,
  ): Promise<GuideRun> {
    return this.#request(`/v1/guide-runs/${encodeId(guideRunId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  completeGuideRun(
    guideRunId: string,
    input: CompleteGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<GuideRun> {
    return this.#request(
      `/v1/guide-runs/${encodeId(guideRunId)}/complete`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  cancelGuideRun(
    guideRunId: string,
    input: CancelGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<GuideRun> {
    return this.#request(
      `/v1/guide-runs/${encodeId(guideRunId)}/cancel`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  requestSupportFromGuideRun(
    guideRunId: string,
    input: CreateSupportRequestFromGuideRunInput,
    operation: IdempotentOperation,
  ): Promise<{ guideRun: GuideRun; supportRequest: SupportRequest }> {
    return this.#request(
      `/v1/guide-runs/${encodeId(guideRunId)}/support-request`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  endSupportSessionWithoutGuide(
    supportSessionId: string,
    input: EndSupportSessionWithoutGuideInput,
    operation: IdempotentOperation,
  ): Promise<SupportSession> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/end-without-guide`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }
  endSupportSession(
    supportSessionId: string,
    input: EndSupportSessionInput,
    operation: IdempotentOperation,
  ): Promise<SupportSession> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/end`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }
}
