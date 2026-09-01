import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FamilyView } from '../components/FamilyView'
import { GrandfatherView } from '../components/GrandfatherView'
import { PRIMARY_GUIDE, createInitialState } from '../domain/fixtures'
import { miteReducer } from '../domain/reducer'
import { MiteProvider } from '../state/MiteContext'

const renderScenario = (scenario: 'A' | 'B' | 'C' | 'D') =>
  render(
    <MiteProvider initialState={createInitialState(scenario)}>
      <GrandfatherView />
      <FamilyView />
    </MiteProvider>,
  )

const openPrimaryGuideFromList = () => {
  fireEvent.click(
    screen.getByRole('button', { name: /ガイドを見る 前に保存した手順/ }),
  )
  const guideTitle = screen.getByRole('heading', {
    name: PRIMARY_GUIDE.title,
  })
  const card = guideTitle.closest('article')
  if (!card) throw new Error('主シナリオのガイドカードが見つかりません')
  fireEvent.click(
    within(card).getByRole('button', { name: 'このガイドを見る' }),
  )
}

describe('Scenario A〜DのUI接続', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('Scenario Aを記録からガイド保存・一覧確認まで操作できる', () => {
    renderScenario('A')

    fireEvent.click(
      screen.getByRole('button', { name: /困りごとを記録する/ }),
    )
    fireEvent.change(
      screen.getByLabelText(/今の状況を、書ける範囲で教えてください/),
      {
        target: {
          value: '番号は分かったけれど、飛行機の画面に戻れません',
        },
      },
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に知らせる' }))
    expect(
      screen.getByRole('heading', {
        name: '似たガイドがないか確認しています',
      }),
    ).toBeInTheDocument()

    act(() => vi.advanceTimersByTime(350))
    fireEvent.click(screen.getByRole('button', { name: '依頼の内容を見る' }))
    fireEvent.click(screen.getByRole('button', { name: /電話をかける/ }))
    fireEvent.click(screen.getByRole('button', { name: /電話に出る/ }))
    act(() => vi.advanceTimersByTime(350))

    const solvedButton = screen.getByRole('button', {
      name: /問題を解決した/,
    })
    expect(solvedButton).toBeDisabled()
    act(() => vi.advanceTimersByTime(5000))
    expect(solvedButton).toBeEnabled()
    fireEvent.click(solvedButton)
    fireEvent.click(
      screen.getByRole('button', { name: /ガイドを作成する/ }),
    )
    act(() => vi.advanceTimersByTime(550))

    const editedTitle = '番号を確認して、飛行機の画面へ戻る'
    fireEvent.change(screen.getByLabelText('ガイドのタイトル'), {
      target: { value: editedTitle },
    })
    expect(
      screen.getByRole('heading', { name: editedTitle }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /保存する/ }))

    expect(
      screen.getByRole('heading', { name: 'ガイドを保存しました' }),
    ).toBeInTheDocument()
    fireEvent.click(
      screen.getByRole('button', { name: /保存したガイドを見る/ }),
    )
    expect(screen.getAllByText(editedTitle).length).toBeGreaterThan(0)
    expect(
      screen.getByRole('heading', { name: 'ガイドを保存しました' }),
    ).toBeInTheDocument()
  })

  it('Scenario Bは照合後に類似ガイドの最初の手順へ移る', () => {
    renderScenario('B')

    fireEvent.click(
      screen.getByRole('button', { name: /困りごとを記録する/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に知らせる' }))
    act(() => vi.advanceTimersByTime(350))

    expect(
      screen.getByText(/似たガイドが見つかりました/),
    ).toBeInTheDocument()
    expect(screen.getByText('STEP 1 / 3')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: /次へ/ }),
    ).toBeInTheDocument()
  })

  it('Scenario Cは一覧から選び、前後移動して完了できる', () => {
    renderScenario('C')
    openPrimaryGuideFromList()

    fireEvent.click(screen.getByRole('button', { name: /次へ/ }))
    expect(screen.getByText('STEP 2 / 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /前へ/ }))
    expect(screen.getByText('STEP 1 / 3')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }))
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }))
    fireEvent.click(screen.getByRole('button', { name: 'できました' }))

    expect(
      screen.getByRole('heading', { name: 'できました' }),
    ).toBeInTheDocument()
  })

  it('Scenario Dは現在の手順から家族への依頼へ移る', () => {
    renderScenario('D')
    openPrimaryGuideFromList()
    fireEvent.click(screen.getByRole('button', { name: /次へ/ }))
    fireEvent.click(
      screen.getByRole('button', { name: /遠隔支援へ移る/ }),
    )
    expect(
      screen.getByRole('heading', { name: 'このまま家族に相談しますか？' }),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))

    const comment = screen.getByLabelText(
      /今の状況を、書ける範囲で教えてください/,
    )
    expect(comment).toHaveValue(
      `「${PRIMARY_GUIDE.title}」の手順2で分からなくなりました`,
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に知らせる' }))
    act(() => vi.advanceTimersByTime(350))

    expect(
      screen.getByRole('button', { name: '依頼の内容を見る' }),
    ).toBeInTheDocument()
  })

  it('家族が示した相対位置を祖父側と家族側の両方へ描画する', () => {
    let state = createInitialState('A')
    state = [
      { type: 'START_SUPPORT_REQUEST' as const },
      { type: 'SUBMIT_SUPPORT_REQUEST' as const },
      { type: 'GUIDE_MATCH_NOT_FOUND' as const },
      { type: 'VIEW_SUPPORT_REQUEST' as const },
      { type: 'START_CALL' as const },
      { type: 'ACCEPT_CALL' as const },
      { type: 'CONNECTION_ESTABLISHED' as const },
    ].reduce(miteReducer, state)

    const { container } = render(
      <MiteProvider initialState={state}>
        <GrandfatherView />
        <FamilyView />
      </MiteProvider>,
    )
    const sharedScreen = screen.getByRole('button', {
      name: /祖父の共有画面/,
    })
    vi.spyOn(sharedScreen, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      top: 50,
      width: 400,
      height: 200,
      right: 500,
      bottom: 250,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    })

    fireEvent.click(sharedScreen, { clientX: 300, clientY: 150 })

    const markers = container.querySelectorAll<HTMLElement>('.shared-marker')
    expect(markers).toHaveLength(2)
    markers.forEach((marker) => {
      expect(marker.style.left).toBe('50%')
      expect(marker.style.top).toBe('50%')
    })
  })
})
