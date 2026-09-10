import { useCallback, useEffect, useRef, useState } from 'react'
import type { CompanionStatus, MiteApi, SupportRequest } from '@mite/client-api'
import { selectNewestRevision, startPolling } from '@mite/client-core'

export function useCompanionData(api: MiteApi) {
  const [status, setStatus] = useState<CompanionStatus | null>(null)
  const [request, setRequest] = useState<SupportRequest | null>(null)
  const [refreshError, setRefreshError] = useState<unknown>(null)
  const [refreshedAt, setRefreshedAt] = useState(0)
  const active = useRef(false)
  const refreshVersion = useRef(0)
  const settledVersion = useRef(0)

  const refresh = useCallback(async () => {
    if (!active.current) return
    const version = ++refreshVersion.current
    try {
      const [nextStatus, pending] = await Promise.all([
        api.getCompanionStatus(),
        api.listSupportRequests('PENDING'),
      ])
      // Compare completed reads: a slow response remains useful while a newer GET is in flight.
      if (!active.current || version < settledVersion.current) return
      settledVersion.current = version
      setStatus((current) =>
        current &&
        current.user.id === nextStatus.user.id &&
        current.presence.revision > nextStatus.presence.revision
          ? current
          : nextStatus,
      )
      setRequest((current) =>
        pending[0] ? selectNewestRevision(current, pending[0]) : null,
      )
      setRefreshedAt(Date.now())
      setRefreshError(null)
    } catch (error) {
      if (active.current && version >= settledVersion.current) {
        settledVersion.current = version
        setRefreshError(error)
      }
    }
  }, [api])

  const acceptAcknowledgement = (updated: SupportRequest) => {
    if (!active.current) return
    settledVersion.current = ++refreshVersion.current
    // A request removed/replaced by a newer list must not reappear on PATCH completion.
    setRequest((current) =>
      current?.id === updated.id
        ? selectNewestRevision(current, updated)
        : current,
    )
  }

  useEffect(() => {
    active.current = true
    const polling = startPolling(refresh)
    const onFocus = () => void refresh()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('online', onFocus)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      active.current = false
      settledVersion.current = ++refreshVersion.current
      polling.stop()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('online', onFocus)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return {
    status,
    request,
    refreshError,
    refreshedAt,
    refresh,
    acceptAcknowledgement,
  }
}
