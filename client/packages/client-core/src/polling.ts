export interface PollingController {
  stop(): void
}

export const startPolling = (
  task: () => Promise<void>,
  options: {
    intervalMs?: number
    immediate?: boolean
    onError?: (error: unknown) => void
  } = {},
): PollingController => {
  const intervalMs = options.intervalMs ?? 5_000
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(run, intervalMs)
  }

  const run = async () => {
    try {
      await task()
    } catch (error) {
      options.onError?.(error)
    } finally {
      schedule()
    }
  }

  if (options.immediate ?? true) void run()
  else schedule()

  return {
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}
