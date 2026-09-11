import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MiteApi } from '@mite/client-api'
import { ArtifactImage } from './ArtifactImage'

beforeEach(() => {
  let sequence = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(
    () => `blob:guide-${++sequence}`,
  )
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

it('enlarges the loaded guide image and returns focus without refetching it', async () => {
  const getArtifactContent = vi.fn().mockResolvedValue(new Blob(['image']))
  const api = { getArtifactContent } as unknown as MiteApi
  const { unmount } = render(
    <ArtifactImage api={api} artifactId="step_1" alt="手順1の画面" />,
  )
  const trigger = await screen.findByRole('button', {
    name: '手順1の画面を拡大する',
  })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: '手順1の画面' })
  expect(within(dialog).getByAltText('手順1の画面の拡大表示')).toHaveAttribute(
    'src',
    within(trigger).getByRole('img').getAttribute('src'),
  )
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(trigger).toHaveFocus()
  fireEvent.click(trigger)
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(getArtifactContent).toHaveBeenCalledOnce()
  expect(URL.revokeObjectURL).not.toHaveBeenCalled()
  unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:guide-1')
})

it('closes an enlarged old step while the next image loads and handles a failed image', async () => {
  let resolveNext!: (blob: Blob) => void
  const getArtifactContent = vi
    .fn()
    .mockResolvedValueOnce(new Blob(['first']))
    .mockImplementationOnce(
      () => new Promise<Blob>((resolve) => (resolveNext = resolve)),
    )
    .mockRejectedValueOnce(new Error('unavailable'))
  const api = { getArtifactContent } as unknown as MiteApi
  const { rerender } = render(
    <ArtifactImage api={api} artifactId="step_1" alt="手順1の画面" />,
  )
  fireEvent.click(
    await screen.findByRole('button', { name: '手順1の画面を拡大する' }),
  )
  rerender(<ArtifactImage api={api} artifactId="step_2" alt="手順2の画面" />)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('画像を読み込んでいます…')).toBeInTheDocument()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:guide-1')
  await act(async () => resolveNext(new Blob(['second'])))
  fireEvent.click(screen.getByRole('button', { name: '手順2の画面を拡大する' }))
  expect(within(screen.getByRole('dialog')).getByRole('img')).toHaveAttribute(
    'src',
    'blob:guide-2',
  )
  rerender(<ArtifactImage api={api} artifactId="step_3" alt="手順3の画面" />)
  await screen.findByText('画像を表示できません')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})
