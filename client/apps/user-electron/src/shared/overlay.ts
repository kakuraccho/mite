export const overlayCollapsedWidth = 4
export const overlayEntryWidth = 320
export const overlayDetailMinimumWidth = 720
export const overlayDetailMaximumWidth = 1_040

export type UserOverlayMode = 'COLLAPSED' | 'ENTRY' | 'DETAIL'

export const isUserOverlayMode = (value: unknown): value is UserOverlayMode =>
  value === 'COLLAPSED' || value === 'ENTRY' || value === 'DETAIL'

export interface OverlayRectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface UserOverlayLayout {
  mode: UserOverlayMode
  reservation: 'WINDOWS_APPBAR' | 'SIMULATED'
  bounds: OverlayRectangle
  reservedBounds: OverlayRectangle
}

export const detailOverlayWidth = (availableWidth: number) =>
  Math.min(
    availableWidth,
    Math.max(
      Math.min(overlayDetailMinimumWidth, availableWidth),
      Math.min(overlayDetailMaximumWidth, Math.round(availableWidth * 0.62)),
    ),
  )

export const calculateOverlayBounds = (
  reservedBounds: OverlayRectangle,
  availableWidth: number,
  mode: UserOverlayMode,
): OverlayRectangle => {
  const width =
    mode === 'COLLAPSED'
      ? overlayCollapsedWidth
      : mode === 'ENTRY'
        ? Math.min(overlayEntryWidth, availableWidth)
        : detailOverlayWidth(availableWidth)

  return {
    x: reservedBounds.x,
    y: reservedBounds.y,
    width,
    height: reservedBounds.height,
  }
}
