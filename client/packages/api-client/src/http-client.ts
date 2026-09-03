import type {
  ArtifactUploadInput,
  GuideMaterialUploadInput,
  IdempotentOperation,
  MiteApi,
} from './api'
import { MiteApiError } from './error'
import type {
  ApiErrorBody,
  Artifact,
  DataEnvelope,
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

export interface HttpMiteApiOptions {
  baseUrl: string
  token: string
  fetch?: typeof globalThis.fetch
}

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
    input: { initialScreenshotArtifactId: string; comment: string },
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
    input: { expectedRequestRevision: number },
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
    input: { expectedSessionRevision: number; consent: SupportConsent },
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
    input: {
      expectedSessionRevision: number
      guideDecision: 'CREATE' | 'SKIP'
    },
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
    input: {
      expectedSessionRevision: number
      captureIntervalSeconds: 5
      capturedFrom: string | null
      capturedTo: string | null
      expectedItemCount: number
    },
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
    input: { expectedBatchRevision: number; expectedItemCount: number },
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
    input: { expectedJobRevision: number },
    operation: IdempotentOperation,
  ): Promise<GuideGenerationJob> {
    return this.#request(
      `/v1/guide-generation-jobs/${encodeId(jobId)}/retry`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  getGuideDraft(draftId: string): Promise<GuideDraft> {
    return this.#request(`/v1/guide-drafts/${encodeId(draftId)}`)
  }

  updateGuideDraft(
    draftId: string,
    input: {
      expectedRevision: number
      title: string
      steps: GuideDraft['steps']
    },
  ): Promise<GuideDraft> {
    return this.#request(`/v1/guide-drafts/${encodeId(draftId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  saveGuideDraft(
    draftId: string,
    input: { expectedRevision: number },
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
    input: { guideId: string },
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
    input: { expectedRevision: number; action: 'NEXT' | 'PREVIOUS' },
  ): Promise<GuideRun> {
    return this.#request(`/v1/guide-runs/${encodeId(guideRunId)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  }

  completeGuideRun(
    guideRunId: string,
    input: { expectedRevision: number },
    operation: IdempotentOperation,
  ): Promise<GuideRun> {
    return this.#request(
      `/v1/guide-runs/${encodeId(guideRunId)}/complete`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }

  requestSupportFromGuideRun(
    guideRunId: string,
    input: {
      expectedRevision: number
      initialScreenshotArtifactId: string
      comment: string
    },
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
    input: {
      expectedSessionRevision: number
      reason: 'GUIDE_CANCELLED' | 'NO_MATERIALS'
    },
    operation: IdempotentOperation,
  ): Promise<SupportSession> {
    return this.#request(
      `/v1/support-sessions/${encodeId(supportSessionId)}/end-without-guide`,
      { method: 'POST', body: JSON.stringify(input) },
      operation,
    )
  }
}
