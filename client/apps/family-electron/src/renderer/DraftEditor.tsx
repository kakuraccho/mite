import { useState } from 'react'
import type { GuideStep, MiteApi } from '@mite/client-api'
import { Button, Modal, Notice, Surface } from '@mite/ui'
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
  const [selectedStep, setSelectedStep] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerPage, setPickerPage] = useState(0)
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const [availableImages, setAvailableImages] = useState<string[]>([])
  const [selectedImage, setSelectedImage] = useState<string | null>(null)
  const [newInstruction, setNewInstruction] = useState('')

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
    setSelectedStep(target)
  }

  const remove = (index: number) => {
    if (snapshot.draft.steps.length <= 1) return
    edit(
      snapshot.draft.title,
      snapshot.draft.steps.filter((_, stepIndex) => stepIndex !== index),
    )
    setSelectedStep(Math.min(index, snapshot.draft.steps.length - 2))
  }

  const openPicker = async () => {
    if (busy || snapshot.draft.steps.length >= 8) return
    setPickerOpen(true)
    setPickerLoading(true)
    setPickerError(null)
    setSelectedImage(null)
    setPickerPage(0)
    setNewInstruction('')
    try {
      const session = await api.getSupportSession(
        snapshot.draft.supportSessionId,
      )
      if (
        session.status !== 'REVIEWING_GUIDE' ||
        !session.guideMaterialBatchId
      ) {
        throw new Error('Guide is no longer editable')
      }
      const [request, materialBatch] = await Promise.all([
        api.getSupportRequest(session.supportRequestId),
        api.getGuideMaterialBatch(session.guideMaterialBatchId),
      ])
      setAvailableImages([
        ...new Set([
          request.initialScreenshotArtifactId,
          ...materialBatch.materials.map((material) => material.artifactId),
        ]),
      ])
    } catch {
      setPickerError(
        '撮影した画面を読み込めませんでした。閉じてから、もう一度試してください。',
      )
    } finally {
      setPickerLoading(false)
    }
  }

  const addStep = () => {
    if (
      busy ||
      snapshot.draft.steps.length >= 8 ||
      !selectedImage ||
      !newInstruction.trim() ||
      [...newInstruction].length > 120
    )
      return
    edit(snapshot.draft.title, [
      ...snapshot.draft.steps,
      {
        position: snapshot.draft.steps.length + 1,
        artifactId: selectedImage,
        instruction: newInstruction,
      },
    ])
    setSelectedStep(snapshot.draft.steps.length)
    setPickerOpen(false)
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
            disabled={busy}
            value={snapshot.draft.title}
            maxLength={40}
            onChange={(event) =>
              edit(event.currentTarget.value, snapshot.draft.steps)
            }
          />
          <small>{Array.from(snapshot.draft.title).length} / 40文字</small>
        </label>
      </Surface>

      <nav className="family-step-tabs" aria-label="編集する手順">
        {snapshot.draft.steps.map((step, index) => (
          <Button
            key={index}
            variant={selectedStep === index ? 'primary' : 'secondary'}
            aria-pressed={selectedStep === index}
            onClick={() => setSelectedStep(index)}
          >
            手順 {step.position}
          </Button>
        ))}
        <Button
          variant="secondary"
          disabled={busy || snapshot.draft.steps.length >= 8}
          onClick={() => void openPicker()}
        >
          手順を追加
        </Button>
      </nav>
      <ol className="family-draft-steps" aria-label="手順一覧">
        {snapshot.draft.steps.map((step, index) => (
          <li
            key={`${step.artifactId}-${index}`}
            hidden={
              index !== Math.min(selectedStep, snapshot.draft.steps.length - 1)
            }
          >
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
                  disabled={busy}
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
                  disabled={busy || index === 0}
                  aria-label={`手順${index + 1}を上へ移動`}
                  onClick={() => move(index, -1)}
                >
                  ↑ 上へ
                </Button>
                <Button
                  variant="quiet"
                  disabled={busy || index === snapshot.draft.steps.length - 1}
                  aria-label={`手順${index + 1}を下へ移動`}
                  onClick={() => move(index, 1)}
                >
                  ↓ 下へ
                </Button>
                <Button
                  variant="secondary"
                  disabled={busy || snapshot.draft.steps.length <= 1}
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
      {pickerOpen ? (
        <Modal
          title="撮影した画面から手順を追加"
          onClose={() => setPickerOpen(false)}
          actions={
            <Button
              disabled={
                busy ||
                snapshot.draft.steps.length >= 8 ||
                !selectedImage ||
                !newInstruction.trim() ||
                [...newInstruction].length > 120
              }
              onClick={addStep}
            >
              この画面を手順に追加
            </Button>
          }
        >
          <p>
            画像を1枚選び、操作の説明を入力してください。手順は8件までです。
          </p>
          {pickerLoading ? (
            <p role="status">撮影した画面を読み込んでいます</p>
          ) : null}
          {pickerError ? <Notice tone="danger" title={pickerError} /> : null}
          {!pickerLoading && !pickerError ? (
            <>
              <nav
                className="family-material-pages"
                aria-label="撮影画像のページ操作"
              >
                <Button
                  variant="secondary"
                  disabled={pickerPage === 0}
                  onClick={() => setPickerPage(pickerPage - 1)}
                >
                  前の画像
                </Button>
                <label>
                  ページ{' '}
                  <select
                    aria-label="撮影画像のページ"
                    value={pickerPage}
                    onChange={(event) =>
                      setPickerPage(Number(event.target.value))
                    }
                  >
                    {Array.from(
                      { length: Math.ceil(availableImages.length / 6) },
                      (_, page) => (
                        <option key={page} value={page}>
                          {page + 1} / {Math.ceil(availableImages.length / 6)}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  disabled={(pickerPage + 1) * 6 >= availableImages.length}
                  onClick={() => setPickerPage(pickerPage + 1)}
                >
                  次の画像
                </Button>
              </nav>
              <div className="family-material-picker">
                {availableImages
                  .slice(pickerPage * 6, (pickerPage + 1) * 6)
                  .map((artifactId, localIndex) => {
                    const index = pickerPage * 6 + localIndex
                    return (
                      <button
                        key={artifactId}
                        type="button"
                        aria-pressed={selectedImage === artifactId}
                        aria-label={`撮影画像${index + 1}を選択`}
                        onClick={() => setSelectedImage(artifactId)}
                      >
                        <ArtifactImage
                          api={api}
                          artifactId={artifactId}
                          alt={`撮影画像${index + 1}`}
                        />
                        <span>
                          {index === 0
                            ? '相談時の画面'
                            : `撮影した画面 ${index}`}
                        </span>
                      </button>
                    )
                  })}
              </div>
              {selectedImage ? (
                <p role="status">
                  選択中：撮影画像{availableImages.indexOf(selectedImage) + 1}
                </p>
              ) : null}
              <label className="family-field">
                <span>追加する手順の説明</span>
                <textarea
                  value={newInstruction}
                  maxLength={120}
                  rows={3}
                  onChange={(event) => setNewInstruction(event.target.value)}
                />
              </label>
            </>
          ) : null}
        </Modal>
      ) : null}
    </fieldset>
  )
}
