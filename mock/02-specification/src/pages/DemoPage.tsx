import { DeveloperPanel } from '../components/DeveloperPanel'
import { FamilyView } from '../components/FamilyView'
import { GrandfatherView } from '../components/GrandfatherView'
import { Link } from 'react-router-dom'

export function DemoPage() {
  return (
    <main className="demo-page">
      <header className="demo-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
          <div>
            <strong>Mite</strong>
            <small>仕様探索モック</small>
          </div>
        </div>
        <div className="demo-header__center">
          <span>祖父側と家族側を同じ状態で確認</span>
        </div>
        <nav aria-label="画面リンク">
          <Link to="/grandfather">祖父側</Link>
          <Link to="/family">家族側</Link>
        </nav>
      </header>
      <div className="demo-layout">
        <DeveloperPanel />
        <div className="demo-stage">
          <div className="demo-stage__labels" aria-hidden="true">
            <span>GRANDFATHER VIEW</span>
            <span>FAMILY VIEW</span>
          </div>
          <div className="demo-views">
            <GrandfatherView />
            <FamilyView />
          </div>
        </div>
      </div>
    </main>
  )
}
