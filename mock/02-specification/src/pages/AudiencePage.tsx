import { Link } from 'react-router-dom'
import { FamilyView } from '../components/FamilyView'
import { GrandfatherView } from '../components/GrandfatherView'

export function AudiencePage({
  audience,
}: {
  audience: 'grandfather' | 'family'
}) {
  const isGrandfather = audience === 'grandfather'
  return (
    <main className="solo-page">
      <header className="solo-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            m
          </span>
          <div>
            <strong>Mite</strong>
            <small>{isGrandfather ? '祖父側画面' : '家族側画面'}</small>
          </div>
        </div>
        <p>
          この画面はブラウザ内モックです。実際の通話・画面共有・通知は行いません。
        </p>
        <nav aria-label="モック画面リンク">
          <Link to="/demo">両画面のデモへ</Link>
          <Link to={isGrandfather ? '/family' : '/grandfather'}>
            {isGrandfather ? '家族側を見る' : '祖父側を見る'}
          </Link>
        </nav>
      </header>
      <div className="solo-stage">
        <div className="solo-stage__label">
          {isGrandfather ? 'GRANDFATHER VIEW' : 'FAMILY VIEW'}
          <span>デモ画面から移動した場合は同じモック状態を表示します</span>
        </div>
        {isGrandfather ? <GrandfatherView standalone /> : <FamilyView />}
      </div>
    </main>
  )
}
