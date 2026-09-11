import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const [appDirectoryArgument, portArgument] = process.argv.slice(2)

if (!appDirectoryArgument || !portArgument) {
  throw new Error('Usage: dev-electron.mjs <app-directory> <port>')
}

const appDirectory = path.resolve(process.cwd(), appDirectoryArgument)
const port = Number(portArgument)

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid port: ${portArgument}`)
}

const parseEnvFile = (filename) => {
  try {
    return Object.fromEntries(
      readFileSync(path.join(appDirectory, filename), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line.includes('='))
        .map((line) => {
          const separator = line.indexOf('=')
          const key = line.slice(0, separator).trim()
          const rawValue = line.slice(separator + 1).trim()
          const value = rawValue.replace(/^(['"])(.*)\1$/, '$2')
          return [key, value]
        }),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
}

const childEnvironment = {
  ...process.env,
  ...parseEnvFile('.env'),
  ...parseEnvFile('.env.local'),
  MITE_RENDERER_DEV_URL: `http://127.0.0.1:${port}`,
}

const buildElectronCli = fileURLToPath(
  new URL('./build-electron.mjs', import.meta.url),
)
const viteCli = path.join(
  path.dirname(require.resolve('vite/package.json')),
  'bin/vite.js',
)
const electronCli = require.resolve('electron/cli.js')

const compileResult = spawnSync(process.execPath, [buildElectronCli, '.'], {
  cwd: appDirectory,
  env: childEnvironment,
  stdio: 'inherit',
})

if (compileResult.status !== 0) process.exit(compileResult.status ?? 1)

const vite = spawn(
  process.execPath,
  [
    viteCli,
    '--config',
    path.join(appDirectory, 'vite.renderer.config.mts'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--strictPort',
  ],
  {
    cwd: appDirectory,
    env: childEnvironment,
    stdio: 'inherit',
  },
)

let electron

const stop = () => {
  electron?.kill()
  vite.kill()
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)
vite.once('exit', (code) => {
  electron?.kill()
  process.exitCode = code ?? 0
})

const waitForVite = async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await new Promise((resolve) => {
      const probe = request(
        { host: '127.0.0.1', port, path: '/', method: 'HEAD' },
        (response) => {
          response.resume()
          resolve(Boolean(response.statusCode && response.statusCode < 500))
        },
      )
      probe.on('error', () => resolve(false))
      probe.end()
    })

    if (ready) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Vite did not start on port ${port}`)
}

await waitForVite()

electron = spawn(process.execPath, [electronCli, '.'], {
  cwd: appDirectory,
  env: childEnvironment,
  stdio: 'inherit',
})

electron.once('exit', (code) => {
  vite.kill()
  process.exitCode = code ?? 0
})
