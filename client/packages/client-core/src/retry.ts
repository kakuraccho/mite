export interface RetryOptions {
  delaysMs: readonly number[]
  signal?: AbortSignal
  shouldRetry?: (error: unknown, attempt: number) => boolean
}

const wait = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason)
      return
    }
    const timer = setTimeout(resolve, delayMs)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })

export const retry = async <TResult>(
  operation: (attempt: number) => Promise<TResult>,
  options: RetryOptions,
): Promise<TResult> => {
  let attempt = 0
  while (true) {
    try {
      return await operation(attempt + 1)
    } catch (error) {
      const delay = options.delaysMs[attempt]
      const shouldRetry = options.shouldRetry?.(error, attempt + 1) ?? true
      if (delay === undefined || !shouldRetry) throw error
      attempt += 1
      await wait(delay, options.signal)
    }
  }
}

export const retryGuideMaterialUpload = <TResult>(
  operation: (attempt: number) => Promise<TResult>,
  signal?: AbortSignal,
) => retry(operation, { delaysMs: [1_000, 2_000, 4_000], signal })
