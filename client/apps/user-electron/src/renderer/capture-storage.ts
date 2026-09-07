export const captureStorageFailureMessage =
  'この端末に保存した画面を読み書きできませんでした。空き容量や保存先を確認して、もう一度試してください。'

export class CaptureStorageError extends Error {
  constructor(cause: unknown) {
    super(captureStorageFailureMessage, { cause })
    this.name = 'CaptureStorageError'
  }
}

export const accessCaptureStorage = async <T>(operation: () => Promise<T>) => {
  try {
    return await operation()
  } catch (cause) {
    throw new CaptureStorageError(cause)
  }
}
