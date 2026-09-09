import { describe, expect, it } from 'vitest'
import {
  decodeGuidanceMessage,
  encodeGuidanceMessage,
  guidanceKeyLabel,
  type GuidanceMessage,
} from './guidance'

const packet: GuidanceMessage = {
  type: 'guidance.set',
  mode: 'KEYBOARD',
  x: 0.5,
  y: 0.5,
  buttons: 0,
  keys: ['Ctrl', 'C'],
  ttlMs: 2000,
  sequence: 1,
  trackSid: 'TR_screen',
  sentAt: '2026-09-09T00:00:00Z',
}
describe('visual guidance contract', () => {
  it('roundtrips keys, pressed/drag mouse buttons, and clear', () => {
    for (const message of [
      packet,
      { ...packet, mode: 'CURSOR_MOUSE', keys: [], buttons: 3 },
      {
        type: 'guidance.clear',
        trackSid: 'TR_screen',
        sequence: 2,
        sentAt: packet.sentAt,
      },
    ] as GuidanceMessage[]) {
      expect(decodeGuidanceMessage(encodeGuidanceMessage(message))).toEqual(
        message,
      )
    }
  })
  it.each([
    { x: -0.1 },
    { y: 2 },
    { buttons: 8 },
    { buttons: 1 },
    { keys: ['unknown'] },
    { keys: Array(9).fill('A') },
    { sequence: 0 },
    { sequence: 1.5 },
    { ttlMs: 0 },
    { ttlMs: 3000 },
    { mode: 'REMOTE_CONTROL' },
    { trackSid: '' },
    { sentAt: 'bad' },
  ])('rejects malformed or unbounded input %j', (patch) => {
    expect(
      decodeGuidanceMessage(
        new TextEncoder().encode(JSON.stringify({ ...packet, ...patch })),
      ),
    ).toBeNull()
  })
  it('decodes only known physical key names, never text entry payloads', () => {
    expect(guidanceKeyLabel('ControlLeft')).toBe('Ctrl')
    expect(guidanceKeyLabel('KeyC')).toBe('C')
    expect(guidanceKeyLabel('ArrowLeft')).toBe('←')
    expect(guidanceKeyLabel('personal text')).toBeNull()
    expect(decodeGuidanceMessage(new Uint8Array(4096))).toBeNull()
  })
})
