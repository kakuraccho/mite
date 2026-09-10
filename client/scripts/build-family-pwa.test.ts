// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const clientDirectory = fileURLToPath(new URL('..', import.meta.url))
const appDirectory = path.join(clientDirectory, 'apps/family-pwa')
const outputDirectory = path.join(appDirectory, 'dist')
const publicPath = '/mite/pwa/'
const apiBaseUrl = 'https://priv.chi-llenge.com/mite'

it('builds the family PWA for its production subpath without embedding a token', () => {
  const built = spawnSync(
    process.execPath,
    [path.join(clientDirectory, 'node_modules/vite/bin/vite.js'), 'build'],
    {
      cwd: appDirectory,
      encoding: 'utf8',
      env: {
        ...process.env,
        VITE_API_BASE_URL: apiBaseUrl,
        VITE_DEMO_FAMILY_TOKEN: '',
        VITE_PWA_BASE_PATH: publicPath,
      },
      timeout: 30_000,
    },
  )
  expect(built.error).toBeUndefined()
  expect(built.status, built.stdout + built.stderr).toBe(0)

  const index = readFileSync(path.join(outputDirectory, 'index.html'), 'utf8')
  expect(index).toContain(`${publicPath}manifest.webmanifest`)
  expect(index).toContain(`${publicPath}icon.svg`)
  expect(index).toContain(`${publicPath}assets/`)
  expect(index).not.toContain('/src/main.tsx')

  const manifest = JSON.parse(
    readFileSync(path.join(outputDirectory, 'manifest.webmanifest'), 'utf8'),
  ) as {
    id: string
    start_url: string
    scope: string
    icons: { src: string }[]
  }
  expect(manifest).toMatchObject({ id: './', start_url: './', scope: './' })
  expect(manifest.icons[0]?.src).toBe('./icon.svg')

  const javascript = readdirSync(path.join(outputDirectory, 'assets'))
    .filter((filename) => filename.endsWith('.js'))
    .map((filename) =>
      readFileSync(path.join(outputDirectory, 'assets', filename), 'utf8'),
    )
    .join('\n')
  expect(javascript).toContain(apiBaseUrl)
  expect(javascript).toContain(`${publicPath}sw.js`)
  expect(javascript).not.toContain('change-me-family')

  const serviceWorker = readFileSync(
    path.join(outputDirectory, 'sw.js'),
    'utf8',
  )
  expect(serviceWorker).toContain('self.registration.scope')
  expect(serviceWorker).not.toContain("caches.match('/')")
  expect(serviceWorker).not.toContain("openWindow('/')")
}, 40_000)
