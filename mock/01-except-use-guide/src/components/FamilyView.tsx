import { useSession } from '../state/SessionContext'
import { MockDesktop } from './MockDesktop'

function formatRecordedAt(value?: string) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))
}

function EmptyFamilyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="family-empty" role="status">
      <span aria-hidden="true">◎</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  )
}

export function FamilyView() {
  const { state, dispatch } = useSession()

  return (
    <section className="side-app family-app" aria-labelledby="family-heading">
      <header className="side-app-header family-header">
        <div>
          <span className="eyebrow">家族側</span>
          <h2 id="family-heading">Mite サポート</h2>
        </div>
        <div className="family-person-status">
          <span className="person-avatar" aria-hidden="true">祖</span>
          <span><small>おじいちゃん</small><strong><i /> オンライン</strong></span>
        </div>
      </header>

      <div className="family-content">
        {state.status === 'idle' ? (
          <EmptyFamilyState title="新しい支援依頼はありません" body="依頼が届くと、ここに内容が表示されます。" />
        ) : null}

        {state.status === 'requestDraft' ? (
          <EmptyFamilyState title="おじいちゃんが依頼を準備中です" body="まだ家族側には内容は届いていません。" />
        ) : null}

        {state.status === 'requestSent' ? (
          <div className="delivery-card" role="status">
            <span className="connecting-spinner" aria-hidden="true" />
            <h3>支援依頼が届いています…</h3>
            <p>通知の到着をモックで表現しています。</p>
          </div>
        ) : null}

        {state.status === 'waitingForFamily' ? (
          <article className="notification-card">
            <div className="notification-heading">
              <span className="notification-icon" aria-hidden="true">!</span>
              <div><span className="eyebrow">新しい支援依頼</span><h3>画面の操作で困っています</h3></div>
              <span className="new-badge">未確認</span>
            </div>
            <p>「{state.request?.comment || 'ひとことはありません'}」</p>
            <button
              className="primary-button"
              onClick={() => dispatch({ type: 'VIEW_SUPPORT_REQUEST' })}
            >
              依頼の内容を見る
            </button>
          </article>
        ) : null}

        {state.status === 'familyViewingRequest' && state.request ? (
          <article className="request-detail">
            <div className="section-heading-row">
              <div><span className="eyebrow">支援依頼</span><h3>元の購入画面へ戻れない</h3></div>
              <span className="status-chip online-chip"><i /> オンライン</span>
            </div>
            <dl className="request-meta">
              <div><dt>記録した時刻</dt><dd>{formatRecordedAt(state.request.createdAt)}</dd></div>
              <div><dt>画面</dt><dd>メールを開いています</dd></div>
            </dl>
            <div className="request-comment">
              <small>おじいちゃんからのひとこと</small>
              <p>「{state.request.comment || 'ひとことはありません'}」</p>
            </div>
            <div className="screenshot-preview">
              <span className="mock-label">記録された画面（モック）</span>
              <MockDesktop compact />
            </div>
            <button
              className="primary-button call-button"
              onClick={() => dispatch({ type: 'START_CALL' })}
            >
              <span aria-hidden="true">☎</span> おじいちゃんに電話する
            </button>
          </article>
        ) : null}

        {state.status === 'incomingCall' ? (
          <div className="outgoing-call-card" role="status">
            <span className="person-avatar large-avatar" aria-hidden="true">祖</span>
            <span className="ringing-label">呼び出しています</span>
            <h3>おじいちゃんの応答を待っています</h3>
            <p>おじいちゃん側で「電話に出る」を押してください。</p>
            <div className="sound-wave" aria-hidden="true"><i /><i /><i /><i /><i /></div>
          </div>
        ) : null}

        {state.status === 'connecting' ? (
          <div className="delivery-card" role="status">
            <span className="connecting-spinner" aria-hidden="true" />
            <h3>画面共有を準備しています</h3>
            <p>実際の通信は行わないモック接続です。</p>
          </div>
        ) : null}

        {state.status === 'inSession' ? (
          <article className="support-session">
            <div className="session-toolbar">
              <div className="live-call-status"><span aria-hidden="true">☎</span><div><strong>通話中・画面共有中</strong><small>音声と画面はモックです</small></div></div>
              <button className="danger-button" onClick={() => dispatch({ type: 'END_SUPPORT' })}>支援を終了する</button>
            </div>
            <div className="shared-screen-heading">
              <div><h3>おじいちゃんの画面</h3><p>案内したい場所をクリックしてください。</p></div>
              <span className="marker-tool"><i /> マーカー</span>
            </div>
            <MockDesktop
              marker={state.marker}
              interactive
              onPlaceMarker={(x, y) =>
                dispatch({ type: 'PLACE_MARKER', x, y })
              }
            />
            <p className="marker-help">クリックは操作を代行せず、同じ場所に「ここです」と表示するだけです。</p>
          </article>
        ) : null}

        {state.status === 'guideDecision' ? (
          <div className="guide-decision-card">
            <span className="decision-icon" aria-hidden="true">▤</span>
            <span className="eyebrow">支援を終了します</span>
            <h3>今回の案内をガイドに残しますか？</h3>
            <p>次に同じことで困ったとき、おじいちゃんが見返せる手順を残せます。</p>
            <div className="decision-actions">
              <button className="primary-button" onClick={() => dispatch({ type: 'CHOOSE_CREATE_GUIDE' })}>ガイドを作成する</button>
              <button className="secondary-button" onClick={() => dispatch({ type: 'CHOOSE_SKIP_GUIDE' })}>作成せず終了する</button>
            </div>
            <small>ガイドは固定のひな形から作るモックです。AIは使用しません。</small>
          </div>
        ) : null}

        {state.status === 'guideDraft' && state.guide ? (
          <article className="guide-editor">
            <div className="section-heading-row">
              <div><span className="eyebrow">仮ガイド（モック生成済み）</span><h3>内容を整える</h3></div>
              <span className="draft-badge">下書き</span>
            </div>
            <p className="editor-intro">記録した体の画面から固定のひな形を用意しました。必要な箇所だけ編集してください。</p>
            <label htmlFor="guide-title">ガイドのタイトル</label>
            <input
              id="guide-title"
              value={state.guide.title}
              onChange={(event) => dispatch({ type: 'UPDATE_GUIDE_TITLE', title: event.target.value })}
            />
            <fieldset>
              <legend>手順</legend>
              {state.guide.steps.map((step, index) => (
                <label className="guide-step-input" key={index}>
                  <span>{index + 1}</span>
                  <textarea
                    rows={2}
                    value={step}
                    onChange={(event) => dispatch({ type: 'UPDATE_GUIDE_STEP', index, text: event.target.value })}
                    aria-label={`手順 ${index + 1}`}
                  />
                </label>
              ))}
            </fieldset>
            <button className="primary-button" onClick={() => dispatch({ type: 'BEGIN_GUIDE_REVIEW' })}>おじいちゃんに確認してもらう</button>
          </article>
        ) : null}

        {state.status === 'guideReview' && state.guide ? (
          <article className="family-review">
            <div className="review-notice"><span aria-hidden="true">👁</span><div><strong>おじいちゃん側にも表示中</strong><p>おじいちゃんは読み取り専用で確認しています。</p></div></div>
            <div className="guide-preview">
              <span className="mock-label">保存前のガイド</span>
              <h3>{state.guide.title}</h3>
              <ol>{state.guide.steps.map((step, index) => <li key={index}><span>{index + 1}</span><p>{step}</p></li>)}</ol>
            </div>
            <button className="primary-button" onClick={() => dispatch({ type: 'SAVE_GUIDE' })}>ガイドを保存して終了する</button>
          </article>
        ) : null}

        {state.status === 'completed' ? (
          <div className="completion-card family-completion" role="status">
            <span className="completion-check" aria-hidden="true">✓</span>
            <span className="eyebrow">支援終了</span>
            <h3>おつかれさまでした</h3>
            <p>{state.guide ? 'ガイドを保存し、接続を終了しました。' : 'ガイドを作成せず、接続を終了しました。'}</p>
            <small>もう一度試す場合は、下の開発用表示からリセットしてください。</small>
          </div>
        ) : null}
      </div>
    </section>
  )
}
