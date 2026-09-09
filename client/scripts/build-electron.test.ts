// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const clientDirectory = fileURLToPath(new URL('..', import.meta.url))

it.each(['user-electron', 'family-electron'])(
  '%s builds main and sandboxed preloads without workspace runtime imports',
  (appName) => {
    const appDirectory = path.join(clientDirectory, 'apps', appName)
    const built = spawnSync(
      process.execPath,
      [path.join(clientDirectory, 'scripts/build-electron.mjs'), appDirectory],
      { encoding: 'utf8', timeout: 30_000 },
    )
    expect(built.error).toBeUndefined()
    expect(built.status, built.stdout + built.stderr).toBe(0)

    const electron = {
      app: { whenReady: () => new Promise(() => {}), on: vi.fn() },
      protocol: { registerSchemesAsPrivileged: vi.fn() },
      contextBridge: { exposeInMainWorld: vi.fn() },
      ipcRenderer: { invoke: vi.fn(), on: vi.fn(), send: vi.fn() },
    }
    const output = path.join(appDirectory, 'dist-electron')
    const mainFilename = path.join(output, 'main/main.js')
    // Load emitted CommonJS with Node's resolution instead of Vite's TS loader.
    // Only Electron itself is faked; an accidental workspace import fails here.
    runInNewContext(readFileSync(mainFilename, 'utf8'), {
      require: (id: string) => {
        if (id === 'electron') return electron
        if (isBuiltin(id)) return require(id) as unknown
        throw new Error(`Unexpected main runtime dependency: ${id}`)
      },
      exports: {},
      process,
      __dirname: path.dirname(mainFilename),
      __filename: mainFilename,
    })
    expect(electron.protocol.registerSchemesAsPrivileged).toHaveBeenCalledOnce()

    for (const filename of readdirSync(path.join(output, 'preload'))) {
      electron.contextBridge.exposeInMainWorld.mockClear()
      runInNewContext(
        readFileSync(path.join(output, 'preload', filename), 'utf8'),
        {
          require: (id: string) => {
            if (id === 'electron') return electron
            throw new Error(`Sandbox cannot load preload dependency: ${id}`)
          },
          exports: {},
        },
      )
      expect(electron.contextBridge.exposeInMainWorld).toHaveBeenCalledOnce()
    }
  },
  40_000,
)
