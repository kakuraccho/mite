import { sessionStatusLabels } from '../domain/session'
import { useSession } from '../state/SessionContext'

export function DeveloperPanel() {
  const { state, dispatch } = useSession()

  return (
    <aside className="developer-panel" aria-labelledby="developer-panel-title">
      <div className="developer-heading">
        <div>
          <span className="dev-tag">DEV</span>
          <div>
            <h2 id="developer-panel-title">状態遷移を確認</h2>
            <p>仕様探索用の表示です。利用者向け画面には含めません。</p>
          </div>
        </div>
        <button
          className="reset-button"
          onClick={() => dispatch({ type: 'RESET_DEMO' })}
        >
          ↻ 最初からやり直す
        </button>
      </div>

      <div className="developer-content">
        <div className="current-state">
          <small>現在の状態</small>
          <strong>{state.status}</strong>
          <span>{sessionStatusLabels[state.status]}</span>
        </div>
        <div className="recent-events">
          <small>直近イベント</small>
          {state.eventLog.length ? (
            <ol>
              {state.eventLog.slice(-6).map((eventName, index) => (
                <li key={`${eventName}-${index}`}>
                  <span>{state.eventLog.length - Math.min(6, state.eventLog.length) + index + 1}</span>
                  <code>{eventName}</code>
                </li>
              ))}
            </ol>
          ) : (
            <p>まだイベントはありません</p>
          )}
        </div>
      </div>
    </aside>
  )
}
