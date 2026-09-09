import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MiteApiError, type GuideDraft, type MiteApi } from '@mite/client-api'
import { GuideReview } from './GuideReview'

const draft = (id: string, title: string, count = 2): GuideDraft => ({
  id,
  supportSessionId: 'session_01',
  title,
  steps: Array.from({ length: count }, (_, index) => ({
    position: index + 1,
    artifactId: `${id}_image_${index + 1}`,
    instruction: `${title}の説明${index + 1}`,
  })),
  status: 'EDITING',
  revision: 1,
  createdAt: '2026-09-08T00:00:00Z',
  updatedAt: '2026-09-08T00:00:00Z',
})
const drafts = [
  draft('login', 'Amazonにログインする'),
  draft('address', '配送先住所を変更する', 3),
]

function setup(items = drafts) {
  const updateGuideDraft = vi.fn(
    async (
      id: string,
      input: {
        expectedRevision: number
        title: string
        steps: GuideDraft['steps']
      },
    ) => ({
      ...items.find((item) => item.id === id)!,
      ...input,
      revision: input.expectedRevision + 1,
    }),
  )
  const getGuideDraft = vi.fn().mockRejectedValue(new TypeError('offline'))
  const api = {
    updateGuideDraft,
    getGuideDraft,
    getArtifactContent: vi.fn().mockResolvedValue(new Blob()),
  } as unknown as MiteApi
  const onComplete = vi.fn()
  const onCancel = vi.fn()
  const props = {
    api,
    supportSessionId: 'session_01',
    drafts: items,
    busy: false,
    onComplete,
    onCancel,
  }
  const rendered = render(<GuideReview {...props} />)
  return {
    ...rendered,
    props,
    api,
    updateGuideDraft,
    getGuideDraft,
    onComplete,
    onCancel,
  }
}
const completeButton = () =>
  screen.getByRole('button', { name: 'レビュー完了' })
const card = (title: string) =>
  screen.getByRole('article', { name: new RegExp(title) })
const toggle = (title: string) =>
  within(card(title)).getByRole('button', { name: new RegExp(title) })

afterEach(() => vi.useRealTimers())

describe('GuideReview', () => {
  it.each([1, 2, 10])(
    '%i件でも開いた履歴を条件にせず1回で全件を渡す',
    (count) => {
      const items = Array.from({ length: count }, (_, index) =>
        draft(`draft_${index}`, `ガイド${index}`, (index % 8) + 1),
      )
      const { onComplete, api } = setup(items)
      expect(
        screen.getByRole('heading', {
          name: `今回の支援から${count}件のガイドを作成しました`,
        }),
      ).toBeInTheDocument()
      expect(screen.getAllByRole('article')).toHaveLength(count)
      for (const [index, item] of items.entries()) {
        expect(toggle(item.title)).toHaveAttribute(
          'aria-expanded',
          String(index === 0),
        )
        expect(
          within(card(item.title)).getByText(`${item.steps.length}ステップ`),
        ).toBeInTheDocument()
      }
      expect(
        screen.getAllByRole('button', { name: 'レビュー完了' }),
      ).toHaveLength(1)
      expect(
        screen.queryByRole('button', { name: /ガイドを保存|承認|分割|統合/ }),
      ).not.toBeInTheDocument()
      fireEvent.click(completeButton())
      expect(onComplete).toHaveBeenCalledExactlyOnceWith(items)
      expect(api.updateGuideDraft).not.toHaveBeenCalled()
    },
  )

  it('各ガイドのタイトル・説明・順番・削除を編集でき、閉じても自動保存を続ける', async () => {
    vi.useFakeTimers()
    const { updateGuideDraft, onComplete } = setup()
    fireEvent.click(toggle(drafts[1]!.title))
    const second = within(card(drafts[1]!.title))
    fireEvent.change(second.getByRole('textbox', { name: /手順の名前/ }), {
      target: { value: '新しい住所を登録する' },
    })
    fireEvent.change(second.getAllByRole('textbox', { name: /説明/ })[0]!, {
      target: { value: '住所のボタンを押す' },
    })
    fireEvent.click(second.getByRole('button', { name: '手順1を下へ移動' }))
    fireEvent.click(second.getByRole('button', { name: '手順3を削除' }))
    expect(second.getByText('2ステップ')).toBeInTheDocument()
    fireEvent.click(toggle('新しい住所を登録する'))
    expect(completeButton()).toBeDisabled()
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(updateGuideDraft).toHaveBeenCalledExactlyOnceWith('address', {
      expectedRevision: 1,
      title: '新しい住所を登録する',
      steps: [
        { ...drafts[1]!.steps[1], position: 1 },
        {
          ...drafts[1]!.steps[0],
          position: 2,
          instruction: '住所のボタンを押す',
        },
      ],
    })
    expect(completeButton()).toBeEnabled()
    fireEvent.click(completeButton())
    expect(onComplete.mock.calls[0]![0]).toEqual([
      drafts[0],
      expect.objectContaining({
        id: 'address',
        revision: 2,
        title: '新しい住所を登録する',
      }),
    ])
    fireEvent.click(toggle('新しい住所を登録する'))
    expect(
      within(card('新しい住所を登録する')).getAllByRole('textbox', {
        name: /説明/,
      })[1],
    ).toHaveValue('住所のボタンを押す')
  })

  it('1件でも保存失敗があれば確定を止め、まとめて再試行できる', async () => {
    vi.useFakeTimers()
    const { updateGuideDraft, onComplete } = setup()
    updateGuideDraft.mockRejectedValueOnce(new TypeError('offline'))
    fireEvent.change(screen.getByRole('textbox', { name: /手順の名前/ }), {
      target: { value: '変更した名前' },
    })
    fireEvent.click(toggle('変更した名前'))
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(completeButton()).toBeDisabled()
    expect(screen.getByText('変更を保存できません')).toBeVisible()
    fireEvent.click(completeButton())
    expect(onComplete).not.toHaveBeenCalled()
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: '変更の保存を再試行' }),
      ),
    )
    expect(completeButton()).toBeEnabled()
  })

  it('非表示のガイドの入力不備でも確定を止める', () => {
    setup([drafts[0]!, { ...drafts[1]!, title: '' }])
    expect(completeButton()).toBeDisabled()
    expect(
      screen.getByText('入力を確認してください', {
        selector: '[role="status"]',
      }),
    ).toBeVisible()
  })

  it('確定中と結果確認待ちはすべての編集・終了操作を無効にする', () => {
    const { props, rerender } = setup()
    rerender(<GuideReview {...props} busy />)
    fireEvent.click(toggle(drafts[1]!.title))
    for (const input of screen.getAllByRole('textbox'))
      expect(input).toBeDisabled()
    expect(completeButton()).toBeDisabled()
    expect(screen.getByRole('button', { name: '作成せず終了' })).toBeDisabled()
  })

  it('ポーリングで各ガイドの新しいrevisionだけを反映し、開閉状態を保つ', () => {
    const { props, rerender, onComplete } = setup()
    const latest = { ...drafts[1]!, revision: 3, title: '新しい配送先' }
    rerender(<GuideReview {...props} drafts={[drafts[0]!, latest]} />)
    expect(toggle(latest.title)).toHaveAttribute('aria-expanded', 'false')
    rerender(
      <GuideReview
        {...props}
        drafts={[drafts[0]!, { ...latest, revision: 2, title: '古い配送先' }]}
      />,
    )
    expect(toggle(latest.title)).toBeVisible()
    fireEvent.click(completeButton())
    expect(onComplete).toHaveBeenCalledWith([drafts[0], latest])
  })

  it('更新の競合を読み直し、最新のrevisionでまとめて確定する', async () => {
    vi.useFakeTimers()
    const { updateGuideDraft, getGuideDraft, onComplete } = setup()
    updateGuideDraft.mockRejectedValueOnce(
      new MiteApiError(409, {
        error: {
          code: 'REVISION_CONFLICT',
          message: 'conflict',
          requestId: 'request_01',
        },
      }),
    )
    const latest = { ...drafts[0]!, revision: 4, title: '最新の手順' }
    getGuideDraft.mockResolvedValue(latest)
    fireEvent.change(screen.getByRole('textbox', { name: /手順の名前/ }), {
      target: { value: '競合する名前' },
    })
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(screen.getByText('最新内容を反映')).toBeVisible()
    fireEvent.click(completeButton())
    expect(onComplete).toHaveBeenCalledWith([latest, drafts[1]])
  })

  it('キーボードでガイドを開閉できる', async () => {
    setup()
    const user = userEvent.setup()
    toggle(drafts[1]!.title).focus()
    await user.keyboard('{Enter}')
    expect(toggle(drafts[1]!.title)).toHaveAttribute('aria-expanded', 'true')
    await user.keyboard(' ')
    expect(toggle(drafts[1]!.title)).toHaveAttribute('aria-expanded', 'false')
  })

  it('別の支援のガイドや0件のレビューは確定させない', () => {
    const { props, rerender } = setup([])
    expect(completeButton()).toBeDisabled()
    rerender(
      <GuideReview
        {...props}
        drafts={[{ ...drafts[0]!, supportSessionId: 'another_session' }]}
      />,
    )
    expect(screen.getByText('ガイドを確認できません')).toBeVisible()
    expect(completeButton()).toBeDisabled()
  })
})
