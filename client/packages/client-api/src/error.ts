import type { ApiErrorBody, ApiErrorCode } from './types'

export class MiteApiError extends Error {
  readonly status: number
  readonly code: ApiErrorCode
  readonly requestId: string
  readonly retryAfterSeconds: number | null

  constructor(
    status: number,
    body: ApiErrorBody,
    retryAfterSeconds: number | null = null,
  ) {
    super(body.error.message)
    this.name = 'MiteApiError'
    this.status = status
    this.code = body.error.code
    this.requestId = body.error.requestId
    this.retryAfterSeconds = retryAfterSeconds
  }
}
