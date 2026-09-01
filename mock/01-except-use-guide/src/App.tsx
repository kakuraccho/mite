import { useEffect } from 'react'
import { DeveloperPanel } from './components/DeveloperPanel'
import { FamilyView } from './components/FamilyView'
import { GrandfatherView } from './components/GrandfatherView'
import { mockSupportService } from './services/mockSupportService'
import { SessionProvider, useSession } from './state/SessionContext'

function Brand() {
  return (
    <a className="brand" href="/demo" aria-label="Mite デモへ">
      <span className="brand-mark" aria-hidden="true">m</span>
      <span><strong>Mite</strong><small>仕様探索プロトタイプ</small></span>
    </a>
  )
}

function RouteNav() {
  return (
    <nav className="route-nav" aria-label="表示する画面">
      <a href="/grandfather">祖父側</a>
      <a href="/family">家族側</a>
      <a href="/demo">並べてデモ</a>
    </nav>
  )
}

function MockTransitionController() {
  const { state, dispatch } = useSession()
  const ownsAutomaticTransitions = ['/demo', '/grandfather'].includes(
    window.location.pathname.replace(/\/$/, ''),
  )

  useEffect(() => {
    const controller = new AbortController()

    if (ownsAutomaticTransitions && state.status === 'requestSent') {
      void mockSupportService
        .waitForNotificationDelivery(controller.signal)
        .then(() => dispatch({ type: 'DELIVER_SUPPORT_REQUEST' }))
        .catch(() => undefined)
    }

    if (ownsAutomaticTransitions && state.status === 'connecting') {
      void mockSupportService
        .waitForConnection(controller.signal)
        .then(() => dispatch({ type: 'CONNECTION_ESTABLISHED' }))
        .catch(() => undefined)
    }

    return () => controller.abort()
  }, [dispatch, ownsAutomaticTransitions, state.status])

  return null
}

function DemoPage() {
  return (
    <div className="app-shell demo-page">
      <header className="topbar">
        <Brand />
        <RouteNav />
        <span className="prototype-badge">すべてモック</span>
      </header>

      <main>
        <section className="demo-intro">
          <div>
            <span className="eyebrow">NORMAL FLOW / DEMO</span>
            <h1>離れた家族の案内を、<br />ひとつの画面で試す。</h1>
          </div>
          <p>
            左が祖父側、右が家族側です。祖父側の画面左端から依頼を始め、
            ガイドの保存まで順番に操作できます。
          </p>
        </section>

        <div className="demo-grid">
          <GrandfatherView />
          <FamilyView />
        </div>

        <DeveloperPanel />
      </main>
    </div>
  )
}

function StandalonePage({ side }: { side: 'grandfather' | 'family' }) {
  const isGrandfather = side === 'grandfather'

  return (
    <div className="app-shell standalone-page">
      <header className="topbar">
        <Brand />
        <RouteNav />
        <span className="prototype-badge">同一ブラウザ内で疑似同期</span>
      </header>
      <main>
        <section className="standalone-intro">
          <span className="eyebrow">{isGrandfather ? 'GRANDFATHER VIEW' : 'FAMILY VIEW'}</span>
          <h1>{isGrandfather ? '祖父側の画面' : '家族側の画面'}</h1>
          <p>別タブでもう一方の画面を開くと、操作が同じブラウザ内で反映されます。</p>
        </section>
        <div className="standalone-content">
          {isGrandfather ? <GrandfatherView /> : <FamilyView />}
        </div>
        <DeveloperPanel />
      </main>
    </div>
  )
}

function HomePage() {
  return (
    <main className="home-page">
      <Brand />
      <span className="eyebrow">SPEC EXPLORATION PROTOTYPE</span>
      <h1>家族に「ここが分からない」を<br />かんたんに伝える。</h1>
      <p>Miteの支援依頼からガイド保存までを、すべてモックで体験できます。</p>
      <a className="primary-button large-button" href="/demo">並べたデモを始める <span aria-hidden="true">→</span></a>
      <small>画面・マイク・カメラの権限は使用しません。</small>
    </main>
  )
}

function CurrentRoute() {
  const path = window.location.pathname.replace(/\/$/, '') || '/'

  switch (path) {
    case '/demo':
      return <DemoPage />
    case '/grandfather':
      return <StandalonePage side="grandfather" />
    case '/family':
      return <StandalonePage side="family" />
    default:
      return <HomePage />
  }
}

export function App() {
  return (
    <SessionProvider>
      <MockTransitionController />
      <CurrentRoute />
    </SessionProvider>
  )
}
