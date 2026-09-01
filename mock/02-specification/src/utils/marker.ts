export interface PointerRect {
  left: number
  top: number
  width: number
  height: number
}

const clampRatio = (value: number) => Math.min(1, Math.max(0, value))

export const calculateMarkerRatios = (
  clientX: number,
  clientY: number,
  rect: PointerRect,
) => ({
  xRatio: clampRatio((clientX - rect.left) / rect.width),
  yRatio: clampRatio((clientY - rect.top) / rect.height),
})

