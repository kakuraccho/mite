import { useEffect, useRef, useState } from 'react'
import type { GuideDraft, GuideStep, MiteApi } from '@mite/client-api'
import { Button, Notice, ScreenHeading, StatusBadge, Surface } from '@mite/ui'
import { ArtifactImage } from './ArtifactImage'
import { DraftSaveQueue, type DraftSaveSnapshot } from './draft-save-queue'

interface DraftEditorProps {
  api: MiteApi
  draft: GuideDraft
  busy: boolean
  onSave(draft: GuideDraft): void
  onCancel(): void
}

const positionSteps = (steps: GuideStep[]): GuideStep[] =>
  steps.map((step, index) => ({ ...step, position: index + 1 }))

const isValidDraft = (draft: GuideDraft) => {
  const titleLength = Array.from(draft.title.trim()).length
  return (
    titleLength >= 1 &&
    titleLength <= 40 &&
    draft.steps.length >= 1 &&
    draft.steps.length <= 8 &&
    draft.steps.every((step) => {
      const length = Array.from(step.instruction.trim()).length
      return length >= 1 && length <= 120
    })
  )
}

export function DraftEditor({
  api,
  draft,
  busy,
  onSave,
  onCancel,
}: DraftEditorProps) {
  const initialDraftRef = useRef(draft)
  const queueRef = useRef<DraftSaveQueue | null>(null)
  const [snapshot, setSnapshot] = useState<DraftSaveSnapshot>({
    draft,
    status: 'SAVED',
    message: null,
    hasPendingChanges: false,
  })

  useEffect(() => {
    const queue = new DraftSaveQueue(api, initialDraftRef.current)
    queueRef.current = queue
    const unsubscribe = queue.subscribe(setSnapshot)
    return () => {
      unsubscribe()
      queue.dispose()
      queueRef.current = null
    }
  }, [api])

  useEffect(() => {
    queueRef.current?.replaceFromServer(draft)
  }, [draft])

  const edit = (title: string, steps: GuideStep[]) => {
    queueRef.current?.edit({ title, steps: positionSteps(steps) })
  }

  const move = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= snapshot.draft.steps.length) return
    const steps = [...snapshot.draft.steps]
    const current = steps[index]
    const other = steps[target]
    if (!current || !other) return
    steps[index] = other
    steps[target] = current
    edit(snapshot.draft.title, steps)
  }

  const remove = (index: number) => {
    if (snapshot.draft.steps.length <= 1) return
    edit(
      snapshot.draft.title,
      snapshot.draft.steps.filter((_, stepIndex) => stepIndex !== index),
    )
  }

  const valid = isValidDraft(snapshot.draft)
  const canSave =
    valid &&
    (snapshot.status === 'SAVED' || snapshot.status === 'CONFLICT') &&
    !snapshot.hasPendingChanges &&
    snapshot.draft.status === 'EDITING' &&
    !busy

  return (
    <div className="family-stack">
      <Surface elevated>
        <ScreenHeading
          eyebrow="F-05 手順の確認"
          title="利用者に残す手順を整える"
          description="変更は入力を止めてから自動で保存されます。画像と説明の順番を確認してください。"
          aside={
            <StatusBadge
              tone={
                snapshot.status === 'SAVED'
                  ? 'success'
                  : snapshot.status === 'ERROR'
                    ? 'danger'
                    : snapshot.status === 'CONFLICT'
                      ? 'warning'
                      : 'active'
              }
              role="status"
              aria-live="polite"
            >
              {snapshot.status === 'SAVED'
                ? '保存済み'
                : snapshot.status === 'SAVING'
                  ? '保存中'
                  : snapshot.status === 'WAITING'
                    ? '変更あり'
                    : snapshot.status === 'CONFLICT'
                      ? '最新内容を反映'
                      : '保存できません'}
            </StatusBadge>
          }
        />

        {snapshot.message ? (
          <Notice
            title={
              snapshot.status === 'CONFLICT'
                ? '最新の内容を表示しています'
                : '自動保存に失敗しました'
            }
            tone={snapshot.status === 'CONFLICT' ? 'warning' : 'danger'}
          >
            <p>{snapshot.message}</p>
            {snapshot.status === 'ERROR' ? (
              <Button
                variant="secondary"
                onClick={() => void queueRef.current?.flush()}
              >
                もう一度保存する
              </Button>
            ) : null}
          </Notice>
        ) : null}

        <label className="family-field family-title-field">
          <span>手順の名前</span>
          <input
            value={snapshot.draft.title}
            maxLength={40}
            onChange={(event) =>
              edit(event.currentTarget.value, snapshot.draft.steps)
            }
          />
          <small>{Array.from(snapshot.draft.title).length} / 40文字</small>
        </label>
      </Surface>

      <ol className="family-draft-steps" aria-label="手順一覧">
        {snapshot.draft.steps.map((step, index) => (
          <li key={`${step.artifactId}-${index}`}>
            <Surface className="family-draft-step">
              <div className="family-step-index" aria-hidden="true">
                {index + 1}
              </div>
              <ArtifactImage
                api={api}
                artifactId={step.artifactId}
                alt={`手順${index + 1}の画面`}
                className="family-draft-image"
              />
              <label className="family-field family-instruction-field">
                <span>説明</span>
                <textarea
                  value={step.instruction}
                  maxLength={120}
                  rows={4}
                  onChange={(event) => {
                    const steps = snapshot.draft.steps.map(
                      (currentStep, stepIndex) =>
                        stepIndex === index
                          ? {
                              ...currentStep,
                              instruction: event.currentTarget.value,
                            }
                          : currentStep,
                    )
                    edit(snapshot.draft.title, steps)
                  }}
                />
                <small>{Array.from(step.instruction).length} / 120文字</small>
              </label>
              <div className="family-step-actions" aria-label="手順の操作">
                <Button
                  variant="quiet"
                  disabled={index === 0}
                  aria-label={`手順${index + 1}を上へ移動`}
                  onClick={() => move(index, -1)}
                >
                  ↑ 上へ
                </Button>
                <Button
                  variant="quiet"
                  disabled={index === snapshot.draft.steps.length - 1}
                  aria-label={`手順${index + 1}を下へ移動`}
                  onClick={() => move(index, 1)}
                >
                  ↓ 下へ
                </Button>
                <Button
                  variant="secondary"
                  disabled={snapshot.draft.steps.length <= 1}
                  aria-label={`手順${index + 1}を削除`}
                  onClick={() => remove(index)}
                >
                  削除
                </Button>
              </div>
            </Surface>
          </li>
        ))}
      </ol>

      {!valid ? (
        <Notice tone="warning" title="入力を確認してください">
          名前は1〜40文字、説明は各1〜120文字、手順は1〜8件必要です。
        </Notice>
      ) : null}

      <Surface className="family-footer-actions">
        <div>
          <strong>内容を利用者のガイドへ保存しますか？</strong>
          <p>「ガイドを保存」は、自動保存が完了すると選べます。</p>
        </div>
        <div className="family-action-row">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            作成せず終了
          </Button>
          <Button
            size="large"
            disabled={!canSave}
            onClick={() => onSave(snapshot.draft)}
          >
            ガイドを保存
          </Button>
        </div>
      </Surface>
    </div>
  )
}
