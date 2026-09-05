export const familyScheme = 'mite-family'
export const familyProductionOrigin = `${familyScheme}://app`
export const familyDevelopmentOrigin = 'http://127.0.0.1:5174'

export const isTrustedRendererUrl = (value: string) => {
  try {
    const url = new URL(value)
    if (url.origin === familyDevelopmentOrigin) return true
    return (
      url.protocol === `${familyScheme}:` &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}
