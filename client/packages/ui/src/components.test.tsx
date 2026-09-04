import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Button, Notice } from './components'

describe('shared UI', () => {
  it('ボタンをアクセシブルな名前で操作できる', () => {
    render(<Button leadingIcon="☎">家族へ連絡する</Button>)
    expect(
      screen
        .getByRole('button', { name: '家族へ連絡する' })
        .hasAttribute('disabled'),
    ).toBe(false)
  })

  it('通知の内容を表示する', () => {
    render(
      <Notice tone="danger" title="通信できません" role="alert">
        もう一度お試しください。
      </Notice>,
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'もう一度お試しください。',
    )
  })
})
