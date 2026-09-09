import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  HttpMiteApi,
  MiteApiError,
  type CompanionStatus,
  type SupportAcknowledgementKind,
  type SupportRequest,
} from '@mite/client-api'

const tokenKey = 'mite.family.companionToken'
const apiBaseUrl =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  'http://localhost:3000'
const initialToken =
  localStorage.getItem(tokenKey) ??
  (import.meta.env.VITE_DEMO_FAMILY_TOKEN as string | undefined) ??
  ''

const formatTime = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat('ja-JP', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value))
    : 'まだ確認できていません'

const messageFor = (error: unknown) => {
  if (error instanceof MiteApiError) return error.message
  return '情報を取得できませんでした。通信を確認して、もう一度お試しください。'
}

const base64URLToBytes = (value: string) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const binary = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

const bytesToBase64URL = (value: ArrayBuffer | null) => {
  if (!value) return ''
  const binary = String.fromCharCode(...new Uint8Array(value))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function App() {
  const [token, setToken] = useState(initialToken)
  const [draftToken, setDraftToken] = useState(initialToken)
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [request, setRequest] = useState<SupportRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notificationEnabled, setNotificationEnabled] = useState(false)
  const [scheduledAt, setScheduledAt] = useState('')
  const [refreshedAt, setRefreshedAt] = useState(0)
  const api = useMemo(
    () => (token ? new HttpMiteApi({ baseUrl: apiBaseUrl, token }) : null),
    [token],
  )

  const refresh = useCallback(async () => {
    if (!api) return
    try {
      const [nextStatus, pending] = await Promise.all([
        api.getCompanionStatus(),
        api.listSupportRequests('PENDING'),
      ])
      setStatus(nextStatus)
      setRequest(pending[0] ?? null)
      setRefreshedAt(Date.now())
      setError(null)
    } catch (caught) {
      setError(messageFor(caught))
    }
  }, [api])

  useEffect(() => {
    if (!api) return
    const initial = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), 5_000)
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearTimeout(initial)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [api, refresh])

  useEffect(() => {
    if (
      !api ||
      typeof Notification === 'undefined' ||
      Notification.permission !== 'granted' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      return
    }
    let active = true
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) => {
        if (active) setNotificationEnabled(Boolean(subscription))
      })
      .catch(() => {
        if (active) setNotificationEnabled(false)
      })
    return () => {
      active = false
    }
  }, [api])

  useEffect(() => {
    const badgeNavigator = navigator as Navigator & {
      clearAppBadge?: () => Promise<void>
      setAppBadge?: (contents?: number) => Promise<void>
    }
    const updateBadge = request
      ? badgeNavigator.setAppBadge?.(1)
      : badgeNavigator.clearAppBadge?.()
    void updateBadge?.catch(() => undefined)
  }, [request])

  const saveToken = () => {
    const normalized = draftToken.trim()
    if (!normalized) return
    localStorage.setItem(tokenKey, normalized)
    setToken(normalized)
  }

  const acknowledge = async (kind: SupportAcknowledgementKind) => {
    if (!api || !request) return
    if (kind === 'SCHEDULED' && !scheduledAt) {
      setError('対応できそうな日時を選んでください。')
      return
    }
    setBusy(true)
    try {
      const updated = await api.updateSupportRequestAcknowledgement(
        request.id,
        {
          acknowledgementKind: kind,
          estimatedSupportAt:
            kind === 'SCHEDULED' ? new Date(scheduledAt).toISOString() : null,
          expectedRevision: request.revision,
        },
      )
      setRequest(updated)
      setError(null)
    } catch (caught) {
      setError(messageFor(caught))
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const enableNotifications = async () => {
    if (
      !api ||
      typeof Notification === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('PushManager' in window)
    ) {
      setError('このブラウザではPush通知を利用できません。')
      return
    }
    setBusy(true)
    try {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted')
        throw new Error('notification permission denied')
      const registration = await navigator.serviceWorker.ready
      const publicKey = await api.getVapidPublicKey()
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64URLToBytes(publicKey),
        }))
      const p256dh = subscription.getKey('p256dh')
      const auth = subscription.getKey('auth')
      if (!p256dh || !auth) throw new Error('push keys missing')
      await api.upsertPushSubscription({
        endpoint: subscription.endpoint,
        p256dh: bytesToBase64URL(p256dh),
        auth: bytesToBase64URL(auth),
      })
      setNotificationEnabled(true)
      setError(null)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setBusy(false)
    }
  }

  const disableNotifications = async () => {
    if (!api || !('serviceWorker' in navigator)) return
    setBusy(true)
    try {
      const registration = await navigator.serviceWorker.ready
      const subscription = await registration.pushManager.getSubscription()
      if (subscription) {
        await api.deletePushSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setNotificationEnabled(false)
      setError(null)
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setBusy(false)
    }
  }

  if (!token) {
    return (
      <main className="setup">
        <section className="card setup-card">
          <div className="brand">
            <span>M</span>
            <strong>Mite 家族用</strong>
          </div>
          <h1>家族用トークンを設定</h1>
          <p>
            試作期間中だけの設定です。トークンはこの端末内に保存し、URLや通知には含めません。
          </p>
          <label>
            家族用トークン
            <input
              type="password"
              autoComplete="off"
              value={draftToken}
              onChange={(event) => setDraftToken(event.target.value)}
            />
          </label>
          <button className="primary" onClick={saveToken}>
            はじめる
          </button>
        </section>
      </main>
    )
  }

  const presence = status?.presence.status ?? 'OFFLINE'
  const presenceLabel =
    presence === 'ONLINE'
      ? 'PCにつながっています'
      : presence === 'CONNECTING'
        ? '接続を確認しています'
        : 'PCの接続は不明です'
  const scheduledOverdue =
    request?.acknowledgementKind === 'SCHEDULED' &&
    request.estimatedSupportAt &&
    new Date(request.estimatedSupportAt).getTime() < refreshedAt

  return (
    <div className="app-shell">
      <header>
        <div className="brand">
          <span>M</span>
          <strong>Mite</strong>
        </div>
        <div className="header-actions">
          <button className="text-button" onClick={() => void refresh()}>
            更新
          </button>
          <button
            className="text-button"
            onClick={() => {
              localStorage.removeItem(tokenKey)
              setDraftToken('')
              setToken('')
            }}
          >
            設定
          </button>
        </div>
      </header>
      <main>
        {error ? (
          <div className="error" role="alert">
            {error}
          </div>
        ) : null}
        <section className="hero card">
          <p className="eyebrow">
            {status?.user.displayName ?? '利用者'}さんの状態
          </p>
          <div className={`presence ${presence.toLowerCase()}`}>
            <i aria-hidden="true" />
            {presenceLabel}
          </div>
          <p className="last-seen">
            最終確認: {formatTime(status?.presence.lastSeenAt)}
          </p>
          <p className="note">
            Miteを起動したPCとの通信状態です。ご本人がPCの前にいることを示すものではありません。
          </p>
        </section>

        <section className="card request-card">
          <div className="section-heading">
            <div>
              <p className="eyebrow">支援依頼</p>
              <h1>
                {request ? '対応を待っています' : '新しい依頼はありません'}
              </h1>
            </div>
            {request ? <span className="badge">支援待ち</span> : null}
          </div>
          {request ? (
            <>
              <blockquote>
                {request.comment || 'コメントはありません'}
              </blockquote>
              <p className="requested-at">
                依頼日時 {formatTime(request.createdAt)}
              </p>
              {request.acknowledgementKind ? (
                <div className="acknowledged">
                  返答済み:{' '}
                  {request.acknowledgementKind === 'NOW'
                    ? '今から確認します'
                    : request.acknowledgementKind === 'SCHEDULED'
                      ? scheduledOverdue
                        ? `予定時刻（${formatTime(request.estimatedSupportAt)}）を過ぎています`
                        : `${formatTime(request.estimatedSupportAt)}ごろ`
                      : '確認しました'}
                </div>
              ) : null}
              <div className="actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void acknowledge('NOW')}
                >
                  今から確認する
                </button>
                <button
                  disabled={busy}
                  onClick={() => void acknowledge('UNKNOWN')}
                >
                  確認しました
                </button>
              </div>
              <div className="schedule">
                <label>
                  対応できそうな日時
                  <input
                    type="datetime-local"
                    value={scheduledAt}
                    onChange={(event) => setScheduledAt(event.target.value)}
                  />
                </label>
                <button
                  disabled={busy || !scheduledAt}
                  onClick={() => void acknowledge('SCHEDULED')}
                >
                  この予定を伝える
                </button>
              </div>
              <div className="desktop-callout">
                <strong>実際の支援はPC版Miteから</strong>
                <p>
                  通話・画面共有・指示・ガイド編集は家族用PCアプリで行います。
                </p>
              </div>
            </>
          ) : (
            <p className="empty-copy">
              依頼が届くと、内容と対応状況をここで確認できます。
            </p>
          )}
        </section>

        <section className="card notification-card">
          <div>
            <p className="eyebrow">通知</p>
            <h2>支援のお知らせ</h2>
            <p>
              新しい依頼や、支援待ちの間にPCが再接続したときだけお知らせします。ロック画面には詳しい内容を表示しません。
            </p>
          </div>
          <button
            className={notificationEnabled ? '' : 'primary'}
            disabled={busy}
            onClick={() =>
              void (notificationEnabled
                ? disableNotifications()
                : enableNotifications())
            }
          >
            {notificationEnabled ? '通知を解除' : '通知を受け取る'}
          </button>
        </section>
      </main>
      <footer>
        このアプリは状況確認用です。緊急時の連絡手段には使用しないでください。
      </footer>
    </div>
  )
}
