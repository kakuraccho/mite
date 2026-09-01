import type { KeyboardEvent, MouseEvent } from 'react'
import type { Marker, MockScreenId } from '../domain/types'
import { calculateMarkerRatios } from '../utils/marker'

interface MockDesktopProps {
  screenId?: MockScreenId
  marker?: Marker | null
  onPoint?: (xRatio: number, yRatio: number) => void
  compact?: boolean
}

const MailWindow = () => (
  <div className="mock-window mock-mail-window" aria-hidden="true">
    <div className="mock-window__topbar">
      <span className="mock-window__app-icon">✉</span>
      <span>おたより</span>
      <span className="mock-window__controls">— □ ×</span>
    </div>
    <div className="mock-mail">
      <aside className="mock-mail__sidebar">
        <strong>受信トレイ</strong>
        <span>大切なお知らせ</span>
        <span>あとで読む</span>
        <span>送信済み</span>
      </aside>
      <main className="mock-mail__body">
        <span className="mock-label">見本のメール</span>
        <h3>お申し込みの確認</h3>
        <p>前の画面に入力する番号をご確認ください。</p>
        <div className="mock-code">
          <small>確認番号（見本）</small>
          <strong>482 731</strong>
        </div>
        <p className="mock-muted">この画面はデモ用です。実在の情報ではありません。</p>
      </main>
    </div>
  </div>
)

const PurchaseWindow = () => (
  <div className="mock-window mock-purchase-window" aria-hidden="true">
    <div className="mock-window__topbar mock-window__topbar--blue">
      <span className="mock-window__app-icon">✈</span>
      <span>空の旅 お申し込み（見本）</span>
      <span className="mock-window__controls">— □ ×</span>
    </div>
    <div className="mock-purchase">
      <div className="mock-purchase__steps">
        <span className="is-done">1. 内容</span>
        <span className="is-current">2. 番号確認</span>
        <span>3. 完了</span>
      </div>
      <div className="mock-purchase__card">
        <span className="mock-label">見本の購入画面</span>
        <h3>確認番号を入力してください</h3>
        <div className="mock-input">番号を入力</div>
        <div className="mock-fake-button">次へ進む</div>
      </div>
    </div>
  </div>
)

const TextSizeWindow = () => (
  <div className="mock-window mock-reading-window" aria-hidden="true">
    <div className="mock-window__topbar">
      <span className="mock-window__app-icon">文</span>
      <span>読みもの（見本）</span>
      <span className="mock-window__controls">— □ ×</span>
    </div>
    <div className="mock-reading">
      <div className="mock-reading__toolbar">
        <strong>文字サイズ</strong>
        <span>小さくする</span>
        <span className="mock-reading__target">大きくする</span>
      </div>
      <h3>今日のお知らせ</h3>
      <p>ここには読みやすさを確認するための見本文が入ります。</p>
      <p>実在する記事や個人情報は使用していません。</p>
    </div>
  </div>
)

const Taskbar = ({ highlighted }: { highlighted: boolean }) => (
  <div className="mock-taskbar" aria-hidden="true">
    <span className="mock-start">◆</span>
    <span className="mock-task-icon">✉</span>
    <span
      className={`mock-task-icon mock-task-icon--plane ${highlighted ? 'is-highlighted' : ''}`}
    >
      ✈
    </span>
    <span className="mock-task-icon">▤</span>
    <span className="mock-taskbar__spacer" />
    <span className="mock-clock">10:18</span>
  </div>
)

export function MockDesktop({
  screenId = 'mock-mail-screen',
  marker = null,
  onPoint,
  compact = false,
}: MockDesktopProps) {
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!onPoint) return
    const rect = event.currentTarget.getBoundingClientRect()
    const ratios = calculateMarkerRatios(event.clientX, event.clientY, rect)
    onPoint(ratios.xRatio, ratios.yRatio)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!onPoint || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onPoint(0.36, 0.92)
  }

  const content = (
    <>
      <div className="mock-desktop__wallpaper" />
      {screenId === 'mock-purchase-screen' ? (
        <PurchaseWindow />
      ) : screenId === 'mock-text-size-screen' ? (
        <TextSizeWindow />
      ) : (
        <MailWindow />
      )}
      <Taskbar highlighted={screenId === 'mock-taskbar-screen'} />
      {marker ? (
        <span
          className="shared-marker"
          style={{
            left: `${marker.xRatio * 100}%`,
            top: `${marker.yRatio * 100}%`,
          }}
          aria-label="家族が示している場所"
        >
          <span />
        </span>
      ) : null}
    </>
  )

  if (onPoint) {
    return (
      <div
        role="button"
        tabIndex={0}
        className={`mock-desktop mock-desktop--interactive ${compact ? 'mock-desktop--compact' : ''}`}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        aria-label="祖父の共有画面。クリックすると、その場所を祖父側に示します"
      >
        {content}
      </div>
    )
  }

  return (
    <div
      className={`mock-desktop ${compact ? 'mock-desktop--compact' : ''}`}
      role="img"
      aria-label="デモ用のパソコン画面"
    >
      {content}
    </div>
  )
}
