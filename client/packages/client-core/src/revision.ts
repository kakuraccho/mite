import type { RevisionedEntity } from '@mite/api-client'

export const selectNewestRevision = <TEntity extends RevisionedEntity>(
  current: TEntity | null,
  incoming: TEntity,
): TEntity => {
  if (!current || current.id !== incoming.id) return incoming
  return incoming.revision > current.revision ? incoming : current
}

export class RevisionGate {
  readonly #revisions = new Map<string, number>()

  accept(entityId: string, revision: number): boolean {
    const current = this.#revisions.get(entityId)
    if (current !== undefined && revision <= current) return false
    this.#revisions.set(entityId, revision)
    return true
  }

  get(entityId: string): number | null {
    return this.#revisions.get(entityId) ?? null
  }

  clear() {
    this.#revisions.clear()
  }
}
