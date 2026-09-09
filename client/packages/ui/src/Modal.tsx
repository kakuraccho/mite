import { useEffect, useId, useRef, type ReactNode } from 'react'
import { Button } from './components'

const focusable =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [href], [tabindex="0"]'

export function Modal({
  title,
  children,
  actions,
  onClose,
  busy = false,
  open = true,
}: {
  title: string
  children: ReactNode
  actions?: ReactNode
  onClose(): void
  busy?: boolean
  open?: boolean
}) {
  const titleId = useId()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement
    panel.current?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus()
      }
    }
  }, [open])
  return (
    <div
      hidden={!open}
      className="mite-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <div
        ref={panel}
        className="mite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.stopPropagation()
            onClose()
          }
          if (event.key !== 'Tab') return
          const elements = Array.from(
            panel.current?.querySelectorAll<HTMLElement>(focusable) ?? [],
          ).filter((element) => !element.closest('[hidden]'))
          const first = elements[0]
          const last = elements.at(-1)
          if (!first) {
            event.preventDefault()
            panel.current?.focus()
          } else if (
            event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === panel.current)
          ) {
            event.preventDefault()
            last?.focus()
          } else if (
            !event.shiftKey &&
            (document.activeElement === last ||
              document.activeElement === panel.current)
          ) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <header className="mite-modal-header">
          <h2 id={titleId}>{title}</h2>
          <Button variant="quiet" disabled={busy} onClick={onClose}>
            閉じる
          </Button>
        </header>
        <div className="mite-modal-body">{children}</div>
        {actions ? (
          <footer className="mite-modal-actions">{actions}</footer>
        ) : null}
      </div>
    </div>
  )
}
