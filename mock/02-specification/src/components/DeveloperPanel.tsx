import { SCENARIO_DESCRIPTIONS } from '../domain/fixtures'
import { useMite } from '../state/useMite'
import { StatusPill } from './SharedUi'

const STATE_LABELS = {
  idle: '待機',
  draft: '記録入力',
  matching: 'ガイド照合中',
  pending: '依頼待ち',
  viewed: '家族が確認済み',
  closed: '依頼終了',
  ringing: '呼び出し中',
  connecting: '接続中',
  supporting: '支援中',
  guideDecision: 'ガイド作成判断',
  guideGenerating: 'ガイド生成中',
  guideReview: 'ガイド確認中',
  ended: '接続終了',
  browsing: 'ガイド一覧',
  running: 'ガイド利用中',
  completed: 'ガイド完了',
  fallback: '支援へ切替中',
} as const

const SCENARIO_HINTS = {
  A: ['困りごとを記録', '家族が発信・支援', 'ガイドを編集して保存'],
  B: ['困りごとを記録', '似たガイドへ移動', '最後まで進めて完了'],
  C: ['「ガイドを見る」を開く', '主ガイドを選択', '前後移動して完了'],
  D: ['ガイドを開始', '「家族に相談する」', '記録を送って家族側で確認'],
} as const

export function DeveloperPanel() {
  const { state, dispatch } = useMite()
  const description = SCENARIO_DESCRIPTIONS[state.settings.scenario]
  const requestState = state.supportRequest?.status ?? 'idle'

  return (
    <aside className="developer-panel" aria-label="デモ操作パネル">
      <header className="developer-panel__header">
        <div>
          <span className="developer-kicker">DEMO CONTROLS</span>
          <h2>Scenario {state.settings.scenario}</h2>
          <p>{description.title}</p>
        </div>
        <StatusPill tone="active">実装確認中</StatusPill>
      </header>

      <section className="scenario-brief">
        <span>{state.settings.scenario}</span>
        <div>
          <strong>{description.title}</strong>
          <p>{description.summary}</p>
        </div>
      </section>

      <section className="developer-section">
        <h3>シナリオ選択</h3>
        <label className="select-field select-field--scenario">
          <span>確認する正常系</span>
          <select
            value={state.settings.scenario}
            onChange={(event) =>
              dispatch({
                type: 'SET_SCENARIO',
                scenario: event.target.value as 'A' | 'B' | 'C' | 'D',
              })
            }
          >
            <option value="A">A — 支援してガイドを作る</option>
            <option value="B">B — 似たガイドで解決</option>
            <option value="C">C — 一覧からガイドを使う</option>
            <option value="D">D — 途中から家族に相談</option>
          </select>
        </label>
        <ol className="scenario-hints">
          {SCENARIO_HINTS[state.settings.scenario].map((hint, index) => (
            <li key={hint}>
              <span>{index + 1}</span>
              {hint}
            </li>
          ))}
        </ol>
      </section>

      <section className="developer-section">
        <h3>モック設定</h3>
        <label className="select-field">
          <span>類似ガイド</span>
          <select
            value={state.settings.matchMode}
            onChange={(event) =>
              dispatch({
                type: 'SET_MATCH_MODE',
                matchMode: event.target.value as 'match' | 'no-match',
              })
            }
          >
            <option value="no-match">なし（家族へ依頼）</option>
            <option value="match">あり（ガイドへ移動）</option>
          </select>
        </label>
        <label className="toggle-row">
          <span>
            <strong>祖父の状態</strong>
            <small>
              {state.settings.grandfatherOnline
                ? 'オンライン'
                : 'オフライン'}
            </small>
          </span>
          <input
            type="checkbox"
            checked={state.settings.grandfatherOnline}
            onChange={(event) =>
              dispatch({
                type: 'SET_GRANDFATHER_ONLINE',
                online: event.target.checked,
              })
            }
          />
        </label>
        <label className="toggle-row">
          <span>
            <strong>待ち時間を短縮</strong>
            <small>照合・接続・生成のみ</small>
          </span>
          <input
            type="checkbox"
            checked={state.settings.fastMode}
            onChange={(event) =>
              dispatch({ type: 'SET_FAST_MODE', fastMode: event.target.checked })
            }
          />
        </label>
      </section>

      <section className="developer-section">
        <h3>現在の主要状態</h3>
        <dl className="state-grid">
          <div>
            <dt>支援依頼</dt>
            <dd>{STATE_LABELS[requestState]}</dd>
          </div>
          <div>
            <dt>支援接続</dt>
            <dd>{STATE_LABELS[state.supportSession.status]}</dd>
          </div>
          <div>
            <dt>ガイド利用</dt>
            <dd>{STATE_LABELS[state.guideRun.status]}</dd>
          </div>
          <div>
            <dt>公開ガイド</dt>
            <dd>{state.guides.filter((guide) => guide.status === 'published').length}件</dd>
          </div>
        </dl>
      </section>

      <section className="developer-section developer-events">
        <div className="developer-section__heading">
          <h3>直近イベント</h3>
          <small>最大12件</small>
        </div>
        <ol>
          {state.eventLog.map((item) => (
            <li key={item.id}>
              <span>{item.logicalTime}</span>
              <div>
                <code>{item.event}</code>
                <p>{item.label}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <button
        type="button"
        className="reset-button"
        onClick={() => dispatch({ type: 'RESET_DEMO' })}
      >
        ↻ Scenario {state.settings.scenario}をリセット
      </button>
      <p className="developer-note">
        この領域はデモ操作専用です。実際の祖父・家族向け画面には表示しません。
      </p>
    </aside>
  )
}
