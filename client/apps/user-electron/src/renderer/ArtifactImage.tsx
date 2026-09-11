import { useEffect, useState } from 'react'
import type { MiteApi } from '@mite/client-api'
import { Modal } from '@mite/ui'

function GuideImagePreview({
  src,
  alt,
  className,
}: {
  src: string
  alt: string
  className?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className="user-guide-image"
        aria-label={`${alt}を拡大する`}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <img className={className} src={src} alt={alt} />
        <span>画像を大きく見る</span>
      </button>
      {open ? (
        <Modal title={alt} onClose={() => setOpen(false)}>
          <img
            className="user-guide-expanded-image"
            src={src}
            alt={`${alt}の拡大表示`}
          />
        </Modal>
      ) : null}
    </>
  )
}

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
  return (
    <GuideImagePreview
      key={result.url}
      src={result.url}
      alt={alt}
      className={className}
    />
  )
}
