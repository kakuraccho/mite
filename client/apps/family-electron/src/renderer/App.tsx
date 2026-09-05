import { useEffect, useState } from 'react'
import { HttpMiteApi } from '@mite/client-api'
import { loadRuntimeConfig, type RuntimeConfig } from '@mite/client-core'
import { AppShell, Button, LoadingState, Notice, Surface } from '@mite/ui'
import { FamilyClient } from './FamilyClient'

interface BootstrapState {
  config: RuntimeConfig
  api: HttpMiteApi
}

export function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void loadRuntimeConfig()
      .then((config) => {
        if (config.role !== 'FAMILY' || !config.demoToken.trim()) {
          throw new Error('Family runtime configuration is invalid')
        }
        setBootstrap({
          config,
          api: new HttpMiteApi({
            baseUrl: config.apiBaseUrl,
            token: config.demoToken,
          }),
        })
      })
      .catch(() => {
        setError(
          '家族用の接続先またはデモ用トークンが設定されていません。設定を確認してください。',
        )
      })
  }, [])

  if (error) {
    return (
      <AppShell roleLabel="家族用" title="接続設定の確認">
        <Surface elevated>
          <Notice tone="danger" title="Miteを起動できません">
            <p>{error}</p>
            <Button onClick={() => window.location.reload()}>再読み込み</Button>
          </Notice>
        </Surface>
      </AppShell>
    )
  }

  if (!bootstrap) return <LoadingState>Miteを準備しています</LoadingState>

  return <FamilyClient config={bootstrap.config} api={bootstrap.api} />
}
