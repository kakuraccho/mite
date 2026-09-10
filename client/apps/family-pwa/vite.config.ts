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

export default defineConfig({
  root: appDirectory,
  base: configuredBasePath,
  plugins: [react()],
  server: { port: 5175, strictPort: true },
  build: {
    outDir: path.join(appDirectory, 'dist'),
    emptyOutDir: true,
  },
})
