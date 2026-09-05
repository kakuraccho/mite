import { describe, expect, it } from 'vitest'
import {
  decodeMarkingMessage,
  encodeMarkingMessage,
  normalizedPointInVideo,
} from './marking'
import type { MarkSetMessage } from './marking'

describe('marking messages', () => {
  it('仕様のData Packetを往復する', () => {
    const value: MarkSetMessage = {
      type: 'mark.set',
      markId: 'mark_01',
      trackSid: 'TR_screen',
      x: 0.42,
      y: 0.31,
      shape: 'CIRCLE',
      ttlMs: 2_000,
      sentAt: '2026-09-03T10:00:00Z',
    }

    expect(decodeMarkingMessage(encodeMarkingMessage(value))).toEqual(value)
  })

  it('範囲外の座標と壊れたJSONを拒否する', () => {
    const invalidCoordinate = new TextEncoder().encode(
      JSON.stringify({
        type: 'mark.set',
        markId: 'mark_01',
        trackSid: 'TR_screen',
        x: 1.1,
        y: 0.5,
        shape: 'CIRCLE',
        ttlMs: 2_000,
        sentAt: '2026-09-03T10:00:00Z',
      }),
    )
    expect(decodeMarkingMessage(invalidCoordinate)).toBeNull()
    expect(decodeMarkingMessage(new Uint8Array([0xff]))).toBeNull()
  })
})

describe('normalizedPointInVideo', () => {
  it('横方向の余白を除いた実映像領域から座標を計算する', () => {
    const geometry = {
      left: 100,
      top: 50,
      width: 1_000,
      height: 500,
      videoWidth: 1_600,
      videoHeight: 1_000,
    }

    expect(normalizedPointInVideo(500, 300, geometry)).toEqual({
      x: 0.375,
      y: 0.5,
    })
    expect(normalizedPointInVideo(150, 300, geometry)).toBeNull()
  })
})
