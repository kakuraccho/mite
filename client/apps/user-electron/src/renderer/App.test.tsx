import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Artifact,
  MiteApi,
  SupportRequest,
  SupportSession,
} from '@mite/client-api'
import { MemoryStorage, type RuntimeConfig } from '@mite/client-core'
import { App, EdgeHelpEntry, UserClient } from './App'
import type { CaptureManifest, UserDesktopBridge } from './desktop'
import type { UserMediaSession } from './livekit'

const timestamp = '2026-09-03T10:00:00Z'
const runtime: RuntimeConfig = {
  role: 'USER',
  apiBaseUrl: 'http://127.0.0.1:3000',
  demoToken: 'user-token',
  captureIntervalMs: 5_000,
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
    textVersion: 'v1',
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
  id: 'window:1:0',
  name: '相談したい画面',
  thumbnailDataUrl: 'data:image/jpeg;base64,AQID',
}

const makeDesktop = (): UserDesktopBridge =>
  ({
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
    listScreenSources: vi.fn().mockResolvedValue([source]),
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
    ...overrides,
  }) as unknown as MiteApi

const eventStreamFactory = () => ({
  start: vi.fn(),
  stop: vi.fn(),
})

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

  it('offers the current task before starting another flow', () => {
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
    fireEvent.click(screen.getByRole('button', { name: '支援画面に戻る' }))
    expect(onResume).toHaveBeenCalledOnce()
  })
})

describe('UserClient', () => {
  it('accepts an incoming call only after all three consent items are checked', async () => {
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
      getSupportSession: vi.fn().mockResolvedValue(ringingSession),
      acceptSupportSession,
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

    await screen.findByText('家族が待っています')
    const acceptButton = screen.getByRole('button', { name: '応答する' })
    expect((acceptButton as HTMLButtonElement).disabled).toBe(true)
    for (const checkbox of screen.getAllByRole('checkbox')) {
      fireEvent.click(checkbox)
    }
    expect((acceptButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(acceptButton)

    await waitFor(() => expect(acceptSupportSession).toHaveBeenCalledTimes(1))
    expect(acceptSupportSession.mock.calls[0]?.[0]).toBe('session_01')
    expect(acceptSupportSession.mock.calls[0]?.[1]).toEqual({
      expectedSessionRevision: 1,
      consent: {
        audio: true,
        screenShare: true,
        periodicCapture: true,
        textVersion: 'v1',
      },
    })
    expect(acceptSupportSession.mock.calls[0]?.[2]).toEqual({
      idempotencyKey: expect.any(String),
    })
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
    fireEvent.click(
      await screen.findByRole('radio', { name: /相談したい画面/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'この画面を撮影する' }))
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
    fireEvent.click(
      await screen.findByRole('radio', { name: /相談したい画面/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'この画面を撮影する' }))
    await screen.findByAltText('家族に送る画面')
    fireEvent.click(screen.getByRole('button', { name: '家族に相談する' }))
    await screen.findByText(
      '通信できません。少し待ってから、もう一度試してください。',
    )

    expect(desktop.saveSupportScreenshotDraft).toHaveBeenCalled()
    const firstInput = uploadArtifact.mock.calls[0]?.[0]
    const firstOperation = uploadArtifact.mock.calls[0]?.[1]
    fireEvent.click(screen.getByRole('button', { name: 'この画面を撮影する' }))
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
      selectScreenSource: vi.fn().mockResolvedValue(undefined),
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
      await screen.findByRole('radio', { name: /相談したい画面/ }),
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
