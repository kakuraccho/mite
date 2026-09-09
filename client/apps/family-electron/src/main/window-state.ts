import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { BrowserWindow } from 'electron'

export function rememberMaximizedState(
  window: Pick<BrowserWindow, 'on' | 'maximize'>,
  filename: string,
) {
  let maximized = false
  try {
    const saved: unknown = JSON.parse(readFileSync(filename, 'utf8'))
    maximized =
      !!saved &&
      typeof saved === 'object' &&
      'maximized' in saved &&
      saved.maximized === true
  } catch {
    // First launch or an interrupted write uses the normal window size.
  }
  const persist = () => {
    try {
      writeFileSync(`${filename}.tmp`, JSON.stringify({ maximized }), 'utf8')
      renameSync(`${filename}.tmp`, filename)
    } catch {
      console.warn('ウィンドウの表示設定を保存できませんでした。')
    }
  }
  window.on('maximize', () => {
    maximized = true
    persist()
  })
  window.on('unmaximize', () => {
    maximized = false
    persist()
  })
  // Retain the last normal/maximized state even when closing while minimized.
  window.on('close', persist)
  if (maximized) window.maximize()
}
