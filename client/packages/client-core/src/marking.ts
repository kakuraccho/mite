export const MITE_MARKING_TOPIC = 'mite.marking.v1'

export interface MarkSetMessage {
  type: 'mark.set'
  markId: string
  trackSid: string
  x: number
  y: number
  shape: 'CIRCLE'
  ttlMs: number
  sentAt: string
}

export interface MarkClearMessage {
  type: 'mark.clear'
  trackSid: string
  sentAt: string
}

export type MarkingMessage = MarkSetMessage | MarkClearMessage

export interface RenderedVideoGeometry {
  left: number
  top: number
  width: number
  height: number
  videoWidth: number
  videoHeight: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object')

const isFiniteUnitValue = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  Number.isFinite(Date.parse(value))

export const isMarkingMessage = (value: unknown): value is MarkingMessage => {
  if (
    !isRecord(value) ||
    typeof value.trackSid !== 'string' ||
    !value.trackSid ||
    !isIsoDate(value.sentAt)
  ) {
    return false
  }

  if (value.type === 'mark.clear') return true

  return (
    value.type === 'mark.set' &&
    typeof value.markId === 'string' &&
    value.markId.length > 0 &&
    isFiniteUnitValue(value.x) &&
    isFiniteUnitValue(value.y) &&
    value.shape === 'CIRCLE' &&
    typeof value.ttlMs === 'number' &&
    Number.isFinite(value.ttlMs) &&
    value.ttlMs > 0
  )
}

export const encodeMarkingMessage = (message: MarkingMessage): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(message))

export const decodeMarkingMessage = (
  payload: Uint8Array,
): MarkingMessage | null => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(payload))
    return isMarkingMessage(value) ? value : null
  } catch {
    return null
  }
}

export const normalizedPointInVideo = (
  clientX: number,
  clientY: number,
  geometry: RenderedVideoGeometry,
): { x: number; y: number } | null => {
  const { left, top, width, height, videoWidth, videoHeight } = geometry
  if (
    ![
      clientX,
      clientY,
      left,
      top,
      width,
      height,
      videoWidth,
      videoHeight,
    ].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    videoWidth <= 0 ||
    videoHeight <= 0
  ) {
    return null
  }

  const scale = Math.min(width / videoWidth, height / videoHeight)
  const renderedWidth = videoWidth * scale
  const renderedHeight = videoHeight * scale
  const renderedLeft = left + (width - renderedWidth) / 2
  const renderedTop = top + (height - renderedHeight) / 2
  const x = (clientX - renderedLeft) / renderedWidth
  const y = (clientY - renderedTop) / renderedHeight

  if (x < 0 || x > 1 || y < 0 || y > 1) return null
  return { x, y }
}
