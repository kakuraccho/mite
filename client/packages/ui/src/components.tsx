import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'

const cx = (...values: Array<string | false | null | undefined>) =>
  values.filter(Boolean).join(' ')

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'call'
  size?: 'medium' | 'large'
  block?: boolean
  leadingIcon?: ReactNode
}

export function Button({
  variant = 'primary',
  size = 'medium',
  block = false,
  leadingIcon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={cx(
        'mite-button',
        `mite-button--${variant}`,
        `mite-button--${size}`,
        block && 'mite-button--block',
        className,
      )}
    >
      {leadingIcon ? (
        <span className="mite-button__icon" aria-hidden="true">
          {leadingIcon}
        </span>
      ) : null}
      <span>{children}</span>
    </button>
  )
}

export interface StatusBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: 'neutral' | 'waiting' | 'active' | 'success' | 'warning' | 'danger'
}

export function StatusBadge({
  tone = 'neutral',
  className,
  children,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      {...props}
      className={cx('mite-status', `mite-status--${tone}`, className)}
    >
      {children}
    </span>
  )
}

export interface AppShellProps {
  roleLabel: string
  title: string
  subtitle?: string
  status?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}

export function AppShell({
  roleLabel,
  title,
  subtitle,
  status,
  actions,
  children,
  className,
}: AppShellProps) {
  return (
    <div className={cx('mite-app-shell', className)}>
      <header className="mite-app-header">
        <div className="mite-brand" aria-label="Mite">
          <span className="mite-brand__mark" aria-hidden="true">
            M
          </span>
          <span className="mite-brand__copy">
            <strong>Mite</strong>
            <small>{roleLabel}</small>
          </span>
        </div>
        <div className="mite-app-header__title">
          <h1>{title}</h1>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="mite-app-header__tools">
          {status}
          {actions}
        </div>
      </header>
      <main className="mite-app-main">{children}</main>
    </div>
  )
}

export interface SurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: 'section' | 'article' | 'div'
  elevated?: boolean
}

export function Surface({
  as: Component = 'section',
  elevated = false,
  className,
  children,
  ...props
}: SurfaceProps) {
  return (
    <Component
      {...props}
      className={cx(
        'mite-surface',
        elevated && 'mite-surface--elevated',
        className,
      )}
    >
      {children}
    </Component>
  )
}

export interface ScreenHeadingProps {
  eyebrow?: string
  title: string
  description?: string
  aside?: ReactNode
}

export function ScreenHeading({
  eyebrow,
  title,
  description,
  aside,
}: ScreenHeadingProps) {
  return (
    <header className="mite-screen-heading">
      <div>
        {eyebrow ? <span className="mite-eyebrow">{eyebrow}</span> : null}
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {aside ? <div className="mite-screen-heading__aside">{aside}</div> : null}
    </header>
  )
}

export interface NoticeProps extends HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'success' | 'warning' | 'danger'
  title: string
}

export function Notice({
  tone = 'info',
  title,
  className,
  children,
  ...props
}: NoticeProps) {
  return (
    <div
      {...props}
      className={cx('mite-notice', `mite-notice--${tone}`, className)}
    >
      <span className="mite-notice__symbol" aria-hidden="true">
        {tone === 'success'
          ? '✓'
          : tone === 'danger' || tone === 'warning'
            ? '!'
            : 'i'}
      </span>
      <div>
        <strong>{title}</strong>
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  )
}

export function LoadingState({ children }: { children: ReactNode }) {
  return (
    <div className="mite-loading" role="status" aria-live="polite">
      <span className="mite-loading__spinner" aria-hidden="true" />
      <p>{children}</p>
    </div>
  )
}

export interface EmptyStateProps {
  symbol?: ReactNode
  title: string
  description: string
  action?: ReactNode
}

export function EmptyState({
  symbol = '✓',
  title,
  description,
  action,
}: EmptyStateProps) {
  return (
    <div className="mite-empty-state">
      <span className="mite-empty-state__symbol" aria-hidden="true">
        {symbol}
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="mite-empty-state__action">{action}</div> : null}
    </div>
  )
}
