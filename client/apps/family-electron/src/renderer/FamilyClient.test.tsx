import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  GuideGenerationJob,
  GuideMaterialBatch,
  MiteApi,
  SupportRequest,
  SupportSession,
} from '@mite/client-api'
import { MemoryStorage, type RuntimeConfig } from '@mite/client-core'
import { FamilyClient, type FamilyEventStreamFactory } from './FamilyClient'
import type { FamilyLiveSupport, LiveSupportSnapshot } from './live-support'

const now = '2026-09-03T10:00:00Z'
const config: RuntimeConfig = {
  role: 'FAMILY',
  apiBaseUrl: 'http://localhost:3000',
  demoToken: 'family-token',
  captureIntervalMs: 5_000,
  captureMaxCount: 360,
  appVersion: '0.1.0',
}

const pendingRequest = (): SupportRequest => ({
  id: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  initialScreenshotArtifactId: 'artifact_01',
  comment: 'このボタンが分からない',
  status: 'PENDING',
  supportSessionId: null,
  guideContext: {
    guideRunId: 'run_01',
    guideId: 'guide_01',
    guideVersionNumber: 1,
    stepNumber: 2,
    guideTitle: 'メールを確認する',
    stepInstruction: '青い確認ボタンを押す',
    stepArtifactId: 'artifact_step_02',
  },
  revision: 1,
  createdAt: now,
  updatedAt: now,
})

const ringingSession = (): SupportSession => ({
  id: 'session_01',
  supportRequestId: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  livekitRoomName: 'mite-session_01',
  status: 'RINGING',
  guideDecision: null,
  guideMaterialBatchId: null,
  guideGenerationJobId: null,
  guideDraftId: null,
  guideId: null,
  consent: null,
  consentedAt: null,
  startedAt: null,
  endedAt: null,
  endReason: null,
  revision: 1,
  createdAt: now,
  updatedAt: now,
})

const activeRequest = (): SupportRequest => ({
  ...pendingRequest(),
  status: 'IN_SUPPORT',
  supportSessionId: 'session_01',
  revision: 3,
})

const activeSession = (): SupportSession => ({
  ...ringingSession(),
  status: 'ACTIVE',
  consent: {
    audio: true,
    screenShare: true,
    periodicCapture: true,
    textVersion: 'v1',
  },
  consentedAt: now,
  startedAt: now,
  revision: 2,
})

const noEvents: FamilyEventStreamFactory = () => ({
  start: () => undefined,
  stop: () => undefined,
})

const quietLiveSupport = (
  patch: Partial<LiveSupportSnapshot> = {},
): FamilyLiveSupport => {
  const snapshot: LiveSupportSnapshot = {
    connectionStatus: 'IDLE',
    microphoneEnabled: false,
    audioPlaybackBlocked: false,
    screenTrackSid: null,
    receivedAudioLevel: 0,
    errorMessage: null,
    ...patch,
  }
  const support: FamilyLiveSupport = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listener(snapshot)
      return () => undefined
    },
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
    startAudio: vi.fn().mockResolvedValue(undefined),
    attachScreen: vi.fn(),
    sendMark: vi.fn().mockResolvedValue(undefined),
    clearMarks: vi.fn().mockResolvedValue(undefined),
  }
  return support
}

describe('FamilyClient', () => {
  it('ガイド文脈を表示し、revisionと永続キーを使って発信する', async () => {
    const initial = pendingRequest()
    const calledRequest: SupportRequest = {
      ...initial,
      supportSessionId: 'session_01',
      revision: 2,
    }
    const callSupportRequest = vi.fn().mockResolvedValue({
      supportRequest: calledRequest,
      supportSession: ringingSession(),
    })
    const api = {
      listSupportRequests: vi.fn().mockResolvedValue([initial]),
      getSupportRequest: vi.fn().mockResolvedValue(calledRequest),
      getSupportSession: vi.fn().mockResolvedValue(ringingSession()),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
      callSupportRequest,
    } as unknown as MiteApi

    render(
      <FamilyClient
        config={config}
        api={api}
        storage={new MemoryStorage()}
        liveSupport={quietLiveSupport()}
        eventStreamFactory={noEvents}
        pollIntervalMs={60_000}
      />,
    )

    expect(await screen.findByText('メールを確認する')).toBeTruthy()
    expect(screen.getByText(/手順 2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '利用者へ発信する' }))

    await waitFor(() => expect(callSupportRequest).toHaveBeenCalledTimes(1))
    expect(callSupportRequest).toHaveBeenCalledWith(
      'request_01',
      { expectedRequestRevision: 1 },
      { idempotencyKey: expect.any(String) },
    )
    expect(await screen.findByText('利用者の応答を待っています')).toBeTruthy()
  })

  it('生成が3回失敗した場合は上限を表示して再試行を無効にする', async () => {
    const request: SupportRequest = {
      ...pendingRequest(),
      status: 'RESOLVED',
      supportSessionId: 'session_01',
      revision: 4,
    }
    const session: SupportSession = {
      ...ringingSession(),
      status: 'GENERATING_GUIDE',
      guideDecision: 'CREATE',
      guideMaterialBatchId: 'batch_01',
      guideGenerationJobId: 'job_01',
      consent: {
        audio: true,
        screenShare: true,
        periodicCapture: true,
        textVersion: 'v1',
      },
      consentedAt: now,
      startedAt: now,
      revision: 5,
    }
    const batch: GuideMaterialBatch = {
      id: 'batch_01',
      supportSessionId: session.id,
      status: 'COMPLETED',
      captureIntervalSeconds: 5,
      expectedItemCount: 4,
      receivedItemCount: 4,
      capturedFrom: now,
      capturedTo: now,
      completedAt: now,
      revision: 6,
      createdAt: now,
      updatedAt: now,
    }
    const job: GuideGenerationJob = {
      id: 'job_01',
      batchId: batch.id,
      status: 'FAILED',
      attempt: 3,
      guideDraftId: null,
      errorCode: 'AI_TIMEOUT',
      startedAt: now,
      finishedAt: now,
      revision: 7,
      createdAt: now,
      updatedAt: now,
    }
    const api = {
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportSession: vi.fn().mockResolvedValue(session),
      getGuideMaterialBatch: vi.fn().mockResolvedValue({
        batch,
        materials: [],
      }),
      getGuideGenerationJob: vi.fn().mockResolvedValue(job),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    } as unknown as MiteApi

    render(
      <FamilyClient
        config={config}
        api={api}
        storage={new MemoryStorage()}
        liveSupport={quietLiveSupport()}
        eventStreamFactory={noEvents}
        pollIntervalMs={60_000}
      />,
    )

    expect(await screen.findByText(/実行上限の3回/)).toBeTruthy()
    const retryButton = screen.getByRole('button', {
      name: '手順作成を再試行',
    }) as HTMLButtonElement
    expect(retryButton.disabled).toBe(true)
  })

  it('resolve結果が不明で状態が未変更なら別選択を止め、同じbodyとキーで再送する', async () => {
    let currentRequest = activeRequest()
    let currentSession = activeSession()
    const resolveSupportSession = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('connection lost'))
      .mockImplementationOnce(async () => {
        currentRequest = {
          ...currentRequest,
          status: 'RESOLVED',
          revision: 4,
        }
        currentSession = {
          ...currentSession,
          status: 'GENERATING_GUIDE',
          guideDecision: 'CREATE',
          revision: 3,
        }
        return {
          supportRequest: currentRequest,
          supportSession: currentSession,
        }
      })
    const api = {
      listSupportRequests: vi
        .fn()
        .mockImplementation(async () => [currentRequest]),
      getSupportRequest: vi.fn().mockImplementation(async () => currentRequest),
      getSupportSession: vi.fn().mockImplementation(async () => currentSession),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
      getLiveKitToken: vi.fn().mockResolvedValue({
        serverUrl: 'wss://livekit.example.com',
        roomName: 'mite-session_01',
        participantIdentity: 'family:family_demo',
        token: 'livekit-token',
        expiresAt: '2026-09-03T10:30:00Z',
      }),
      resolveSupportSession,
    } as unknown as MiteApi

    render(
      <FamilyClient
        config={config}
        api={api}
        storage={new MemoryStorage()}
        liveSupport={quietLiveSupport()}
        eventStreamFactory={noEvents}
        pollIntervalMs={60_000}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: '支援を解決済みにする' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }))

    const retry = await screen.findByRole('button', {
      name: '同じ選択内容で送信を確認する',
    })
    const otherDecision = screen.getByRole('button', {
      name: '作成せず終了',
    }) as HTMLButtonElement
    expect(otherDecision.disabled).toBe(true)

    const firstCall = resolveSupportSession.mock.calls[0]
    fireEvent.click(retry)
    await waitFor(() => expect(resolveSupportSession).toHaveBeenCalledTimes(2))
    const secondCall = resolveSupportSession.mock.calls[1]
    expect(secondCall?.[1]).toEqual(firstCall?.[1])
    expect(secondCall?.[2]).toEqual(firstCall?.[2])
    expect(
      await screen.findByText('利用者の画面から手順を作っています'),
    ).toBeTruthy()
  })

  it('resolveが適用済みならGETで収束し、保留操作とキーを消す', async () => {
    let currentRequest = activeRequest()
    let currentSession = activeSession()
    const operationStorage = new MemoryStorage()
    const resolveSupportSession = vi.fn().mockImplementation(async () => {
      currentRequest = {
        ...currentRequest,
        status: 'RESOLVED',
        revision: 4,
      }
      currentSession = {
        ...currentSession,
        status: 'GENERATING_GUIDE',
        guideDecision: 'CREATE',
        revision: 3,
      }
      throw new TypeError('response lost')
    })
    const api = {
      listSupportRequests: vi
        .fn()
        .mockImplementation(async () => [currentRequest]),
      getSupportRequest: vi.fn().mockImplementation(async () => currentRequest),
      getSupportSession: vi.fn().mockImplementation(async () => currentSession),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
      getLiveKitToken: vi.fn().mockResolvedValue({
        serverUrl: 'wss://livekit.example.com',
        roomName: 'mite-session_01',
        participantIdentity: 'family:family_demo',
        token: 'livekit-token',
        expiresAt: '2026-09-03T10:30:00Z',
      }),
      resolveSupportSession,
    } as unknown as MiteApi

    render(
      <FamilyClient
        config={config}
        api={api}
        storage={operationStorage}
        liveSupport={quietLiveSupport()}
        eventStreamFactory={noEvents}
        pollIntervalMs={60_000}
      />,
    )

    fireEvent.click(
      await screen.findByRole('button', { name: '支援を解決済みにする' }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'ガイドを作る' }))

    expect(
      await screen.findByText('利用者の画面から手順を作っています'),
    ).toBeTruthy()
    expect(
      screen.queryByRole('button', {
        name: '同じ選択内容で送信を確認する',
      }),
    ).toBeNull()
    expect(
      operationStorage.getItem('mite.family.idem.resolve:session_01:CREATE'),
    ).toBeNull()
  })

  it('共有画面ではキーボード操作で中央へ一時マーキングを送れる', async () => {
    const request = activeRequest()
    const session = activeSession()
    const liveSupport = quietLiveSupport({
      connectionStatus: 'CONNECTED',
      microphoneEnabled: true,
      screenTrackSid: 'TR_screen',
    })
    const api = {
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn().mockResolvedValue(session),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
      getLiveKitToken: vi.fn().mockResolvedValue({
        serverUrl: 'wss://livekit.example.com',
        roomName: 'mite-session_01',
        participantIdentity: 'family:family_demo',
        token: 'livekit-token',
        expiresAt: '2026-09-03T10:30:00Z',
      }),
    } as unknown as MiteApi

    render(
      <FamilyClient
        config={config}
        api={api}
        storage={new MemoryStorage()}
        liveSupport={liveSupport}
        eventStreamFactory={noEvents}
        pollIntervalMs={60_000}
      />,
    )

    const sharedScreen = await screen.findByRole('button', {
      name: /共有画面。画面上をクリック/,
    })
    fireEvent.keyDown(sharedScreen, { key: 'Enter' })
    await waitFor(() =>
      expect(liveSupport.sendMark).toHaveBeenCalledWith({ x: 0.5, y: 0.5 }),
    )
  })
})
