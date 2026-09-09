import type { GuideStep, MiteApi } from '@mite/client-api'
import { Button, Notice, Surface } from '@mite/ui'
import { ArtifactImage } from './ArtifactImage'
import type { DraftContent, DraftSaveSnapshot } from './draft-save-queue'
import { isValidDraft } from './draft-validation'

interface DraftEditorProps {
  api: MiteApi
  snapshot: DraftSaveSnapshot
  busy: boolean
  onEdit(content: DraftContent): void
}

export function DraftEditor({ api, snapshot, busy, onEdit }: DraftEditorProps) {
  const edit = (title: string, steps: GuideStep[]) => {
    onEdit({
      title,
      steps: steps.map((step, index) => ({ ...step, position: index + 1 })),
    })
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
  return (
    <fieldset className="family-draft-fields family-stack" disabled={busy}>
      <Surface elevated>
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
    </fieldset>
  )
}
