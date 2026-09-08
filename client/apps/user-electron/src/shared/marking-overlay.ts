export interface DesktopMark {
  id: string
  x: number
  y: number
  expiresAt: number
}

export interface MarkingOverlayBridge {
  onMarksChanged(listener: (marks: DesktopMark[]) => void): () => void
}

export const isDesktopMarkList = (value: unknown): value is DesktopMark[] =>
  Array.isArray(value) &&
  value.length <= 256 &&
  value.every(
    (mark: unknown) =>
      !!mark &&
      typeof mark === 'object' &&
      'id' in mark &&
      typeof mark.id === 'string' &&
      mark.id.length > 0 &&
      mark.id.length <= 256 &&
      'x' in mark &&
      typeof mark.x === 'number' &&
      Number.isFinite(mark.x) &&
      mark.x >= 0 &&
      mark.x <= 1 &&
      'y' in mark &&
      typeof mark.y === 'number' &&
      Number.isFinite(mark.y) &&
      mark.y >= 0 &&
      mark.y <= 1 &&
      'expiresAt' in mark &&
      typeof mark.expiresAt === 'number' &&
      Number.isSafeInteger(mark.expiresAt),
  )
