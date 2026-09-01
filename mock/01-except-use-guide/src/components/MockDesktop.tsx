import type { KeyboardEvent, MouseEvent } from 'react'
import type { Marker } from '../domain/session'

interface MockDesktopProps {
  marker?: Marker | null
  interactive?: boolean
  compact?: boolean
  onPlaceMarker?: (x: number, y: number) => void
}

function placeMarkerFromPointer(
  event: MouseEvent<HTMLDivElement>,
  onPlaceMarker?: (x: number, y: number) => void,
) {
  if (!onPlaceMarker) return
  const bounds = event.currentTarget.getBoundingClientRect()
  const x = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))
  const y = Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height))
  onPlaceMarker(x, y)
}

function placeMarkerFromKeyboard(
  event: KeyboardEvent<HTMLDivElement>,
  onPlaceMarker?: (x: number, y: number) => void,
) {
  if (!onPlaceMarker || (event.key !== 'Enter' && event.key !== ' ')) return
  event.preventDefault()
  onPlaceMarker(0.58, 0.94)
}

export function MockDesktop({
  marker,
  interactive = false,
  compact = false,
  onPlaceMarker,
}: MockDesktopProps) {
  const interactiveProps = interactive
    ? {
        role: 'button',
        tabIndex: 0,
        'aria-label':
          'おじいちゃんの共有画面。クリックすると、その場所を示すマーカーを置きます',
        onClick: (event: MouseEvent<HTMLDivElement>) =>
          placeMarkerFromPointer(event, onPlaceMarker),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) =>
          placeMarkerFromKeyboard(event, onPlaceMarker),
      }
    : {}

  return (
    <div
      className={`mock-desktop${interactive ? ' is-interactive' : ''}${compact ? ' is-compact' : ''}`}
      {...interactiveProps}
    >
      <div className="window-chrome" aria-hidden="true">
        <div className="window-title">
          <span className="mail-app-icon">M</span>
          <span>メール</span>
        </div>
        <div className="window-actions">
          <span>—</span><span>□</span><span>×</span>
        </div>
      </div>

      <div className="mail-layout" aria-hidden="true">
        <aside className="mail-sidebar">
          <div className="mail-search">メールを検索</div>
          <div className="mail-compose">＋ 新しいメール</div>
          <ul>
            <li className="is-current"><span>▣</span> 受信トレイ <b>2</b></li>
            <li><span>☆</span> お気に入り</li>
            <li><span>◷</span> 下書き</li>
            <li><span>➤</span> 送信済み</li>
          </ul>
        </aside>

        <section className="message-list">
          <div className="message-list-heading">受信トレイ</div>
          <div className="message-item is-selected">
            <div><b>旅行予約サービス</b><time>10:14</time></div>
            <strong>認証コードのお知らせ</strong>
            <p>お手続きに必要な番号は…</p>
          </div>
          <div className="message-item">
            <div><b>まちの広報</b><time>昨日</time></div>
            <strong>9月のお知らせ</strong>
            <p>今月の催しについて…</p>
          </div>
        </section>

        <article className="message-reader">
          <div className="message-tools">← · ↩ · ▣ · ⋯</div>
          <p className="message-from">旅行予約サービス &lt;info@example.test&gt;</p>
          <h3>認証コードのお知らせ</h3>
          <p>航空券のお申し込みありがとうございます。</p>
          <div className="auth-code">
            <small>認証コード</small>
            <strong>583 291</strong>
          </div>
          <p>購入画面に戻り、上の番号を入力してください。</p>
        </article>
      </div>

      <div className="mock-taskbar" aria-hidden="true">
        <span className="taskbar-start">⊞</span>
        <span className="taskbar-search">⌕ 検索</span>
        <span className="taskbar-icon is-mail">M</span>
        <span className="taskbar-icon is-flight">✈<i>購入画面</i></span>
        <span className="taskbar-spacer" />
        <span className="taskbar-clock">10:16<br />2026/8/29</span>
      </div>

      {marker ? (
        <span
          className="screen-marker"
          style={{
            left: `clamp(26px, ${marker.x * 100}%, calc(100% - 26px))`,
            top: `clamp(26px, ${marker.y * 100}%, calc(100% - 26px))`,
          }}
          aria-label="家族が示している場所"
        >
          <span className="marker-ring" />
          <span className="marker-label">ここです</span>
        </span>
      ) : null}
    </div>
  )
}
