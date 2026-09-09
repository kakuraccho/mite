import { useEffect, useState } from 'react'
import type {
  DesktopMark,
  DesktopGuidance,
  MarkingOverlayBridge,
} from '../shared/marking-overlay'
import './marking-overlay.css'
import { KeyboardGuide } from './KeyboardGuide'

export function MarkingOverlay({ bridge }: { bridge: MarkingOverlayBridge }) {
  const [marks, setMarks] = useState<DesktopMark[]>([])
  const [guidance, setGuidance] = useState<DesktopGuidance | null>(null)
  useEffect(() => bridge.onMarksChanged(setMarks), [bridge])
  useEffect(() => bridge.onGuidanceChanged(setGuidance), [bridge])
  return (
    <div className="desktop-marking-layer">
      {guidance?.mode === 'CURSOR_MOUSE' ? (
        <>
          <svg
            className="desktop-guidance-cursor"
            style={{
              left: `${guidance.x * 100}%`,
              top: `${guidance.y * 100}%`,
            }}
            width="44"
            height="58"
            viewBox="0 0 44 58"
            aria-label="家族のカーソル"
          >
            <path
              d="M3 3 L3 45 L14 34 L23 53 L31 49 L22 31 L39 31 Z"
              fill="#ffb000"
              stroke="#171717"
              strokeWidth="3"
            />
          </svg>
          {guidance.buttons !== 0 ? (
            <div
              className="desktop-guidance-mouse"
              aria-label="家族のマウス操作"
              style={{
                left: `clamp(12px, calc(${guidance.x * 100}% + 48px), calc(100% - 204px))`,
                top: `clamp(12px, calc(${guidance.y * 100}% + 12px), calc(100% - 192px))`,
              }}
            >
              <svg
                width="72"
                height="80"
                viewBox="0 0 108 120"
                aria-hidden="true"
              >
                <rect
                  x="4"
                  y="4"
                  width="100"
                  height="112"
                  rx="40"
                  fill="white"
                  stroke="#222"
                  strokeWidth="4"
                />
                <path
                  d="M54 5 Q6 5 6 48 V57 H54Z"
                  fill={guidance.buttons & 1 ? '#ffb000' : '#eee'}
                  stroke="#222"
                  strokeWidth="3"
                />
                <path
                  d="M54 5 Q102 5 102 48 V57 H54Z"
                  fill={guidance.buttons & 2 ? '#ffb000' : '#eee'}
                  stroke="#222"
                  strokeWidth="3"
                />
                <rect
                  x="47"
                  y="19"
                  width="14"
                  height="27"
                  rx="7"
                  fill={guidance.buttons & 4 ? '#ffb000' : '#777'}
                />
              </svg>
              <span>
                {[
                  guidance.buttons & 1 ? '左' : '',
                  guidance.buttons & 2 ? '右' : '',
                  guidance.buttons & 4 ? '中央' : '',
                ]
                  .filter(Boolean)
                  .join('・')}
                <br />
                押しています
              </span>
            </div>
          ) : null}
        </>
      ) : null}
      {guidance?.mode === 'KEYBOARD' && guidance.keys.length ? (
        <KeyboardGuide keys={guidance.keys} />
      ) : null}
      {marks.map((mark) => (
        <span
          key={mark.id}
          className="desktop-mark"
          aria-label="家族が示している場所"
          style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
        />
      ))}
    </div>
  )
}
