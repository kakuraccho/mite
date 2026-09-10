import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const appDirectory = path.dirname(fileURLToPath(import.meta.url))
const configuredBasePath = process.env.VITE_PWA_BASE_PATH?.trim() || '/'
if (
  !configuredBasePath.startsWith('/') ||
  !configuredBasePath.endsWith('/') ||
  configuredBasePath.includes('//') ||
  configuredBasePath.includes('\\') ||
  configuredBasePath.includes('?') ||
  configuredBasePath.includes('#')
) {
  throw new Error(
    'VITE_PWA_BASE_PATH must be an absolute URL path with one trailing slash',
  )
}

const noncePlaceholder = '__MITE_PWA_DEV_NONCE__'
const securityHeaders = {
  'Content-Security-Policy': "frame-ancestors 'none'",
}

export default defineConfig({
  root: appDirectory,
  base: configuredBasePath,
  plugins: [
    react(),
    {
      name: 'mite-pwa-development-csp',
      apply: 'serve',
      config: () => ({ html: { cspNonce: noncePlaceholder } }),
      configureServer(server) {
        const transformIndexHtml = server.transformIndexHtml.bind(server)
        server.transformIndexHtml = async (...args) => {
          const html = await transformIndexHtml(...args)
          // Replace after Vite has added nonce attributes to all injected tags.
          return html.replaceAll(
            noncePlaceholder,
            randomBytes(16).toString('base64'),
          )
        }
      },
      transformIndexHtml: {
        order: 'pre',
        handler: (html) =>
          html
            .replace(
              "script-src 'self'",
              `script-src 'self' 'nonce-${noncePlaceholder}'`,
            )
            .replace(
              "style-src 'self'",
              `style-src 'self' 'nonce-${noncePlaceholder}'`,
            )
            .replace(
              "connect-src 'self'",
              "connect-src 'self' ws://localhost:* ws://127.0.0.1:*",
            ),
      },
    },
  ],
  server: { port: 5175, strictPort: true, headers: securityHeaders },
  preview: { headers: securityHeaders },
  build: {
    outDir: path.join(appDirectory, 'dist'),
    emptyOutDir: true,
  },
})
