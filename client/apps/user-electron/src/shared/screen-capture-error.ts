export const wslScreenCaptureErrorCode = 'WSL_SCREEN_CAPTURE_UNAVAILABLE'

export const screenCaptureFailureMessage = (
  error: unknown,
  fallback: string,
): string =>
  error instanceof Error && error.message.includes(wslScreenCaptureErrorCode)
    ? 'この起動方法では画面を撮影・共有できません。Windows用のMiteを起動してください。'
    : fallback
