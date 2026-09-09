import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react'
import {
  MiteApiError,
  MiteEventStream,
  type EventConnectionStatus,
  type GuideDraft,
  type CompleteGuideReviewInput,
  type GuideGenerationJob,
  type GuideMaterialBatch,
  type MiteApi,
  type MiteEvent,
  type MiteEventStreamOptions,
  type SupportRequest,
  type SupportSession,
} from '@mite/client-api'
import {
  IdempotencyKeyStore,
  normalizedPointInVideo,
  startPolling,
  type KeyValueStorage,
  type RuntimeConfig,
} from '@mite/client-core'
import {
  AppShell,
  Button,
  EmptyState,
  LoadingState,
  Notice,
  ScreenHeading,
  StatusBadge,
  Surface,
} from '@mite/ui'
import { ArtifactImage } from './ArtifactImage'
import { GuideReview } from './GuideReview'
import {
  LiveKitFamilySupport,
  type FamilyLiveSupport,
  type LiveSupportSnapshot,
} from './live-support'

const LAST_REQUEST_KEY = 'mite.family.lastSupportRequestId'

interface EventStreamControl {
  start(): void
  stop(): void
}

export type FamilyEventStreamFactory = (
  options: MiteEventStreamOptions,
) => EventStreamControl

export interface FamilyClientProps {
  config: RuntimeConfig
  api: MiteApi
  storage?: KeyValueStorage
  liveSupport?: FamilyLiveSupport
  eventStreamFactory?: FamilyEventStreamFactory
  pollIntervalMs?: number
}

interface PendingAction {
  kind: 'CALL' | 'RESOLVE' | 'RETRY_JOB' | 'CANCEL_GUIDE' | 'COMPLETE_REVIEW'
  label: string
  operationId: string
  entityId: string
  expectedRevision: number
  decision?: 'CREATE' | 'SKIP'
  reviewInput?: CompleteGuideReviewInput
}

const PENDING_REVIEW_KEY = 'mite.family.pendingGuideReview'

function restorePendingReview(storage: KeyValueStorage): PendingAction | null {
  try {
    const raw = storage.getItem(PENDING_REVIEW_KEY)
    if (!raw) return null
    const pending = JSON.parse(raw) as PendingAction
    const input = pending.reviewInput
    if (
      pending.kind !== 'COMPLETE_REVIEW' ||
      typeof pending.entityId !== 'string' ||
      pending.operationId !== `complete-review:${pending.entityId}` ||
      !input ||
      !Number.isInteger(input.expectedSessionRevision) ||
      input.expectedSessionRevision < 1 ||
      !Array.isArray(input.drafts) ||
      input.drafts.length === 0 ||
      !input.drafts.every(
        (draft) =>
          typeof draft.id === 'string' &&
          Number.isInteger(draft.expectedRevision) &&
          draft.expectedRevision >= 1,
      )
    )
      return null
    return pending
  } catch {
    return null
  }
}

const requestStatus = (status: SupportRequest['status']) => {
  switch (status) {
    case 'PENDING':
      return { text: '対応待ち', tone: 'waiting' as const }
    case 'IN_SUPPORT':
      return { text: '支援中', tone: 'active' as const }
    case 'RESOLVED':
      return { text: '解決済み', tone: 'success' as const }
  }
}

const endReasonMessage = (reason: SupportSession['endReason']) => {
  switch (reason) {
    case 'GUIDE_SAVED':
      return 'ガイドを保存して支援を終了しました。'
    case 'GUIDE_SKIPPED':
      return 'ガイドを作成せずに支援を終了しました。'
    case 'GUIDE_CANCELLED':
      return 'ガイド作成を中止して支援を終了しました。'
    case 'NO_MATERIALS':
      return '画面を保存できなかったため手順を作れませんでした。'
    default:
      return '支援は終了しています。'
  }
}

const generationErrorMessage = (job: GuideGenerationJob) => {
  switch (job.errorCode) {
    case 'AI_TIMEOUT':
      return '手順の作成に時間がかかりすぎました。'
    case 'AI_UNAVAILABLE':
      return '手順作成サービスを利用できません。'
    case 'AI_REFUSAL':
    case 'AI_INCOMPLETE_RESPONSE':
    case 'AI_INVALID_OUTPUT':
      return '画像から手順を作成できませんでした。'
    case 'AI_INPUT_UNAVAILABLE':
      return '手順作成に使える画像を準備できませんでした。'
    case 'WORKER_RESTARTED':
      return 'サーバーの再起動により手順作成が中断されました。'
    default:
      return '手順を作成できませんでした。'
  }
}

const describeError = (error: unknown) => {
  if (error instanceof MiteApiError) {
    if (error.status === 401) {
      return '家族用の接続設定を確認してください。設定を直したあと、再読み込みしてください。'
    }
    if (error.code === 'REVISION_CONFLICT') {
      return '内容が更新されていたため、最新の状態を読み直しました。'
    }
    if (error.code === 'INVALID_STATE') {
      return '状態が変わっていたため、最新の状態を読み直しました。'
    }
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') {
      return '送信情報を確認できませんでした。最新の状態を読み直してください。'
    }
  }
  return '通信できませんでした。現在の状態を保ったまま、もう一度試してください。'
}

const sleep = (delayMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, delayMs))

const isOutcomeUnknown = (error: unknown) =>
  !(error instanceof MiteApiError) ||
  error.status >= 500 ||
  error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS'

const defaultEventStreamFactory: FamilyEventStreamFactory = (options) =>
  new MiteEventStream(options)

function ConnectionBadge({ status }: { status: EventConnectionStatus }) {
  const connected = status === 'CONNECTED'
  return (
    <StatusBadge tone={connected ? 'success' : 'warning'}>
      {connected ? 'サーバー接続中' : '再接続中'}
    </StatusBadge>
  )
}

interface RequestListProps {
  api: MiteApi
  requests: SupportRequest[]
  selectedId: string | null
  disabled: boolean
  onSelect(request: SupportRequest): void
}

function RequestList({
  api,
  requests,
  selectedId,
  disabled,
  onSelect,
}: RequestListProps) {
  return (
    <aside className="family-request-list" aria-label="支援依頼一覧">
      <div className="family-list-heading">
        <div>
          <span className="mite-eyebrow">F-01 依頼一覧</span>
          <h2>利用者からの依頼</h2>
        </div>
        <span className="family-count" aria-label={`${requests.length}件`}>
          {requests.length}
        </span>
      </div>
      {requests.length === 0 ? (
        <p className="family-muted">現在、支援依頼はありません。</p>
      ) : (
        <ul>
          {requests.map((request) => {
            const status = requestStatus(request.status)
            return (
              <li key={request.id}>
                <button
                  type="button"
                  className="family-request-card"
                  disabled={disabled}
                  aria-current={selectedId === request.id ? 'true' : undefined}
                  onClick={() => onSelect(request)}
                >
                  <ArtifactImage
                    api={api}
                    artifactId={request.initialScreenshotArtifactId}
                    alt="依頼時の画面"
                    className="family-request-thumb"
                  />
                  <span className="family-request-card__body">
                    <span className="family-request-card__topline">
                      <strong>利用者</strong>
                      <StatusBadge tone={status.tone}>
                        {status.text}
                      </StatusBadge>
                    </span>
                    <span className="family-request-comment">
                      {request.comment || 'コメントはありません'}
                    </span>
                    <time dateTime={request.createdAt}>
                      {new Date(request.createdAt).toLocaleString('ja-JP')}
                    </time>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </aside>
  )
}

interface RequestDetailProps {
  api: MiteApi
  request: SupportRequest
  busy: boolean
  onCall(): void
}

function RequestDetail({ api, request, busy, onCall }: RequestDetailProps) {
  const status = requestStatus(request.status)
  const canCall =
    request.status === 'PENDING' && request.supportSessionId === null
  return (
    <Surface elevated className="family-detail">
      <ScreenHeading
        eyebrow="F-01 依頼の詳細"
        title="利用者から支援依頼が届いています"
        description="画面と困っている内容を確認してから発信してください。"
        aside={<StatusBadge tone={status.tone}>{status.text}</StatusBadge>}
      />
      <div className="family-detail-grid">
        <ArtifactImage
          api={api}
          artifactId={request.initialScreenshotArtifactId}
          alt="利用者が送った画面"
          className="family-main-image"
        />
        <div className="family-detail-copy">
          <div className="family-person-row">
            <span className="family-avatar" aria-hidden="true">
              利
            </span>
            <div>
              <strong>利用者</strong>
              <small>支援を待っています</small>
            </div>
          </div>
          <section aria-labelledby="request-comment-heading">
            <h3 id="request-comment-heading">困っていること</h3>
            <p className="family-quote">
              {request.comment || 'コメントはありません'}
            </p>
          </section>
          {request.guideContext ? (
            <section
              className="family-guide-context"
              aria-labelledby="guide-context-heading"
            >
              <h3 id="guide-context-heading">ガイドの途中からの相談</h3>
              <p>
                <strong>{request.guideContext.guideTitle}</strong>
              </p>
              <p>
                手順 {request.guideContext.stepNumber}:{' '}
                {request.guideContext.stepInstruction}
              </p>
              <ArtifactImage
                api={api}
                artifactId={request.guideContext.stepArtifactId}
                alt={`ガイドの手順${request.guideContext.stepNumber}の画面`}
                className="family-context-image"
              />
            </section>
          ) : null}
          <Button
            variant="call"
            size="large"
            block
            disabled={!canCall || busy}
            onClick={onCall}
          >
            {busy
              ? '発信しています'
              : canCall
                ? '利用者へ発信する'
                : '発信済み'}
          </Button>
        </div>
      </div>
    </Surface>
  )
}

function RingingScreen({ request }: { request: SupportRequest }) {
  return (
    <Surface elevated className="family-centered-screen">
      <div className="family-ringing-symbol" aria-hidden="true">
        ♪
      </div>
      <StatusBadge tone="waiting">呼び出し中</StatusBadge>
      <h2>利用者の応答を待っています</h2>
      <p>
        {request.comment
          ? `「${request.comment}」について発信しています。`
          : '利用者へ発信しています。'}
      </p>
      <div className="family-pulse" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <p className="family-muted">応答すると自動で支援画面へ移ります。</p>
    </Surface>
  )
}

interface ScreenShareProps {
  liveSupport: FamilyLiveSupport
  live: LiveSupportSnapshot
  onError(error: unknown): void
}

function ScreenShare({ liveSupport, live, onError }: ScreenShareProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [localMark, setLocalMark] = useState<{
    x: number
    y: number
    key: number
  } | null>(null)

  useEffect(() => {
    liveSupport.attachScreen(videoRef.current)
    return () => liveSupport.attachScreen(null)
  }, [liveSupport])

  const sendPoint = (point: { x: number; y: number }) => {
    if (!point) return
    setLocalMark({ ...point, key: Date.now() })
    void liveSupport.sendMark(point).catch(onError)
  }

  const mark = (event: MouseEvent<HTMLDivElement>) => {
    const video = videoRef.current
    if (!video || !live.screenTrackSid) return
    const bounds = video.getBoundingClientRect()
    const point = normalizedPointInVideo(event.clientX, event.clientY, {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    })
    if (point) sendPoint(point)
  }

  return (
    <div className="family-screen-share">
      <div
        className="family-video-stage"
        onClick={mark}
        onKeyDown={(event) => {
          if (
            live.screenTrackSid &&
            (event.key === 'Enter' || event.key === ' ')
          ) {
            event.preventDefault()
            sendPoint({ x: 0.5, y: 0.5 })
          }
        }}
        role="button"
        tabIndex={live.screenTrackSid ? 0 : -1}
        aria-label={
          live.screenTrackSid
            ? '共有画面。画面上をクリックすると利用者へ印を送ります'
            : '共有画面を待っています'
        }
      >
        <video ref={videoRef} autoPlay playsInline />
        {!live.screenTrackSid ? (
          <div className="family-video-empty">
            <span aria-hidden="true">▣</span>
            <strong>利用者の画面共有を待っています</strong>
            <p>音声通話はそのまま続けられます。</p>
          </div>
        ) : null}
        {localMark ? (
          <span
            key={localMark.key}
            className="family-local-mark"
            style={{
              left: `${localMark.x * 100}%`,
              top: `${localMark.y * 100}%`,
            }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="family-mark-help">
        <span>
          共有画面をクリックすると、利用者の画面に2秒間だけ印を表示します。
        </span>
        <Button
          variant="quiet"
          disabled={!live.screenTrackSid}
          onClick={() => void liveSupport.clearMarks().catch(onError)}
        >
          印を消す
        </Button>
      </div>
    </div>
  )
}

interface ActiveSupportScreenProps {
  session: SupportSession
  liveSupport: FamilyLiveSupport
  live: LiveSupportSnapshot
  busy: boolean
  onReconnect(): void
  onResolve(decision: 'CREATE' | 'SKIP'): void
  onError(error: unknown): void
}

function ActiveSupportScreen({
  session,
  liveSupport,
  live,
  busy,
  onReconnect,
  onResolve,
  onError,
}: ActiveSupportScreenProps) {
  const [showDecision, setShowDecision] = useState(false)
  const connected = live.connectionStatus === 'CONNECTED'
  return (
    <div className="family-stack">
      <Surface elevated>
        <ScreenHeading
          eyebrow="F-03 支援中"
          title="利用者の画面を見ながら案内する"
          description="操作は利用者本人が行います。必要な場所は共有画面をクリックして伝えられます。"
          aside={
            <StatusBadge tone={connected ? 'active' : 'warning'}>
              {connected ? '通話中' : '通話を再接続中'}
            </StatusBadge>
          }
        />
        {live.errorMessage ? (
          <Notice tone="warning" title="通話へ接続できません">
            <p>{live.errorMessage}</p>
            <Button variant="secondary" onClick={onReconnect}>
              通話へ再接続
            </Button>
          </Notice>
        ) : null}
        {live.audioPlaybackBlocked ? (
          <Notice tone="warning" title="利用者の声を再生してください">
            <p>端末の制限により音声が一時停止しています。</p>
            <Button
              variant="secondary"
              onClick={() => void liveSupport.startAudio().catch(onError)}
            >
              音声を再生
            </Button>
          </Notice>
        ) : null}
        <ScreenShare liveSupport={liveSupport} live={live} onError={onError} />
        <div className="family-call-controls">
          <Button
            variant={live.microphoneEnabled ? 'secondary' : 'danger'}
            disabled={!connected}
            aria-pressed={live.microphoneEnabled}
            onClick={() =>
              void liveSupport
                .setMicrophoneEnabled(!live.microphoneEnabled)
                .catch(onError)
            }
          >
            {live.microphoneEnabled ? 'マイクをオフ' : 'マイクをオン'}
          </Button>
          <div className="family-audio-level">
            <span>利用者の声</span>
            <meter
              min="0"
              max="1"
              value={live.receivedAudioLevel}
              aria-label="利用者の音声レベル"
            />
          </div>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => setShowDecision(true)}
          >
            支援を解決済みにする
          </Button>
        </div>
      </Surface>

      {showDecision ? (
        <Surface
          className="family-decision"
          aria-labelledby="guide-decision-heading"
        >
          <div>
            <h2 id="guide-decision-heading">
              今回の操作をガイドに残しますか？
            </h2>
            <p>
              ガイドを作る場合、利用者が保存した画面から下書きを作成します。
            </p>
          </div>
          <div className="family-action-row">
            <Button
              variant="secondary"
              disabled={busy || session.status !== 'ACTIVE'}
              onClick={() => onResolve('SKIP')}
            >
              作成せず終了
            </Button>
            <Button
              size="large"
              disabled={busy || session.status !== 'ACTIVE'}
              onClick={() => onResolve('CREATE')}
            >
              ガイドを作る
            </Button>
          </div>
        </Surface>
      ) : null}
    </div>
  )
}

interface GenerationScreenProps {
  batch: GuideMaterialBatch | null
  job: GuideGenerationJob | null
  busy: boolean
  onRetry(): void
  onCancel(): void
}

function GenerationScreen({
  batch,
  job,
  busy,
  onRetry,
  onCancel,
}: GenerationScreenProps) {
  const canRetry = job?.status === 'FAILED' && job.attempt < 3
  const canCancel = !job || job.status === 'FAILED'
  const progress = batch
    ? Math.round((batch.receivedItemCount / batch.expectedItemCount) * 100)
    : 0
  return (
    <Surface elevated className="family-generation">
      <ScreenHeading
        eyebrow="F-04 ガイド作成中"
        title="利用者の画面から手順を作っています"
        description="画像の受け取りと手順の作成状況は自動で更新されます。"
        aside={<StatusBadge tone="active">処理中</StatusBadge>}
      />
      <div className="family-generation-grid">
        <section
          className="family-progress-card"
          aria-labelledby="upload-heading"
        >
          <span className="family-progress-number" aria-hidden="true">
            1
          </span>
          <div>
            <h3 id="upload-heading">画面を受け取る</h3>
            <p>
              {batch
                ? `${batch.receivedItemCount} / ${batch.expectedItemCount} 枚`
                : '利用者が画面を準備しています'}
            </p>
            {batch ? (
              <progress
                value={batch.receivedItemCount}
                max={batch.expectedItemCount}
                aria-label={`画像アップロード ${progress}%`}
              />
            ) : null}
          </div>
        </section>
        <section
          className="family-progress-card"
          aria-labelledby="generation-heading"
        >
          <span className="family-progress-number" aria-hidden="true">
            2
          </span>
          <div>
            <h3 id="generation-heading">手順の下書きを作る</h3>
            <p>
              {!job
                ? '画像の受け取りを待っています'
                : job.status === 'QUEUED'
                  ? '作成開始を待っています'
                  : job.status === 'RUNNING'
                    ? `作成しています（${job.attempt}回目）`
                    : job.status === 'SUCCEEDED'
                      ? '下書きができました'
                      : `作成できませんでした（${job.attempt}回目）`}
            </p>
          </div>
        </section>
      </div>

      {job?.status === 'FAILED' ? (
        <Notice tone="danger" title="手順を作成できませんでした">
          <p>{generationErrorMessage(job)}</p>
          {job.attempt >= 3 ? (
            <p>実行上限の3回に達しました。作成せず終了してください。</p>
          ) : null}
        </Notice>
      ) : null}

      <div className="family-generation-actions">
        <Button
          variant="secondary"
          disabled={!canCancel || busy}
          onClick={onCancel}
        >
          作成せず終了
        </Button>
        <Button disabled={!canRetry || busy} onClick={onRetry}>
          手順作成を再試行
        </Button>
      </div>
      {!canCancel ? (
        <p className="family-muted family-action-note">
          手順の作成中は終了できません。処理が完了するまでお待ちください。
        </p>
      ) : null}
    </Surface>
  )
}

export function FamilyClient({
  config,
  api,
  storage = window.localStorage,
  liveSupport: liveSupportProp,
  eventStreamFactory = defaultEventStreamFactory,
  pollIntervalMs = 5_000,
}: FamilyClientProps) {
  const liveSupport = useMemo(
    () => liveSupportProp ?? new LiveKitFamilySupport(),
    [liveSupportProp],
  )
  const operationKeys = useMemo(
    () => new IdempotencyKeyStore(storage, { prefix: 'mite.family.idem.' }),
    [storage],
  )
  const [requests, setRequests] = useState<SupportRequest[]>([])
  const [request, setRequest] = useState<SupportRequest | null>(null)
  const [session, setSession] = useState<SupportSession | null>(null)
  const [batch, setBatch] = useState<GuideMaterialBatch | null>(null)
  const [job, setJob] = useState<GuideGenerationJob | null>(null)
  const [drafts, setDrafts] = useState<GuideDraft[]>([])
  const [initialLoading, setInitialLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(() =>
    restorePendingReview(storage),
  )
  const [restoredResolveDecision, setRestoredResolveDecision] = useState<
    'CREATE' | 'SKIP' | null
  >(null)
  const [fatal, setFatal] = useState<string | null>(null)
  const [eventStatus, setEventStatus] =
    useState<EventConnectionStatus>('CONNECTING')
  const [live, setLive] = useState<LiveSupportSnapshot>(
    liveSupport.getSnapshot(),
  )
  const requestRef = useRef<SupportRequest | null>(null)
  const sessionRef = useRef<SupportSession | null>(null)
  const jobRef = useRef<GuideGenerationJob | null>(null)
  const draftsRef = useRef<GuideDraft[]>([])
  const liveSessionIdRef = useRef<string | null>(null)

  const acceptRequest = useCallback(
    (incoming: SupportRequest) => {
      const current = requestRef.current
      if (
        current?.id === incoming.id &&
        current.revision >= incoming.revision
      ) {
        return current
      }
      requestRef.current = incoming
      setRequest(incoming)
      storage.setItem(LAST_REQUEST_KEY, incoming.id)
      return incoming
    },
    [storage],
  )

  const acceptSession = useCallback(
    (incoming: SupportSession) => {
      const current = sessionRef.current
      if (
        current?.id === incoming.id &&
        current.revision >= incoming.revision
      ) {
        return current
      }
      sessionRef.current = incoming
      setSession(incoming)
      if (incoming.status === 'ENDED') {
        const pending = restorePendingReview(storage)
        if (pending?.entityId === incoming.id) {
          operationKeys.complete(pending.operationId)
          storage.removeItem(PENDING_REVIEW_KEY)
        }
      }
      if (incoming.status === 'ACTIVE') {
        const decision = operationKeys.peek(`resolve:${incoming.id}:CREATE`)
          ? 'CREATE'
          : operationKeys.peek(`resolve:${incoming.id}:SKIP`)
            ? 'SKIP'
            : null
        setRestoredResolveDecision(decision)
      } else {
        setRestoredResolveDecision(null)
      }
      setPendingAction((pending) => {
        if (!pending) return null
        if (pending.kind === 'CALL') return null
        if (pending.kind === 'RESOLVE' && incoming.status !== 'ACTIVE') {
          return null
        }
        if (
          (pending.kind === 'CANCEL_GUIDE' ||
            pending.kind === 'COMPLETE_REVIEW') &&
          incoming.status === 'ENDED'
        ) {
          return null
        }
        return pending
      })
      return incoming
    },
    [operationKeys, storage],
  )

  const handleError = useCallback((error: unknown) => {
    const text = describeError(error)
    setMessage(text)
    if (error instanceof MiteApiError && error.status === 401) setFatal(text)
  }, [])

  const acceptJob = useCallback((incoming: GuideGenerationJob) => {
    const current = jobRef.current
    if (current?.id === incoming.id && current.revision >= incoming.revision) {
      return current
    }
    jobRef.current = incoming
    setJob(incoming)
    return incoming
  }, [])

  const acceptDrafts = useCallback((incoming: GuideDraft[]) => {
    const accepted = incoming.map((draft) => {
      const current = draftsRef.current.find((item) => item.id === draft.id)
      return current && current.revision >= draft.revision ? current : draft
    })
    draftsRef.current = accepted
    setDrafts(accepted)
  }, [])

  const refreshChildren = useCallback(
    async (currentSession: SupportSession) => {
      if (currentSession.status === 'GENERATING_GUIDE') {
        draftsRef.current = []
        setDrafts([])
        const [batchResult, jobResult] = await Promise.all([
          currentSession.guideMaterialBatchId
            ? api.getGuideMaterialBatch(currentSession.guideMaterialBatchId)
            : Promise.resolve(null),
          currentSession.guideGenerationJobId
            ? api.getGuideGenerationJob(currentSession.guideGenerationJobId)
            : Promise.resolve(null),
        ])
        if (batchResult) {
          setBatch((current) =>
            current?.id === batchResult.batch.id &&
            current.revision >= batchResult.batch.revision
              ? current
              : batchResult.batch,
          )
        } else {
          setBatch(null)
        }
        if (jobResult) {
          acceptJob(jobResult)
          if (jobResult.status !== 'FAILED') {
            setPendingAction((pending) =>
              pending?.kind === 'RETRY_JOB' ? null : pending,
            )
          }
        } else {
          jobRef.current = null
          setJob(null)
        }
        return
      }
      if (
        currentSession.status === 'REVIEWING_GUIDE' &&
        currentSession.guideDraftId
      ) {
        const incomingDrafts = await api.listSessionGuideDrafts(
          currentSession.id,
        )
        if (
          sessionRef.current?.id === currentSession.id &&
          sessionRef.current.status === 'REVIEWING_GUIDE'
        ) {
          acceptDrafts(incomingDrafts)
        }
        return
      }
      setBatch(null)
      jobRef.current = null
      setJob(null)
      draftsRef.current = []
      setDrafts([])
    },
    [acceptDrafts, acceptJob, api],
  )

  const hydrateRequest = useCallback(
    async (
      incomingRequest: SupportRequest,
      prefetchedSession?: SupportSession | null,
    ) => {
      const acceptedRequest = acceptRequest(incomingRequest)
      if (!acceptedRequest.supportSessionId) {
        sessionRef.current = null
        setSession(null)
        setBatch(null)
        jobRef.current = null
        setJob(null)
        draftsRef.current = []
        setDrafts([])
        return
      }
      const incomingSession =
        prefetchedSession ??
        (await api.getSupportSession(acceptedRequest.supportSessionId))
      const accepted = acceptSession(incomingSession)
      await refreshChildren(accepted)
    },
    [acceptRequest, acceptSession, api, refreshChildren],
  )

  const refreshCurrent = useCallback(async () => {
    const current = requestRef.current
    if (!current) return
    const incoming = await api.getSupportRequest(current.id)
    await hydrateRequest(incoming)
    setMessage(null)
  }, [api, hydrateRequest])

  const refreshOverview = useCallback(async () => {
    const incoming = await api.listSupportRequests()
    setRequests(incoming)
    const firstPending = incoming.find(
      (item) => item.status === 'PENDING' && !item.supportSessionId,
    )
    if (
      firstPending &&
      (!requestRef.current ||
        sessionRef.current?.status === 'ENDED' ||
        firstPending.id !== requestRef.current.id)
    ) {
      await hydrateRequest(firstPending)
      setMessage(null)
      return
    }
    await refreshCurrent()
  }, [api, hydrateRequest, refreshCurrent])

  const restore = useCallback(async () => {
    setInitialLoading(true)
    setMessage(null)
    try {
      const listed = await api.listSupportRequests()
      setRequests(listed)
      const storedId = storage.getItem(LAST_REQUEST_KEY)
      let storedRequest: SupportRequest | null = null
      if (storedId) {
        try {
          storedRequest = await api.getSupportRequest(storedId)
        } catch (error) {
          if (error instanceof MiteApiError && error.status === 401) throw error
        }
      }
      const candidates = [...listed]
      if (
        storedRequest &&
        !candidates.some((candidate) => candidate.id === storedRequest?.id)
      ) {
        candidates.push(storedRequest)
      }
      let selected: SupportRequest | null = null
      let selectedSession: SupportSession | null = null
      for (const candidate of candidates) {
        if (candidate.status === 'PENDING' && !candidate.supportSessionId) {
          selected = candidate
          break
        }
        if (!candidate.supportSessionId) continue
        try {
          const candidateSession = await api.getSupportSession(
            candidate.supportSessionId,
          )
          if (candidateSession.status !== 'ENDED') {
            selected = candidate
            selectedSession = candidateSession
            break
          }
          if (!selected && candidate.id === storedRequest?.id) {
            selected = candidate
            selectedSession = candidateSession
          }
        } catch (error) {
          if (error instanceof MiteApiError && error.status === 401) throw error
        }
      }
      selected ??= storedRequest ?? listed[0] ?? null
      if (selected) await hydrateRequest(selected, selectedSession)
    } catch (error) {
      handleError(error)
    } finally {
      setInitialLoading(false)
    }
  }, [api, handleError, hydrateRequest, storage])

  useEffect(() => {
    const timer = setTimeout(() => void restore(), 0)
    return () => clearTimeout(timer)
  }, [restore])

  useEffect(() => liveSupport.subscribe(setLive), [liveSupport])

  useEffect(() => {
    const controller = startPolling(refreshOverview, {
      immediate: false,
      intervalMs: pollIntervalMs,
      onError: handleError,
    })
    return () => controller.stop()
  }, [handleError, pollIntervalMs, refreshOverview])

  useEffect(() => {
    const handleEvent = (event: MiteEvent) => {
      if (event.type === 'supportRequest.created') {
        void api
          .getSupportRequest(event.entityId)
          .then((created) => {
            setRequests((current) => [
              created,
              ...current.filter((item) => item.id !== created.id),
            ])
            return hydrateRequest(created)
          })
          .catch(handleError)
        return
      }
      void refreshCurrent().catch(handleError)
    }
    const stream = eventStreamFactory({
      apiBaseUrl: config.apiBaseUrl,
      token: config.demoToken,
      onEvent: handleEvent,
      onStatusChange: (status) => {
        setEventStatus(status)
        if (status === 'CONNECTED') {
          void refreshOverview().catch(handleError)
        }
      },
    })
    stream.start()
    return () => stream.stop()
  }, [
    api,
    config.apiBaseUrl,
    config.demoToken,
    eventStreamFactory,
    handleError,
    hydrateRequest,
    refreshCurrent,
    refreshOverview,
  ])

  const connectLive = useCallback(async () => {
    const currentSession = sessionRef.current
    if (!currentSession) return
    try {
      const latest = await api.getSupportSession(currentSession.id)
      const accepted = acceptSession(latest)
      if (accepted.status !== 'ACTIVE') {
        await liveSupport.disconnect()
        return
      }
      const info = await api.getLiveKitToken(accepted.id)
      await liveSupport.connect(info)
      liveSessionIdRef.current = accepted.id
    } catch (error) {
      handleError(error)
    }
  }, [acceptSession, api, handleError, liveSupport])

  useEffect(() => {
    if (session?.status === 'ACTIVE') {
      if (liveSessionIdRef.current !== session.id) {
        liveSessionIdRef.current = session.id
        void connectLive()
      }
      return
    }
    if (liveSessionIdRef.current) {
      liveSessionIdRef.current = null
      void liveSupport.disconnect()
    }
  }, [connectLive, liveSupport, session?.id, session?.status])

  useEffect(
    () => () => {
      void liveSupport.disconnect()
    },
    [liveSupport],
  )

  const runIdempotent = useCallback(
    async <TResult,>(
      operationId: string,
      operation: (idempotencyKey: string) => Promise<TResult>,
    ) => {
      const idempotencyKey = operationKeys.getOrCreate(operationId)
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const result = await operation(idempotencyKey)
          operationKeys.complete(operationId)
          return result
        } catch (error) {
          const inProgress =
            error instanceof MiteApiError &&
            error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
          if (inProgress && attempt < 3) {
            await sleep((error.retryAfterSeconds ?? 1) * 1_000)
            continue
          }
          if (
            error instanceof MiteApiError &&
            !inProgress &&
            error.status < 500
          ) {
            operationKeys.complete(operationId)
          }
          throw error
        }
      }
      throw new Error('Idempotent operation retry exhausted')
    },
    [operationKeys],
  )

  const canRetryExactly = useCallback((pending: PendingAction) => {
    switch (pending.kind) {
      case 'CALL': {
        const current = requestRef.current
        return (
          current?.id === pending.entityId &&
          current.revision === pending.expectedRevision &&
          current.status === 'PENDING' &&
          current.supportSessionId === null
        )
      }
      case 'RESOLVE':
      case 'CANCEL_GUIDE': {
        const current = sessionRef.current
        return (
          current?.id === pending.entityId &&
          current.revision === pending.expectedRevision &&
          (pending.kind === 'RESOLVE'
            ? current.status === 'ACTIVE'
            : current.status === 'GENERATING_GUIDE' ||
              current.status === 'REVIEWING_GUIDE')
        )
      }
      case 'RETRY_JOB': {
        const current = jobRef.current
        return (
          current?.id === pending.entityId &&
          current.revision === pending.expectedRevision &&
          current.status === 'FAILED' &&
          current.attempt < 3
        )
      }
      case 'COMPLETE_REVIEW': {
        const current = sessionRef.current
        return current?.id === pending.entityId && current.status !== 'ENDED'
      }
    }
  }, [])

  const recoverAfterActionError = useCallback(
    async (error: unknown, pending?: PendingAction) => {
      try {
        await refreshCurrent()
      } catch {
        // The original operation error remains the most useful message. The
        // persisted key is kept so the exact same operation can be retried.
      }
      if (pending && isOutcomeUnknown(error)) {
        if (canRetryExactly(pending)) {
          handleError(error)
          setPendingAction(pending)
        } else {
          operationKeys.complete(pending.operationId)
          setPendingAction(null)
          setMessage('送信結果を確認し、サーバーの最新状態へ合わせました。')
        }
      } else {
        handleError(error)
      }
    },
    [canRetryExactly, handleError, operationKeys, refreshCurrent],
  )

  const call = async (retryAction?: PendingAction) => {
    const current = requestRef.current
    if (!current || busy) return
    const pending: PendingAction =
      retryAction?.kind === 'CALL'
        ? retryAction
        : {
            kind: 'CALL',
            label: '同じ内容で発信を確認する',
            operationId: `call:${current.id}`,
            entityId: current.id,
            expectedRevision: current.revision,
          }
    setBusy(true)
    setMessage(null)
    try {
      const result = await runIdempotent(pending.operationId, (key) =>
        api.callSupportRequest(
          pending.entityId,
          { expectedRequestRevision: pending.expectedRevision },
          { idempotencyKey: key },
        ),
      )
      acceptRequest(result.supportRequest)
      acceptSession(result.supportSession)
      await refreshCurrent()
      setPendingAction(null)
    } catch (error) {
      await recoverAfterActionError(error, pending)
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (
    decision: 'CREATE' | 'SKIP',
    retryAction?: PendingAction,
  ) => {
    const current = sessionRef.current
    if (!current || busy) return
    const pending: PendingAction =
      retryAction?.kind === 'RESOLVE'
        ? retryAction
        : {
            kind: 'RESOLVE',
            label: '同じ選択内容で送信を確認する',
            operationId: `resolve:${current.id}:${decision}`,
            entityId: current.id,
            expectedRevision: current.revision,
            decision,
          }
    setBusy(true)
    setMessage(null)
    try {
      const result = await runIdempotent(pending.operationId, (key) =>
        api.resolveSupportSession(
          pending.entityId,
          {
            expectedSessionRevision: pending.expectedRevision,
            guideDecision: pending.decision ?? decision,
          },
          { idempotencyKey: key },
        ),
      )
      acceptRequest(result.supportRequest)
      acceptSession(result.supportSession)
      await refreshChildren(result.supportSession)
      await refreshCurrent()
      setRestoredResolveDecision(null)
      setPendingAction(null)
    } catch (error) {
      await recoverAfterActionError(error, pending)
    } finally {
      setBusy(false)
    }
  }

  const retryGeneration = async (retryAction?: PendingAction) => {
    const currentJob = jobRef.current
    if (
      !currentJob ||
      currentJob.status !== 'FAILED' ||
      currentJob.attempt >= 3 ||
      busy
    ) {
      return
    }
    const pending: PendingAction =
      retryAction?.kind === 'RETRY_JOB'
        ? retryAction
        : {
            kind: 'RETRY_JOB',
            label: '同じ内容で再試行を確認する',
            operationId: `retry-job:${currentJob.id}`,
            entityId: currentJob.id,
            expectedRevision: currentJob.revision,
          }
    setBusy(true)
    setMessage(null)
    try {
      const updated = await runIdempotent(pending.operationId, (key) =>
        api.retryGuideGenerationJob(
          pending.entityId,
          { expectedJobRevision: pending.expectedRevision },
          { idempotencyKey: key },
        ),
      )
      acceptJob(updated)
      acceptJob(await api.getGuideGenerationJob(updated.id))
      setPendingAction(null)
    } catch (error) {
      await recoverAfterActionError(error, pending)
    } finally {
      setBusy(false)
    }
  }

  const cancelGuide = async (retryAction?: PendingAction) => {
    const current = sessionRef.current
    if (!current || busy) return
    const pending: PendingAction =
      retryAction?.kind === 'CANCEL_GUIDE'
        ? retryAction
        : {
            kind: 'CANCEL_GUIDE',
            label: '同じ内容で終了を確認する',
            operationId: `cancel-guide:${current.id}`,
            entityId: current.id,
            expectedRevision: current.revision,
          }
    setBusy(true)
    setMessage(null)
    try {
      const ended = await runIdempotent(pending.operationId, (key) =>
        api.endSupportSessionWithoutGuide(
          pending.entityId,
          {
            expectedSessionRevision: pending.expectedRevision,
            reason: 'GUIDE_CANCELLED',
          },
          { idempotencyKey: key },
        ),
      )
      acceptSession(ended)
      await refreshCurrent()
      setPendingAction(null)
    } catch (error) {
      await recoverAfterActionError(error, pending)
    } finally {
      setBusy(false)
    }
  }

  const completeReview = async (
    currentDrafts: GuideDraft[],
    retryAction?: PendingAction,
  ) => {
    const currentSession = sessionRef.current
    if (busy || !currentSession) return
    const pending: PendingAction =
      retryAction?.kind === 'COMPLETE_REVIEW'
        ? retryAction
        : {
            kind: 'COMPLETE_REVIEW',
            label: '同じ内容でレビュー完了を確認する',
            operationId: `complete-review:${currentSession.id}`,
            entityId: currentSession.id,
            expectedRevision: currentSession.revision,
            reviewInput: {
              expectedSessionRevision: currentSession.revision,
              drafts: currentDrafts.map((draft) => ({
                id: draft.id,
                expectedRevision: draft.revision,
              })),
            },
          }
    if (!pending.reviewInput) return
    const input = pending.reviewInput
    storage.setItem(PENDING_REVIEW_KEY, JSON.stringify(pending))
    setBusy(true)
    setMessage(null)
    try {
      const result = await runIdempotent(pending.operationId, (key) =>
        api.completeGuideReview(pending.entityId, input, {
          idempotencyKey: key,
        }),
      )
      storage.removeItem(PENDING_REVIEW_KEY)
      acceptSession(result.supportSession)
      await refreshCurrent()
      setPendingAction(null)
    } catch (error) {
      await recoverAfterActionError(error, pending)
      if (!operationKeys.peek(pending.operationId))
        storage.removeItem(PENDING_REVIEW_KEY)
    } finally {
      setBusy(false)
    }
  }

  const chooseRequest = (selected: SupportRequest) => {
    setMessage(null)
    void hydrateRequest(selected).catch(handleError)
  }

  const effectivePendingAction: PendingAction | null =
    pendingAction ??
    (restoredResolveDecision
      ? {
          kind: 'RESOLVE',
          label: '同じ選択内容で送信を確認する',
          operationId: `resolve:${session?.id ?? ''}:${restoredResolveDecision}`,
          entityId: session?.id ?? '',
          expectedRevision: session?.revision ?? 0,
          decision: restoredResolveDecision,
        }
      : null)
  const actionLocked = busy || effectivePendingAction !== null

  const retryPendingAction = (pending: PendingAction) => {
    setPendingAction(null)
    switch (pending.kind) {
      case 'CALL':
        void call(pending)
        break
      case 'RESOLVE':
        if (pending.decision) void resolve(pending.decision, pending)
        break
      case 'RETRY_JOB':
        void retryGeneration(pending)
        break
      case 'CANCEL_GUIDE':
        void cancelGuide(pending)
        break
      case 'COMPLETE_REVIEW':
        void completeReview([], pending)
        break
    }
  }

  let content
  if (initialLoading) {
    content = <LoadingState>支援依頼を確認しています</LoadingState>
  } else if (fatal) {
    content = (
      <Surface elevated>
        <Notice tone="danger" title="接続設定を確認してください">
          <p>{fatal}</p>
          <Button onClick={() => window.location.reload()}>再読み込み</Button>
        </Notice>
      </Surface>
    )
  } else if (!request) {
    content = (
      <EmptyState
        symbol={requests.length ? '選' : '待'}
        title={
          requests.length
            ? '確認する依頼を選んでください'
            : '支援依頼はありません'
        }
        description={
          requests.length
            ? '左の一覧から依頼を選ぶと、画面とコメントを確認できます。'
            : '利用者から依頼が届くと、ここに画面とコメントが表示されます。'
        }
        action={<Button onClick={() => void restore()}>もう一度確認</Button>}
      />
    )
  } else if (!session) {
    content = (
      <RequestDetail
        api={api}
        request={request}
        busy={actionLocked}
        onCall={() => void call()}
      />
    )
  } else {
    switch (session.status) {
      case 'RINGING':
        content = <RingingScreen request={request} />
        break
      case 'ACTIVE':
        content = (
          <ActiveSupportScreen
            session={session}
            liveSupport={liveSupport}
            live={live}
            busy={actionLocked}
            onReconnect={() => void connectLive()}
            onResolve={(decision) => void resolve(decision)}
            onError={handleError}
          />
        )
        break
      case 'GENERATING_GUIDE':
        content = (
          <GenerationScreen
            batch={batch}
            job={job}
            busy={actionLocked}
            onRetry={() => void retryGeneration()}
            onCancel={() => void cancelGuide()}
          />
        )
        break
      case 'REVIEWING_GUIDE':
        content =
          drafts.length > 0 ? (
            <GuideReview
              key={session.id}
              api={api}
              supportSessionId={session.id}
              drafts={drafts}
              busy={actionLocked}
              onComplete={(currentDrafts) => void completeReview(currentDrafts)}
              onCancel={() => void cancelGuide()}
            />
          ) : (
            <LoadingState>手順の下書きを読み込んでいます</LoadingState>
          )
        break
      case 'ENDED':
        content = (
          <EmptyState
            symbol="✓"
            title="支援が完了しました"
            description={endReasonMessage(session.endReason)}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  requestRef.current = null
                  sessionRef.current = null
                  setRequest(null)
                  setSession(null)
                  storage.removeItem(LAST_REQUEST_KEY)
                }}
              >
                依頼一覧へ戻る
              </Button>
            }
          />
        )
        break
    }
  }

  return (
    <AppShell
      roleLabel="家族用"
      title="利用者の支援"
      subtitle="画面を見ながら、操作する場所を伝えます"
      status={<ConnectionBadge status={eventStatus} />}
    >
      {message && !fatal ? (
        <Notice
          tone="warning"
          title="確認してください"
          className="family-global-notice"
        >
          {message}
        </Notice>
      ) : null}
      {effectivePendingAction && !fatal ? (
        <Notice
          tone="warning"
          title="送信結果を確認できていません"
          className="family-global-notice"
        >
          <p>別の操作は行わず、同じ内容と送信情報で結果を確認してください。</p>
          <Button
            variant="secondary"
            onClick={() => retryPendingAction(effectivePendingAction)}
          >
            {effectivePendingAction.label}
          </Button>
        </Notice>
      ) : null}
      <div className="family-workspace">
        <RequestList
          api={api}
          requests={requests}
          selectedId={request?.id ?? null}
          disabled={actionLocked}
          onSelect={chooseRequest}
        />
        <section className="family-content" aria-label="選択中の支援">
          {content}
        </section>
      </div>
    </AppShell>
  )
}
