export const createCaptureSessionQueue = () => {
  const pending = new Map<string, Promise<unknown>>()
  return async <T>(
    sessionId: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const previous = pending.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    pending.set(sessionId, current)
    try {
      return await current
    } finally {
      if (pending.get(sessionId) === current) pending.delete(sessionId)
    }
  }
}
