import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import { App } from './App'

beforeEach(() => localStorage.clear())

it('トークンをURLへ載せず初回設定画面から開始する', () => {
  render(<App />)
  expect(
    screen.getByRole('heading', { name: '家族用トークンを設定' }),
  ).toBeVisible()
  expect(screen.getByLabelText('家族用トークン')).toHaveAttribute(
    'type',
    'password',
  )
})
