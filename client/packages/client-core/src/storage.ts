export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class MemoryStorage implements KeyValueStorage {
  readonly #values = new Map<string, string>()

  getItem(key: string) {
    return this.#values.get(key) ?? null
  }

  setItem(key: string, value: string) {
    this.#values.set(key, value)
  }

  removeItem(key: string) {
    this.#values.delete(key)
  }
}

export const readStoredString = (
  storage: KeyValueStorage,
  key: string,
): string | null => {
  const value = storage.getItem(key)
  return value && value.trim() ? value : null
}
