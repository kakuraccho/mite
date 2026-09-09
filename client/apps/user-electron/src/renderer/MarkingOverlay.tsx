import { useEffect, useState } from 'react'
import type {
  DesktopMark,
  MarkingOverlayBridge,
} from '../shared/marking-overlay'
import './marking-overlay.css'

export function MarkingOverlay({ bridge }: { bridge: MarkingOverlayBridge }) {
  const [marks, setMarks] = useState<DesktopMark[]>([])
  useEffect(() => bridge.onMarksChanged(setMarks), [bridge])
  return (
    <div className="desktop-marking-layer">
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
