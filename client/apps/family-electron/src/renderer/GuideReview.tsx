import { useEffect, useId, useRef, useState } from 'react'
import type { GuideDraft, MiteApi } from '@mite/client-api'
import { Button, Notice, ScreenHeading, StatusBadge, Surface } from '@mite/ui'
import { DraftEditor } from './DraftEditor'
import {
  DraftSaveQueue,
  type DraftContent,
  type DraftSaveSnapshot,
} from './draft-save-queue'
import { isValidDraft } from './draft-validation'

interface GuideReviewProps {
  api: MiteApi
  supportSessionId: string
  drafts: GuideDraft[]
  busy: boolean
  onComplete(drafts: GuideDraft[]): void
  onCancel(): void
}

const initialSnapshot = (draft: GuideDraft): DraftSaveSnapshot => ({
  draft,
  status: 'SAVED',
  message: null,
  hasPendingChanges: false,
})

function ReviewCard({
  api,
  snapshot,
  busy,
  initiallyExpanded,
  onEdit,
}: {
  api: MiteApi
  snapshot: DraftSaveSnapshot
  busy: boolean
  initiallyExpanded: boolean
  onEdit(content: DraftContent): void
}) {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const contentId = useId()
  const headingId = useId()
  const valid = isValidDraft(snapshot.draft)
  const statusLabel = !valid
    ? '入力を確認してください'
    : snapshot.status === 'SAVED'
      ? '変更は保存済み'
      : snapshot.status === 'SAVING'
        ? '変更を保存中'
        : snapshot.status === 'WAITING'
          ? '変更あり'
          : snapshot.status === 'CONFLICT'
            ? '最新内容を反映'
            : '変更を保存できません'

  return (
    <Surface
      as="article"
      className="family-review-card"
      aria-labelledby={headingId}
    >
      <h3 className="family-review-card-heading">
        <button
          type="button"
          id={headingId}
          className="family-review-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((current) => !current)}
        >
          <span aria-hidden="true">{expanded ? '▼' : '▶'}</span>
          <span className="family-review-card-title">
            <span>
              {snapshot.draft.title.trim() || '名前を入力してください'}
            </span>
            <small>{snapshot.draft.steps.length}ステップ</small>
          </span>
        </button>
      </h3>
      <StatusBadge
        tone={
          !valid || snapshot.status === 'ERROR'
            ? 'danger'
            : snapshot.status === 'CONFLICT'
              ? 'warning'
              : snapshot.status === 'SAVED'
                ? 'success'
                : 'active'
        }
        role="status"
        aria-live="polite"
      >
        {statusLabel}
      </StatusBadge>
      <div
        id={contentId}
        hidden={!expanded}
        className="family-review-card-content"
      >
        <DraftEditor
          api={api}
          snapshot={snapshot}
          busy={busy}
          onEdit={onEdit}
        />
      </div>
    </Surface>
  )
}

export function GuideReview({
  api,
  supportSessionId,
  drafts,
  busy,
  onComplete,
  onCancel,
}: GuideReviewProps) {
  const queuesRef = useRef(new Map<string, DraftSaveQueue>())
  const [snapshots, setSnapshots] = useState<Record<string, DraftSaveSnapshot>>(
    {},
  )

  useEffect(() => {
    const queues = queuesRef.current
    return () => {
      for (const queue of queues.values()) queue.dispose()
      queues.clear()
    }
  }, [api, supportSessionId])

  useEffect(() => {
    const queues = queuesRef.current
    for (const [id, queue] of queues) {
      if (!drafts.some((draft) => draft.id === id)) {
        queue.dispose()
        queues.delete(id)
      }
    }
    for (const draft of drafts) {
      const existing = queues.get(draft.id)
      if (existing) {
        existing.replaceFromServer(draft)
      } else {
        const queue = new DraftSaveQueue(api, draft)
        queues.set(draft.id, queue)
        queue.subscribe((snapshot) =>
          setSnapshots((current) => ({ ...current, [draft.id]: snapshot })),
        )
      }
    }
  }, [api, supportSessionId, drafts])

  const currentSnapshots = drafts.map(
    (draft) => snapshots[draft.id] ?? initialSnapshot(draft),
  )
  const belongsToSession = drafts.every(
    (draft) => draft.supportSessionId === supportSessionId,
  )
  const hasErrors = currentSnapshots.some(
    (snapshot) => snapshot.status === 'ERROR',
  )
  const canComplete =
    !busy &&
    belongsToSession &&
    currentSnapshots.length > 0 &&
    currentSnapshots.every(
      (snapshot) =>
        isValidDraft(snapshot.draft) &&
        !snapshot.hasPendingChanges &&
        (snapshot.status === 'SAVED' || snapshot.status === 'CONFLICT') &&
        snapshot.draft.status === 'EDITING',
    )

  return (
    <div className="family-stack">
      <Surface elevated>
        <ScreenHeading
          eyebrow="手順の確認"
          title={`今回の支援から${drafts.length}件のガイドを作成しました`}
          description="内容を確認し、必要に応じて編集してください。変更は自動で保存されます。最後に「レビュー完了」で、すべてのガイドを保存して通話を終了します。"
        />
      </Surface>

      {belongsToSession ? (
        <div className="family-stack" aria-label="今回の支援のガイド">
          {currentSnapshots.map((snapshot, index) => (
            <ReviewCard
              key={snapshot.draft.id}
              api={api}
              snapshot={snapshot}
              busy={busy || snapshot.draft.status !== 'EDITING'}
              initiallyExpanded={index === 0}
              onEdit={(content) =>
                queuesRef.current.get(snapshot.draft.id)?.edit(content)
              }
            />
          ))}
        </div>
      ) : (
        <Notice tone="danger" title="ガイドを確認できません">
          今回の支援のガイドを読み直してください。
        </Notice>
      )}

      <Surface className="family-footer-actions">
        <div>
          <strong>
            すべてのガイドの確認が終わったら、レビューを完了してください。
          </strong>
          <p role="status" aria-live="polite">
            {busy
              ? '処理中です。しばらくお待ちください。'
              : hasErrors
                ? '変更を保存できませんでした。通信を確認して再試行してください。'
                : !canComplete
                  ? 'すべての入力が正しく、変更の自動保存が終わると完了できます。'
                  : 'すべてのガイドをまとめて確定できます。'}
          </p>
        </div>
        <div className="family-action-row">
          {hasErrors ? (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                for (const queue of queuesRef.current.values()) {
                  if (queue.getSnapshot().status === 'ERROR') void queue.flush()
                }
              }}
            >
              変更の保存を再試行
            </Button>
          ) : null}
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            作成せず終了
          </Button>
          <Button
            size="large"
            disabled={!canComplete}
            onClick={() => {
              if (canComplete)
                onComplete(currentSnapshots.map((snapshot) => snapshot.draft))
            }}
          >
            レビュー完了
          </Button>
        </div>
      </Surface>
    </div>
  )
}
