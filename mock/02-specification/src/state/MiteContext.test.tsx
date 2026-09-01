import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FIXED_REQUEST_CREATED_AT, createInitialState } from '../domain/fixtures'
import { MiteProvider } from './MiteContext'
import { useMite } from './useMite'

function StateProbe() {
  const { state } = useMite()
  return (
    <dl>
      <dt>依頼</dt>
      <dd data-testid="request-status">
        {state.supportRequest?.status ?? 'none'}
      </dd>
      <dt>ガイド</dt>
      <dd data-testid="guide-status">{state.guideRun.status}</dd>
      <dt>記録件数</dt>
      <dd data-testid="capture-count">
        {state.supportSession.mockCaptureCount}
      </dd>
    </dl>
  )
}

describe('MiteProviderの疑似時間', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('照合待ちのあと、設定どおり似たガイドへ移る', () => {
    const state = createInitialState('B')
    state.supportRequest = {
      id: 'request-auth-code',
      createdAt: FIXED_REQUEST_CREATED_AT,
      screenshotId: 'mock-mail-screen',
      comment: '',
      status: 'matching',
      source: 'problem',
    }
    render(
      <MiteProvider initialState={state}>
        <StateProbe />
      </MiteProvider>,
    )

    expect(screen.getByTestId('request-status')).toHaveTextContent('matching')
    act(() => vi.advanceTimersByTime(350))
    expect(screen.getByTestId('request-status')).toHaveTextContent('closed')
    expect(screen.getByTestId('guide-status')).toHaveTextContent('running')
  })

  it('支援中は5秒ごとに疑似記録を1件増やす', () => {
    const state = createInitialState('A')
    state.supportSession = {
      ...state.supportSession,
      requestId: 'request-auth-code',
      status: 'supporting',
    }
    render(
      <MiteProvider initialState={state}>
        <StateProbe />
      </MiteProvider>,
    )

    expect(screen.getByTestId('capture-count')).toHaveTextContent('0')
    act(() => vi.advanceTimersByTime(4999))
    expect(screen.getByTestId('capture-count')).toHaveTextContent('0')
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByTestId('capture-count')).toHaveTextContent('1')
    act(() => vi.advanceTimersByTime(5000))
    expect(screen.getByTestId('capture-count')).toHaveTextContent('2')
  })
})
