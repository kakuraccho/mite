import { useEffect, useState } from 'react'
import type { MiteApi } from '@mite/client-api'

export interface ArtifactImageProps {
  api: MiteApi
  artifactId: string
  alt: string
  className?: string
}

export function ArtifactImage({
  api,
  artifactId,
  alt,
  className,
}: ArtifactImageProps) {
  const [result, setResult] = useState<{
    artifactId: string
    source: string | null
    failed: boolean
  }>({ artifactId, source: null, failed: false })

  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void api
      .getArtifactContent(artifactId)
      .then((blob) => {
        if (!active) return
        if (typeof URL.createObjectURL !== 'function') {
          setResult({ artifactId, source: null, failed: true })
          return
        }
        objectUrl = URL.createObjectURL(blob)
        setResult({ artifactId, source: objectUrl, failed: false })
      })
      .catch(() => {
        if (active) setResult({ artifactId, source: null, failed: true })
      })

    return () => {
      active = false
      if (objectUrl && typeof URL.revokeObjectURL === 'function') {
        URL.revokeObjectURL(objectUrl)
      }
    }
  }, [api, artifactId])

  const source = result.artifactId === artifactId ? result.source : null
  const failed = result.artifactId === artifactId && result.failed
  if (failed) {
    return (
      <div className={`family-image-placeholder ${className ?? ''}`} role="img">
        <span aria-hidden="true">画像なし</span>
        <span className="sr-only">{alt}を表示できませんでした</span>
      </div>
    )
  }
  if (!source) {
    return (
      <div
        className={`family-image-placeholder ${className ?? ''}`}
        role="status"
        aria-label={`${alt}を読み込み中`}
      >
        <span aria-hidden="true">読み込み中</span>
      </div>
    )
  }
  return <img className={className} src={source} alt={alt} />
}
