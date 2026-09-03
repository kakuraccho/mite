import { MiteApiError, type GuideDraft, type MiteApi } from '@mite/api-client'

export type DraftSaveStatus =
  'SAVED' | 'WAITING' | 'SAVING' | 'ERROR' | 'CONFLICT'

export interface DraftContent {
  title: string
  steps: GuideDraft['steps']
}

export interface DraftSaveSnapshot {
  draft: GuideDraft
  status: DraftSaveStatus
  message: string | null
  hasPendingChanges: boolean
}

export class DraftSaveQueue {
  readonly #api: MiteApi
  readonly #draftId: string
  readonly #delayMs: number
  readonly #listeners = new Set<(snapshot: DraftSaveSnapshot) => void>()
  #confirmed: GuideDraft
  #content: DraftContent
  #editVersion = 0
  #savedVersion = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #inFlight = false
  #disposed = false
  #snapshot: DraftSaveSnapshot

  constructor(
    api: MiteApi,
    initialDraft: GuideDraft,
    options: { delayMs?: number } = {},
  ) {
    this.#api = api
    this.#draftId = initialDraft.id
    this.#delayMs = options.delayMs ?? 500
    this.#confirmed = initialDraft
    this.#content = {
      title: initialDraft.title,
      steps: initialDraft.steps,
    }
    this.#snapshot = {
      draft: initialDraft,
      status: 'SAVED',
      message: null,
      hasPendingChanges: false,
    }
  }

  getSnapshot(): DraftSaveSnapshot {
    return this.#snapshot
  }

  subscribe(listener: (snapshot: DraftSaveSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#snapshot)
    return () => this.#listeners.delete(listener)
  }

  edit(content: DraftContent) {
    if (this.#disposed) return
    this.#content = content
    this.#editVersion += 1
    this.#publish('WAITING', null)
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = null
      void this.flush()
    }, this.#delayMs)
  }

  async flush(): Promise<void> {
    if (
      this.#disposed ||
      this.#inFlight ||
      this.#savedVersion === this.#editVersion
    ) {
      return
    }
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#inFlight = true
    const sendingVersion = this.#editVersion
    const sendingContent = this.#content
    this.#publish('SAVING', null)

    try {
      const updated = await this.#api.updateGuideDraft(this.#draftId, {
        expectedRevision: this.#confirmed.revision,
        title: sendingContent.title,
        steps: sendingContent.steps,
      })
      this.#confirmed = updated
      this.#savedVersion = sendingVersion
      this.#publish(
        this.#savedVersion === this.#editVersion ? 'SAVED' : 'WAITING',
        null,
      )
    } catch (error) {
      if (
        error instanceof MiteApiError &&
        (error.code === 'REVISION_CONFLICT' || error.code === 'INVALID_STATE')
      ) {
        await this.#reloadAfterConflict()
      } else if (!(error instanceof MiteApiError) || error.status >= 500) {
        await this.#reconcileUnknownResult(sendingVersion, sendingContent)
      } else {
        this.#publish(
          'ERROR',
          '変更を保存できませんでした。通信を確認して、もう一度試してください。',
        )
      }
    } finally {
      this.#inFlight = false
      if (
        !this.#disposed &&
        this.#snapshot.status !== 'ERROR' &&
        this.#snapshot.status !== 'CONFLICT' &&
        this.#savedVersion < this.#editVersion
      ) {
        void this.flush()
      }
    }
  }

  replaceFromServer(draft: GuideDraft) {
    if (this.#inFlight || this.#savedVersion !== this.#editVersion) return
    if (draft.revision <= this.#confirmed.revision) return
    this.#confirmed = draft
    this.#content = { title: draft.title, steps: draft.steps }
    this.#publish('SAVED', null)
  }

  dispose() {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
    this.#listeners.clear()
  }

  async #reloadAfterConflict() {
    try {
      const latest = await this.#api.getGuideDraft(this.#draftId)
      this.#confirmed = latest
      this.#content = { title: latest.title, steps: latest.steps }
      this.#editVersion += 1
      this.#savedVersion = this.#editVersion
      this.#publish(
        'CONFLICT',
        '内容が更新されたため、最新の内容を読み直しました。',
      )
    } catch {
      this.#publish(
        'ERROR',
        '最新の内容を取得できませんでした。もう一度試してください。',
      )
    }
  }

  async #reconcileUnknownResult(
    sendingVersion: number,
    sendingContent: DraftContent,
  ) {
    try {
      const latest = await this.#api.getGuideDraft(this.#draftId)
      const sameContent =
        latest.title === sendingContent.title &&
        JSON.stringify(latest.steps) === JSON.stringify(sendingContent.steps)
      if (sameContent) {
        this.#confirmed = latest
        this.#savedVersion = sendingVersion
        this.#publish(
          this.#savedVersion === this.#editVersion ? 'SAVED' : 'WAITING',
          null,
        )
        return
      }
      if (latest.revision > this.#confirmed.revision) {
        this.#confirmed = latest
        this.#content = { title: latest.title, steps: latest.steps }
        this.#editVersion += 1
        this.#savedVersion = this.#editVersion
        this.#publish(
          'CONFLICT',
          '内容が更新されたため、最新の内容を読み直しました。',
        )
        return
      }
    } catch {
      // Keep the pending edit below so the user can retry without losing data.
    }
    this.#publish(
      'ERROR',
      '変更を保存できませんでした。通信を確認して、もう一度試してください。',
    )
  }

  #publish(status: DraftSaveStatus, message: string | null) {
    this.#snapshot = {
      draft: {
        ...this.#confirmed,
        title: this.#content.title,
        steps: this.#content.steps,
      },
      status,
      message,
      hasPendingChanges: this.#savedVersion !== this.#editVersion,
    }
    for (const listener of this.#listeners) listener(this.#snapshot)
  }
}
