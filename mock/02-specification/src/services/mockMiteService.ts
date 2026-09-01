import type { AppState, Guide } from '../domain/types'

export interface MockDelays {
  matching: number
  connecting: number
  guideGeneration: number
  captureInterval: number
}

export const getMockDelays = (fastMode: boolean): MockDelays => ({
  matching: fastMode ? 350 : 750,
  connecting: fastMode ? 350 : 750,
  guideGeneration: fastMode ? 550 : 1100,
  captureInterval: 5000,
})

export const findMockMatchingGuide = (state: AppState): Guide | null => {
  if (
    state.settings.matchMode === 'no-match' ||
    state.supportRequest?.source === 'guideFallback'
  ) {
    return null
  }

  return (
    state.guides.find(
      (guide) => guide.id === 'guide-auth-code' && guide.status === 'published',
    ) ?? state.guides.find((guide) => guide.status === 'published') ?? null
  )
}

export const formatRequestTime = (value: string) => {
  const date = new Date(value)
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}
