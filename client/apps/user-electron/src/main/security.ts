export const userScheme = 'mite-user'
export const userProductionOrigin = `${userScheme}://app`
export const userDevelopmentOrigin = 'http://127.0.0.1:5173'

export const isTrustedRendererUrl = (value: string) => {
  try {
    const url = new URL(value)
    if (url.origin === userDevelopmentOrigin) return true
    return (
      url.protocol === `${userScheme}:` &&
      url.hostname === 'app' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}
