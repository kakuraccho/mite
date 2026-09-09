import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  GuideDraft,
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
  captureIntervalMs: 10_000,
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
    textVersion: 'v3',
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
    localAudioLevel: 0,
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
    sendGuidance: vi.fn().mockResolvedValue(undefined),
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
        textVersion: 'v3',
      },
      consentedAt: now,
      startedAt: now,
      revision: 5,
    }
    const batch: GuideMaterialBatch = {
      id: 'batch_01',
      supportSessionId: session.id,
      status: 'COMPLETED',
      captureIntervalSeconds: 10,
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

    const sharedScreen = await screen.findByRole('group', {
      name: /共有画面。選んだモード/,
    })
    fireEvent.keyDown(sharedScreen, { key: 'Enter' })
    await waitFor(() =>
      expect(liveSupport.sendMark).toHaveBeenCalledWith({ x: 0.5, y: 0.5 }),
    )
  })
})

it('retries a failed save and manual end exactly, keeps the call/video attached through save, and restores a saved call', async () => {
  const request = { ...activeRequest(), status: 'RESOLVED' as const }
  let session: SupportSession = {
    ...activeSession(),
    status: 'REVIEWING_GUIDE',
    guideDecision: 'CREATE',
    guideDraftId: 'draft_1',
    guideMaterialBatchId: 'batch_1',
    revision: 6,
  }
  const draft: GuideDraft = {
    id: 'draft_1',
    supportSessionId: session.id,
    status: 'EDITING',
    revision: 2,
    title: '確認する手順',
    steps: [
      { position: 1, artifactId: 'art_1', instruction: '保存を押します' },
    ],
    createdAt: now,
    updatedAt: now,
  }
  const saveGuideDraft = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('save response lost'))
    .mockImplementationOnce(async () => {
      session = {
        ...session,
        status: 'GUIDE_SAVED',
        guideId: 'guide_1',
        guideMaterialBatchId: null,
        revision: 7,
      }
      return { supportSession: session, guide: { id: 'guide_1' } }
    })
  const endSupportSession = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('end response lost'))
    .mockImplementationOnce(async () => {
      session = {
        ...session,
        status: 'ENDED',
        endedAt: now,
        endReason: 'GUIDE_SAVED',
        revision: 8,
      }
      return session
    })
  const api = {
    listSupportRequests: vi.fn().mockResolvedValue([request]),
    getSupportRequest: vi.fn().mockResolvedValue(request),
    getSupportSession: vi.fn(async () => session),
    getGuideDraft: vi.fn().mockResolvedValue(draft),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    saveGuideDraft,
    endSupportSession,
  } as unknown as MiteApi
  const media = quietLiveSupport({
    connectionStatus: 'CONNECTED',
    screenTrackSid: 'TR_screen',
    microphoneEnabled: true,
    localAudioLevel: 0.6,
  })
  const storage = new MemoryStorage()
  const first = render(
    <FamilyClient
      config={config}
      api={api}
      storage={storage}
      liveSupport={media}
      eventStreamFactory={noEvents}
      pollIntervalMs={60000}
    />,
  )
  const save = await screen.findByRole('button', { name: 'ガイドを保存' })
  await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
  expect(screen.queryByLabelText('支援依頼一覧')).toBeNull()
  expect(screen.getByLabelText('自分のマイクの大きさ')).toHaveAttribute(
    'value',
    '0.6',
  )
  fireEvent.click(save)
  const retry = await screen.findByRole('button', {
    name: '同じ内容で保存を確認する',
  })
  expect(media.disconnect).not.toHaveBeenCalled()
  fireEvent.click(retry)
  await screen.findByRole('dialog', { name: 'ガイドを保存しました' })
  expect(saveGuideDraft.mock.calls[1]).toEqual(saveGuideDraft.mock.calls[0])
  expect(media.disconnect).not.toHaveBeenCalled()
  expect(media.attachScreen).not.toHaveBeenCalledWith(null)
  expect(media.connect).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(endSupportSession).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
  first.unmount()
  const restored = quietLiveSupport({
    connectionStatus: 'CONNECTED',
    screenTrackSid: 'TR_new',
  })
  render(
    <FamilyClient
      config={config}
      api={api}
      storage={storage}
      liveSupport={restored}
      eventStreamFactory={noEvents}
      pollIntervalMs={60000}
    />,
  )
  await screen.findByRole('dialog', { name: 'ガイドを保存しました' })
  await waitFor(() => expect(restored.connect).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  fireEvent.click(screen.getByRole('button', { name: '通話を終了する' }))
  const retryEnd = await screen.findByRole('button', {
    name: '同じ内容で通話終了を確認する',
  })
  expect(restored.disconnect).not.toHaveBeenCalled()
  fireEvent.click(retryEnd)
  await screen.findByText('支援が完了しました')
  expect(endSupportSession.mock.calls[1]).toEqual(
    endSupportSession.mock.calls[0],
  )
  expect(restored.disconnect).toHaveBeenCalledOnce()
  expect(
    screen.queryByRole('dialog', { name: 'ガイドを作りますか？' }),
  ).toBeNull()
  expect(screen.getByLabelText('支援依頼一覧')).toBeTruthy()
  expect(screen.getByText('現在、支援依頼はありません。')).toBeTruthy()
})

it.each(['SKIP', 'CANCEL'] as const)(
  'ends the call after %s with a confirmation popup',
  async (decision) => {
    const request = activeRequest()
    let session: SupportSession =
      decision === 'SKIP'
        ? activeSession()
        : {
            ...activeSession(),
            status: 'GENERATING_GUIDE',
            guideDecision: 'CREATE',
            revision: 3,
          }
    const end = async () => {
      session = {
        ...session,
        status: 'ENDED',
        endReason: decision === 'SKIP' ? 'GUIDE_SKIPPED' : 'GUIDE_CANCELLED',
        endedAt: now,
        revision: session.revision + 1,
      }
      return session
    }
    const resolveSupportSession = vi.fn(async () => ({
      supportRequest: { ...request, status: 'RESOLVED' },
      supportSession: await end(),
    }))
    const endSupportSessionWithoutGuide = vi.fn(end)
    const api = {
      listSupportRequests: vi.fn().mockResolvedValue([request]),
      getSupportRequest: vi.fn().mockResolvedValue(request),
      getSupportSession: vi.fn(async () => session),
      getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
      getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
      resolveSupportSession,
      endSupportSessionWithoutGuide,
    } as unknown as MiteApi
    const media = quietLiveSupport({ connectionStatus: 'CONNECTED' })
    render(
      <FamilyClient
        config={config}
        api={api}
        storage={new MemoryStorage()}
        liveSupport={media}
        eventStreamFactory={noEvents}
        pollIntervalMs={60000}
      />,
    )
    await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
    if (decision === 'SKIP') {
      fireEvent.click(
        await screen.findByRole('button', { name: '支援を解決済みにする' }),
      )
      expect(
        screen.getByRole('dialog', { name: 'ガイドを作りますか？' }),
      ).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: '作成せず終了' }))
    } else {
      fireEvent.click(
        await screen.findByRole('button', { name: '作成せず終了' }),
      )
      expect(endSupportSessionWithoutGuide).not.toHaveBeenCalled()
      fireEvent.click(
        screen.getByRole('button', { name: '作成を中止して通話を終了' }),
      )
    }
    await screen.findByText('支援が完了しました')
    await waitFor(() => expect(media.disconnect).toHaveBeenCalled())
  },
)
