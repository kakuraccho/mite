import { useEffect, useState } from 'react'
import { Button, EmptyState, Notice } from '@mite/ui'
import type { ScreenSourceSummary, UserDesktopBridge } from './desktop'

export interface ScreenSourcePickerProps {
  desktop: UserDesktopBridge
  selectedId: string | null
  disabled?: boolean
  onSelect(source: ScreenSourceSummary): void
}

export function ScreenSourcePicker({
  desktop,
  selectedId,
  disabled = false,
  onSelect,
}: ScreenSourcePickerProps) {
  const [sources, setSources] = useState<ScreenSourceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      setSources(await desktop.listScreenSources())
    } catch {
      setError('画面の一覧を開けませんでした。もう一度試してください。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    void desktop
      .listScreenSources()
      .then((next) => {
        if (active) setSources(next)
      })
      .catch(() => {
        if (active) {
          setError('画面の一覧を開けませんでした。もう一度試してください。')
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [desktop])

  if (loading) return <p role="status">画面の一覧を準備しています…</p>
  if (error) {
    return (
      <Notice tone="danger" title={error}>
        <Button variant="secondary" onClick={() => void load()}>
          もう一度試す
        </Button>
      </Notice>
    )
  }
  if (sources.length === 0) {
    return (
      <EmptyState
        symbol="□"
        title="選べる画面がありません"
        description="相談したい画面を開いてから、一覧を更新してください。"
        action={
          <Button variant="secondary" onClick={() => void load()}>
            一覧を更新する
          </Button>
        }
      />
    )
  }

  return (
    <div
      className="user-source-grid"
      role="radiogroup"
      aria-label="共有する画面"
    >
      {sources.map((source) => (
        <button
          className="user-source-card"
          data-selected={source.id === selectedId}
          aria-checked={source.id === selectedId}
          role="radio"
          type="button"
          disabled={disabled}
          key={source.id}
          onClick={() => onSelect(source)}
        >
          <img src={source.thumbnailDataUrl} alt="" />
          <span>{source.name}</span>
          <strong>
            {source.id === selectedId ? '選択中' : 'この画面を選ぶ'}
          </strong>
        </button>
      ))}
    </div>
  )
}
