import { useEffect, useState } from 'react'
import type { MiteApi } from '@mite/client-api'

export function ArtifactImage({
  api,
  artifactId,
  alt,
  className,
}: {
  api: MiteApi
  artifactId: string
  alt: string
  className?: string
}) {
  const [result, setResult] = useState<{
    artifactId: string
    url: string | null
    failed: boolean
  } | null>(null)

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void api
      .getArtifactContent(artifactId)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setResult({ artifactId, url: objectUrl, failed: false })
      })
      .catch(() => {
        if (active) setResult({ artifactId, url: null, failed: true })
      })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [api, artifactId])

  if (result?.artifactId === artifactId && result.failed) {
    return <div className="user-image-fallback">画像を表示できません</div>
  }
  if (result?.artifactId !== artifactId || !result.url)
    return <div className="user-image-fallback">画像を読み込んでいます…</div>
  return <img className={className} src={result.url} alt={alt} />
}
