import '@testing-library/jest-dom/vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Artifact,
  GuideDetail,
  GuideDraft,
  GuideRun,
  MiteApi,
  SupportRequest,
  SupportSession,
} from '@mite/client-api'
import { MemoryStorage, type RuntimeConfig } from '@mite/client-core'
import { App, EdgeHelpEntry, UserClient } from './App'
import type { CaptureManifest, UserDesktopBridge } from './desktop'
import type { UserMediaCallbacks, UserMediaSession } from './livekit'
import { captureStorageFailureMessage } from './capture-storage'

const timestamp = '2026-09-03T10:00:00Z'
const runtime: RuntimeConfig = {
  role: 'USER',
  apiBaseUrl: 'http://127.0.0.1:3000',
  demoToken: 'user-token',
  captureIntervalMs: 10_000,
  captureMaxCount: 360,
  appVersion: '0.1.0',
}

const supportRequest = (
  supportSessionId: string | null = null,
): SupportRequest => ({
  id: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  initialScreenshotArtifactId: 'artifact_01',
  comment: '元の画面に戻れない',
  status: supportSessionId ? 'IN_SUPPORT' : 'PENDING',
  supportSessionId,
  guideContext: null,
  acknowledgedAt: null,
  acknowledgementKind: null,
  estimatedSupportAt: null,
  revision: supportSessionId ? 3 : 1,
  createdAt: timestamp,
  updatedAt: timestamp,
})

const activeSession: SupportSession = {
  id: 'session_01',
  supportRequestId: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  livekitRoomName: 'mite-session_01',
  status: 'ACTIVE',
  guideDecision: null,
  guideMaterialBatchId: null,
  guideGenerationJobId: null,
  guideDraftId: null,
  guideId: null,
  consent: {
    audio: true,
    screenShare: true,
    periodicCapture: true,
    textVersion: 'v4',
  },
  consentedAt: timestamp,
  startedAt: timestamp,
  endedAt: null,
  endReason: null,
  revision: 2,
  createdAt: timestamp,
  updatedAt: timestamp,
}

const artifact: Artifact = {
  id: 'artifact_01',
  ownerUserId: 'user_demo',
  purpose: 'REQUEST_SCREENSHOT',
  mimeType: 'image/jpeg',
  sha256: 'a'.repeat(64),
  byteSize: 3,
  width: 1,
  height: 1,
  capturedAt: timestamp,
  contentUrl: '/v1/artifacts/artifact_01/content',
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
}

const source = {
  name: '画面全体',
  thumbnailDataUrl: 'data:image/jpeg;base64,AQID',
}

const makeDesktop = (): UserDesktopBridge =>
  ({
    prepareSpeakerVolume: vi.fn().mockResolvedValue(undefined),
    onOverlayCollapsed: vi.fn(() => () => {}),
    setOverlayMode: vi.fn(async (mode) => ({
      mode,
      reservation: 'SIMULATED',
      bounds: {
        x: 0,
        y: 0,
        width: mode === 'COLLAPSED' ? 4 : 320,
        height: 800,
      },
      reservedBounds: { x: 0, y: 0, width: 4, height: 800 },
    })),
    setGuidance: vi.fn().mockResolvedValue(undefined),
    setMarkings: vi.fn().mockResolvedValue(undefined),
    prepareScreenShare: vi.fn().mockResolvedValue(source),
    capturePreview: vi.fn().mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      capturedAt: timestamp,
    }),
    saveSupportScreenshotDraft: vi.fn(async (draftId, capturedAt, bytes) => ({
      draftId,
      capturedAt,
      bytes: Uint8Array.from(bytes),
    })),
    loadSupportScreenshotDraft: vi.fn().mockResolvedValue(null),
    deleteSupportScreenshotDraft: vi.fn().mockResolvedValue(undefined),
    listCaptureSessions: vi.fn().mockResolvedValue([]),
    deleteCaptureSession: vi.fn().mockResolvedValue(undefined),
  }) as unknown as UserDesktopBridge

const makeApi = (overrides: Record<string, unknown> = {}): MiteApi =>
  ({
    listSupportRequests: vi.fn().mockResolvedValue([]),
    listGuides: vi.fn().mockResolvedValue([]),
    recordPresenceHeartbeat: vi.fn().mockResolvedValue({}),
    ...overrides,
  }) as unknown as MiteApi

const eventStreamFactory = () => ({
  start: vi.fn(),
  stop: vi.fn(),
})

const openConsultation = async () => {
  fireEvent.focus(
    await screen.findByRole('button', {
      name: '家族に相談するメニューを開く',
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
}

const guideRun: GuideRun = {
  id: 'run_01',
  guideId: 'guide_01',
  guideVersionNumber: 1,
  userId: 'user_demo',
  status: 'IN_PROGRESS',
  currentStepNumber: 1,
  supportRequestId: null,
  startedAt: timestamp,
  completedAt: null,
  pausedAt: null,
  updatedAt: timestamp,
  revision: 1,
}

const guide: GuideDetail = {
  id: 'guide_01',
  userId: 'user_demo',
  title: '購入画面に戻る',
  currentVersionNumber: 1,
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  representativeArtifactId: 'artifact_01',
  currentVersion: {
    versionNumber: 1,
    title: '購入画面に戻る',
    createdBy: 'family_demo',
    createdAt: timestamp,
    steps: [
      {
        position: 1,
        artifactId: 'artifact_01',
        instruction: '戻るボタンを押します',
      },
    ],
  },
}

const readBlob = (blob: Blob) =>
  new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer))
    })
    reader.addEventListener('error', () => reject(reader.error))
    reader.readAsArrayBuffer(blob)
  })

beforeEach(() => {
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: vi.fn(() => 'blob:preview'),
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: vi.fn(),
  })
})

afterEach(() => {
  delete window.miteDesktop
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('App bootstrap', () => {
  it('shows a controlled setup error when opened outside Electron', async () => {
    delete window.miteDesktop

    render(<App />)

    expect(
      await screen.findByText('このアプリの設定を確認できませんでした'),
    ).toBeTruthy()
  })
})

describe('EdgeHelpEntry', () => {
  it('opens after a 300ms hover and returns to four pixels after leaving', () => {
    vi.useFakeTimers()
    const onExpandedChange = vi.fn()
    render(
      <EdgeHelpEntry
        onAskForHelp={vi.fn()}
        onOpenGuides={vi.fn()}
        onExpandedChange={onExpandedChange}
      />,
    )
    const trigger = screen.getByRole('button', {
      name: '家族に相談するメニューを開く',
    })
    const edge = trigger.closest('aside')
    expect(edge).not.toBeNull()

    fireEvent.mouseEnter(edge as HTMLElement)
    vi.advanceTimersByTime(299)
    expect(onExpandedChange).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpandedChange).toHaveBeenLastCalledWith(true)

    fireEvent.mouseLeave(edge as HTMLElement)
    vi.advanceTimersByTime(150)
    expect(onExpandedChange).toHaveBeenLastCalledWith(false)
  })

  it('returns directly to the current task', () => {
    const onResume = vi.fn()
    render(
      <EdgeHelpEntry
        resumeLabel="支援画面に戻る"
        onResume={onResume}
        onAskForHelp={vi.fn()}
        onOpenGuides={vi.fn()}
        onExpandedChange={vi.fn()}
      />,
    )

    fireEvent.focus(
      screen.getByRole('button', {
        name: '家族に相談するメニューを開く',
      }),
    )
    expect(onResume).toHaveBeenCalledOnce()
  })
})

describe('UserClient', () => {
  it('explains an unsupported WSL launch without restoring or uploading a black screenshot', async () => {
    const desktop = makeDesktop()
    const error = new Error(
      "Error invoking remote method 'support-draft:load-screenshot': Error: WSL_SCREEN_CAPTURE_UNAVAILABLE",
    )
    vi.mocked(desktop.loadSupportScreenshotDraft).mockRejectedValue(error)
    vi.mocked(desktop.capturePreview).mockRejectedValue(error)
    const uploadArtifact = vi.fn()
    render(
      <UserClient
        api={makeApi({ uploadArtifact })}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
      />,
    )
    await openConsultation()
    await screen.findByText(
      'この起動方法では画面を撮影・共有できません。Windows用のMiteを起動してください。',
    )
    expect(screen.queryByAltText('家族に送る画面')).toBeNull()
    expect(
      screen.getByRole('button', { name: '家族に相談する' }),
    ).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '画面を撮影する' }))
    await screen.findByText(
      'この起動方法では画面を撮影・共有できません。Windows用のMiteを起動してください。',
    )
    expect(desktop.saveSupportScreenshotDraft).not.toHaveBeenCalled()
    expect(uploadArtifact).not.toHaveBeenCalled()
  })
  it('automatically captures the full screen and sends the retaken image while preserving the comment', async () => {
    const desktop = makeDesktop()
    const retaken = {
      capturedAt: '2026-09-03T10:00:10Z',
      bytes: new Uint8Array([4, 5, 6]),
    }
    const uploadArtifact = vi.fn().mockResolvedValue(artifact)
    const createSupportRequest = vi.fn().mockResolvedValue(supportRequest())
    render(
      <UserClient
        api={makeApi({ uploadArtifact, createSupportRequest })}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
      />,
    )
    await openConsultation()
    await screen.findByAltText('家族に送る画面')
    expect(screen.queryByRole('radio')).toBeNull()
    expect(desktop.capturePreview).toHaveBeenCalledExactlyOnceWith()
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '戻る場所が分かりません' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Miteを左端へしまう' }))
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.focus(
      screen.getByRole('button', { name: '家族に相談するメニューを開く' }),
    )
    expect(screen.getByRole('textbox')).toHaveProperty(
      'value',
      '戻る場所が分かりません',
    )
    expect(desktop.capturePreview).toHaveBeenCalledTimes(1)
    fireEvent.click(
      screen.getByRole('button', { name: '家族に送る画面を大きく見る' }),
    )
    expect(screen.getByRole('dialog', { name: '家族に送る画面' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.getByRole('textbox')).toHaveValue('戻る場所が分かりません')
    expect(desktop.capturePreview).toHaveBeenCalledTimes(1)
    let finish: (value: typeof retaken) => void = () => {}
    vi.mocked(desktop.capturePreview).mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '画面を撮り直す' }))
    expect(
      screen.getByRole('button', { name: '撮影しています…' }),
    ).toHaveProperty('disabled', true)
    expect(
      screen.getByRole('button', { name: '家族に相談する' }),
    ).toHaveProperty('disabled', true)
    await act(async () => finish(retaken))
    expect(screen.getByRole('textbox')).toHaveProperty(
      'value',
      '戻る場所が分かりません',
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText('家族に知らせました')
    const input = uploadArtifact.mock.calls[0]?.[0]
    expect(input.capturedAt).toBe(retaken.capturedAt)
    expect(await readBlob(input.file)).toEqual(retaken.bytes)
    expect(createSupportRequest.mock.calls[0]?.[0].comment).toBe(
      '戻る場所が分かりません',
    )
  })

  it('lets the user retry a failed first screenshot and keeps the previous image after a failed retake', async () => {
    const desktop = makeDesktop()
    vi.mocked(desktop.capturePreview).mockRejectedValueOnce(
      new Error('unavailable'),
    )
    render(
      <UserClient
        api={makeApi()}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
      />,
    )
    await openConsultation()
    const retry = await screen.findByRole('button', { name: '画面を撮影する' })
    expect(
      screen.getByRole('button', { name: '家族に相談する' }),
    ).toHaveProperty('disabled', true)
    fireEvent.click(retry)
    const image = await screen.findByAltText('家族に送る画面')
    vi.mocked(desktop.capturePreview).mockRejectedValueOnce(
      new Error('unavailable'),
    )
    fireEvent.click(screen.getByRole('button', { name: '画面を撮り直す' }))
    await screen.findByText(
      '画面を撮影できませんでした。もう一度試してください。',
    )
    expect(screen.getByAltText('家族に送る画面')).toBe(image)
    expect(
      screen.getByRole('button', { name: '家族に相談する' }),
    ).toHaveProperty('disabled', false)
  })

  it('enlarges each guide step without moving or completing the guide', async () => {
    const storage = new MemoryStorage()
    storage.setItem('mite.user.guideRunId', guideRun.id)
    const twoStepGuide: GuideDetail = {
      ...guide,
      currentVersion: {
        ...guide.currentVersion,
        steps: [
          ...guide.currentVersion.steps,
          {
            position: 2,
            artifactId: 'artifact_02',
            instruction: '内容を確認します',
          },
        ],
      },
    }
    const moveGuideRun = vi.fn().mockResolvedValue({
      ...guideRun,
      currentStepNumber: 2,
      revision: 2,
    })
    const completeGuideRun = vi.fn()
    const api = makeApi({
      getGuideRun: vi.fn().mockResolvedValue(guideRun),
      getGuide: vi.fn().mockResolvedValue(twoStepGuide),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['guide'])),
      moveGuideRun,
      completeGuideRun,
    })
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={makeDesktop()}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '手順1の画面を拡大する' }),
    )
    fireEvent.keyDown(screen.getByRole('dialog', { name: '手順1の画面' }), {
      key: 'Escape',
    })
    expect(screen.getByText('戻るボタンを押します')).toBeInTheDocument()
    expect(moveGuideRun).not.toHaveBeenCalled()
    expect(completeGuideRun).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '次へ' }))
    fireEvent.click(
      await screen.findByRole('button', { name: '手順2の画面を拡大する' }),
    )
    expect(screen.getByAltText('手順2の画面の拡大表示')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(screen.getByText('内容を確認します')).toBeInTheDocument()
    expect(moveGuideRun).toHaveBeenCalledOnce()
    expect(completeGuideRun).not.toHaveBeenCalled()
  })

  it('retakes the full screen from a guide and reuses that image if upload must be retried', async () => {
    const storage = new MemoryStorage()
    storage.setItem('mite.user.guideRunId', guideRun.id)
    const desktop = makeDesktop()
    const drafts = new Map<
      string,
      { draftId: string; capturedAt: string; bytes: Uint8Array }
    >()
    vi.mocked(desktop.saveSupportScreenshotDraft).mockImplementation(
      async (draftId, capturedAt, bytes) => {
        const saved = { draftId, capturedAt, bytes: Uint8Array.from(bytes) }
        drafts.set(draftId, saved)
        return saved
      },
    )
    vi.mocked(desktop.loadSupportScreenshotDraft).mockImplementation(
      async (id) => drafts.get(id) ?? null,
    )
    const uploadArtifact = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(artifact)
    const requestSupportFromGuideRun = vi.fn().mockResolvedValue({
      guideRun: {
        ...guideRun,
        status: 'PAUSED_FOR_SUPPORT',
        supportRequestId: 'request_01',
        revision: 2,
      },
      supportRequest: supportRequest(),
    })
    const api = makeApi({
      getGuideRun: vi.fn().mockResolvedValue(guideRun),
      getGuide: vi.fn().mockResolvedValue(guide),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['guide'])),
      uploadArtifact,
      requestSupportFromGuideRun,
    })
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: '家族に聞く' }))
    await screen.findByAltText('家族に送る現在の画面')
    expect(screen.queryByRole('radio')).toBeNull()
    const retaken = {
      capturedAt: '2026-09-03T10:00:10Z',
      bytes: new Uint8Array([7, 8, 9]),
    }
    vi.mocked(desktop.capturePreview).mockResolvedValueOnce(retaken)
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'この次が分かりません' },
    })
    fireEvent.click(screen.getByRole('button', { name: '家族に聞く' }))
    fireEvent.click(screen.getByRole('button', { name: '家族に聞く' }))
    expect(screen.getByRole('textbox')).toHaveProperty(
      'value',
      'この次が分かりません',
    )
    fireEvent.click(screen.getByRole('button', { name: '画面を撮り直す' }))
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'この場所から家族に相談する' }),
      ).toHaveProperty('disabled', false),
    )
    fireEvent.click(
      screen.getByRole('button', { name: 'この場所から家族に相談する' }),
    )
    await screen.findByText(
      '通信できません。少し待ってから、もう一度試してください。',
    )
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '画面を撮り直す' }),
      ).toHaveProperty('disabled', false),
    )
    fireEvent.click(screen.getByRole('button', { name: '画面を撮り直す' }))
    await screen.findByText(
      '前回の送信結果を確認するため、保存済みの画面をそのまま再送します。',
    )
    expect(desktop.capturePreview).toHaveBeenCalledTimes(2)
    fireEvent.click(
      screen.getByRole('button', { name: 'この場所から家族に相談する' }),
    )
    await screen.findByText('家族に知らせました')
    expect(uploadArtifact).toHaveBeenCalledTimes(2)
    for (const [input] of uploadArtifact.mock.calls) {
      expect(input.capturedAt).toBe(retaken.capturedAt)
      expect(await readBlob(input.file)).toEqual(retaken.bytes)
    }
    expect(uploadArtifact.mock.calls[0]?.[1]).toEqual(
      uploadArtifact.mock.calls[1]?.[1],
    )
    expect(requestSupportFromGuideRun).toHaveBeenCalledWith(
      guideRun.id,
      {
        expectedRevision: guideRun.revision,
        initialScreenshotArtifactId: artifact.id,
        comment: 'この次が分かりません',
      },
      { idempotencyKey: expect.any(String) },
    )
  })

  it('keeps sharing and desktop markings available after capture initialization fails, then recovers recording', async () => {
    const request = supportRequest(activeSession.id)
    let refreshFromEvent!: () => void
    let serverSession = activeSession
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn(async () => serverSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    })
    const desktop = makeDesktop()
    desktop.initializeCaptureSession = vi
      .fn()
      .mockRejectedValue(new Error('EPERM: fsync'))
    desktop.saveCapture = vi.fn().mockResolvedValue({
      manifest: { captures: [{ sequence: 1 }] },
      reachedLimit: false,
    })
    let callbacks!: UserMediaCallbacks
    const media: UserMediaSession = {
      connect: vi.fn(async (_connection, nextCallbacks) => {
        callbacks = nextCallbacks
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      startScreenShare: vi
        .fn()
        .mockResolvedValue({ screenTrackSid: 'TR_screen' }),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={(options) => {
          refreshFromEvent = () => options.onStatusChange?.('CONNECTED')
          return eventStreamFactory()
        }}
        createMediaSession={() => media}
      />,
    )
    const start = await screen.findByRole('button', {
      name: '画面全体を共有する',
    })
    vi.useFakeTimers()
    await act(async () => fireEvent.click(start))
    expect(screen.getByText('画面全体を共有中')).toBeTruthy()
    expect(screen.getByText('画面の保存をやり直しています')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: '画面共有を止める' }),
    ).toBeTruthy()
    expect(media.disconnect).not.toHaveBeenCalled()
    expect(media.stopScreenShare).not.toHaveBeenCalled()
    const marking = {
      type: 'mark.set' as const,
      markId: 'mark_01',
      trackSid: 'TR_screen',
      x: 0.42,
      y: 0.31,
      shape: 'CIRCLE' as const,
      ttlMs: 2000,
      sentAt: timestamp,
    }
    await act(async () => callbacks.onMarking(marking))
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'mark_01', x: 0.42, y: 0.31 }),
    ])
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: 'Miteを左端へしまう' }),
      ),
    )
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'mark_01' }),
    ])
    await act(async () => vi.advanceTimersByTimeAsync(2000))
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([])
    await act(async () => vi.advanceTimersByTimeAsync(8000))
    expect(desktop.saveCapture).toHaveBeenCalledOnce()
    await act(async () => callbacks.onMarking(marking))
    serverSession = {
      ...activeSession,
      status: 'ENDED',
      revision: 3,
      guideDecision: 'SKIP',
    }
    await act(async () => vi.advanceTimersByTimeAsync(10000))
    await act(async () => refreshFromEvent())
    expect(media.disconnect).toHaveBeenCalled()
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([])
    await act(async () => callbacks.onMarking(marking))
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([])
  })

  it('does not restart capture or markings if a pending share finishes after the screen is closed', async () => {
    const request = supportRequest(activeSession.id)
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn().mockResolvedValue(activeSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    })
    const desktop = makeDesktop()
    desktop.initializeCaptureSession = vi.fn()
    let finishShare!: () => void
    const published = new Promise<void>((resolve) => {
      finishShare = resolve
    })
    let callbacks!: UserMediaCallbacks
    const media: UserMediaSession = {
      connect: vi.fn(async (_connection, nextCallbacks) => {
        callbacks = nextCallbacks
        await published
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      setMicrophoneEnabled: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    const { unmount } = render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
        createMediaSession={() => media}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '画面全体を共有する' }),
    )
    await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
    unmount()
    await act(async () => finishShare())
    expect(desktop.initializeCaptureSession).not.toHaveBeenCalled()
    expect(media.disconnect).toHaveBeenCalled()
    act(() =>
      callbacks.onMarking({
        type: 'mark.set',
        markId: 'late',
        trackSid: 'TR_screen',
        x: 0.5,
        y: 0.5,
        shape: 'CIRCLE',
        ttlMs: 2000,
        sentAt: timestamp,
      }),
    )
    expect(desktop.setMarkings).toHaveBeenLastCalledWith([])
  })

  it('reports local storage failure during guide preparation and lets the user retry', async () => {
    const request = supportRequest(activeSession.id)
    const generating: SupportSession = {
      ...activeSession,
      status: 'GENERATING_GUIDE',
      revision: 3,
      guideDecision: 'CREATE',
    }
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn().mockResolvedValue(generating),
      createGuideMaterialBatch: vi.fn(),
    })
    const desktop = makeDesktop()
    desktop.getCaptureManifest = vi.fn().mockResolvedValue(null)
    desktop.initializeCaptureSession = vi
      .fn()
      .mockRejectedValue(new Error('EPERM: fsync'))
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
      />,
    )
    expect(await screen.findByText(captureStorageFailureMessage)).toBeTruthy()
    expect(api.createGuideMaterialBatch).not.toHaveBeenCalled()
    expect(
      screen.queryByText(
        '通信できません。少し待ってから、もう一度試してください。',
      ),
    ).toBeNull()
    const manifest = {
      captures: [],
      guideMaterialBatchId: 'batch_01',
    } as unknown as CaptureManifest
    vi.mocked(desktop.getCaptureManifest).mockResolvedValue(manifest)
    api.getGuideMaterialBatch = vi
      .fn()
      .mockResolvedValue({ batch: { status: 'COMPLETED' }, materials: [] })
    fireEvent.click(screen.getByRole('button', { name: 'もう一度試す' }))
    await waitFor(() =>
      expect(desktop.deleteCaptureSession).toHaveBeenCalledWith(
        activeSession.id,
      ),
    )
    expect(screen.queryByText(captureStorageFailureMessage)).toBeNull()
  })

  it('starts, stops and resumes screen sharing and periodic captures without a source picker', async () => {
    const request = supportRequest(activeSession.id)
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn().mockResolvedValue(activeSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    })
    const desktop = makeDesktop()
    const manifest = { captures: [] } as unknown as CaptureManifest
    desktop.initializeCaptureSession = vi.fn().mockResolvedValue(manifest)
    desktop.saveCapture = vi
      .fn()
      .mockResolvedValue({ manifest, reachedLimit: false })
    let callbacks: UserMediaCallbacks | undefined
    const media: UserMediaSession = {
      connect: vi.fn<UserMediaSession['connect']>(
        async (_connection, nextCallbacks) => {
          callbacks = nextCallbacks
          callbacks.onStateChange('CONNECTED')
          return { screenTrackSid: 'TR_screen' }
        },
      ),
      startScreenShare: vi
        .fn()
        .mockResolvedValue({ screenTrackSid: 'TR_screen' }),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
        createMediaSession={() => media}
      />,
    )
    const start = await screen.findByRole('button', {
      name: '画面全体を共有する',
    })
    vi.useFakeTimers()
    await act(async () => fireEvent.click(start))
    expect(desktop.saveCapture).toHaveBeenCalledTimes(1)
    expect(desktop.prepareScreenShare).toHaveBeenCalledExactlyOnceWith()
    expect(screen.queryByRole('radio')).toBeNull()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(desktop.saveCapture).toHaveBeenCalledTimes(2)
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '画面共有を止める' })),
    )
    expect(media.stopScreenShare).toHaveBeenCalledOnce()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(desktop.saveCapture).toHaveBeenCalledTimes(2)
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: '画面全体の共有を再開する' }),
      ),
    )
    expect(media.startScreenShare).toHaveBeenCalledTimes(2)
    expect(desktop.prepareScreenShare).toHaveBeenCalledTimes(2)
    expect(desktop.saveCapture).toHaveBeenCalledTimes(3)
    await act(async () => callbacks?.onStateChange('RECONNECTING'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(desktop.saveCapture).toHaveBeenCalledTimes(3)
    expect(
      screen.getByRole('button', { name: '画面全体の共有を再開する' }),
    ).toHaveProperty('disabled', true)
    await act(async () => callbacks?.onStateChange('CONNECTED'))
    await act(async () =>
      fireEvent.click(
        screen.getByRole('button', { name: '画面全体の共有を再開する' }),
      ),
    )
    expect(desktop.prepareScreenShare).toHaveBeenCalledTimes(3)
    expect(desktop.saveCapture).toHaveBeenCalledTimes(4)
  })

  it('does not restart periodic capture if sharing is stopped during the first pending image', async () => {
    const request = supportRequest(activeSession.id)
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn().mockResolvedValue(activeSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    })
    const desktop = makeDesktop()
    const manifest = { captures: [] } as unknown as CaptureManifest
    desktop.initializeCaptureSession = vi.fn().mockResolvedValue(manifest)
    let finishCapture: (value: {
      manifest: CaptureManifest
      reachedLimit: boolean
    }) => void = () => {}
    desktop.saveCapture = vi.fn<UserDesktopBridge['saveCapture']>(
      () =>
        new Promise((resolve) => {
          finishCapture = resolve
        }),
    )
    const media: UserMediaSession = {
      connect: vi.fn(async (_connection, callbacks) => {
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      startScreenShare: vi
        .fn()
        .mockResolvedValue({ screenTrackSid: 'TR_screen' }),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
        createMediaSession={() => media}
      />,
    )
    const start = await screen.findByRole('button', {
      name: '画面全体を共有する',
    })
    vi.useFakeTimers()
    await act(async () => fireEvent.click(start))
    expect(desktop.saveCapture).toHaveBeenCalledOnce()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '画面共有を止める' })),
    )
    await act(async () => finishCapture({ manifest, reachedLimit: false }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(desktop.saveCapture).toHaveBeenCalledOnce()
    expect(media.stopScreenShare).toHaveBeenCalledOnce()
  })

  it('starts voice and sharing with a single consent operation and collapses the menu', async () => {
    const ringingRequest: SupportRequest = {
      ...supportRequest(),
      supportSessionId: 'session_01',
      revision: 2,
    }
    const ringingSession: SupportSession = {
      ...activeSession,
      status: 'RINGING',
      consent: null,
      consentedAt: null,
      startedAt: null,
      revision: 1,
    }
    const acceptSupportSession = vi.fn().mockResolvedValue({
      supportRequest: supportRequest(activeSession.id),
      supportSession: activeSession,
    })
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([ringingRequest]),
      getSupportSession: vi
        .fn()
        .mockResolvedValueOnce(ringingSession)
        .mockResolvedValue(activeSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
      acceptSupportSession,
    })

    const desktop = makeDesktop()
    desktop.initializeCaptureSession = vi
      .fn()
      .mockResolvedValue({ captures: [] })
    desktop.saveCapture = vi
      .fn()
      .mockResolvedValue({ manifest: { captures: [] }, reachedLimit: false })
    const media: UserMediaSession = {
      connect: vi.fn(async (_info, callbacks) => {
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      setMicrophoneEnabled: vi.fn(),
    }
    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        createMediaSession={() => media}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
      />,
    )

    await screen.findByText('家族が待っています')
    const acceptButton = screen.getByRole('button', {
      name: '同意して応答する',
    })
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(acceptButton)

    await waitFor(() => expect(acceptSupportSession).toHaveBeenCalledTimes(1))
    expect(acceptSupportSession.mock.calls[0]?.[0]).toBe('session_01')
    expect(acceptSupportSession.mock.calls[0]?.[1]).toEqual({
      expectedSessionRevision: 1,
      consent: {
        audio: true,
        screenShare: true,
        periodicCapture: true,
        textVersion: 'v4',
      },
    })
    expect(acceptSupportSession.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: expect.any(String),
    })
    await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
    expect(desktop.prepareSpeakerVolume).toHaveBeenCalledOnce()
    expect(desktop.saveCapture).toHaveBeenCalledOnce()
    expect(desktop.setOverlayMode).toHaveBeenLastCalledWith('COLLAPSED')
    expect(
      screen.queryByRole('button', { name: '画面全体を共有する' }),
    ).toBeNull()
  })

  it('recovers the exact support-request body after restart between image and request', async () => {
    const storage = new MemoryStorage()
    const created = supportRequest()
    const uploadArtifact = vi.fn().mockResolvedValue(artifact)
    const createSupportRequest = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(created)
    const api = makeApi({ uploadArtifact, createSupportRequest })
    const desktop = makeDesktop()
    const first = render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )

    await waitFor(() =>
      expect(desktop.setOverlayMode).toHaveBeenCalledWith('COLLAPSED'),
    )
    fireEvent.focus(
      screen.getByRole('button', {
        name: '家族に相談するメニューを開く',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByAltText('家族に送る画面')
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: '元の画面に戻れない' },
    })
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText(
      '通信できません。少し待ってから、もう一度試してください。',
    )

    const firstBody = createSupportRequest.mock.calls[0]?.[0]
    const firstOperation = createSupportRequest.mock.calls[0]?.[1]
    expect(storage.getItem('mite.user.supportDraftPayload')).not.toBeNull()
    first.unmount()
    vi.mocked(desktop.setOverlayMode).mockClear()

    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )
    await waitFor(() =>
      expect(desktop.setOverlayMode).toHaveBeenCalledWith('COLLAPSED'),
    )
    fireEvent.focus(
      screen.getByRole('button', {
        name: '家族に相談するメニューを開く',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText('前回の送信を確認しています')
    fireEvent.click(screen.getByRole('button', { name: '前回の送信を続ける' }))
    await screen.findByText('家族に知らせました')

    expect(uploadArtifact).toHaveBeenCalledTimes(1)
    expect(createSupportRequest).toHaveBeenCalledTimes(2)
    expect(createSupportRequest.mock.calls[1]?.[0]).toEqual(firstBody)
    expect(createSupportRequest.mock.calls[1]?.[1]).toEqual(firstOperation)
    expect(storage.getItem('mite.user.supportDraftPayload')).toBeNull()
  })

  it('persists and reuses the screenshot before retrying Artifact after restart', async () => {
    const storage = new MemoryStorage()
    let savedDraft: {
      draftId: string
      capturedAt: string
      bytes: Uint8Array
    } | null = null
    const desktop = {
      ...makeDesktop(),
      saveSupportScreenshotDraft: vi.fn(
        async (draftId: string, capturedAt: string, bytes: Uint8Array) => {
          savedDraft = {
            draftId,
            capturedAt,
            bytes: Uint8Array.from(bytes),
          }
          return savedDraft
        },
      ),
      loadSupportScreenshotDraft: vi.fn(async () => savedDraft),
      deleteSupportScreenshotDraft: vi.fn(async () => {
        savedDraft = null
      }),
    } as unknown as UserDesktopBridge
    const uploadArtifact = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockResolvedValueOnce(artifact)
    const api = makeApi({
      uploadArtifact,
      createSupportRequest: vi.fn().mockResolvedValue(supportRequest()),
    })

    const first = render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )
    fireEvent.focus(
      await screen.findByRole('button', {
        name: '家族に相談するメニューを開く',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByAltText('家族に送る画面')
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText(
      '通信できません。少し待ってから、もう一度試してください。',
    )

    expect(desktop.saveSupportScreenshotDraft).toHaveBeenCalled()
    const firstInput = uploadArtifact.mock.calls[0]?.[0]
    const firstOperation = uploadArtifact.mock.calls[0]?.[1]
    fireEvent.click(screen.getByRole('button', { name: '画面を撮り直す' }))
    await screen.findByText(
      '前回の送信結果を確認するため、保存済みの画面をそのまま再送します。',
    )
    expect(desktop.capturePreview).toHaveBeenCalledTimes(1)
    first.unmount()

    render(
      <UserClient
        api={api}
        runtime={runtime}
        desktop={desktop}
        storage={storage}
        createEventStream={eventStreamFactory}
      />,
    )
    fireEvent.focus(
      await screen.findByRole('button', {
        name: '家族に相談するメニューを開く',
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByAltText('家族に送る画面')
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText('家族に知らせました')

    expect(uploadArtifact).toHaveBeenCalledTimes(2)
    const secondInput = uploadArtifact.mock.calls[1]?.[0]
    expect(secondInput.capturedAt).toBe(firstInput.capturedAt)
    expect(await readBlob(secondInput.file)).toEqual(
      await readBlob(firstInput.file),
    )
    expect(uploadArtifact.mock.calls[1]?.[1]).toEqual(firstOperation)
    expect(desktop.deleteSupportScreenshotDraft).toHaveBeenCalledOnce()
  })

  it('does not schedule another capture after the first frame reaches the limit', async () => {
    const request = supportRequest(activeSession.id)
    const oneCaptureManifest: CaptureManifest = {
      schemaVersion: 1,
      supportSessionId: activeSession.id,
      guideMaterialBatchId: null,
      batchCreateIdempotencyKey: 'batch-key',
      batchCompleteIdempotencyKey: 'complete-key',
      noMaterialsEndIdempotencyKey: null,
      captures: [
        {
          clientCaptureId: 'capture_01',
          sequence: 1,
          capturedAt: timestamp,
          filename: '000001.jpg',
          sha256: 'a'.repeat(64),
          uploadIdempotencyKey: 'upload-key',
        },
      ],
    }
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportSession: vi.fn().mockResolvedValue(activeSession),
      getLiveKitToken: vi.fn().mockResolvedValue({
        serverUrl: 'wss://livekit.test',
        roomName: activeSession.livekitRoomName,
        participantIdentity: 'user:user_demo',
        token: 'livekit-token',
        expiresAt: timestamp,
      }),
    })
    const saveCapture = vi.fn().mockResolvedValue({
      manifest: oneCaptureManifest,
      reachedLimit: true,
    })
    const desktop = {
      ...makeDesktop(),
      initializeCaptureSession: vi.fn().mockResolvedValue({
        ...oneCaptureManifest,
        captures: [],
      }),
      saveCapture,
    } as unknown as UserDesktopBridge
    const media = {
      connect: vi.fn(async (_connection, callbacks) => {
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      startScreenShare: vi.fn().mockResolvedValue({
        screenTrackSid: 'TR_screen',
      }),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } satisfies UserMediaSession

    render(
      <UserClient
        api={api}
        runtime={{ ...runtime, captureMaxCount: 1 }}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
        createMediaSession={() => media}
      />,
    )

    await screen.findByText('家族とつながっています')
    fireEvent.click(
      await screen.findByRole('button', { name: '画面全体を共有する' }),
    )
    await waitFor(() => expect(saveCapture).toHaveBeenCalledTimes(1))
    expect(
      await screen.findByText('保存できる画面が上限に達しました'),
    ).toBeTruthy()

    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(saveCapture).toHaveBeenCalledTimes(1)
  })
})

it.each([true, false])(
  'keeps audio through generation and review, then ends support on save (previous sharing: %s)',
  async (sharedBeforeCreation) => {
    let serverSession = activeSession
    const request = supportRequest(activeSession.id)
    let refresh!: () => void
    let collapse!: () => void
    let callbacks!: UserMediaCallbacks
    const desktop = makeDesktop()
    desktop.onOverlayCollapsed = vi.fn((listener) => {
      collapse = listener
      return () => {}
    })
    const manifest = {
      captures: [],
      guideMaterialBatchId: 'batch_1',
    } as unknown as CaptureManifest
    desktop.initializeCaptureSession = vi.fn().mockResolvedValue(manifest)
    desktop.getCaptureManifest = vi.fn().mockResolvedValue(manifest)
    desktop.saveCapture = vi
      .fn()
      .mockResolvedValue({ manifest, reachedLimit: false })
    let finishPause!: () => void
    const pauseFinished = new Promise<void>((resolve) => {
      finishPause = () => {
        callbacks.onScreenShareStopped()
        resolve()
      }
    })
    const media: UserMediaSession = {
      connect: vi.fn(async (_info, cb) => {
        callbacks = cb
        cb.onStateChange('CONNECTED')
        return { screenTrackSid: 'TR_screen' }
      }),
      startScreenShare: vi
        .fn()
        .mockResolvedValue({ screenTrackSid: 'TR_screen' }),
      stopScreenShare: vi.fn(() =>
        sharedBeforeCreation ? pauseFinished : Promise.resolve(),
      ),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    }
    const api = makeApi({
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn(async () => serverSession),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
      getGuideMaterialBatch: vi
        .fn()
        .mockResolvedValue({ batch: { status: 'COMPLETED' }, materials: [] }),
      listSessionGuideDrafts: vi.fn().mockResolvedValue([
        {
          id: 'draft_1',
          title: '確認する手順',
          steps: guide.currentVersion.steps,
          revision: 1,
        },
      ]),
      listGuides: vi.fn().mockResolvedValue([guide]),
      getGuide: vi.fn().mockResolvedValue(guide),
      createGuideRun: vi.fn().mockResolvedValue(guideRun),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    })
    vi.useFakeTimers()
    await act(async () => {
      render(
        <UserClient
          api={api}
          runtime={runtime}
          desktop={desktop}
          storage={new MemoryStorage()}
          createMediaSession={() => media}
          createEventStream={(options) => {
            refresh = () => options.onStatusChange?.('CONNECTED')
            return eventStreamFactory()
          }}
        />,
      )
    })
    const start = screen.getByRole('button', { name: '画面全体を共有する' })
    await act(async () => fireEvent.click(start))
    expect(desktop.saveCapture).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(desktop.saveCapture).toHaveBeenCalledTimes(1)
    expect(api.getSupportSession).toHaveBeenCalledTimes(3) // restore, share guard, five-second polling
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(desktop.saveCapture).toHaveBeenCalledTimes(2)
    vi.mocked(desktop.setGuidance).mockClear()
    for (let sequence = 1; sequence <= 3; sequence++) {
      await act(async () =>
        callbacks.onGuidance?.({
          type: 'guidance.set',
          sequence,
          trackSid: 'TR_screen',
          mode: 'CURSOR_MOUSE',
          x: sequence / 10,
          y: 0.5,
          buttons: 1,
          keys: [],
          ttlMs: 2000,
          sentAt: timestamp,
        }),
      )
    }
    expect(desktop.setGuidance).toHaveBeenCalledTimes(3)
    expect(desktop.setGuidance).not.toHaveBeenCalledWith(null)
    if (!sharedBeforeCreation) {
      await act(async () =>
        fireEvent.click(
          screen.getByRole('button', { name: '画面共有を止める' }),
        ),
      )
    }
    await act(async () => collapse())
    expect(desktop.setOverlayMode).toHaveBeenLastCalledWith('COLLAPSED')
    for (const status of ['GENERATING_GUIDE', 'REVIEWING_GUIDE'] as const) {
      serverSession = {
        ...serverSession,
        status,
        guideDecision: 'CREATE',
        guideMaterialBatchId: 'batch_1',
        guideDraftId: status !== 'GENERATING_GUIDE' ? 'draft_1' : null,
        guideId: null,
        revision: serverSession.revision + 1,
      }
      await act(async () => refresh())
      // The pending video unpublish can finish while review is loading.
      if (status === 'REVIEWING_GUIDE' && sharedBeforeCreation)
        await act(async () => finishPause())
      await act(async () => vi.advanceTimersByTimeAsync(10000))
      expect(media.disconnect).not.toHaveBeenCalled()
      expect(media.stopScreenShare).toHaveBeenCalledTimes(
        sharedBeforeCreation ? 1 : 2,
      )
      expect(media.startScreenShare).toHaveBeenCalledTimes(1)
      expect(desktop.saveCapture).toHaveBeenCalledTimes(2)
      expect(desktop.setOverlayMode).toHaveBeenLastCalledWith('COLLAPSED')
    }
    serverSession = {
      ...serverSession,
      status: 'ENDED',
      guideId: guide.id,
      guideMaterialBatchId: null,
      endReason: 'GUIDE_SAVED',
      endedAt: timestamp,
      revision: serverSession.revision + 1,
    }
    await act(async () => refresh())
    expect(media.disconnect).toHaveBeenCalledOnce()
    expect(media.startScreenShare).toHaveBeenCalledTimes(1)
    expect(desktop.saveCapture).toHaveBeenCalledTimes(2)
    fireEvent.focus(
      screen.getByRole('button', { name: '家族に相談するメニューを開く' }),
    )
    expect(
      screen.getByRole('heading', { name: '相談が終わりました' }),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', { name: '画面全体の共有を再開する' }),
    ).toBeNull()
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: '閉じる' })),
    )
    expect(api.listGuides).toHaveBeenCalled()
  },
)

it.each(['GENERATING_GUIDE', 'REVIEWING_GUIDE'] as const)(
  'restores %s with audio only and no sharing controls',
  async (status) => {
    const restoringSession: SupportSession = {
      ...activeSession,
      status,
      guideDecision: 'CREATE',
      guideMaterialBatchId: 'batch_1',
      guideDraftId: status === 'REVIEWING_GUIDE' ? 'draft_1' : null,
      revision: 5,
    }
    const desktop = makeDesktop()
    desktop.getCaptureManifest = vi
      .fn()
      .mockResolvedValue({ captures: [], guideMaterialBatchId: 'batch_1' })
    const media: UserMediaSession = {
      connect: vi.fn(async (_token, callbacks) => {
        callbacks.onStateChange('CONNECTED')
        return { screenTrackSid: null }
      }),
      startScreenShare: vi.fn(),
      stopScreenShare: vi.fn(),
      disconnect: vi.fn(),
      setMicrophoneEnabled: vi.fn(),
    }
    const request = supportRequest(activeSession.id)
    render(
      <UserClient
        runtime={runtime}
        desktop={desktop}
        storage={new MemoryStorage()}
        createEventStream={eventStreamFactory}
        createMediaSession={() => media}
        api={makeApi({
          listSupportRequests: vi.fn().mockResolvedValue([request]),
          getSupportRequest: vi.fn().mockResolvedValue(request),
          getSupportSession: vi.fn().mockResolvedValue(restoringSession),
          getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
          getGuideMaterialBatch: vi.fn().mockResolvedValue({
            batch: { status: 'COMPLETED' },
            materials: [],
          }),
          getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
          listSessionGuideDrafts: vi.fn().mockResolvedValue([
            {
              id: 'draft_1',
              title: '確認する手順',
              steps: guide.currentVersion.steps,
              revision: 1,
            },
          ]),
        })}
      />,
    )
    fireEvent.click(
      await screen.findByRole('button', { name: '音声通話をつなぎ直す' }),
    )
    await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
    expect(media.connect).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { shareScreen: false },
    )
    expect(media.startScreenShare).not.toHaveBeenCalled()
    expect(desktop.prepareScreenShare).not.toHaveBeenCalled()
    expect(media.disconnect).not.toHaveBeenCalled()
    expect(
      screen.queryByRole('button', { name: '画面全体の共有を再開する' }),
    ).toBeNull()
  },
)

it('retains a connecting audio call when guide creation starts before connection finishes', async () => {
  let serverSession = activeSession
  let refresh!: () => void
  let finish!: () => void
  const connected = new Promise<void>((resolve) => {
    finish = resolve
  })
  const desktop = makeDesktop()
  desktop.getCaptureManifest = vi
    .fn()
    .mockResolvedValue({ captures: [], guideMaterialBatchId: 'batch_1' })
  const media: UserMediaSession = {
    connect: vi.fn(async (_token, callbacks) => {
      callbacks.onStateChange('CONNECTING')
      await connected
      callbacks.onStateChange('CONNECTED')
      return { screenTrackSid: null }
    }),
    startScreenShare: vi.fn(),
    stopScreenShare: vi.fn(),
    disconnect: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
  }
  const request = supportRequest(activeSession.id)
  render(
    <UserClient
      runtime={runtime}
      desktop={desktop}
      storage={new MemoryStorage()}
      createEventStream={(options) => {
        refresh = () => options.onStatusChange?.('CONNECTED')
        return eventStreamFactory()
      }}
      createMediaSession={() => media}
      api={makeApi({
        listSupportRequests: vi.fn().mockResolvedValue([request]),
        getSupportRequest: vi.fn().mockResolvedValue(request),
        getSupportSession: vi.fn(async () => serverSession),
        getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
        getGuideMaterialBatch: vi
          .fn()
          .mockResolvedValue({ batch: { status: 'COMPLETED' }, materials: [] }),
      })}
    />,
  )
  fireEvent.click(
    await screen.findByRole('button', { name: '画面全体を共有する' }),
  )
  await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
  serverSession = {
    ...activeSession,
    status: 'GENERATING_GUIDE',
    guideDecision: 'CREATE',
    guideMaterialBatchId: 'batch_1',
    revision: 3,
  }
  await act(async () => refresh())
  await act(async () => finish())
  expect(media.startScreenShare).not.toHaveBeenCalled()
  expect(desktop.prepareScreenShare).not.toHaveBeenCalled()
  expect(media.disconnect).not.toHaveBeenCalled()
  expect(
    screen.getByText('手順の作成中は画面共有を停止しています'),
  ).toBeTruthy()
})

it('restores a saved call and an in-progress guide after restart without scheduling new captures', async () => {
  const storage = new MemoryStorage()
  storage.setItem(
    'mite.user.lastSupportRequestId',
    activeSession.supportRequestId,
  )
  storage.setItem('mite.user.guideRunId', guideRun.id)
  const saved: SupportSession = {
    ...activeSession,
    status: 'GUIDE_SAVED',
    guideDecision: 'CREATE',
    guideDraftId: 'draft_1',
    guideId: guide.id,
    revision: 7,
  }
  const request: SupportRequest = {
    ...supportRequest(saved.id),
    status: 'RESOLVED',
    revision: 4,
  }
  const api = makeApi({
    listSupportRequests: vi.fn().mockResolvedValue([request]),
    getSupportRequest: vi.fn().mockResolvedValue(request),
    getSupportSession: vi.fn().mockResolvedValue(saved),
    getGuideRun: vi.fn().mockResolvedValue(guideRun),
    getGuide: vi.fn().mockResolvedValue(guide),
    listGuides: vi.fn().mockResolvedValue([guide]),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
  })
  const desktop = makeDesktop()
  desktop.initializeCaptureSession = vi.fn()
  desktop.saveCapture = vi.fn()
  const media: UserMediaSession = {
    connect: vi.fn(async (_info, callbacks) => {
      callbacks.onStateChange('CONNECTED')
      return { screenTrackSid: 'TR_restored' }
    }),
    disconnect: vi.fn(),
    startScreenShare: vi.fn(),
    stopScreenShare: vi.fn(),
    setMicrophoneEnabled: vi.fn(),
  }
  render(
    <UserClient
      api={api}
      runtime={runtime}
      desktop={desktop}
      storage={storage}
      createEventStream={eventStreamFactory}
      createMediaSession={() => media}
    />,
  )
  await screen.findByRole('dialog', { name: '手順を保存しました' })
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  await screen.findByText('戻るボタンを押します')
  fireEvent.click(
    screen.getByRole('button', { name: '画面全体の共有を再開する' }),
  )
  await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
  expect(desktop.initializeCaptureSession).not.toHaveBeenCalled()
  expect(desktop.saveCapture).not.toHaveBeenCalled()
  expect(media.disconnect).not.toHaveBeenCalled()
  expect(screen.getByLabelText('通話の経過時間').textContent).not.toBe(
    '通話 0:00',
  )
})

it('利用者も同じ支援の全ガイドのタイトル・ステップ数・内容を閲覧できる', async () => {
  const drafts: GuideDraft[] = ['ログインする', '住所を変更する'].map(
    (title, index) => ({
      id: `draft_${index}`,
      supportSessionId: activeSession.id,
      title,
      steps: [
        {
          position: 1,
          artifactId: `artifact_${index}`,
          instruction: `${title}ボタンを押す`,
        },
      ],
      status: 'EDITING',
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
  )
  const session = {
    ...activeSession,
    status: 'REVIEWING_GUIDE',
    guideDecision: 'CREATE',
    guideDraftId: drafts[0]!.id,
  }
  const api = makeApi({
    listSupportRequests: vi
      .fn()
      .mockResolvedValue([supportRequest(session.id)]),
    getSupportRequest: vi.fn().mockResolvedValue(supportRequest(session.id)),
    getSupportSession: vi.fn().mockResolvedValue(session),
    listSessionGuideDrafts: vi.fn().mockResolvedValue(drafts),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob()),
  })
  render(
    <UserClient
      api={api}
      runtime={runtime}
      desktop={makeDesktop()}
      storage={new MemoryStorage()}
      createEventStream={eventStreamFactory}
    />,
  )
  for (const draft of drafts) {
    expect(
      await screen.findByRole('heading', { name: draft.title }),
    ).toBeVisible()
    expect(screen.getByText(draft.steps[0]!.instruction)).toBeVisible()
  }
  expect(api.listSessionGuideDrafts).toHaveBeenCalledWith(session.id)
  expect(
    screen.queryByRole('button', { name: 'レビュー完了' }),
  ).not.toBeInTheDocument()
})
