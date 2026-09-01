import { FAMILY, GRANDFATHER } from '../domain/fixtures'
import { formatRequestTime } from '../services/mockMiteService'
import { useMite } from '../state/useMite'
import { MockDesktop } from './MockDesktop'
import {
  ProgressCard,
  ScreenPreview,
  StatusPill,
  ViewFrame,
} from './SharedUi'

function EmptyInbox() {
  const { state } = useMite()
  return (
    <div className="family-home">
      <section className="family-summary-card">
        <div>
          <span className="eyebrow">今日のMite</span>
          <h3>新しい支援依頼はありません</h3>
          <p>依頼が届くと、ここに画面とコメントが表示されます。</p>
        </div>
        <div className="empty-inbox-symbol" aria-hidden="true">
          ✓
        </div>
      </section>
      <section className="family-person-card">
        <div className="person-avatar">祖</div>
        <div>
          <strong>{GRANDFATHER.displayName}</strong>
          <StatusPill
            tone={state.settings.grandfatherOnline ? 'online' : 'neutral'}
          >
            {state.settings.grandfatherOnline ? '● オンライン' : '○ オフライン'}
          </StatusPill>
        </div>
        <small>困りごとが届くまで待機中</small>
      </section>
      <div className="family-empty-illustration" aria-hidden="true">
        <span>✉</span>
        <i />
        <i />
      </div>
    </div>
  )
}

function NewRequestNotification() {
  const { state, dispatch } = useMite()
  const request = state.supportRequest
  if (!request) return null

  return (
    <div className="family-home">
      <div className="in-app-notification" role="status" aria-live="polite">
        <span className="notification-dot" aria-hidden="true" />
        新しい支援依頼が届きました
      </div>
      <section className="request-list-card request-list-card--new">
        <header>
          <div>
            <StatusPill tone="active">新着</StatusPill>
            <span>{formatRequestTime(request.createdAt)}</span>
          </div>
          <StatusPill
            tone={state.settings.grandfatherOnline ? 'online' : 'neutral'}
          >
            {state.settings.grandfatherOnline
              ? '● 祖父はオンライン'
              : '○ 祖父はオフライン'}
          </StatusPill>
        </header>
        <div className="request-list-card__body">
          <MockDesktop screenId={request.screenshotId} compact />
          <div>
            <span className="eyebrow">{GRANDFATHER.displayName}から</span>
            <h3>{request.comment || 'コメントはありません'}</h3>
            <p>困ったときの画面が一緒に記録されています。</p>
          </div>
        </div>
        <button
          type="button"
          className="button button--primary button--large button--block"
          onClick={() => dispatch({ type: 'VIEW_SUPPORT_REQUEST' })}
        >
          依頼の内容を見る
        </button>
      </section>
    </div>
  )
}

function RequestDetail() {
  const { state, dispatch } = useMite()
  const request = state.supportRequest
  if (!request) return null

  return (
    <div className="family-workspace">
      <header className="family-workspace__heading">
        <div>
          <span className="eyebrow">支援依頼の詳細</span>
          <h3>{GRANDFATHER.displayName}が困っています</h3>
        </div>
        <StatusPill
          tone={state.settings.grandfatherOnline ? 'online' : 'neutral'}
        >
          {state.settings.grandfatherOnline
            ? '● オンライン — 発信できます'
            : '○ オフライン — 発信できません'}
        </StatusPill>
      </header>
      <div className="request-detail-grid">
        <ScreenPreview
          screenId={request.screenshotId}
          caption="困ったときに記録された見本画面"
        />
        <section className="request-information">
          <dl>
            <div>
              <dt>記録した時刻</dt>
              <dd>{formatRequestTime(request.createdAt)}</dd>
            </div>
            <div>
              <dt>祖父からのコメント</dt>
              <dd>{request.comment || 'コメントはありません'}</dd>
            </div>
            {request.guideContext ? (
              <div>
                <dt>見ていたガイド</dt>
                <dd>
                  {request.guideContext.guideTitle}
                  <small>手順 {request.guideContext.stepNumber} から相談</small>
                </dd>
              </div>
            ) : null}
          </dl>
          {!state.settings.grandfatherOnline ? (
            <p className="offline-note" role="status">
              祖父がオンラインになると電話をかけられます。
            </p>
          ) : null}
          <button
            type="button"
            className="button button--call button--xl button--block"
            disabled={!state.settings.grandfatherOnline}
            onClick={() => dispatch({ type: 'START_CALL' })}
          >
            <span aria-hidden="true">☎</span>
            電話をかける
          </button>
          <small className="mock-disclaimer">
            音声通話は行わず、画面上の状態だけが切り替わります。
          </small>
        </section>
      </div>
    </div>
  )
}

function Calling() {
  return (
    <div className="family-centered-state" role="status">
      <div className="calling-avatar">
        <span className="calling-ring calling-ring--one" />
        <span className="calling-ring calling-ring--two" />
        <span>祖</span>
      </div>
      <StatusPill tone="active">発信中</StatusPill>
      <h3>{GRANDFATHER.displayName}を呼び出しています</h3>
      <p>祖父が「電話に出る」を押すまでお待ちください。</p>
      <div className="call-progress">
        <span className="is-active" />
        <span />
        <span />
      </div>
      <small>実際の音声は使っていません</small>
    </div>
  )
}

function SupportWorkspace() {
  const { state, dispatch } = useMite()
  const request = state.supportRequest
  if (!request) return null
  const lastCapture = state.supportSession.mockCaptureTimes.at(-1)

  return (
    <div className="live-support">
      <header className="live-support__header">
        <div>
          <StatusPill tone="active">● 会話中</StatusPill>
          <h3>{GRANDFATHER.displayName}の画面を見ています</h3>
          <p>画面内をクリックすると、その場所に丸印を出せます。</p>
        </div>
        <button
          type="button"
          className="button button--resolved"
          disabled={state.supportSession.mockCaptureCount < 1}
          onClick={() => dispatch({ type: 'FINISH_PROBLEM_SOLVING' })}
        >
          <span aria-hidden="true">✓</span>
          問題を解決した
        </button>
      </header>
      <div className="live-support__screen">
        <div className="live-support__hint">
          <span aria-hidden="true">◎</span>
          クリックして見る場所を示す
        </div>
        <MockDesktop
          screenId={request.screenshotId}
          marker={state.supportSession.marker}
          onPoint={(xRatio, yRatio) =>
            dispatch({ type: 'PLACE_MARKER', xRatio, yRatio })
          }
        />
      </div>
      <footer className="live-support__footer">
        <div>
          <span className="record-dot" aria-hidden="true" />
          <span>
            <strong>支援内容を記録しています</strong>
            <small>5秒ごとに、件数と時刻だけを残すデモです</small>
          </span>
        </div>
        <div className="capture-count">
          <strong>{state.supportSession.mockCaptureCount}</strong>
          <span>
            件記録
            <small>{lastCapture ? `最終 ${lastCapture}` : '最初の記録を待っています'}</small>
          </span>
        </div>
      </footer>
      {state.supportSession.mockCaptureCount < 1 ? (
        <p className="capture-wait-note" role="status">
          最初の記録ができると「問題を解決した」を押せます。
        </p>
      ) : null}
    </div>
  )
}

function GuideDecision() {
  const { state, dispatch } = useMite()
  return (
    <div className="family-centered-state guide-decision">
      <div className="success-symbol success-symbol--large" aria-hidden="true">
        ✓
      </div>
      <span className="eyebrow">支援が終わりました</span>
      <h3>今回の内容からガイドを作成しますか？</h3>
      <p>
        支援中に記録した{state.supportSession.mockCaptureCount}
        件の情報をもとに、次回使える手順を準備できます。
      </p>
      <div className="decision-grid">
        <button
          type="button"
          className="decision-card decision-card--primary"
          onClick={() => dispatch({ type: 'CHOOSE_CREATE_GUIDE' })}
        >
          <span aria-hidden="true">▤</span>
          <strong>ガイドを作成する</strong>
          <small>固定テンプレートから下書きを準備します</small>
        </button>
        <button
          type="button"
          className="decision-card"
          onClick={() => dispatch({ type: 'CHOOSE_SKIP_GUIDE' })}
        >
          <span aria-hidden="true">→</span>
          <strong>作成せず終了する</strong>
          <small>このまま支援を終わります</small>
        </button>
      </div>
    </div>
  )
}

function EditableGuideReview() {
  const { state, dispatch } = useMite()
  const guide = state.draftGuide
  if (!guide) return null
  const step = guide.steps[state.reviewStepIndex]
  const isFirst = state.reviewStepIndex === 0
  const isLast = state.reviewStepIndex === guide.steps.length - 1

  return (
    <div className="family-guide-editor">
      <header className="family-guide-editor__header">
        <div>
          <span className="eyebrow">仮ガイドを確認・編集</span>
          <h3>必要なところだけ直してください</h3>
          <p>変更は祖父側のプレビューへすぐ反映されます。</p>
        </div>
        <StatusPill tone="waiting">下書き</StatusPill>
      </header>
      <label className="field-label" htmlFor="guide-title">
        ガイドのタイトル
      </label>
      <input
        id="guide-title"
        className="title-input"
        value={guide.title}
        onChange={(event) =>
          dispatch({ type: 'UPDATE_GUIDE_TITLE', title: event.target.value })
        }
      />
      <div className="guide-editor-grid">
        <ScreenPreview
          screenId={step.imageId}
          caption={`STEP ${state.reviewStepIndex + 1} / ${guide.steps.length}`}
        />
        <div className="guide-editor-fields">
          <div className="editor-step-heading">
            <span>{state.reviewStepIndex + 1}</span>
            <div>
              <small>現在の手順</small>
              <strong>
                STEP {state.reviewStepIndex + 1} / {guide.steps.length}
              </strong>
            </div>
          </div>
          <label className="field-label" htmlFor="guide-instruction">
            この手順の説明
          </label>
          <textarea
            id="guide-instruction"
            rows={4}
            value={step.instruction}
            onChange={(event) =>
              dispatch({
                type: 'UPDATE_GUIDE_STEP',
                instruction: event.target.value,
              })
            }
          />
          <div className="guide-editor-navigation">
            <button
              type="button"
              className="button button--quiet"
              disabled={isFirst}
              onClick={() =>
                dispatch({
                  type: 'GO_TO_GUIDE_REVIEW_STEP',
                  direction: 'previous',
                })
              }
            >
              ← 前へ
            </button>
            <div className="step-dots" aria-label="ガイドのページ位置">
              {guide.steps.map((guideStep, index) => (
                <span
                  key={guideStep.id}
                  className={index === state.reviewStepIndex ? 'is-active' : ''}
                />
              ))}
            </div>
            <button
              type="button"
              className="button button--quiet"
              disabled={isLast}
              onClick={() =>
                dispatch({
                  type: 'GO_TO_GUIDE_REVIEW_STEP',
                  direction: 'next',
                })
              }
            >
              次へ →
            </button>
          </div>
        </div>
      </div>
      <footer className="family-guide-editor__footer">
        <span>全{guide.steps.length}手順・祖父側は読み取り専用</span>
        <button
          type="button"
          className="button button--primary button--xl"
          disabled={!guide.title.trim() || guide.steps.some((item) => !item.instruction.trim())}
          onClick={() => dispatch({ type: 'SAVE_GUIDE' })}
        >
          <span aria-hidden="true">✓</span>
          保存する
        </button>
      </footer>
    </div>
  )
}

function EndedState() {
  const { state } = useMite()
  const saved = state.lastSessionOutcome === 'guideSaved'
  return (
    <div className="family-centered-state" role="status">
      <div className="success-symbol success-symbol--large" aria-hidden="true">
        ✓
      </div>
      <span className="eyebrow">接続を終了しました</span>
      <h3>{saved ? 'ガイドを保存しました' : '支援を終了しました'}</h3>
      <p>
        {saved
          ? '保存したガイドは、祖父側の「ガイドを見る」から使えます。'
          : '祖父側もいつもの画面に戻っています。'}
      </p>
      <StatusPill tone="complete">完了</StatusPill>
    </div>
  )
}

export function FamilyView() {
  const { state } = useMite()
  const requestStatus = state.supportRequest?.status
  const sessionStatus = state.supportSession.status

  let content = <EmptyInbox />

  if (requestStatus === 'pending') content = <NewRequestNotification />
  if (
    requestStatus === 'viewed' &&
    (sessionStatus === 'idle' || sessionStatus === 'ended')
  ) {
    content = <RequestDetail />
  }
  if (sessionStatus === 'ringing') content = <Calling />
  if (sessionStatus === 'connecting') {
    content = (
      <div className="family-progress-wrap">
        <ProgressCard eyebrow="祖父が応答しました" title="接続しています">
          <p>共有する見本画面を準備しています。</p>
        </ProgressCard>
      </div>
    )
  }
  if (sessionStatus === 'supporting') content = <SupportWorkspace />
  if (sessionStatus === 'guideDecision') content = <GuideDecision />
  if (sessionStatus === 'guideGenerating') {
    content = (
      <div className="family-progress-wrap">
        <ProgressCard eyebrow="固定テンプレートを使用" title="ガイドを準備しています">
          <p>実際のAIや画像解析は使用していません。</p>
        </ProgressCard>
      </div>
    )
  }
  if (sessionStatus === 'guideReview') content = <EditableGuideReview />
  if (sessionStatus === 'ended' && requestStatus === 'closed') {
    content = <EndedState />
  }

  return (
    <ViewFrame audience="family" name={FAMILY.displayName}>
      <div className="family-surface">{content}</div>
    </ViewFrame>
  )
}
