import type { KeyValueStorage } from './storage'

export type KeyFactory = () => string

const defaultKeyFactory: KeyFactory = () => crypto.randomUUID()

export class IdempotencyKeyStore {
  readonly #storage: KeyValueStorage
  readonly #prefix: string
  readonly #keyFactory: KeyFactory

  constructor(
    storage: KeyValueStorage,
    options: { prefix?: string; keyFactory?: KeyFactory } = {},
  ) {
    this.#storage = storage
    this.#prefix = options.prefix ?? 'mite.idempotency.'
    this.#keyFactory = options.keyFactory ?? defaultKeyFactory
  }

  getOrCreate(operationId: string): string {
    const storageKey = this.#storageKey(operationId)
    const existing = this.#storage.getItem(storageKey)
    if (existing) return existing
    const key = this.#keyFactory()
    this.#storage.setItem(storageKey, key)
    return key
  }

  complete(operationId: string) {
    this.#storage.removeItem(this.#storageKey(operationId))
  }

  peek(operationId: string): string | null {
    return this.#storage.getItem(this.#storageKey(operationId))
  }

  #storageKey(operationId: string) {
    if (!operationId.trim()) throw new Error('operationId must not be empty')
    return `${this.#prefix}${operationId}`
  }
}
