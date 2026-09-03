import { describe, expect, it } from 'vitest'
import { IdempotencyKeyStore } from './idempotency'
import { MemoryStorage } from './storage'

describe('IdempotencyKeyStore', () => {
  it('応答確定までは同じキーを再利用し、完了後は新しいキーを作る', () => {
    const storage = new MemoryStorage()
    const values = ['idem_01', 'idem_02']
    const store = new IdempotencyKeyStore(storage, {
      keyFactory: () => values.shift() ?? 'unexpected',
    })

    expect(store.getOrCreate('create-request')).toBe('idem_01')
    expect(store.getOrCreate('create-request')).toBe('idem_01')
    store.complete('create-request')
    expect(store.getOrCreate('create-request')).toBe('idem_02')
  })
})
