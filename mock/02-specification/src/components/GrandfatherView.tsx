import { useEffect, useRef, useState, type RefObject } from 'react'
import { FAMILY, GRANDFATHER } from '../domain/fixtures'
import type { Guide } from '../domain/types'
import { useMite } from '../state/useMite'
import { MockDesktop } from './MockDesktop'
import {
  ProgressCard,
  ScreenPreview,
  StatusPill,
  ViewFrame,
} from './SharedUi'

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function useStandaloneModalFocus(
  surfaceRef: RefObject<HTMLDivElement | null>,
  modalKey: string | null,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled || !modalKey) return
    const modal = surfaceRef.current?.querySelector<HTMLElement>('.modal-layer')
    if (!modal) return

    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
    const focusables = () =>
      [...modal.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => !element.hasAttribute('disabled'),
      )
    const initialTarget =
      modal.querySelector<HTMLElement>('[autofocus]') ??
      focusables()[0] ??
      modal.querySelector<HTMLElement>(
        '[role="dialog"], [role="alertdialog"], [role="status"], section',
      ) ??
      modal

    const hadTabIndex = initialTarget.hasAttribute('tabindex')
    if (!hadTabIndex && !initialTarget.matches(FOCUSABLE_SELECTOR)) {
      initialTarget.setAttribute('tabindex', '-1')
    }
    if (!modal.contains(document.activeElement)) initialTarget.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusables()
      if (items.length === 0) {
        event.preventDefault()
        initialTarget.focus()
        return
      }
      const first = items[0]
      const last = items.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    modal.addEventListener('keydown', handleKeyDown)
    return () => {
      modal.removeEventListener('keydown', handleKeyDown)
      if (!hadTabIndex) initialTarget.removeAttribute('tabindex')
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [enabled, modalKey, surfaceRef])
}

function EdgeLauncher({ disabled }: { disabled: boolean }) {
  const { dispatch } = useMite()
  const [announced, setAnnounced] = useState(false)

  const announceOpen = () => {
    if (announced) return
    setAnnounced(true)
    dispatch({ type: 'OPEN_EDGE_PANEL' })
  }

  return (
    <aside
      className="edge-launcher"
      aria-label="Miteメニュー"
      onMouseEnter={announceOpen}
      onMouseLeave={() => setAnnounced(false)}
      onFocus={announceOpen}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setAnnounced(false)
      }}
    >
      <div className="edge-launcher__rail">
        <span className="edge-launcher__dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="edge-launcher__vertical-label">Mite</span>
      </div>
      <div className="edge-launcher__panel">
        <span className="eyebrow">困ったときのメニュー</span>
        <strong>どうしますか？</strong>
        <button
          type="button"
          className="edge-action edge-action--primary"
          disabled={disabled}
          onClick={() => dispatch({ type: 'START_SUPPORT_REQUEST' })}
        >
          <span aria-hidden="true">◎</span>
          <span>
            困りごとを記録する
            <small>今の画面を家族に伝えます</small>
          </span>
        </button>
        <button
          type="button"
          className="edge-action"
          disabled={disabled}
          onClick={() => dispatch({ type: 'OPEN_GUIDE_LIST' })}
        >
          <span aria-hidden="true">▤</span>
          <span>
            ガイドを見る
            <small>前に保存した手順を開きます</small>
          </span>
        </button>
      </div>
    </aside>
  )
}

function RequestDialog() {
  const { state, dispatch } = useMite()
  const request = state.supportRequest
  if (!request || request.status !== 'draft') return null

  return (
    <div className="modal-layer" role="presentation">
      <section
        className="dialog-card request-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="request-dialog-title"
      >
        <div className="dialog-card__heading">
          <span className="step-badge">1</span>
          <div>
            <span className="eyebrow">今の画面を記録しました</span>
            <h3 id="request-dialog-title">どこで困りましたか？</h3>
          </div>
        </div>
        {request.source === 'guideFallback' ? (
          <div className="context-note">
            ガイドの途中から、家族への相談に切り替えます。
          </div>
        ) : null}
        <ScreenPreview
          screenId={request.screenshotId}
          caption="家族には、この見本画面が届きます"
        />
        <label className="field-label" htmlFor="request-comment">
          今の状況を、書ける範囲で教えてください
          <span>書かなくても送れます</span>
        </label>
        <textarea
          id="request-comment"
          autoFocus
          value={request.comment}
          onChange={(event) =>
            dispatch({
              type: 'SET_REQUEST_COMMENT',
              comment: event.target.value,
            })
          }
          rows={3}
          placeholder="例：番号は分かったけれど、元の画面に戻れません"
        />
        <div className="dialog-actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => dispatch({ type: 'CANCEL_SUPPORT_REQUEST' })}
          >
            やめる
          </button>
          <button
            type="button"
            className="button button--primary button--large"
            onClick={() => dispatch({ type: 'SUBMIT_SUPPORT_REQUEST' })}
          >
            家族に知らせる
          </button>
        </div>
      </section>
    </div>
  )
}

function WaitingForFamily() {
  const { state } = useMite()
  const request = state.supportRequest
  if (!request) return null

  return (
    <div className="modal-layer modal-layer--soft">
      <section className="center-card waiting-card" role="status">
        <div className="success-symbol" aria-hidden="true">
          ✓
        </div>
        <span className="eyebrow">家族へお知らせ済み</span>
        <h3>家族に知らせました</h3>
        <p>家族から連絡が来るまで、そのままお待ちください。</p>
        <div className="waiting-summary">
          <MockDesktop screenId={request.screenshotId} compact />
          <div>
            <small>伝えたこと</small>
            <strong>{request.comment || 'コメントなし'}</strong>
          </div>
        </div>
        {request.status === 'viewed' ? (
          <StatusPill tone="active">家族が内容を確認しました</StatusPill>
        ) : (
          <StatusPill tone="waiting">家族の確認を待っています</StatusPill>
        )}
      </section>
    </div>
  )
}

function IncomingCall() {
  const { dispatch } = useMite()
  return (
    <div className="modal-layer modal-layer--call">
      <section
        className="center-card incoming-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="incoming-title"
      >
        <div className="caller-avatar" aria-hidden="true">
          家
        </div>
        <StatusPill tone="active">家族からの連絡</StatusPill>
        <h3 id="incoming-title">家族から連絡が来ています</h3>
        <p>{FAMILY.displayName}が、困りごとの画面を一緒に確認します。</p>
        <button
          type="button"
          className="button button--call button--xl"
          autoFocus
          onClick={() => dispatch({ type: 'ACCEPT_CALL' })}
        >
          <span aria-hidden="true">☎</span>
          電話に出る
        </button>
        <small>実際の音声は流れないデモです</small>
      </section>
    </div>
  )
}

function SupportingBanner() {
  const { state } = useMite()
  return (
    <div className="support-banner" role="status">
      <div className="support-banner__call">
        <span className="pulse-dot" aria-hidden="true" />
        <div>
          <strong>家族と会話中</strong>
          <span>家族が今の画面を見ながら説明しています</span>
        </div>
      </div>
      <div className="support-banner__recording">
        <span aria-hidden="true">●</span>
        次回のガイド用に記録中
        <strong>{state.supportSession.mockCaptureCount}件</strong>
      </div>
    </div>
  )
}

function ReadOnlyGuideReview() {
  const { state } = useMite()
  const guide = state.draftGuide
  if (!guide) return null
  const step = guide.steps[state.reviewStepIndex]

  return (
    <div className="modal-layer modal-layer--guide-review">
      <section className="guide-preview-card" aria-live="polite">
        <header>
          <div>
            <span className="eyebrow">家族と一緒に確認中</span>
            <h3>{guide.title || 'タイトルを入力中です'}</h3>
          </div>
          <StatusPill tone="waiting">見るだけ</StatusPill>
        </header>
        <p className="guide-preview-card__lead">
          家族と一緒に、次回使うガイドを確認しています。
        </p>
        <ScreenPreview
          screenId={step.imageId}
          caption={`STEP ${state.reviewStepIndex + 1} / ${guide.steps.length}`}
        />
        <div className="instruction-card">
          <span>{state.reviewStepIndex + 1}</span>
          <p>{step.instruction || '家族が説明を書いています'}</p>
        </div>
        <small className="read-only-note">
          家族がページを動かすと、こちらも同じ手順に切り替わります。
        </small>
      </section>
    </div>
  )
}

function GuideList() {
  const { state, dispatch } = useMite()
  const publishedGuides = state.guides.filter(
    (guide) => guide.status === 'published',
  )

  return (
    <div className="modal-layer modal-layer--guide-list">
      <section
        className="guide-library"
        role="dialog"
        aria-modal="true"
        aria-labelledby="guide-list-title"
      >
        <header className="guide-library__header">
          <div>
            <span className="eyebrow">保存したガイド</span>
            <h3 id="guide-list-title">どの操作で困っていますか？</h3>
            <p>今の状況に近いものを1つ選んでください。</p>
          </div>
          <button
            type="button"
            className="button button--quiet"
            onClick={() => dispatch({ type: 'CLOSE_GUIDE_LIST' })}
          >
            閉じる
          </button>
        </header>
        <div className="guide-grid">
          {publishedGuides.map((guide) => (
            <GuideCard key={guide.id} guide={guide} />
          ))}
        </div>
      </section>
    </div>
  )
}

function GuideCard({ guide }: { guide: Guide }) {
  const { dispatch } = useMite()
  const featured =
    guide.id === 'guide-auth-code' || guide.id === 'guide-auth-code-created'
  return (
    <article className={`guide-card ${featured ? 'guide-card--featured' : ''}`}>
      {featured ? <span className="guide-card__tag">今回の操作</span> : null}
      <MockDesktop screenId={guide.coverImageId} compact />
      <div className="guide-card__body">
        <small>{guide.steps.length}つの手順</small>
        <h4>{guide.title}</h4>
        <button
          type="button"
          className="button button--primary button--block"
          onClick={() => dispatch({ type: 'SELECT_GUIDE', guideId: guide.id })}
        >
          このガイドを見る
        </button>
      </div>
    </article>
  )
}

function ActiveGuide() {
  const { state, dispatch } = useMite()
  const guide = state.guides.find(
    (candidate) => candidate.id === state.guideRun.guideId,
  )
  if (!guide) return null
  const step = guide.steps[state.guideRun.currentStepIndex]
  const isLast = state.guideRun.currentStepIndex === guide.steps.length - 1

  return (
    <aside className="active-guide-panel" aria-label="利用中のガイド">
      {state.notice?.kind === 'similarGuideFound' ? (
        <div className="match-found-note" role="status">
          <span aria-hidden="true">✦</span>
          {state.notice.message}
        </div>
      ) : null}
      <div className="active-guide-panel__header">
        <div>
          <span className="eyebrow">1つずつ進めましょう</span>
          <h3>{guide.title}</h3>
        </div>
        <span className="step-counter">
          STEP {state.guideRun.currentStepIndex + 1} / {guide.steps.length}
        </span>
      </div>
      <ScreenPreview
        screenId={step.imageId}
        caption="この見本を見ながら操作してください"
      />
      <div className="instruction-card instruction-card--large">
        <span>{state.guideRun.currentStepIndex + 1}</span>
        <p>{step.instruction}</p>
      </div>
      <div className="guide-navigation">
        <button
          type="button"
          className="button button--quiet"
          disabled={state.guideRun.currentStepIndex === 0}
          onClick={() => dispatch({ type: 'GO_TO_PREVIOUS_GUIDE_STEP' })}
        >
          ← 前へ
        </button>
        <button
          type="button"
          className="button button--primary button--large"
          onClick={() =>
            dispatch({
              type: isLast ? 'COMPLETE_GUIDE' : 'GO_TO_NEXT_GUIDE_STEP',
            })
          }
        >
          {isLast ? 'できました' : '次へ →'}
        </button>
      </div>
      <button
        type="button"
        className="remote-support-link"
        onClick={() => dispatch({ type: 'OPEN_REMOTE_SUPPORT_CONFIRMATION' })}
      >
        <strong>遠隔支援へ移る</strong>
        <small>この手順では分からないとき、家族に相談します</small>
      </button>
    </aside>
  )
}

function RemoteSupportConfirmation() {
  const { dispatch } = useMite()
  return (
    <div className="modal-layer modal-layer--confirm">
      <section
        className="dialog-card confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="fallback-title"
      >
        <div className="family-help-symbol" aria-hidden="true">
          家
        </div>
        <span className="eyebrow">ガイドをいったん止めます</span>
        <h3 id="fallback-title">このまま家族に相談しますか？</h3>
        <p>
          今見ている手順と画面を記録して、家族に知らせる準備をします。
        </p>
        <div className="dialog-actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() =>
              dispatch({ type: 'CANCEL_REMOTE_SUPPORT_CONFIRMATION' })
            }
          >
            ガイドに戻る
          </button>
          <button
            type="button"
            className="button button--primary button--large"
            autoFocus
            onClick={() =>
              dispatch({ type: 'REQUEST_REMOTE_SUPPORT_FROM_GUIDE' })
            }
          >
            家族に相談する
          </button>
        </div>
      </section>
    </div>
  )
}

function GuideComplete() {
  const { dispatch } = useMite()
  return (
    <div className="modal-layer modal-layer--soft">
      <section className="center-card completion-card" role="status">
        <div className="success-symbol success-symbol--large" aria-hidden="true">
          ✓
        </div>
        <span className="eyebrow">すべての手順が終わりました</span>
        <h3>できました</h3>
        <p>ガイドを終了して、いつもの画面に戻ります。</p>
        <button
          type="button"
          className="button button--primary button--xl"
          autoFocus
          onClick={() => dispatch({ type: 'CLOSE_COMPLETED_GUIDE' })}
        >
          ガイドを終了する
        </button>
      </section>
    </div>
  )
}

function SavedNotice() {
  const { state, dispatch } = useMite()
  if (!state.notice) return null

  return (
    <div className="floating-notice" role="status" aria-live="polite">
      <div className="success-symbol" aria-hidden="true">
        ✓
      </div>
      <div>
        <strong>{state.notice.message}</strong>
        {state.notice.kind === 'guideSaved' ? (
          <button
            type="button"
            onClick={() => dispatch({ type: 'OPEN_GUIDE_LIST' })}
          >
            保存したガイドを見る →
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className="icon-button"
        aria-label="お知らせを閉じる"
        onClick={() => dispatch({ type: 'DISMISS_NOTICE' })}
      >
        ×
      </button>
    </div>
  )
}

export function GrandfatherView({ standalone = false }: { standalone?: boolean }) {
  const { state } = useMite()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const requestStatus = state.supportRequest?.status
  const sessionStatus = state.supportSession.status
  const activeRunGuide = state.guides.find(
    (guide) => guide.id === state.guideRun.guideId,
  )
  const currentScreen =
    state.guideRun.status === 'running' && activeRunGuide
      ? activeRunGuide.steps[state.guideRun.currentStepIndex].imageId
      : state.supportRequest?.screenshotId ?? 'mock-mail-screen'
  const launcherDisabled =
    Boolean(state.supportRequest && requestStatus !== 'closed') ||
    !['idle', 'ended'].includes(sessionStatus) ||
    state.guideRun.status !== 'idle'
  const modalKey =
    requestStatus === 'draft' || requestStatus === 'matching'
      ? `request-${requestStatus}`
      : (requestStatus === 'pending' || requestStatus === 'viewed') &&
          (sessionStatus === 'idle' || sessionStatus === 'ended')
        ? `waiting-${requestStatus}`
        : sessionStatus !== 'idle' && sessionStatus !== 'ended'
          ? `session-${sessionStatus}`
          : state.guideRun.status === 'browsing' ||
              state.guideRun.status === 'completed'
            ? `guide-${state.guideRun.status}`
            : state.remoteSupportConfirmationOpen
              ? 'remote-support-confirmation'
              : null

  useStandaloneModalFocus(surfaceRef, modalKey, standalone)

  return (
    <ViewFrame audience="grandfather" name={GRANDFATHER.displayName}>
      <div className="grandfather-surface" ref={surfaceRef}>
        <MockDesktop
          screenId={currentScreen}
          marker={
            sessionStatus === 'supporting' ? state.supportSession.marker : null
          }
        />
        <EdgeLauncher disabled={launcherDisabled} />

        {sessionStatus === 'supporting' ? <SupportingBanner /> : null}
        {requestStatus === 'draft' ? <RequestDialog /> : null}
        {requestStatus === 'matching' ? (
          <div className="modal-layer modal-layer--soft">
            <ProgressCard
              eyebrow="送る前の確認"
              title="似たガイドがないか確認しています"
            >
              <p>この画面に合う手順があれば、先にお見せします。</p>
            </ProgressCard>
          </div>
        ) : null}
        {(requestStatus === 'pending' || requestStatus === 'viewed') &&
        (sessionStatus === 'idle' || sessionStatus === 'ended') ? (
          <WaitingForFamily />
        ) : null}
        {sessionStatus === 'ringing' ? <IncomingCall /> : null}
        {sessionStatus === 'connecting' ? (
          <div className="modal-layer modal-layer--soft">
            <ProgressCard eyebrow="もうすぐ始まります" title="家族とつないでいます">
              <p>つながるまで、このまま少しお待ちください。</p>
            </ProgressCard>
          </div>
        ) : null}
        {sessionStatus === 'guideDecision' ? (
          <div className="modal-layer modal-layer--soft">
            <section className="center-card waiting-card" role="status">
              <div className="success-symbol" aria-hidden="true">
                ✓
              </div>
              <span className="eyebrow">困りごとは解決しました</span>
              <h3>家族が次の準備をしています</h3>
              <p>今回の内容をガイドに残すか、家族が確認しています。</p>
            </section>
          </div>
        ) : null}
        {sessionStatus === 'guideGenerating' ? (
          <div className="modal-layer modal-layer--soft">
            <ProgressCard eyebrow="次回のために" title="ガイドを準備しています">
              <p>今回の支援内容を、分かりやすい手順にまとめています。</p>
            </ProgressCard>
          </div>
        ) : null}
        {sessionStatus === 'guideReview' ? <ReadOnlyGuideReview /> : null}
        {state.guideRun.status === 'browsing' ? <GuideList /> : null}
        {state.guideRun.status === 'running' ? <ActiveGuide /> : null}
        {state.remoteSupportConfirmationOpen ? (
          <RemoteSupportConfirmation />
        ) : null}
        {state.guideRun.status === 'completed' ? <GuideComplete /> : null}
        {sessionStatus === 'ended' && state.guideRun.status === 'idle' ? (
          <SavedNotice />
        ) : null}
      </div>
    </ViewFrame>
  )
}
