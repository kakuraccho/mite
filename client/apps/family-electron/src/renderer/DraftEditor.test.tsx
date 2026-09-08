import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { GuideDraft, MiteApi } from '@mite/client-api'
import { DraftEditor } from './DraftEditor'

afterEach(() => vi.useRealTimers())
const draft: GuideDraft = {
  id: 'draft_1',
  supportSessionId: 'session_1',
  title: '手順',
  status: 'EDITING',
  revision: 1,
  createdAt: '2026-09-09T00:00:00Z',
  updatedAt: '2026-09-09T00:00:00Z',
  steps: [
    { position: 1, artifactId: 'ai_selected', instruction: '最初の説明' },
  ],
}
const makeApi = () =>
  ({
    getSupportSession: vi.fn().mockResolvedValue({
      status: 'REVIEWING_GUIDE',
      supportRequestId: 'request_1',
      guideMaterialBatchId: 'batch_1',
    }),
    getSupportRequest: vi
      .fn()
      .mockResolvedValue({ initialScreenshotArtifactId: 'initial' }),
    getGuideMaterialBatch: vi.fn().mockResolvedValue({
      materials: [
        { artifactId: 'ai_selected' },
        { artifactId: 'not_selected_by_ai' },
      ],
    }),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    updateGuideDraft: vi.fn(async (_id, input) => ({
      ...draft,
      ...input,
      revision: input.expectedRevision + 1,
    })),
  }) as unknown as MiteApi

it('adds an image omitted by AI, edits and reorders the new step using the existing revision PATCH', async () => {
  const api = makeApi()
  render(
    <DraftEditor
      api={api}
      draft={draft}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '手順を追加' }))
  const dialog = screen.getByRole('dialog', {
    name: '撮影した画面から手順を追加',
  })
  const image = await within(dialog).findByRole('button', {
    name: '撮影画像3を選択',
  })
  expect(api.getGuideMaterialBatch).toHaveBeenCalledWith('batch_1')
  fireEvent.click(image)
  expect(
    within(dialog).getByRole('button', { name: 'この画面を手順に追加' }),
  ).toBeDisabled()
  fireEvent.change(within(dialog).getByLabelText('追加する手順の説明'), {
    target: { value: '保存を押します' },
  })
  vi.useFakeTimers()
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'この画面を手順に追加' }),
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('textbox', { name: /^説明/ })).toHaveValue(
    '保存を押します',
  )
  fireEvent.change(screen.getByRole('textbox', { name: /^説明/ }), {
    target: { value: '左の保存を押します' },
  })
  fireEvent.click(screen.getByRole('button', { name: '手順2を上へ移動' }))
  await act(async () => vi.advanceTimersByTimeAsync(500))
  expect(api.updateGuideDraft).toHaveBeenLastCalledWith(
    'draft_1',
    expect.objectContaining({
      expectedRevision: 1,
      steps: [
        {
          position: 1,
          artifactId: 'not_selected_by_ai',
          instruction: '左の保存を押します',
        },
        { position: 2, artifactId: 'ai_selected', instruction: '最初の説明' },
      ],
    }),
  )
})

it('keeps the eight-step limit and permits adding again after removing a step', async () => {
  const full = {
    ...draft,
    steps: Array.from({ length: 8 }, (_, i) => ({
      position: i + 1,
      artifactId: `art_${i}`,
      instruction: `説明${i}`,
    })),
  }
  const api = makeApi()
  render(
    <DraftEditor
      api={api}
      draft={full}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  expect(screen.getByRole('button', { name: '手順を追加' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: '手順1を削除' }))
  expect(screen.getByRole('button', { name: '手順を追加' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: '手順を追加' }))
  await screen.findByRole('button', { name: '撮影画像3を選択' })
  expect(screen.getAllByRole('button', { name: /^撮影画像/ })).toHaveLength(3)
})

it('reports stale/failed material loading without adding a step', async () => {
  const api = makeApi()
  vi.mocked(api.getSupportSession).mockResolvedValue({
    status: 'GUIDE_SAVED',
  } as never)
  render(
    <DraftEditor
      api={api}
      draft={draft}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '手順を追加' }))
  await screen.findByText(/撮影した画面を読み込めませんでした/)
  expect(api.getGuideMaterialBatch).not.toHaveBeenCalled()
  expect(
    screen.getByRole('button', { name: 'この画面を手順に追加' }),
  ).toBeDisabled()
})

it('pages through every captured image while loading only the visible page', async () => {
  const api = makeApi()
  vi.mocked(api.getGuideMaterialBatch).mockResolvedValue({
    materials: Array.from({ length: 13 }, (_, i) => ({
      artifactId: `capture_${i}`,
    })),
  } as never)
  render(
    <DraftEditor
      api={api}
      draft={draft}
      busy={false}
      onSave={vi.fn()}
      onCancel={vi.fn()}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: '手順を追加' }))
  await screen.findByRole('button', { name: '撮影画像6を選択' })
  expect(screen.queryByRole('button', { name: '撮影画像7を選択' })).toBeNull()
  expect(api.getArtifactContent).not.toHaveBeenCalledWith('capture_12')
  fireEvent.change(screen.getByRole('combobox', { name: '撮影画像のページ' }), {
    target: { value: '2' },
  })
  fireEvent.click(screen.getByRole('button', { name: '撮影画像14を選択' }))
  expect(api.getArtifactContent).toHaveBeenCalledWith('capture_12')
  expect(screen.getByText('選択中：撮影画像14')).toBeTruthy()
  expect(screen.getByRole('button', { name: '次の画像' })).toBeDisabled()
})
