import type { PropsWithChildren, ReactNode } from 'react'
import type { MockScreenId } from '../domain/types'
import { MockDesktop } from './MockDesktop'

export function ViewFrame({
  audience,
  name,
  children,
}: PropsWithChildren<{ audience: 'grandfather' | 'family'; name: string }>) {
  return (
    <section className={`experience-frame experience-frame--${audience}`}>
      <header className="experience-frame__header">
        <span className="experience-frame__avatar" aria-hidden="true">
          {audience === 'grandfather' ? '祖' : '家'}
        </span>
        <div>
          <span className="eyebrow">
            {audience === 'grandfather' ? '祖父側' : '家族側'}
          </span>
          <h2>{name}</h2>
        </div>
        <span className="mock-badge">モック</span>
      </header>
      <div className="experience-frame__body">{children}</div>
    </section>
  )
}

export function StatusPill({
  tone = 'neutral',
  children,
}: PropsWithChildren<{
  tone?: 'neutral' | 'online' | 'waiting' | 'active' | 'complete'
}>) {
  return <span className={`status-pill status-pill--${tone}`}>{children}</span>
}

export function ProgressCard({
  eyebrow,
  title,
  children,
}: PropsWithChildren<{ eyebrow: string; title: string }>) {
  return (
    <div className="center-card progress-card" role="status" aria-live="polite">
      <span className="eyebrow">{eyebrow}</span>
      <div className="loading-orbit" aria-hidden="true">
        <span />
      </div>
      <h3>{title}</h3>
      <div className="supporting-copy">{children}</div>
    </div>
  )
}

export function ScreenPreview({
  screenId,
  caption,
}: {
  screenId: MockScreenId
  caption: ReactNode
}) {
  return (
    <figure className="screen-preview">
      <MockDesktop screenId={screenId} compact />
      <figcaption>{caption}</figcaption>
    </figure>
  )
}

