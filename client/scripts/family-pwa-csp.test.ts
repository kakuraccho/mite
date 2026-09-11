// @vitest-environment node
import { fileURLToPath } from 'node:url'
import { build, createServer } from 'vite'
import { expect, it } from 'vitest'

const configFile = fileURLToPath(
  new URL('../apps/family-pwa/vite.config.ts', import.meta.url),
)

const getPolicy = (html: string) =>
  html.match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/,
  )?.[1] ?? ''

it('serves a fresh nonce matching the CSP, React preamble and Vite style injection', async () => {
  const server = await createServer({
    configFile,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, open: false },
  })
  try {
    await server.listen()
    const address = server.httpServer?.address()
    if (!address || typeof address === 'string')
      throw new Error('Vite did not listen on a TCP port')
    const url = `http://127.0.0.1:${address.port}/`
    const nonces = []

    for (let request = 0; request < 2; request += 1) {
      const response = await fetch(url)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBe(
        "frame-ancestors 'none'",
      )
      const html = await response.text()
      const nonce = html.match(
        /<meta property="csp-nonce" nonce="([^"]+)"/,
      )?.[1]
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/)
      nonces.push(nonce)
      const policy = getPolicy(html)
      expect(policy).toContain(`script-src 'self' 'nonce-${nonce}'`)
      expect(policy).toContain(`style-src 'self' 'nonce-${nonce}'`)
      expect(policy).toContain('ws://localhost:* ws://127.0.0.1:*')
      expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|frame-ancestors/)
      expect(html).toContain('injectIntoGlobalHook')
      for (const script of html.match(/<script\b[^>]*>/g) ?? []) {
        expect(script).toContain(`nonce="${nonce}"`)
      }
      expect(html).not.toContain('__MITE_PWA_DEV_NONCE__')
    }
    expect(nonces[0]).not.toBe(nonces[1])
  } finally {
    await server.close()
  }
}, 30_000)

it.each(['/', '/mite/pwa/'])(
  'builds strict HTML under %s',
  async (base) => {
    const result = await build({
      configFile,
      base,
      mode: 'development',
      logLevel: 'silent',
      build: { write: false },
    })
    if (Array.isArray(result) || !('output' in result))
      throw new Error('Expected one PWA build')
    const index = result.output.find((file) => file.fileName === 'index.html')
    if (!index || index.type !== 'asset' || typeof index.source !== 'string')
      throw new Error('PWA build did not emit index.html')
    const policy = getPolicy(index.source)
    expect(policy).toContain("script-src 'self';")
    expect(policy).toContain("style-src 'self';")
    expect(policy).not.toMatch(
      /nonce-|unsafe-inline|unsafe-eval|frame-ancestors|ws:\/\//,
    )
    expect(index.source).not.toMatch(/csp-nonce|__MITE_PWA_DEV_NONCE__|@vite/)
    expect(index.source).toContain(`href="${base}manifest.webmanifest"`)
    expect(index.source).toContain(`href="${base}icon.svg"`)
    expect(index.source).toContain(`src="${base}assets/`)
  },
  30_000,
)
