import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  HttpMiteApi,
  MiteApiError,
  MiteEventStream,
  type EventConnectionStatus,
  type GuideDetail,
  type GuideDraft,
  type GuideRun,
  type GuideSummary,
  type MiteApi,
  type MiteEventStreamOptions,
  type SupportRequest,
  type SupportSession,
} from '@mite/client-api'
import {
  deriveUserSupportScreen,
  canContinueCall,
  canShareScreen,
  canCaptureGuideMaterial,
  CAPTURE_INTERVAL_MS,
  IdempotencyKeyStore,
  selectNewestRevision,
  startPolling,
  type KeyValueStorage,
  type MarkingMessage,
  type RuntimeConfig,
} from '@mite/client-core'
import {
  AppShell,
  Modal,
  CallElapsed,
  Button,
  EmptyState,
  LoadingState,
  Notice,
  ScreenHeading,
  StatusBadge,
  Surface,
} from '@mite/ui'
import { ArtifactImage } from './ArtifactImage'
import {
  getUserDesktopBridge,
  type ScreenSharePreview,
  type UserDesktopBridge,
} from './desktop'
import {
  LiveKitUserMediaSession,
  type MediaConnectionState,
  type UserMediaSession,
} from './livekit'
import {
  uploadCapturedMaterials,
  type MaterialUploadProgress,
} from './material-upload'
import { CaptureStorageError } from './capture-storage'
import type { DesktopMark } from '../shared/marking-overlay'
import { screenCaptureFailureMessage } from '../shared/screen-capture-error'
import './user.css'

const lastRequestKey = 'mite.user.lastSupportRequestId'
const guideRunKey = 'mite.user.guideRunId'
const supportDraftKey = 'mite.user.supportDraftId'
const supportDraftPayloadKey = 'mite.user.supportDraftPayload'
const consentText =
  '応答すると、家族との音声通話とメインの画面全体の共有が始まります。共有の開始直後に1枚、その後10秒ごとに、この端末へ画像を一時保存します。家族が手順を作ることを選ぶと撮影を止め、画像をMiteサーバーへ送り、GoogleのGemini AIで下書きを作ります。手順の作成中は画面共有を止め、音声通話だけを続けます。保存すると、作成前に共有していた場合だけ画面共有を再開します。画面共有はいつでも止められます。画面に個人情報が映る可能性があります。音声通話・画面共有・画像の保存と送信に同意して応答しますか。'

interface EventStreamController {
  start(): void
  stop(): void
}

const defaultEventStreamFactory = (options: MiteEventStreamOptions) =>
  new MiteEventStream(options)

const defaultMediaSessionFactory = () => new LiveKitUserMediaSession()

export interface UserClientProps {
  api: MiteApi
  runtime: RuntimeConfig
  desktop: UserDesktopBridge
  storage?: KeyValueStorage
  createEventStream?: (options: MiteEventStreamOptions) => EventStreamController
  createMediaSession?: () => UserMediaSession
}

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

const runIdempotent = async <TResult,>(
  keys: IdempotencyKeyStore,
  operationId: string,
  operation: (idempotencyKey: string) => Promise<TResult>,
) => {
  const idempotencyKey = keys.getOrCreate(operationId)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const result = await operation(idempotencyKey)
      keys.complete(operationId)
      return result
    } catch (error) {
      if (
        error instanceof MiteApiError &&
        error.code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' &&
        attempt < 3
      ) {
        await delay((error.retryAfterSeconds ?? 1) * 1_000)
        continue
      }
      if (
        error instanceof MiteApiError &&
        error.status < 500 &&
        error.code !== 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
      ) {
        keys.complete(operationId)
      }
      throw error
    }
  }
  throw new Error('操作を終えられませんでした')
}

const messageForError = (error: unknown) => {
  if (error instanceof CaptureStorageError) return error.message
  if (!(error instanceof MiteApiError)) {
    return '通信できません。少し待ってから、もう一度試してください。'
  }
  switch (error.code) {
    case 'REVISION_CONFLICT':
    case 'INVALID_STATE':
      return '内容が変わったため、最新の状態を読み直しました。'
    case 'DUPLICATE_ACTIVE_REQUEST':
      return 'すでに相談中の内容があります。そちらを続けてください。'
    case 'MATERIAL_CONFLICT':
      return '保存した画面の記録が一致しません。自動送信を止めました。'
    case 'FILE_TOO_LARGE':
      return '画像が大きすぎるため送れませんでした。'
    case 'IDEMPOTENCY_KEY_REUSED':
      return '操作の確認に失敗しました。最新の状態を読み直しました。'
    case 'UNAUTHENTICATED':
      return 'このアプリの設定を確認できませんでした。'
    default:
      return '通信できません。少し待ってから、もう一度試してください。'
  }
}

const codePointLength = (value: string) => [...value].length

function ErrorNotice({
  message,
  onRetry,
}: {
  message: string
  onRetry?: () => void
}) {
  return (
    <Notice tone="danger" title={message} role="alert">
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          もう一度試す
        </Button>
      ) : null}
    </Notice>
  )
}

function SupportRequestComposer({
  api,
  desktop,
  keys,
  storage,
  onCreated,
  onCancel,
  onAuthenticationError,
}: {
  api: MiteApi
  desktop: UserDesktopBridge
  keys: IdempotencyKeyStore
  storage: KeyValueStorage
  onCreated(request: SupportRequest): void
  onCancel(): void
  onAuthenticationError(): void
}) {
  const recoveredPayload = useMemo(() => {
    const raw = storage.getItem(supportDraftPayloadKey)
    if (!raw) return null
    try {
      const value: unknown = JSON.parse(raw)
      if (
        value &&
        typeof value === 'object' &&
        'draftId' in value &&
        typeof value.draftId === 'string' &&
        'artifactId' in value &&
        typeof value.artifactId === 'string' &&
        'comment' in value &&
        typeof value.comment === 'string'
      ) {
        return {
          draftId: value.draftId,
          artifactId: value.artifactId,
          comment: value.comment,
        }
      }
    } catch {
      storage.removeItem(supportDraftPayloadKey)
    }
    return null
  }, [storage])
  const [preview, setPreview] = useState<{
    bytes: Uint8Array
    capturedAt: string
    url: string
  } | null>(null)
  const [comment, setComment] = useState(recoveredPayload?.comment ?? '')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [pendingPayload, setPendingPayload] = useState(recoveredPayload)
  const [capturing, setCapturing] = useState(!recoveredPayload)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const draftId = useMemo(() => {
    if (recoveredPayload) {
      storage.setItem(supportDraftKey, recoveredPayload.draftId)
      return recoveredPayload.draftId
    }
    const existing = storage.getItem(supportDraftKey)
    if (existing) return existing
    const created = crypto.randomUUID()
    storage.setItem(supportDraftKey, created)
    return created
  }, [recoveredPayload, storage])
  const artifactOperationId = `support-artifact:${draftId}`

  useEffect(() => {
    if (pendingPayload) return
    let cancelled = false
    void desktop
      .loadSupportScreenshotDraft(draftId)
      .then(async (existing) => {
        if (cancelled) return
        if (!existing && keys.peek(artifactOperationId)) {
          throw new Error('pending screenshot is unavailable')
        }
        const result = existing ?? (await desktop.capturePreview())
        if (cancelled) return
        const saved =
          existing ??
          (await desktop.saveSupportScreenshotDraft(
            draftId,
            result.capturedAt,
            result.bytes,
          ))
        if (cancelled) return
        const copy = Uint8Array.from(saved.bytes)
        const blob = new Blob([copy], { type: 'image/jpeg' })
        setPreview((current) => {
          if (current) URL.revokeObjectURL(current.url)
          return {
            bytes: copy,
            capturedAt: saved.capturedAt,
            url: URL.createObjectURL(blob),
          }
        })
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            screenCaptureFailureMessage(
              caught,
              '画面を確認できませんでした。もう一度撮影してください。',
            ),
          )
        }
      })
      .finally(() => {
        if (!cancelled) setCapturing(false)
      })
    return () => {
      cancelled = true
    }
  }, [desktop, draftId, pendingPayload, keys, artifactOperationId])

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url)
    },
    [preview],
  )

  const capture = async () => {
    if (capturing || sending || pendingPayload) return
    if (keys.peek(artifactOperationId)) {
      setError(
        '前回の送信結果を確認するため、保存済みの画面をそのまま再送します。',
      )
      return
    }
    setCapturing(true)
    setError(null)
    try {
      const result = await desktop.capturePreview()
      const saved = await desktop.saveSupportScreenshotDraft(
        draftId,
        result.capturedAt,
        result.bytes,
      )
      if (preview) URL.revokeObjectURL(preview.url)
      const copy = Uint8Array.from(saved.bytes)
      const blob = new Blob([copy], {
        type: 'image/jpeg',
      })
      setPreview({
        bytes: copy,
        capturedAt: saved.capturedAt,
        url: URL.createObjectURL(blob),
      })
    } catch (caught) {
      setError(
        screenCaptureFailureMessage(
          caught,
          '画面を撮影できませんでした。もう一度試してください。',
        ),
      )
    } finally {
      setCapturing(false)
    }
  }

  const send = async () => {
    if (
      (!preview && !pendingPayload) ||
      sending ||
      capturing ||
      codePointLength(comment) > 500
    ) {
      return
    }
    setSending(true)
    setError(null)
    try {
      let requestPayload = pendingPayload
      if (!requestPayload) {
        if (!preview) return
        const savedPreview = await desktop.saveSupportScreenshotDraft(
          draftId,
          preview.capturedAt,
          preview.bytes,
        )
        const artifact = await runIdempotent(
          keys,
          artifactOperationId,
          (idempotencyKey) =>
            api.uploadArtifact(
              {
                purpose: 'REQUEST_SCREENSHOT',
                capturedAt: savedPreview.capturedAt,
                file: new Blob([Uint8Array.from(savedPreview.bytes)], {
                  type: 'image/jpeg',
                }),
                filename: 'screenshot.jpg',
              },
              { idempotencyKey },
            ),
        )
        requestPayload = {
          draftId,
          artifactId: artifact.id,
          comment,
        }
        storage.setItem(supportDraftPayloadKey, JSON.stringify(requestPayload))
        setPendingPayload(requestPayload)
      }
      const request = await runIdempotent(
        keys,
        `support-request:${draftId}`,
        (idempotencyKey) =>
          api.createSupportRequest(
            {
              initialScreenshotArtifactId: requestPayload.artifactId,
              comment: requestPayload.comment,
            },
            { idempotencyKey },
          ),
      )
      storage.removeItem(supportDraftKey)
      storage.removeItem(supportDraftPayloadKey)
      await desktop.deleteSupportScreenshotDraft(draftId).catch(() => {})
      setPendingPayload(null)
      onCreated(request)
    } catch (caught) {
      if (caught instanceof MiteApiError && caught.status === 401) {
        onAuthenticationError()
      }
      setError(messageForError(caught))
    } finally {
      setSending(false)
    }
  }

  return (
    <Surface elevated className="user-request-composer">
      <ScreenHeading
        title="家族に相談する"
        description="送る画面を確認して、下のボタンで知らせましょう。"
      />
      {error ? <ErrorNotice message={error} /> : null}
      {pendingPayload ? (
        <Notice tone="warning" title="前回の送信を確認しています">
          同じ内容で家族への連絡を続けます。
        </Notice>
      ) : null}
      <div className="user-request-fields">
        <div className="user-request-screenshot">
          {preview ? (
            <button
              className="user-request-preview"
              aria-label="家族に送る画面を大きく見る"
              onClick={() => setPreviewOpen(true)}
            >
              <img src={preview.url} alt="家族に送る画面" />
              <span>押すと大きく見られます</span>
            </button>
          ) : (
            <p>家族に送る画面を準備します</p>
          )}
          {!pendingPayload ? (
            <Button
              variant="secondary"
              size="large"
              disabled={capturing || sending}
              onClick={() => void capture()}
            >
              {capturing
                ? '撮影しています…'
                : preview
                  ? '画面を撮り直す'
                  : '画面を撮影する'}
            </Button>
          ) : null}
        </div>
        <label className="user-field">
          <span>困っていること（書かなくても大丈夫です）</span>
          <textarea
            value={comment}
            disabled={sending || Boolean(pendingPayload)}
            maxLength={500}
            rows={3}
            onChange={(event) => setComment(event.target.value)}
            placeholder="例：元の購入画面に戻れない"
          />
          <small>{codePointLength(comment)} / 500文字</small>
        </label>
      </div>
      <div className="user-actions">
        <Button
          variant="secondary"
          size="large"
          disabled={sending || capturing}
          onClick={onCancel}
        >
          戻る
        </Button>
        <Button
          size="large"
          disabled={
            (!preview && !pendingPayload) ||
            sending ||
            capturing ||
            codePointLength(comment) > 500
          }
          onClick={() => void send()}
        >
          {sending
            ? '家族に知らせています…'
            : pendingPayload
              ? '前回の送信を続ける'
              : '家族に相談する'}
        </Button>
      </div>
      <Modal
        title="家族に送る画面"
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
      >
        {preview ? (
          <img
            className="user-request-expanded-preview"
            src={preview.url}
            alt="家族に送る画面の拡大表示"
          />
        ) : null}
        <p>メインの画面全体を送ります。Mite自身の画面は写しません。</p>
      </Modal>
    </Surface>
  )
}

export function EdgeHelpEntry({
  busy = false,
  resumeLabel,
  onResume,
  onAskForHelp,
  onOpenGuides,
  onExpandedChange,
}: {
  busy?: boolean
  resumeLabel?: string
  onResume?(): void
  onAskForHelp(): void
  onOpenGuides(): void
  onExpandedChange(open: boolean): void
}) {
  const [open, setOpen] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const updateOpen = (next: boolean) => {
    setOpen(next)
    onExpandedChange(next)
  }
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (resumeLabel && onResume) onResume()
      else updateOpen(true)
    }, 300)
  }
  const closeLater = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => updateOpen(false), 150)
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  return (
    <aside
      className="user-edge-help"
      data-open={open}
      onMouseEnter={schedule}
      onMouseLeave={closeLater}
      onKeyDown={(event) => {
        if (event.key === 'Escape') updateOpen(false)
      }}
    >
      <button
        className="user-edge-help__tab"
        aria-expanded={open}
        aria-label="家族に相談するメニューを開く"
        type="button"
        onFocus={() => {
          if (resumeLabel && onResume) onResume()
          else updateOpen(true)
        }}
        onClick={() => {
          if (resumeLabel && onResume) onResume()
          else updateOpen(!open)
        }}
      />
      <div className="user-edge-help__panel" aria-hidden={!open} inert={!open}>
        <strong>操作に困りましたか？</strong>
        <p>いま見ている画面を家族に送り、相談できます。</p>
        {resumeLabel && onResume ? (
          <Button block size="large" onClick={onResume}>
            {resumeLabel}
          </Button>
        ) : null}
        <Button block size="large" disabled={busy} onClick={onAskForHelp}>
          家族に相談する
        </Button>
        <Button
          block
          size="large"
          variant="secondary"
          disabled={busy}
          onClick={onOpenGuides}
        >
          保存した手順を見る
        </Button>
      </div>
    </aside>
  )
}

function GuideList({
  api,
  guides,
  loading,
  onReload,
  onStart,
  onAskForHelp,
}: {
  api: MiteApi
  guides: GuideSummary[]
  loading: boolean
  onReload(): void
  onStart(guide: GuideSummary): void
  onAskForHelp(): void
}) {
  return (
    <Surface elevated>
      <ScreenHeading
        eyebrow="保存した手順"
        title="今日は何をしますか？"
        description="以前に家族と解決した操作を、1つずつ確認できます。"
        aside={
          <Button variant="secondary" onClick={onReload}>
            一覧を更新する
          </Button>
        }
      />
      {loading ? (
        <LoadingState>手順を読み込んでいます</LoadingState>
      ) : guides.length === 0 ? (
        <EmptyState
          symbol="☘"
          title="保存した手順はまだありません"
          description="困ったときは、画面の左端に触れると家族へ相談できます。"
          action={<Button onClick={onAskForHelp}>家族に相談する</Button>}
        />
      ) : (
        <div className="user-guide-grid">
          {guides.map((guide) => (
            <article className="user-guide-card" key={guide.id}>
              <ArtifactImage
                api={api}
                artifactId={guide.representativeArtifactId}
                alt="手順の最初の画面"
              />
              <div>
                <h2>{guide.title}</h2>
                <p>画面を見ながら、1つずつ進めます。</p>
                <Button size="large" onClick={() => onStart(guide)}>
                  この手順を始める
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
    </Surface>
  )
}

function WaitingScreen({ request }: { request: SupportRequest }) {
  return (
    <Surface elevated>
      <EmptyState
        symbol="✓"
        title="家族に知らせました"
        description="家族から連絡が来るまで、このままお待ちください。"
      />
      <div className="user-request-summary">
        <strong>相談したこと</strong>
        <p>{request.comment || '画面を見て相談したい'}</p>
      </div>
    </Surface>
  )
}

function IncomingCallScreen({
  session,
  busy,
  error,
  onAccept,
  onClose,
}: {
  session: SupportSession
  busy: boolean
  error: string | null
  onAccept(): void
  onClose(): void
}) {
  return (
    <Modal
      title="家族が待っています"
      busy={busy}
      onClose={onClose}
      actions={
        <Button
          block
          size="large"
          variant="call"
          disabled={busy || session.status !== 'RINGING'}
          onClick={onAccept}
        >
          {busy ? 'つないでいます…' : '同意して応答する'}
        </Button>
      }
    >
      <p>内容を確認し、同意して応答すると通話と画面共有が始まります。</p>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="user-consent-copy">{consentText}</div>
    </Modal>
  )
}

function ActiveSupportScreen({
  source,
  screenSharing,
  mediaState,
  microphoneEnabled,
  audioLevel,
  captureCount,
  captureLimitReached,
  captureError,
  busy,
  error,
  onStartSharing,
  onStopSharing,
  onToggleMicrophone,
}: {
  source: ScreenSharePreview | null
  screenSharing: boolean
  mediaState: MediaConnectionState
  microphoneEnabled: boolean
  audioLevel: number
  captureCount: number
  captureLimitReached: boolean
  captureError: string | null
  busy: boolean
  error: string | null
  onStartSharing(): void
  onStopSharing(): void
  onToggleMicrophone(): void
}) {
  return (
    <Surface elevated>
      <ScreenHeading
        eyebrow="家族が支援中"
        title="家族とつながっています"
        description="操作はあなた自身が行います。家族が示した場所は、いま操作している画面に丸で表示されます。"
        aside={
          <StatusBadge tone={mediaState === 'CONNECTED' ? 'active' : 'warning'}>
            {mediaState === 'CONNECTED'
              ? '通話中'
              : mediaState === 'CONNECTING'
                ? 'つないでいます'
                : 'つなぎ直してください'}
          </StatusBadge>
        }
      />
      {error ? <ErrorNotice message={error} /> : null}
      {captureError && screenSharing ? (
        <Notice tone="warning" title="画面の保存をやり直しています">
          {captureError}
        </Notice>
      ) : null}
      {captureLimitReached ? (
        <Notice tone="warning" title="保存できる画面が上限に達しました">
          通話と画面共有はそのまま続けられます。
        </Notice>
      ) : null}
      {!screenSharing ? (
        <div className="user-stack">
          <Notice tone="info" title="家族に画面全体を見せます">
            メインの画面全体を共有します。Mite自身の画面は写しません。
          </Notice>
          <Button
            size="large"
            disabled={
              busy ||
              mediaState === 'CONNECTING' ||
              mediaState === 'RECONNECTING'
            }
            onClick={onStartSharing}
          >
            {source ? '画面全体の共有を再開する' : '画面全体を共有する'}
          </Button>
          {busy ? <p role="status">画面を共有しています…</p> : null}
        </div>
      ) : (
        <Notice tone="info" title="画面全体を共有中">
          「しまう」でこのパネルを閉じて操作できます。家族の操作案内は、そのまま画面に表示されます。
        </Notice>
      )}
      <div className="user-support-controls">
        <div className="user-audio-level">
          <span>家族の声</span>
          <progress max={1} value={audioLevel} aria-label="家族の声の大きさ" />
        </div>
        <span>保存した画面：{captureCount}枚</span>
        <Button
          variant="secondary"
          disabled={mediaState === 'DISCONNECTED'}
          onClick={onToggleMicrophone}
        >
          {microphoneEnabled ? '自分の声を止める' : '自分の声を届ける'}
        </Button>
        {screenSharing ? (
          <Button variant="danger" onClick={onStopSharing}>
            画面共有を止める
          </Button>
        ) : null}
      </div>
    </Surface>
  )
}

function GeneratingGuideScreen({
  progress,
  error,
  onRetry,
}: {
  progress: MaterialUploadProgress | null
  error: string | null
  onRetry(): void
}) {
  return (
    <Surface elevated>
      <EmptyState
        symbol="…"
        title="手順を準備しています"
        description={
          progress
            ? `保存した画面を送っています（${progress.completed} / ${progress.total}枚）`
            : '家族が見やすい手順を準備しています。このままお待ちください。'
        }
      />
      {progress ? (
        <progress
          className="user-upload-progress"
          max={Math.max(progress.total, 1)}
          value={progress.completed}
          aria-label="画面を送った数"
        />
      ) : null}
      {error ? <ErrorNotice message={error} onRetry={onRetry} /> : null}
    </Surface>
  )
}

function DraftViewer({ api, draft }: { api: MiteApi; draft: GuideDraft }) {
  const [selected, setSelected] = useState(0)
  const index = Math.min(selected, draft.steps.length - 1)
  const step = draft.steps[index]
  return (
    <Surface elevated>
      <ScreenHeading
        eyebrow="家族が確認中"
        title={draft.title}
        description="家族が手順を整えています。内容は自動で新しくなります。"
      />
      {step ? (
        <div className="user-guide-step">
          <ArtifactImage
            api={api}
            artifactId={step.artifactId}
            alt={`手順${step.position}の画面`}
          />
          <div>
            <span>
              手順 {step.position} / {draft.steps.length}
            </span>
            <p>{step.instruction}</p>
          </div>
        </div>
      ) : null}
      <div className="user-actions user-actions--spread">
        <Button
          variant="secondary"
          disabled={index <= 0}
          onClick={() => setSelected(index - 1)}
        >
          前の手順
        </Button>
        <Button
          disabled={index >= draft.steps.length - 1}
          onClick={() => setSelected(index + 1)}
        >
          次の手順
        </Button>
      </div>
    </Surface>
  )
}

function EndedScreen({
  session,
  onDone,
}: {
  session: SupportSession
  onDone(): void
}) {
  const message =
    session.endReason === 'GUIDE_SAVED'
      ? '新しい手順を保存しました。次から一人で確認できます。'
      : session.endReason === 'NO_MATERIALS'
        ? '画像を保存できなかったため手順を作れませんでした。'
        : session.endReason === 'GUIDE_CANCELLED'
          ? '今回は手順を作らずに相談を終えました。'
          : '相談を終えました。'
  return (
    <Surface elevated>
      <EmptyState
        symbol="✓"
        title="相談が終わりました"
        description={message}
        action={
          <Button size="large" onClick={onDone}>
            閉じる
          </Button>
        }
      />
    </Surface>
  )
}

function GuideSupportComposer({
  desktop,
  run,
  keys,
  storage,
  busy,
  onAsk,
}: {
  desktop: UserDesktopBridge
  run: GuideRun
  keys: IdempotencyKeyStore
  storage: KeyValueStorage
  busy: boolean
  onAsk(
    preview: { bytes: Uint8Array; capturedAt: string },
    comment: string,
  ): void
}) {
  const draftId = `guide_${run.id}_${run.revision}`
  const artifactOperationId = `guide-support-artifact:${run.id}:${run.revision}`
  const payloadKey = `mite.user.guideSupportPayload:${run.id}:${run.revision}`
  const pendingPayload = storage.getItem(payloadKey)
  const [comment, setComment] = useState(() => {
    try {
      const saved: unknown = JSON.parse(pendingPayload ?? 'null')
      return saved &&
        typeof saved === 'object' &&
        'comment' in saved &&
        typeof saved.comment === 'string'
        ? saved.comment
        : ''
    } catch {
      return ''
    }
  })
  const [preview, setPreview] = useState<{
    bytes: Uint8Array
    capturedAt: string
    url: string
  } | null>(null)
  const [capturing, setCapturing] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void desktop
      .loadSupportScreenshotDraft(draftId)
      .then(async (existing) => {
        if (cancelled) return
        if (
          !existing &&
          (keys.peek(artifactOperationId) || storage.getItem(payloadKey))
        ) {
          throw new Error('pending screenshot is unavailable')
        }
        const result = existing ?? (await desktop.capturePreview())
        if (cancelled) return
        const saved =
          existing ??
          (await desktop.saveSupportScreenshotDraft(
            draftId,
            result.capturedAt,
            result.bytes,
          ))
        if (cancelled) return
        const bytes = Uint8Array.from(saved.bytes)
        setPreview({
          bytes,
          capturedAt: saved.capturedAt,
          url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
        })
      })
      .catch((caught) => {
        if (!cancelled)
          setError(
            screenCaptureFailureMessage(
              caught,
              '画面を確認できませんでした。もう一度試してください。',
            ),
          )
      })
      .finally(() => {
        if (!cancelled) setCapturing(false)
      })
    return () => {
      cancelled = true
    }
  }, [desktop, draftId, keys, artifactOperationId, storage, payloadKey])

  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url)
    },
    [preview],
  )

  const capture = async () => {
    if (busy || capturing) return
    if (keys.peek(artifactOperationId) || storage.getItem(payloadKey)) {
      setError(
        '前回の送信結果を確認するため、保存済みの画面をそのまま再送します。',
      )
      return
    }
    setCapturing(true)
    setError(null)
    try {
      const result = await desktop.capturePreview()
      const saved = await desktop.saveSupportScreenshotDraft(
        draftId,
        result.capturedAt,
        result.bytes,
      )
      const bytes = Uint8Array.from(saved.bytes)
      setPreview({
        bytes,
        capturedAt: saved.capturedAt,
        url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })),
      })
    } catch (caught) {
      setError(
        screenCaptureFailureMessage(
          caught,
          '画面を撮影できませんでした。もう一度試してください。',
        ),
      )
    } finally {
      setCapturing(false)
    }
  }

  return (
    <div className="user-ask-panel">
      <h3>いま困っている画面を家族に見せる</h3>
      <p>メインの画面全体を撮影します。Mite自身の画面は写しません。</p>
      {error ? <ErrorNotice message={error} /> : null}
      <Button
        variant="secondary"
        size="large"
        disabled={busy || capturing}
        onClick={() => void capture()}
      >
        {capturing
          ? '撮影しています…'
          : preview
            ? '画面を撮り直す'
            : '画面を撮影する'}
      </Button>
      {preview ? (
        <img
          className="user-ask-preview"
          src={preview.url}
          alt="家族に送る現在の画面"
        />
      ) : null}
      <label className="user-field">
        <span>家族に伝えたいこと</span>
        <textarea
          rows={3}
          maxLength={500}
          value={comment}
          disabled={busy || Boolean(pendingPayload)}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      <Button
        size="large"
        disabled={
          !preview || busy || capturing || codePointLength(comment) > 500
        }
        onClick={() => {
          if (preview) onAsk(preview, comment)
        }}
      >
        この場所から家族に相談する
      </Button>
    </div>
  )
}

function GuideRunner({
  api,
  desktop,
  run,
  guide,
  busy,
  error,
  onMove,
  onComplete,
  inCall,
  onAsk,
  keys,
  storage,
}: {
  keys: IdempotencyKeyStore
  storage: KeyValueStorage
  api: MiteApi
  desktop: UserDesktopBridge
  run: GuideRun
  guide: GuideDetail
  busy: boolean
  error: string | null
  inCall: boolean
  onMove(action: 'NEXT' | 'PREVIOUS'): void
  onComplete(): void
  onAsk(
    preview: { bytes: Uint8Array; capturedAt: string },
    comment: string,
  ): void
}) {
  const [asking, setAsking] = useState(false)
  const [hasAsked, setHasAsked] = useState(false)
  const step = guide.currentVersion.steps[run.currentStepNumber - 1]
  const isLast = run.currentStepNumber === guide.currentVersion.steps.length

  if (!step) {
    return (
      <ErrorNotice message="この手順を表示できません。いったん一覧へ戻ってください。" />
    )
  }
  return (
    <Surface elevated>
      <ScreenHeading
        eyebrow={`${run.currentStepNumber} / ${guide.currentVersion.steps.length}`}
        title={guide.title}
        description="画面と説明を見ながら、1つずつ操作してください。"
      />
      {error ? <ErrorNotice message={error} /> : null}
      <div className="user-guide-step">
        <ArtifactImage
          api={api}
          artifactId={step.artifactId}
          alt={`手順${step.position}の画面`}
        />
        <div>
          <span>手順 {step.position}</span>
          <p>{step.instruction}</p>
        </div>
      </div>
      <div className="user-actions user-actions--spread">
        <Button
          variant="secondary"
          size="large"
          disabled={busy || run.currentStepNumber === 1}
          onClick={() => onMove('PREVIOUS')}
        >
          戻る
        </Button>
        <Button
          variant="quiet"
          size="large"
          disabled={busy || inCall}
          onClick={() => {
            setHasAsked(true)
            setAsking((current) => !current)
          }}
        >
          {inCall ? '通話中の家族に聞けます' : '家族に聞く'}
        </Button>
        {isLast ? (
          <Button size="large" disabled={busy} onClick={onComplete}>
            完了する
          </Button>
        ) : (
          <Button size="large" disabled={busy} onClick={() => onMove('NEXT')}>
            次へ
          </Button>
        )}
      </div>
      {hasAsked ? (
        <div hidden={!asking}>
          <Modal
            title="家族に聞く"
            open={asking}
            onClose={() => setAsking(false)}
            busy={busy}
          >
            <GuideSupportComposer
              key={`${run.id}:${run.revision}`}
              desktop={desktop}
              run={run}
              keys={keys}
              storage={storage}
              busy={busy}
              onAsk={onAsk}
            />
          </Modal>
        </div>
      ) : null}
    </Surface>
  )
}

export function UserClient({
  api,
  runtime,
  desktop,
  storage = window.localStorage,
  createEventStream = defaultEventStreamFactory,
  createMediaSession = defaultMediaSessionFactory,
}: UserClientProps) {
  const [restoring, setRestoring] = useState(true)
  const [fatalConfiguration, setFatalConfiguration] = useState(false)
  const [request, setRequest] = useState<SupportRequest | null>(null)
  const [session, setSession] = useState<SupportSession | null>(null)
  const [draft, setDraft] = useState<GuideDraft | null>(null)
  const [guides, setGuides] = useState<GuideSummary[]>([])
  const [guidesLoading, setGuidesLoading] = useState(false)
  const [guide, setGuide] = useState<GuideDetail | null>(null)
  const [guideRun, setGuideRun] = useState<GuideRun | null>(null)
  const [view, setView] = useState<'HOME' | 'REQUEST'>('HOME')
  const [overlayCollapsed, setOverlayCollapsed] = useState(true)
  const [closedSavedSession, setClosedSavedSession] = useState<string | null>(
    null,
  )
  const [connectionStatus, setConnectionStatus] =
    useState<EventConnectionStatus>('CONNECTING')
  const [actionBusy, setActionBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mediaState, setMediaState] =
    useState<MediaConnectionState>('DISCONNECTED')
  const [screenSource, setScreenSource] = useState<ScreenSharePreview | null>(
    null,
  )
  const [screenSharing, setScreenSharing] = useState(false)
  const [microphoneEnabled, setMicrophoneEnabled] = useState(true)
  const [audioLevel, setAudioLevel] = useState(0)
  const [localAudioLevel, setLocalAudioLevel] = useState(0)
  const [marks, setMarks] = useState<DesktopMark[]>([])
  const [captureError, setCaptureError] = useState<string | null>(null)
  const [captureCount, setCaptureCount] = useState(0)
  const [captureLimitReached, setCaptureLimitReached] = useState(false)
  const [uploadProgress, setUploadProgress] =
    useState<MaterialUploadProgress | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [uploadRetry, setUploadRetry] = useState(0)
  const requestRef = useRef<SupportRequest | null>(null)
  const sessionRef = useRef<SupportSession | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const screenSharingRef = useRef(false)
  const sharingAttemptSession = useRef<string | null>(null)
  const resumeAfterGuideSession = useRef<string | null>(null)
  const guidePauseRef = useRef<Promise<void>>(Promise.resolve())
  const guidePauseMediaRef = useRef<UserMediaSession | null>(null)
  const resumeSharingRef = useRef<() => Promise<void>>(async () => {})
  const mediaGenerationRef = useRef(0)
  const mediaRef = useRef<UserMediaSession | null>(null)
  const volumePreparedSessions = useRef(new Set<string>())
  const captureTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const captureInFlightRef = useRef(false)
  const captureGenerationRef = useRef(0)
  const markTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastUploadRef = useRef<string | null>(null)
  const uploadInFlightRef = useRef<string | null>(null)
  const keys = useMemo(() => new IdempotencyKeyStore(storage), [storage])
  useEffect(
    () => desktop.onOverlayCollapsed(() => setOverlayCollapsed(true)),
    [desktop],
  )
  const supportScreen = deriveUserSupportScreen(request, session)
  const reportError = useCallback((caught: unknown) => {
    if (caught instanceof MiteApiError && caught.status === 401) {
      setFatalConfiguration(true)
      setOverlayCollapsed(false)
      return
    }
    setError(messageForError(caught))
  }, [])

  useEffect(() => {
    requestRef.current = request
  }, [request])
  useEffect(() => {
    sessionRef.current = session
  }, [session])
  useEffect(() => {
    if (restoring) return
    void desktop
      .setOverlayMode(overlayCollapsed ? 'COLLAPSED' : 'DETAIL')
      .then(() => {
        if (overlayCollapsed) return
        const dialog = document.querySelector<HTMLElement>(
          '.user-overlay-detail [role="dialog"]',
        )
        if (dialog && !dialog.closest('[hidden]')) dialog.focus()
      })
      .catch(() => setFatalConfiguration(true))
  }, [desktop, overlayCollapsed, restoring])

  const mergeRequest = useCallback(
    (incoming: SupportRequest) => {
      setRequest((current) => selectNewestRevision(current, incoming))
      requestRef.current = selectNewestRevision(requestRef.current, incoming)
      storage.setItem(lastRequestKey, incoming.id)
    },
    [storage],
  )

  const mergeSession = useCallback((incoming: SupportSession) => {
    setSession((current) => selectNewestRevision(current, incoming))
    sessionRef.current = selectNewestRevision(sessionRef.current, incoming)
  }, [])

  const stopCapturing = useCallback(() => {
    captureGenerationRef.current += 1
    if (captureTimerRef.current) clearInterval(captureTimerRef.current)
    captureTimerRef.current = null
  }, [])

  const clearCircleMarks = useCallback(() => {
    setMarks([])
    for (const timer of markTimers.current.values()) clearTimeout(timer)
    markTimers.current.clear()
    void desktop.setMarkings([]).catch(() => {})
  }, [desktop])

  const clearMarks = useCallback(() => {
    clearCircleMarks()
    void desktop.setGuidance(null).catch(() => {})
  }, [clearCircleMarks, desktop])

  useEffect(() => {
    void desktop.setMarkings(marks).catch(() => {
      if (marks.length) setError('家族が示した丸を表示できませんでした。')
    })
  }, [desktop, marks])

  const disconnectMedia = useCallback(async () => {
    mediaGenerationRef.current += 1
    resumeAfterGuideSession.current = null
    screenSharingRef.current = false
    stopCapturing()
    const media = mediaRef.current
    mediaRef.current = null
    setScreenSharing(false)
    clearMarks()
    setAudioLevel(0)
    if (media) await media.disconnect()
    setMediaState('DISCONNECTED')
  }, [clearMarks, stopCapturing])

  const loadGuides = useCallback(async () => {
    setGuidesLoading(true)
    try {
      setGuides(await api.listGuides())
    } catch (caught) {
      reportError(caught)
    } finally {
      setGuidesLoading(false)
    }
  }, [api, reportError])

  const applySupportState = useCallback(
    async (nextRequest: SupportRequest, nextSession: SupportSession | null) => {
      const previousRequest = requestRef.current
      const previousSession = sessionRef.current
      const effectiveRequest = selectNewestRevision(
        previousRequest,
        nextRequest,
      )
      mergeRequest(effectiveRequest)
      if (!nextSession) {
        if (!previousRequest && effectiveRequest.status !== 'RESOLVED') {
          setOverlayCollapsed(false)
        }
        if (!effectiveRequest.supportSessionId) {
          setSession(null)
          sessionRef.current = null
        }
        return
      }
      const effectiveSession = selectNewestRevision(
        previousSession,
        nextSession,
      )
      mergeSession(effectiveSession)
      if (effectiveSession.status !== 'ACTIVE') stopCapturing()
      if (
        canContinueCall(effectiveSession) &&
        !canShareScreen(effectiveSession)
      ) {
        if (
          screenSharingRef.current ||
          sharingAttemptSession.current === effectiveSession.id
        )
          resumeAfterGuideSession.current = effectiveSession.id
        screenSharingRef.current = false
        setScreenSharing(false)
        clearMarks()
        if (canShareScreen(previousSession)) {
          const media = mediaRef.current
          guidePauseMediaRef.current = media
          guidePauseRef.current = (async () => {
            try {
              await media?.stopScreenShare()
            } catch {
              // If unpublishing fails, stop the room to prevent continued sharing.
              await disconnectMedia()
              setError(
                '画面共有を止めるため通話を切りました。音声通話をつなぎ直してください。',
              )
            } finally {
              if (guidePauseMediaRef.current === media)
                guidePauseMediaRef.current = null
            }
          })()
          await guidePauseRef.current
        }
      }
      if (
        effectiveSession.status === 'RINGING' &&
        previousSession?.status !== 'RINGING'
      )
        setOverlayCollapsed(false)
      if (
        effectiveSession.status === 'ACTIVE' &&
        previousSession?.status === 'RINGING'
      )
        setOverlayCollapsed(true)
      if (
        effectiveSession.status === 'GUIDE_SAVED' &&
        previousSession?.status !== 'GUIDE_SAVED'
      )
        await loadGuides()
      if (!previousSession && effectiveSession.status !== 'ENDED')
        setOverlayCollapsed(false)
      if (
        effectiveSession.status === 'REVIEWING_GUIDE' &&
        effectiveSession.guideDraftId
      ) {
        const nextDraft = await api.getGuideDraft(effectiveSession.guideDraftId)
        setDraft((current) => selectNewestRevision(current, nextDraft))
      }
      if (!canContinueCall(effectiveSession)) await disconnectMedia()
      if (effectiveSession.status === 'ENDED') {
        await desktop.deleteCaptureSession(effectiveSession.id).catch(() => {})
      }
    },
    [
      api,
      desktop,
      disconnectMedia,
      clearMarks,
      mergeRequest,
      mergeSession,
      stopCapturing,
      loadGuides,
    ],
  )

  const refreshSupport = useCallback(async () => {
    const requestId = requestRef.current?.id ?? storage.getItem(lastRequestKey)
    if (!requestId) return
    const fetchedRequest = await api.getSupportRequest(requestId)
    const nextRequest = selectNewestRevision(requestRef.current, fetchedRequest)
    const nextSession = nextRequest.supportSessionId
      ? await api.getSupportSession(nextRequest.supportSessionId)
      : null
    await applySupportState(nextRequest, nextSession)
  }, [api, applySupportState, storage])
  useEffect(() => {
    refreshRef.current = refreshSupport
  }, [refreshSupport])

  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      setRestoring(true)
      try {
        const listed = await api.listSupportRequests()
        const sorted = [...listed].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        )
        let selectedRequest: SupportRequest | null = null
        let selectedSession: SupportSession | null = null
        for (const candidate of sorted) {
          if (candidate.status === 'PENDING' && !candidate.supportSessionId) {
            selectedRequest = candidate
            break
          }
          if (candidate.supportSessionId) {
            const candidateSession = await api.getSupportSession(
              candidate.supportSessionId,
            )
            if (candidateSession.status !== 'ENDED') {
              selectedRequest = candidate
              selectedSession = candidateSession
              break
            }
          }
        }
        const savedRequestId = storage.getItem(lastRequestKey)
        if (!selectedRequest && savedRequestId) {
          try {
            selectedRequest = await api.getSupportRequest(savedRequestId)
            selectedSession = selectedRequest.supportSessionId
              ? await api.getSupportSession(selectedRequest.supportSessionId)
              : null
          } catch (caught) {
            if (caught instanceof MiteApiError && caught.status === 404) {
              storage.removeItem(lastRequestKey)
            } else {
              throw caught
            }
          }
        }
        if (cancelled) return
        if (selectedRequest) {
          await applySupportState(selectedRequest, selectedSession)
        }
        if (!selectedRequest || selectedSession?.status === 'GUIDE_SAVED') {
          const savedRunId = storage.getItem(guideRunKey)
          if (savedRunId) {
            const restoredRun = await api.getGuideRun(savedRunId)
            if (restoredRun.status === 'COMPLETED') {
              storage.removeItem(guideRunKey)
            } else if (
              restoredRun.status === 'PAUSED_FOR_SUPPORT' &&
              restoredRun.supportRequestId
            ) {
              const supportRequest = await api.getSupportRequest(
                restoredRun.supportRequestId,
              )
              const supportSession = supportRequest.supportSessionId
                ? await api.getSupportSession(supportRequest.supportSessionId)
                : null
              await applySupportState(supportRequest, supportSession)
            } else {
              setGuideRun(restoredRun)
              setGuide(await api.getGuide(restoredRun.guideId))
              setOverlayCollapsed(false)
            }
          }
        }
        await loadGuides()

        const now = Date.now()
        const localSessions = await desktop.listCaptureSessions()
        for (const local of localSessions) {
          if (local.error || !local.manifest) {
            setError(
              '保存した画面の記録に問題があります。消さずに残しているため、担当者へ確認してください。',
            )
            continue
          }
          if (now - Date.parse(local.modifiedAt) < 24 * 60 * 60 * 1_000)
            continue
          try {
            const serverSession = await api.getSupportSession(
              local.supportSessionId,
            )
            if (serverSession.status === 'ENDED') {
              await desktop.deleteCaptureSession(local.supportSessionId)
            }
          } catch (caught) {
            if (caught instanceof MiteApiError && caught.status === 404) {
              await desktop.deleteCaptureSession(local.supportSessionId)
            }
          }
        }
      } catch (caught) {
        reportError(caught)
      } finally {
        if (!cancelled) setRestoring(false)
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [api, applySupportState, desktop, loadGuides, reportError, storage])

  useEffect(() => {
    const stream = createEventStream({
      apiBaseUrl: runtime.apiBaseUrl,
      token: runtime.demoToken,
      onStatusChange: (status) => {
        setConnectionStatus(status)
        if (status === 'CONNECTED') {
          void refreshRef.current().catch((caught) => {
            reportError(caught)
          })
        }
      },
      onEvent: () => {
        void refreshRef.current().catch((caught) => {
          reportError(caught)
        })
      },
    })
    stream.start()
    return () => stream.stop()
  }, [createEventStream, reportError, runtime.apiBaseUrl, runtime.demoToken])

  useEffect(() => {
    if (
      !request ||
      ![
        'WAITING_FOR_FAMILY',
        'INCOMING_CALL',
        'ACTIVE_SUPPORT',
        'GUIDE_GENERATING',
        'GUIDE_DRAFT_REVIEW',
        'GUIDE_SAVED',
      ].includes(supportScreen)
    ) {
      return
    }
    const polling = startPolling(refreshSupport, {
      immediate: false,
      intervalMs: 5_000,
      onError: reportError,
    })
    return () => polling.stop()
  }, [refreshSupport, reportError, request, supportScreen])

  useEffect(() => {
    if (!session || session.status !== 'GENERATING_GUIDE') return
    stopCapturing()
    const uploadKey = `${session.id}:${session.revision}:${uploadRetry}`
    if (
      lastUploadRef.current === uploadKey ||
      uploadInFlightRef.current !== null
    ) {
      return
    }
    setUploadError(null)
    lastUploadRef.current = uploadKey
    uploadInFlightRef.current = session.id
    void uploadCapturedMaterials({
      api,
      desktop,
      session,
      onProgress: setUploadProgress,
    })
      .then((updated) => {
        mergeSession(updated)
        setUploadProgress(null)
        void refreshSupport()
      })
      .catch((caught) => {
        if (caught instanceof MiteApiError && caught.status === 401) {
          setFatalConfiguration(true)
        } else {
          setUploadError(messageForError(caught))
        }
      })
      .finally(() => {
        uploadInFlightRef.current = null
      })
  }, [
    api,
    desktop,
    mergeSession,
    refreshSupport,
    session,
    uploadRetry,
    stopCapturing,
  ])

  useEffect(
    () => () => {
      mediaGenerationRef.current += 1
      screenSharingRef.current = false
      stopCapturing()
      const media = mediaRef.current
      mediaRef.current = null
      void media?.disconnect()
      clearMarks()
    },
    [clearMarks, stopCapturing],
  )

  const acceptCall = async () => {
    if (!session) return
    setActionBusy(true)
    setError(null)
    try {
      const result = await runIdempotent(
        keys,
        `accept:${session.id}:${session.revision}`,
        (idempotencyKey) =>
          api.acceptSupportSession(
            session.id,
            {
              expectedSessionRevision: session.revision,
              consent: {
                audio: true,
                screenShare: true,
                periodicCapture: true,
                textVersion: 'v3',
              },
            },
            { idempotencyKey },
          ),
      )
      mergeRequest(result.supportRequest)
      mergeSession(result.supportSession)
      setOverlayCollapsed(true)
      await sharePrimaryScreen(result.supportSession)
    } catch (caught) {
      reportError(caught)
      if (caught instanceof MiteApiError && caught.status === 409) {
        await refreshSupport().catch(() => {})
      }
    } finally {
      setActionBusy(false)
    }
  }

  const recordMarking = useCallback(
    (message: MarkingMessage) => {
      if (!screenSharingRef.current) return
      if (message.type === 'mark.clear') {
        setMarks([])
        for (const timer of markTimers.current.values()) clearTimeout(timer)
        markTimers.current.clear()
        return
      }
      void desktop.setGuidance(null).catch(() => {})
      setMarks((current) => [
        ...current.filter((mark) => mark.id !== message.markId),
        {
          id: message.markId,
          x: message.x,
          y: message.y,
          expiresAt: Date.now() + message.ttlMs,
        },
      ])
      const existing = markTimers.current.get(message.markId)
      if (existing) clearTimeout(existing)
      markTimers.current.set(
        message.markId,
        setTimeout(() => {
          setMarks((current) =>
            current.filter((mark) => mark.id !== message.markId),
          )
          markTimers.current.delete(message.markId)
        }, message.ttlMs),
      )
    },
    [desktop],
  )

  const takeCapture = useCallback(
    async (supportSessionId: string): Promise<boolean> => {
      if (
        captureInFlightRef.current ||
        !canCaptureGuideMaterial(sessionRef.current, screenSharingRef.current)
      )
        return false
      captureInFlightRef.current = true
      try {
        const result = await desktop.saveCapture(supportSessionId)
        setCaptureError(null)
        setCaptureCount(result.manifest.captures.length)
        if (result.reachedLimit) {
          setCaptureLimitReached(true)
          stopCapturing()
        }
        return result.reachedLimit
      } catch {
        setCaptureError(
          '画面を保存できませんでした。通話と画面共有は続いています。自動で保存をやり直します。',
        )
        return false
      } finally {
        captureInFlightRef.current = false
      }
    },
    [desktop, stopCapturing],
  )

  const startCapturing = useCallback(
    async (supportSessionId: string) => {
      stopCapturing()
      if (
        !canCaptureGuideMaterial(sessionRef.current, screenSharingRef.current)
      )
        return
      const generation = captureGenerationRef.current
      try {
        const manifest =
          await desktop.initializeCaptureSession(supportSessionId)
        if (generation !== captureGenerationRef.current) return
        setCaptureCount(manifest.captures.length)
        const alreadyAtLimit =
          manifest.captures.length >= runtime.captureMaxCount
        setCaptureLimitReached(alreadyAtLimit)
        if (alreadyAtLimit) return
        const reachedLimit = await takeCapture(supportSessionId)
        if (reachedLimit) return
      } catch {
        setCaptureError(
          '画面を保存する準備ができませんでした。通話と画面共有は続いています。自動で保存をやり直します。',
        )
      }
      if (generation !== captureGenerationRef.current) return
      captureTimerRef.current = setInterval(() => {
        void takeCapture(supportSessionId)
      }, CAPTURE_INTERVAL_MS)
    },
    [desktop, runtime.captureMaxCount, stopCapturing, takeCapture],
  )

  const sharePrimaryScreen = async (acceptedSession?: SupportSession) => {
    const sharingSession = acceptedSession ?? sessionRef.current
    if (
      !sharingSession ||
      !canContinueCall(sharingSession) ||
      (actionBusy && !acceptedSession)
    )
      return
    if (mediaState === 'CONNECTING' || mediaState === 'RECONNECTING') {
      setError('家族との通話をつなぎ直しています。少し待ってください。')
      return
    }
    setActionBusy(true)
    setError(null)
    const generation = ++mediaGenerationRef.current
    sharingAttemptSession.current = canShareScreen(sharingSession)
      ? sharingSession.id
      : null
    const isCurrentShare = () =>
      generation === mediaGenerationRef.current &&
      sessionRef.current?.id === sharingSession.id &&
      canContinueCall(sessionRef.current)
    try {
      const current = await api.getSupportSession(sharingSession.id)
      const activeRequest = requestRef.current
      if (activeRequest) await applySupportState(activeRequest, current)
      else mergeSession(current)
      if (!canContinueCall(sessionRef.current)) return
      if (!isCurrentShare()) return
      let media = mediaRef.current
      const startingCall = !media || mediaState === 'DISCONNECTED'
      if (!media || startingCall) {
        if (media) {
          mediaRef.current = null
          await media.disconnect()
        }
        media = createMediaSession()
        mediaRef.current = media
        if (!volumePreparedSessions.current.has(current.id)) {
          volumePreparedSessions.current.add(current.id)
          await desktop
            .prepareSpeakerVolume()
            .catch(() =>
              setError(
                'スピーカーの音量を確認してください。通話は続けられます。',
              ),
            )
        }
        if (!isCurrentShare()) return
        const token = await api.getLiveKitToken(current.id)
        if (!isCurrentShare()) return
        await media.connect(
          token,
          {
            onStateChange: (state) => {
              if (mediaRef.current !== media) return
              setMediaState(state)
              if (state === 'RECONNECTING' || state === 'DISCONNECTED') {
                mediaGenerationRef.current += 1
                screenSharingRef.current = false
                clearMarks()
                stopCapturing()
                setScreenSharing(false)
                setError(
                  canShareScreen(sessionRef.current)
                    ? '家族との通話が途切れました。状態を確認して、画面共有を再開してください。'
                    : '家族との通話が途切れました。音声通話をつなぎ直してください。',
                )
              }
            },
            onMarking: recordMarking,
            onGuidance: (message) => {
              if (mediaRef.current !== media || !screenSharingRef.current)
                return
              if (message === null || message.type === 'guidance.clear') {
                void desktop.setGuidance(null).catch(() => {})
                return
              }
              clearCircleMarks()
              void desktop
                .setGuidance({
                  ...message,
                  expiresAt: Date.now() + message.ttlMs,
                })
                .catch(() => setError('家族の操作案内を表示できませんでした。'))
            },
            onAudioLevel: setAudioLevel,
            onLocalAudioLevel: setLocalAudioLevel,
            onScreenShareStopped: () => {
              if (mediaRef.current !== media) return
              // A delayed guide pause must not cancel the queued resume after save.
              if (guidePauseMediaRef.current !== media)
                mediaGenerationRef.current += 1
              screenSharingRef.current = false
              stopCapturing()
              setScreenSharing(false)
              clearMarks()
            },
          },
          { shareScreen: false },
        )
        if (startingCall) setMicrophoneEnabled(true)
      }
      if (!isCurrentShare()) {
        if (!canContinueCall(sessionRef.current) || mediaRef.current !== media)
          await media.disconnect()
        return
      }
      if (!canShareScreen(sessionRef.current)) return
      await guidePauseRef.current
      if (!isCurrentShare() || !canShareScreen(sessionRef.current)) return
      const source = await desktop.prepareScreenShare()
      if (!isCurrentShare() || !canShareScreen(sessionRef.current)) return
      await media.startScreenShare()
      if (!isCurrentShare() || !canShareScreen(sessionRef.current)) {
        await media.stopScreenShare()
        return
      }
      clearMarks()
      screenSharingRef.current = true
      setScreenSource(source)
      setScreenSharing(true)
      await startCapturing(current.id)
    } catch (caught) {
      screenSharingRef.current = false
      clearMarks()
      stopCapturing()
      setScreenSharing(false)
      if (caught instanceof MiteApiError) {
        reportError(caught)
      } else {
        setError(
          screenCaptureFailureMessage(
            caught,
            '家族との通話を始められませんでした。もう一度共有を始めてください。',
          ),
        )
      }
    } finally {
      sharingAttemptSession.current = null
      setActionBusy(false)
    }
  }

  const stopSharing = async () => {
    resumeAfterGuideSession.current = null
    mediaGenerationRef.current += 1
    screenSharingRef.current = false
    stopCapturing()
    setScreenSharing(false)
    clearMarks()
    try {
      await mediaRef.current?.stopScreenShare()
    } catch {
      setError('画面共有を止めたことを確認できませんでした。')
    }
  }

  useEffect(() => {
    resumeSharingRef.current = sharePrimaryScreen
  })

  useEffect(() => {
    if (
      session?.status !== 'GUIDE_SAVED' ||
      resumeAfterGuideSession.current !== session.id ||
      actionBusy ||
      mediaState !== 'CONNECTED'
    )
      return
    resumeAfterGuideSession.current = null
    void resumeSharingRef.current()
  }, [session?.status, session?.id, actionBusy, mediaState])

  const toggleMicrophone = async () => {
    const next = !microphoneEnabled
    try {
      await mediaRef.current?.setMicrophoneEnabled(next)
      setMicrophoneEnabled(next)
    } catch {
      setError('自分の声の設定を変えられませんでした。')
    }
  }

  const startGuide = async (summary: GuideSummary) => {
    setActionBusy(true)
    setError(null)
    try {
      const detail = await api.getGuide(summary.id)
      const run = await runIdempotent(
        keys,
        `guide-run:${summary.id}`,
        (idempotencyKey) =>
          api.createGuideRun({ guideId: summary.id }, { idempotencyKey }),
      )
      storage.setItem(guideRunKey, run.id)
      setGuide(detail)
      setGuideRun(run)
    } catch (caught) {
      reportError(caught)
    } finally {
      setActionBusy(false)
    }
  }

  const moveGuide = async (action: 'NEXT' | 'PREVIOUS') => {
    const activeRun = guideRun
    if (!activeRun) return
    setActionBusy(true)
    setError(null)
    try {
      const updated = await api.moveGuideRun(activeRun.id, {
        expectedRevision: activeRun.revision,
        action,
      })
      setGuideRun((current) => selectNewestRevision(current, updated))
    } catch (caught) {
      reportError(caught)
      const current = await api.getGuideRun(activeRun.id).catch(() => null)
      if (current) setGuideRun(current)
    } finally {
      setActionBusy(false)
    }
  }

  const completeGuide = async () => {
    const activeRun = guideRun
    if (!activeRun) return
    setActionBusy(true)
    setError(null)
    try {
      await runIdempotent(
        keys,
        `guide-complete:${activeRun.id}:${activeRun.revision}`,
        (idempotencyKey) =>
          api.completeGuideRun(
            activeRun.id,
            { expectedRevision: activeRun.revision },
            { idempotencyKey },
          ),
      )
      storage.removeItem(guideRunKey)
      setGuideRun(null)
      setGuide(null)
    } catch (caught) {
      reportError(caught)
      const current = await api.getGuideRun(activeRun.id).catch(() => null)
      if (current?.status === 'COMPLETED') {
        storage.removeItem(guideRunKey)
        setGuideRun(null)
        setGuide(null)
      } else if (current) {
        setGuideRun(current)
      }
    } finally {
      setActionBusy(false)
    }
  }

  const askFromGuide = async (
    preview: { bytes: Uint8Array; capturedAt: string },
    comment: string,
  ) => {
    const activeRun = guideRun
    if (!activeRun) return
    setActionBusy(true)
    setError(null)
    try {
      const payloadKey = `mite.user.guideSupportPayload:${activeRun.id}:${activeRun.revision}`
      const screenshotDraftId = `guide_${activeRun.id}_${activeRun.revision}`
      const rawPayload = storage.getItem(payloadKey)
      let savedPayload: { artifactId: string; comment: string } | null = null
      if (rawPayload) {
        try {
          const value: unknown = JSON.parse(rawPayload)
          if (
            value &&
            typeof value === 'object' &&
            'artifactId' in value &&
            typeof value.artifactId === 'string' &&
            'comment' in value &&
            typeof value.comment === 'string'
          ) {
            savedPayload = {
              artifactId: value.artifactId,
              comment: value.comment,
            }
          }
        } catch {
          storage.removeItem(payloadKey)
        }
      }
      if (!savedPayload) {
        const persistedPreview =
          (await desktop.loadSupportScreenshotDraft(screenshotDraftId)) ??
          (await desktop.saveSupportScreenshotDraft(
            screenshotDraftId,
            preview.capturedAt,
            preview.bytes,
          ))
        const artifact = await runIdempotent(
          keys,
          `guide-support-artifact:${activeRun.id}:${activeRun.revision}`,
          (idempotencyKey) =>
            api.uploadArtifact(
              {
                purpose: 'REQUEST_SCREENSHOT',
                capturedAt: persistedPreview.capturedAt,
                file: new Blob([Uint8Array.from(persistedPreview.bytes)], {
                  type: 'image/jpeg',
                }),
                filename: 'current-screen.jpg',
              },
              { idempotencyKey },
            ),
        )
        savedPayload = { artifactId: artifact.id, comment }
        storage.setItem(payloadKey, JSON.stringify(savedPayload))
      }
      const result = await runIdempotent(
        keys,
        `guide-support-request:${activeRun.id}:${activeRun.revision}`,
        (idempotencyKey) =>
          api.requestSupportFromGuideRun(
            activeRun.id,
            {
              expectedRevision: activeRun.revision,
              initialScreenshotArtifactId: savedPayload.artifactId,
              comment: savedPayload.comment,
            },
            { idempotencyKey },
          ),
      )
      setGuideRun(result.guideRun)
      storage.removeItem(payloadKey)
      await desktop
        .deleteSupportScreenshotDraft(screenshotDraftId)
        .catch(() => {})
      mergeRequest(result.supportRequest)
      setGuide(null)
    } catch (caught) {
      reportError(caught)
      const current = await api.getGuideRun(activeRun.id).catch(() => null)
      if (current) {
        setGuideRun(current)
        if (
          current.status === 'PAUSED_FOR_SUPPORT' &&
          current.supportRequestId
        ) {
          const supportRequest = await api
            .getSupportRequest(current.supportRequestId)
            .catch(() => null)
          if (supportRequest) {
            const supportSession = supportRequest.supportSessionId
              ? await api
                  .getSupportSession(supportRequest.supportSessionId)
                  .catch(() => null)
              : null
            await applySupportState(supportRequest, supportSession)
          }
        }
      }
    } finally {
      setActionBusy(false)
    }
  }

  if (fatalConfiguration) {
    return (
      <div className="user-overlay-detail">
        <AppShell roleLabel="利用者用" title="Miteを始められません">
          <Surface elevated>
            <EmptyState
              symbol="!"
              title="このアプリの設定を確認できませんでした"
              description="担当者に設定を確認してもらってから、読み込み直してください。"
              action={
                <Button size="large" onClick={() => window.location.reload()}>
                  読み込み直す
                </Button>
              }
            />
          </Surface>
        </AppShell>
      </div>
    )
  }
  const setEntryExpanded = (open: boolean) => {
    void desktop.setOverlayMode(open ? 'ENTRY' : 'COLLAPSED').catch(() => {})
  }
  if (restoring) {
    return (
      <div className="user-overlay-edge">
        <EdgeHelpEntry
          busy
          onAskForHelp={() => {}}
          onOpenGuides={() => {}}
          onExpandedChange={setEntryExpanded}
        />
      </div>
    )
  }

  let edge: ReactNode = null
  if (overlayCollapsed) {
    const hasResume =
      supportScreen !== 'HOME' ||
      Boolean(guideRun && guide) ||
      view === 'REQUEST'
    const resumeLabel =
      view === 'REQUEST'
        ? '入力中の相談に戻る'
        : guideRun && guide
          ? '開いていた手順に戻る'
          : supportScreen === 'WAITING_FOR_FAMILY'
            ? '家族を待つ画面に戻る'
            : supportScreen === 'INCOMING_CALL'
              ? '家族からの連絡を見る'
              : supportScreen === 'ACTIVE_SUPPORT'
                ? '支援画面に戻る'
                : supportScreen === 'GUIDE_GENERATING'
                  ? '手順の作成状況を見る'
                  : supportScreen === 'GUIDE_DRAFT_REVIEW'
                    ? '作成中の手順を見る'
                    : supportScreen === 'GUIDE_SAVED'
                      ? '保存した手順を確認する'
                      : supportScreen === 'SUPPORT_ENDED'
                        ? '支援結果を見る'
                        : undefined

    edge = (
      <div className="user-overlay-edge">
        <EdgeHelpEntry
          busy={hasResume}
          resumeLabel={resumeLabel}
          onResume={() => setOverlayCollapsed(false)}
          onAskForHelp={() => {
            setError(null)
            setView('REQUEST')
            setOverlayCollapsed(false)
          }}
          onOpenGuides={() => {
            setView('HOME')
            setOverlayCollapsed(false)
          }}
          onExpandedChange={setEntryExpanded}
        />
      </div>
    )
  }

  let content: ReactNode
  if (supportScreen === 'WAITING_FOR_FAMILY' && request) {
    content = <WaitingScreen request={request} />
  } else if (supportScreen === 'INCOMING_CALL' && session) {
    content = (
      <IncomingCallScreen
        session={session}
        busy={actionBusy}
        error={error}
        onAccept={() => void acceptCall()}
        onClose={() => setOverlayCollapsed(true)}
      />
    )
  } else if (supportScreen === 'ACTIVE_SUPPORT' && session) {
    content = (
      <ActiveSupportScreen
        source={screenSource}
        screenSharing={screenSharing}
        mediaState={mediaState}
        microphoneEnabled={microphoneEnabled}
        audioLevel={audioLevel}
        captureCount={captureCount}
        captureLimitReached={captureLimitReached}
        captureError={captureError}
        busy={actionBusy}
        error={error}
        onStartSharing={() => void sharePrimaryScreen()}
        onStopSharing={() => void stopSharing()}
        onToggleMicrophone={() => void toggleMicrophone()}
      />
    )
  } else if (supportScreen === 'GUIDE_GENERATING') {
    content = (
      <GeneratingGuideScreen
        progress={uploadProgress}
        error={uploadError}
        onRetry={() => setUploadRetry((value) => value + 1)}
      />
    )
  } else if (supportScreen === 'GUIDE_DRAFT_REVIEW' && draft) {
    content = <DraftViewer api={api} draft={draft} />
  } else if (supportScreen === 'GUIDE_DRAFT_REVIEW') {
    content = <LoadingState>手順を読み込んでいます</LoadingState>
  } else if (
    supportScreen === 'GUIDE_SAVED' &&
    session &&
    closedSavedSession !== session.id
  ) {
    content = (
      <Modal
        title="手順を保存しました"
        onClose={() => setClosedSavedSession(session.id)}
      >
        <p>
          家族との通話を続けられます。閉じてから、保存した手順を試してみましょう。
        </p>
      </Modal>
    )
  } else if (supportScreen === 'SUPPORT_ENDED' && session) {
    content = (
      <EndedScreen
        session={session}
        onDone={() => {
          storage.removeItem(lastRequestKey)
          storage.removeItem(guideRunKey)
          requestRef.current = null
          sessionRef.current = null
          setRequest(null)
          setSession(null)
          setDraft(null)
          setGuideRun(null)
          setGuide(null)
          setView('HOME')
          setOverlayCollapsed(true)
          void loadGuides()
        }}
      />
    )
  } else if (guideRun && guide) {
    content = (
      <GuideRunner
        key={`${guideRun.id}:${guideRun.revision}`}
        api={api}
        desktop={desktop}
        run={guideRun}
        inCall={canContinueCall(session)}
        guide={guide}
        busy={actionBusy}
        error={error}
        onMove={(action) => void moveGuide(action)}
        onComplete={() => void completeGuide()}
        onAsk={(preview, comment) => void askFromGuide(preview, comment)}
        keys={keys}
        storage={storage}
      />
    )
  } else if (view === 'REQUEST') {
    content = (
      <SupportRequestComposer
        api={api}
        desktop={desktop}
        keys={keys}
        storage={storage}
        onCreated={(created) => {
          mergeRequest(created)
          setView('HOME')
        }}
        onCancel={() => {
          setView('HOME')
          setOverlayCollapsed(true)
        }}
        onAuthenticationError={() => setFatalConfiguration(true)}
      />
    )
  } else {
    content = (
      <>
        {error ? <ErrorNotice message={error} /> : null}
        <GuideList
          api={api}
          guides={guides}
          loading={guidesLoading}
          onReload={() => void loadGuides()}
          onStart={(summary) => void startGuide(summary)}
          onAskForHelp={() => {
            setError(null)
            setView('REQUEST')
          }}
        />
      </>
    )
  }

  return (
    <>
      {edge}
      <div
        className={`user-overlay-detail${view === 'REQUEST' && supportScreen === 'HOME' && !guideRun ? ' user-overlay-detail--request' : ''}`}
        hidden={overlayCollapsed}
      >
        <AppShell
          className="user-overlay-shell"
          roleLabel="利用者用"
          title="困ったときは、いつでも家族に相談できます"
          subtitle={`Mite ${runtime.appVersion}`}
          status={
            <StatusBadge
              tone={connectionStatus === 'CONNECTED' ? 'active' : 'warning'}
            >
              {connectionStatus === 'CONNECTED'
                ? 'お知らせを受け取れます'
                : 'お知らせをつなぎ直しています'}
            </StatusBadge>
          }
          actions={
            <Button
              variant="quiet"
              aria-label="Miteを左端へしまう"
              onClick={() => setOverlayCollapsed(true)}
            >
              しまう
            </Button>
          }
        >
          {session && canContinueCall(session) ? (
            <div className="user-persistent-call-controls">
              <CallElapsed startedAt={session.startedAt} />
              <label>
                自分のマイク{' '}
                <meter
                  min={0}
                  max={1}
                  value={microphoneEnabled ? localAudioLevel : 0}
                  aria-label="自分のマイクの大きさ"
                />
              </label>
              {session.status !== 'ACTIVE' ? (
                <>
                  <Button
                    variant="secondary"
                    disabled={actionBusy}
                    onClick={() => void toggleMicrophone()}
                  >
                    {microphoneEnabled
                      ? '自分の声を止める'
                      : '自分の声を届ける'}
                  </Button>
                  {canShareScreen(session) ? (
                    <Button
                      variant="secondary"
                      disabled={actionBusy}
                      onClick={() =>
                        void (screenSharing
                          ? stopSharing()
                          : sharePrimaryScreen())
                      }
                    >
                      {screenSharing
                        ? '画面共有を止める'
                        : '画面全体の共有を再開する'}
                    </Button>
                  ) : (
                    <>
                      <span>手順の作成中は画面共有を停止しています</span>
                      {mediaState === 'DISCONNECTED' ? (
                        <Button
                          disabled={actionBusy}
                          onClick={() => void sharePrimaryScreen()}
                        >
                          音声通話をつなぎ直す
                        </Button>
                      ) : null}
                    </>
                  )}
                  {error ? <ErrorNotice message={error} /> : null}
                </>
              ) : null}
            </div>
          ) : null}
          {content}
        </AppShell>
      </div>
    </>
  )
}

export function App() {
  const desktop = useMemo(() => getUserDesktopBridge(), [])
  const [runtime, setRuntime] = useState<RuntimeConfig | null>(null)
  const [failed, setFailed] = useState(() => desktop === null)

  useEffect(() => {
    if (!desktop) return

    void desktop
      .getRuntimeConfig()
      .then((config) => {
        if (!config.demoToken || config.role !== 'USER') {
          void desktop.setOverlayMode('DETAIL').catch(() => {})
          setFailed(true)
          return
        }
        setRuntime(config)
      })
      .catch(() => {
        void desktop.setOverlayMode('DETAIL').catch(() => {})
        setFailed(true)
      })
  }, [desktop])

  if (failed) {
    return (
      <div className="user-overlay-detail">
        <AppShell roleLabel="利用者用" title="Miteを始められません">
          <Surface elevated>
            <EmptyState
              symbol="!"
              title="このアプリの設定を確認できませんでした"
              description="担当者に設定を確認してもらってから、読み込み直してください。"
              action={
                <Button size="large" onClick={() => window.location.reload()}>
                  読み込み直す
                </Button>
              }
            />
          </Surface>
        </AppShell>
      </div>
    )
  }
  if (!runtime || !desktop)
    return <LoadingState>Miteを準備しています</LoadingState>

  return (
    <UserClient
      api={
        new HttpMiteApi({
          baseUrl: runtime.apiBaseUrl,
          token: runtime.demoToken,
        })
      }
      runtime={runtime}
      desktop={desktop}
    />
  )
}
