import { useState } from 'react'
import { useSession } from '../state/SessionContext'
import { MockDesktop } from './MockDesktop'

const grandfatherMessages = {
  idle: {
    title: 'メールで番号を確認しています',
    body: '困ったときは、画面の左端にマウスを合わせてください。',
  },
  requestDraft: {
    title: '困っている画面を家族に送ります',
    body: '今の画面と、入力したひとことが家族に届きます。',
  },
  requestSent: {
    title: '家族に送っています',
    body: 'このまま少しお待ちください。',
  },
  waitingForFamily: {
    title: '家族に送りました',
    body: '家族が見たあと、このパソコンに電話がきます。',
  },
  familyViewingRequest: {
    title: '家族が内容を見ています',
    body: '電話がくるまで、そのままお待ちください。',
  },
  incomingCall: {
    title: '家族から電話です',
    body: '下の「電話に出る」を押してください。',
  },
  connecting: {
    title: '家族とつないでいます',
    body: 'そのまま少しお待ちください。',
  },
  inSession: {
    title: '家族とつながりました',
    body: '家族の声を聞きながら、ご自分で操作してください。',
  },
  guideDecision: {
    title: '今回の案内を整理しています',
    body: '家族が終わり方を選んでいます。',
  },
  guideDraft: {
    title: '次に使うガイドを作っています',
    body: '家族が内容を整えるまでお待ちください。',
  },
  guideReview: {
    title: '次に使うガイドを確認してください',
    body: '読むだけで大丈夫です。変更は家族が行います。',
  },
  completed: {
    title: '案内は終わりました',
    body: 'この画面は閉じても大丈夫です。',
  },
} as const

function WaitingCard({ title, body }: { title: string; body: string }) {
  return (
    <div className="grandfather-overlay calm-overlay" role="status">
      <span className="large-status-icon" aria-hidden="true">✓</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

export function GrandfatherView() {
  const { state, dispatch } = useSession()
  const [isAssistPanelOpen, setIsAssistPanelOpen] = useState(false)
  const message = grandfatherMessages[state.status]
  const showDesktop = !['guideReview', 'completed'].includes(state.status)

  return (
    <section className="side-app grandfather-app" aria-labelledby="grandfather-heading">
      <header className="side-app-header">
        <div>
          <span className="eyebrow">おじいちゃん側</span>
          <h2 id="grandfather-heading">いつものパソコン</h2>
        </div>
        <span className="status-chip online-chip"><i /> オンライン</span>
      </header>

      <div className="plain-language-status" aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <div><strong>{message.title}</strong><p>{message.body}</p></div>
      </div>

      <div className="grandfather-stage">
        {showDesktop ? <MockDesktop marker={state.marker} /> : null}

        {state.status === 'idle' ? (
          <div className={`assist-edge${isAssistPanelOpen ? ' is-open' : ''}`}>
            <button
              className="edge-handle"
              type="button"
              aria-label="困ったときのメニューを表示する"
              aria-controls="assist-panel"
              aria-expanded={isAssistPanelOpen}
              onClick={() => setIsAssistPanelOpen((isOpen) => !isOpen)}
            >
              <span aria-hidden="true" />
            </button>
            <div className="assist-panel" id="assist-panel">
              <div className="mite-mini-mark" aria-hidden="true">m</div>
              <p><strong>お困りですか？</strong><br />今の画面を家族に送れます。</p>
              <button
                className="primary-button large-button"
                onClick={() => {
                  setIsAssistPanelOpen(false)
                  dispatch({ type: 'OPEN_REQUEST_PANEL' })
                }}
              >
                困りごとを記録する
              </button>
            </div>
          </div>
        ) : null}

        {state.status === 'requestDraft' ? (
          <form
            className="grandfather-overlay request-form"
            onSubmit={(event) => {
              event.preventDefault()
              dispatch({
                type: 'SUBMIT_SUPPORT_REQUEST',
                createdAt: new Date().toISOString(),
              })
            }}
          >
            <span className="mock-label">画面の記録（モック）</span>
            <h3>今の画面を記録しました</h3>
            <p>家族に伝えたいことがあれば、下に書いてください。書かなくても送れます。</p>
            <div className="request-snapshot" aria-label="記録したメール画面の見本">
              <MockDesktop compact />
            </div>
            <label htmlFor="request-comment">家族へのひとこと <span>任意</span></label>
            <textarea
              id="request-comment"
              rows={3}
              value={state.requestComment}
              onChange={(event) =>
                dispatch({
                  type: 'UPDATE_REQUEST_COMMENT',
                  comment: event.target.value,
                })
              }
            />
            <button className="primary-button large-button" type="submit">
              この内容を家族に送る
            </button>
          </form>
        ) : null}

        {['requestSent', 'waitingForFamily', 'familyViewingRequest'].includes(
          state.status,
        ) ? (
          <WaitingCard title={message.title} body={message.body} />
        ) : null}

        {state.status === 'incomingCall' ? (
          <div className="grandfather-overlay incoming-card" role="alert">
            <div className="incoming-avatar" aria-hidden="true">家</div>
            <span className="ringing-label">♪ 電話がきています</span>
            <h3>家族から電話です</h3>
            <p>実際の音声は流れません。電話に出る操作を試せます。</p>
            <button
              className="primary-button call-button large-button"
              onClick={() => dispatch({ type: 'ACCEPT_CALL' })}
            >
              <span aria-hidden="true">☎</span> 電話に出る
            </button>
          </div>
        ) : null}

        {state.status === 'connecting' ? (
          <div className="grandfather-overlay calm-overlay" role="status">
            <span className="connecting-spinner" aria-hidden="true" />
            <h3>家族とつないでいます</h3>
            <p>まもなく話せるようになります（モック）。</p>
          </div>
        ) : null}

        {state.status === 'inSession' ? (
          <div className="call-strip" role="status">
            <span className="call-live-icon" aria-hidden="true">☎</span>
            <div><strong>家族と通話中</strong><small>画面を家族に見せています（モック）</small></div>
          </div>
        ) : null}

        {['guideDecision', 'guideDraft'].includes(state.status) ? (
          <WaitingCard title={message.title} body={message.body} />
        ) : null}

        {state.status === 'guideReview' && state.guide ? (
          <article className="guide-preview grandfather-guide" aria-live="polite">
            <span className="mock-label">次回用のガイド</span>
            <h3>{state.guide.title}</h3>
            <ol>
              {state.guide.steps.map((step, index) => (
                <li key={`${index}-${step}`}><span>{index + 1}</span><p>{step}</p></li>
              ))}
            </ol>
            <div className="read-only-note">見るだけの画面です。家族が保存するまでお待ちください。</div>
          </article>
        ) : null}

        {state.status === 'completed' ? (
          <div className="completion-card" role="status">
            <span className="completion-check" aria-hidden="true">✓</span>
            <h3>案内は終わりました</h3>
            <p>{state.guide ? '次に見られるガイドも保存されました。' : '今回はガイドを作らずに終了しました。'}</p>
            <small>もう一度試すときは、下の開発用表示から最初に戻せます。</small>
          </div>
        ) : null}
      </div>
    </section>
  )
}
