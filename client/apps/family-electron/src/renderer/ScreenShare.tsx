import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import {
  guidanceKeyLabel,
  normalizedPointInVideo,
  type GuidanceState,
} from '@mite/client-core'
import { Button } from '@mite/ui'
import type { FamilyLiveSupport, LiveSupportSnapshot } from './live-support'

type Mode = 'CIRCLE' | GuidanceState['mode']
export function ScreenShare({
  liveSupport,
  live,
  onError,
}: {
  liveSupport: FamilyLiveSupport
  live: LiveSupportSnapshot
  onError(error: unknown): void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const modeButtons = useRef<HTMLDivElement>(null)
  const [mode, setMode] = useState<Mode>('CIRCLE')
  const [keys, setKeys] = useState<string[]>([])
  const pressed = useRef(new Map<string, string>())
  const current = useRef<GuidanceState | null>(null)
  const [mark, setMark] = useState<{ x: number; y: number } | null>(null)
  const enabled = !!live.screenTrackSid && live.connectionStatus === 'CONNECTED'

  const clear = useCallback(() => {
    current.current = null
    pressed.current.clear()
    setKeys([])
    setMark(null)
    void liveSupport.sendGuidance(null).catch(onError)
    void liveSupport.clearMarks().catch(onError)
  }, [liveSupport, onError])
  const releaseInputs = useCallback(() => {
    const state = current.current
    if (state?.mode !== 'CURSOR_MOUSE') {
      clear()
      return
    }
    // Capture ends after every click. Keep the cursor and its heartbeat alive.
    if (state.buttons === 0) return
    current.current = { ...state, buttons: 0 }
    void liveSupport.sendGuidance(current.current).catch(onError)
  }, [clear, liveSupport, onError])
  useEffect(() => {
    liveSupport.attachScreen(videoRef.current)
    return () => liveSupport.attachScreen(null)
  }, [liveSupport])
  useEffect(() => {
    if (enabled && mode === 'CURSOR_MOUSE') {
      current.current = {
        mode,
        x: 0.5,
        y: 0.5,
        buttons: 0,
        keys: [],
      }
      void liveSupport.sendGuidance(current.current).catch(onError)
    }
    const loseFocus = () => releaseInputs()
    const visibility = () => {
      if (document.hidden) releaseInputs()
    }
    window.addEventListener('blur', loseFocus)
    document.addEventListener('visibilitychange', visibility)
    const timer = setInterval(() => {
      if (enabled && current.current)
        void liveSupport.sendGuidance(current.current).catch(onError)
    }, 500)
    return () => {
      clearInterval(timer)
      clear()
      window.removeEventListener('blur', loseFocus)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [
    clear,
    releaseInputs,
    enabled,
    live.screenTrackSid,
    mode,
    liveSupport,
    onError,
  ])
  useEffect(() => {
    if (!mark) return
    const timer = setTimeout(() => setMark(null), 2000)
    return () => clearTimeout(timer)
  }, [mark])

  const send = (state: GuidanceState) => {
    if (!enabled) return
    current.current = state
    void liveSupport.sendGuidance(state).catch(onError)
  }
  const pointAt = (clientX: number, clientY: number) => {
    const video = videoRef.current
    if (!video) return null
    const bounds = video.getBoundingClientRect()
    return normalizedPointInVideo(clientX, clientY, {
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
    })
  }
  const sendCircle = (x: number, y: number) => {
    void liveSupport.sendMark({ x, y }).catch(onError)
    const video = videoRef.current
    if (video && video.videoWidth && video.videoHeight) {
      const bounds = video.getBoundingClientRect()
      const scale = Math.min(
        bounds.width / video.videoWidth,
        bounds.height / video.videoHeight,
      )
      setMark({
        x:
          (bounds.width - video.videoWidth * scale) / 2 +
          x * video.videoWidth * scale,
        y:
          (bounds.height - video.videoHeight * scale) / 2 +
          y * video.videoHeight * scale,
      })
    }
  }
  const pointer = (event: PointerEvent<HTMLDivElement>) => {
    if (!enabled || mode !== 'CURSOR_MOUSE') return
    const point = pointAt(event.clientX, event.clientY)
    if (!point) {
      releaseInputs()
      return
    }
    send({ mode, ...point, buttons: event.buttons & 7, keys: [] })
  }
  const key = (event: KeyboardEvent<HTMLDivElement>, down: boolean) => {
    if (!enabled) return
    if (mode === 'CIRCLE') {
      if (down && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        sendCircle(0.5, 0.5)
      }
      return
    }
    if (mode !== 'KEYBOARD') return
    if (event.key === 'Escape' && event.shiftKey) {
      event.preventDefault()
      clear()
      setMode('CIRCLE')
      modeButtons.current?.querySelector('button')?.focus()
      return
    }
    event.preventDefault()
    const label = guidanceKeyLabel(event.code)
    if (!label) return
    if (down) pressed.current.set(event.code, label)
    else pressed.current.delete(event.code)
    // Modifier flags also recover a key release intercepted by the OS.
    for (const [code, name] of pressed.current) {
      if (
        (name === 'Ctrl' && !event.ctrlKey) ||
        (name === 'Shift' && !event.shiftKey) ||
        (name === 'Alt' && !event.altKey) ||
        (name === 'Windows' && !event.metaKey)
      )
        pressed.current.delete(code)
    }
    const order = ['Ctrl', 'Shift', 'Alt', 'Windows']
    const next = [...new Set(pressed.current.values())]
      .sort(
        (a, b) =>
          (order.includes(a) ? order.indexOf(a) : 4) -
          (order.includes(b) ? order.indexOf(b) : 4),
      )
      .slice(0, 8)
    setKeys(next)
    if (!next.length) {
      current.current = null
      void liveSupport.sendGuidance(null).catch(onError)
    } else send({ mode, x: 0.5, y: 0.5, buttons: 0, keys: next })
  }

  return (
    <div className="family-screen-share">
      <div
        ref={modeButtons}
        className="family-guidance-modes"
        role="group"
        aria-label="操作案内の表示モード"
      >
        {(
          [
            ['CIRCLE', '丸'],
            ['CURSOR_MOUSE', 'カーソルとマウス'],
            ['KEYBOARD', 'キーボード'],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={mode === value ? 'primary' : 'secondary'}
            aria-pressed={mode === value}
            onClick={() => {
              if (mode === value) {
                if (value === 'KEYBOARD') stageRef.current?.focus()
                return
              }
              clear()
              setMode(value)
              if (value === 'KEYBOARD') stageRef.current?.focus()
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div
        ref={stageRef}
        className="family-video-stage"
        role="group"
        tabIndex={enabled ? 0 : -1}
        aria-label={
          enabled
            ? '共有画面。選んだモードで操作を案内します'
            : '共有画面を待っています'
        }
        onBlur={releaseInputs}
        onKeyDown={(event) => key(event, true)}
        onKeyUp={(event) => key(event, false)}
        onPointerMove={pointer}
        onPointerDown={(event) => {
          if (mode !== 'CURSOR_MOUSE' || !enabled) return
          event.preventDefault()
          event.currentTarget.focus()
          event.currentTarget.setPointerCapture(event.pointerId)
          pointer(event)
        }}
        onPointerUp={pointer}
        onPointerCancel={releaseInputs}
        onLostPointerCapture={releaseInputs}
        onPointerLeave={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId))
            releaseInputs()
        }}
        onContextMenu={(event) => {
          if (mode === 'CURSOR_MOUSE') event.preventDefault()
        }}
        onClick={(event) => {
          if (mode !== 'CIRCLE' || !enabled) return
          const point = pointAt(event.clientX, event.clientY)
          if (point) sendCircle(point.x, point.y)
        }}
      >
        <video ref={videoRef} autoPlay playsInline />
        {!live.screenTrackSid ? (
          <div className="family-video-empty">
            <span aria-hidden="true">▣</span>
            <strong>利用者の画面共有を待っています</strong>
            <p>音声通話はそのまま続けられます。</p>
          </div>
        ) : null}
        {mark ? (
          <span
            className="family-local-mark"
            style={{ left: mark.x, top: mark.y }}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <div className="family-mark-help">
        <span>
          {mode === 'CIRCLE'
            ? 'クリックした場所に2秒間、丸を表示します。'
            : mode === 'CURSOR_MOUSE'
              ? 'カーソルは表示したまま、クリックやドラッグを見せます。マウスの図は押している間だけ表示します。'
              : `共有画面にフォーカスしてキーを押すと案内します。Shift+Escで終了。${keys.length ? ` 表示中: ${keys.join(' + ')}` : ''}`}
        </span>
        <Button variant="quiet" disabled={!enabled} onClick={clear}>
          案内を消す
        </Button>
      </div>
    </div>
  )
}
