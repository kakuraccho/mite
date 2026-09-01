export interface MockSupportService {
  waitForNotificationDelivery(signal?: AbortSignal): Promise<void>
  waitForConnection(signal?: AbortSignal): Promise<void>
}

function mockDelay(duration: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Mock operation was cancelled', 'AbortError'))
      return
    }

    const timer = window.setTimeout(resolve, duration)

    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer)
        reject(new DOMException('Mock operation was cancelled', 'AbortError'))
      },
      { once: true },
    )
  })
}

export const mockSupportService: MockSupportService = {
  waitForNotificationDelivery: (signal) => mockDelay(650, signal),
  waitForConnection: (signal) => mockDelay(900, signal),
}
