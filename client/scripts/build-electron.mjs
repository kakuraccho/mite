import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const appArgument = process.argv[2]
if (!appArgument) throw new Error('Usage: build-electron.mjs <app-directory>')
const appDirectory = path.resolve(appArgument)
const outDirectory = path.join(appDirectory, 'dist-electron')
// Vite empties this generated directory before writing the first entry.
if (path.dirname(outDirectory) !== appDirectory)
  throw new Error('Electron output must stay inside the app directory')

const checked = spawnSync(
  process.execPath,
  [
    require.resolve('typescript/bin/tsc'),
    '-p',
    'tsconfig.electron.json',
    '--noEmit',
  ],
  { cwd: appDirectory, stdio: 'inherit' },
)
if (checked.status !== 0) process.exit(checked.status ?? 1)

const entries = [
  'main/main.ts',
  ...readdirSync(path.join(appDirectory, 'src/preload'))
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => `preload/${name}`),
]

for (const [index, entry] of entries.entries()) {
  // Each sandboxed preload must be self-contained: its require cannot load
  // application modules or shared chunks. Bundle workspace TypeScript here too.
  await build({
    configFile: false,
    root: appDirectory,
    envDir: false,
    publicDir: false,
    build: {
      target: 'es2022',
      outDir: outDirectory,
      emptyOutDir: index === 0,
      minify: false,
      lib: {
        entry: path.join(appDirectory, 'src', entry),
        formats: ['cjs'],
        fileName: () => entry.replace(/\.ts$/, '.js'),
      },
      rolldownOptions: {
        platform: 'node',
        external: (id) => id === 'electron' || id === 'koffi' || isBuiltin(id),
        output: { codeSplitting: false },
      },
    },
  })
}
