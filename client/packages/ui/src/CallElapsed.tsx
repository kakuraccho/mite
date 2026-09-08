import { useEffect, useState } from 'react'

export function CallElapsed({ startedAt }: { startedAt: string | null }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])
  const start = startedAt ? Date.parse(startedAt) : now
  const seconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now - start) / 1_000))
    : 0
  return (
    <span aria-label="通話の経過時間">
      通話 {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}
