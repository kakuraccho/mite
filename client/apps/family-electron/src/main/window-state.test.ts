// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { expect, it, vi } from 'vitest'
import { rememberMaximizedState } from './window-state'

it('remembers maximized/normal state across launches and retains it on close', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mite-window-state-'))
  if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()))
    throw new Error('Unexpected test directory')
  const filename = path.join(directory, 'state.json')
  const create = () => {
    const events = new Map<string, () => void>()
    const window = {
      on: vi.fn((name: string, fn: () => void) => events.set(name, fn)),
      maximize: vi.fn(),
    }
    rememberMaximizedState(window as unknown as BrowserWindow, filename)
    return { window, events }
  }
  try {
    const first = create()
    expect(first.window.maximize).not.toHaveBeenCalled()
    first.events.get('maximize')?.()
    first.events.get('close')?.()
    const second = create()
    expect(second.window.maximize).toHaveBeenCalledOnce()
    second.events.get('unmaximize')?.()
    second.events.get('close')?.()
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual({
      maximized: false,
    })
    expect(create().window.maximize).not.toHaveBeenCalled()
    writeFileSync(filename, '{broken')
    expect(create().window.maximize).not.toHaveBeenCalled()
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
