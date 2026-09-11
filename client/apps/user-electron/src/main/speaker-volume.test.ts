// @vitest-environment node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  coreAudioTypeDefinition,
  ensureMinimumSpeakerVolume,
} from './speaker-volume'

describe('speaker volume threshold', () => {
  it.each([0, 0.1, 0.4999, 0.5, 0.75, 1])(
    'raises only levels below 50%%: %s',
    async (level) => {
      const volume = {
        getLevel: vi.fn().mockResolvedValue(level),
        setLevel: vi.fn().mockResolvedValue(undefined),
      }
      await ensureMinimumSpeakerVolume(volume)
      if (level < 0.5)
        expect(volume.setLevel).toHaveBeenCalledExactlyOnceWith(0.5)
      else expect(volume.setLevel).not.toHaveBeenCalled()
    },
  )
  it.each([NaN, Infinity, -1, 1.1])(
    'does not write an invalid reading: %s',
    async (level) => {
      const volume = {
        getLevel: vi.fn().mockResolvedValue(level),
        setLevel: vi.fn(),
      }
      await expect(ensureMinimumSpeakerVolume(volume)).rejects.toThrow(
        'invalid',
      )
      expect(volume.setLevel).not.toHaveBeenCalled()
    },
  )
  it('propagates read and write failures so the call can show a retry instruction', async () => {
    const setLevel = vi.fn().mockRejectedValue(new Error('write failed'))
    await expect(
      ensureMinimumSpeakerVolume({ getLevel: async () => 0.2, setLevel }),
    ).rejects.toThrow('write failed')
    setLevel.mockClear()
    await expect(
      ensureMinimumSpeakerVolume({
        getLevel: async () => {
          throw new Error('no endpoint')
        },
        setLevel,
      }),
    ).rejects.toThrow('no endpoint')
    expect(setLevel).not.toHaveBeenCalled()
  })
  it.skipIf(process.platform !== 'win32')(
    'compiles the Windows COM adapter without reading or changing the real speaker',
    async () => {
      const script = `Add-Type -TypeDefinition @'\n${coreAudioTypeDefinition}\n'@\n[MiteSpeakerVolume].FullName`
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, timeout: 15000 },
      )
      expect(stdout.trim()).toBe('MiteSpeakerVolume')
    },
    20000,
  )
})
