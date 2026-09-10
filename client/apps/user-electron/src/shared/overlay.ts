export const overlayCollapsedWidth = 4
export const overlayEntryWidth = 320
export const overlayDetailMinimumWidth = 720
export const overlayDetailMaximumWidth = 1_040

export type UserOverlayMode = 'COLLAPSED' | 'ENTRY' | 'DETAIL' | 'GUIDE'

export const isUserOverlayMode = (value: unknown): value is UserOverlayMode =>
  value === 'COLLAPSED' ||
  value === 'ENTRY' ||
  value === 'DETAIL' ||
  value === 'GUIDE'

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

// Keep a dragged guide entirely within the primary display's usable area.
export const calculateGuideBounds = (
  workArea: OverlayRectangle,
  previous?: OverlayRectangle | null,
): OverlayRectangle => {
  const width = Math.min(560, workArea.width)
  const height = Math.min(720, workArea.height)
  return {
    x: Math.max(
      workArea.x,
      Math.min(
        previous?.x ?? workArea.x + workArea.width - width - 24,
        workArea.x + workArea.width - width,
      ),
    ),
    y: Math.max(
      workArea.y,
      Math.min(
        previous?.y ?? workArea.y + 24,
        workArea.y + workArea.height - height,
      ),
    ),
    width,
    height,
  }
}
