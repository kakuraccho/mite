import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MiteApiError } from '@mite/client-api'
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
  acknowledgedAt: null,
  acknowledgementKind: null,
  estimatedSupportAt: null,
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
    textVersion: 'v4',
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
        textVersion: 'v4',
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

it('keeps audio during review and a failed save, then disconnects when saving succeeds', async () => {
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
  const completeGuideReview = vi
    .fn()
    .mockRejectedValueOnce(new TypeError('save response lost'))
    .mockImplementationOnce(async () => {
      session = {
        ...session,
        status: 'ENDED',
        endedAt: now,
        endReason: 'GUIDE_SAVED',
        guideId: 'guide_1',
        guideMaterialBatchId: null,
        revision: 7,
      }
      return { supportSession: session, guides: [{ id: 'guide_1' }] }
    })
  const endSupportSession = vi.fn()
  const api = {
    listSupportRequests: vi.fn().mockResolvedValue([request]),
    getSupportRequest: vi.fn().mockResolvedValue(request),
    getSupportSession: vi.fn(async () => session),
    listSessionGuideDrafts: vi.fn().mockResolvedValue([draft]),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob(['jpeg'])),
    getLiveKitToken: vi.fn().mockResolvedValue({ token: 'token' }),
    completeGuideReview,
    endSupportSession,
  } as unknown as MiteApi
  const media = quietLiveSupport({
    connectionStatus: 'CONNECTED',
    screenTrackSid: 'TR_screen',
    microphoneEnabled: true,
    localAudioLevel: 0.6,
  })
  const storage = new MemoryStorage()
  render(
    <FamilyClient
      config={config}
      api={api}
      storage={storage}
      liveSupport={media}
      eventStreamFactory={noEvents}
      pollIntervalMs={60000}
    />,
  )
  const save = await screen.findByRole('button', { name: 'レビュー完了' })
  await waitFor(() => expect(media.connect).toHaveBeenCalledOnce())
  expect(screen.queryByLabelText('支援依頼一覧')).toBeNull()
  expect(screen.getByLabelText('自分のマイクの大きさ')).toHaveAttribute(
    'value',
    '0.6',
  )
  fireEvent.click(save)
  const retry = await screen.findByRole('button', {
    name: '同じ内容でレビュー完了を確認する',
  })
  expect(media.disconnect).not.toHaveBeenCalled()
  fireEvent.click(retry)
  await screen.findByRole('heading', { name: '支援が完了しました' })
  expect(completeGuideReview.mock.calls[1]).toEqual(
    completeGuideReview.mock.calls[0],
  )
  await waitFor(() => expect(media.disconnect).toHaveBeenCalledOnce())
  expect(media.connect).toHaveBeenCalledOnce()
  expect(endSupportSession).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '通話を終了する' })).toBeNull()
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
const reviewDrafts: GuideDraft[] = ['ログインする', '住所を変更する'].map(
  (title, index) => ({
    id: `draft_${index + 1}`,
    supportSessionId: 'session_01',
    title,
    steps: [
      {
        position: 1,
        artifactId: `artifact_${index + 1}`,
        instruction: `${title}ボタンを押す`,
      },
    ],
    revision: index + 2,
    status: 'EDITING',
    createdAt: now,
    updatedAt: now,
  }),
)

function setupReviewFlow() {
  let currentSession: SupportSession = {
    ...activeSession(),
    status: 'REVIEWING_GUIDE',
    guideDecision: 'CREATE',
    guideDraftId: reviewDrafts[0]!.id,
    guideMaterialBatchId: 'batch_01',
    guideGenerationJobId: 'job_01',
    revision: 6,
  }
  const completeGuideReview = vi.fn<MiteApi['completeGuideReview']>(
    async () => {
      currentSession = {
        ...currentSession,
        status: 'ENDED',
        guideId: 'guide_01',
        endedAt: now,
        endReason: 'GUIDE_SAVED',
        revision: 7,
      }
      return { guides: [], supportSession: currentSession }
    },
  )
  const api = {
    listSupportRequests: vi
      .fn()
      .mockResolvedValue([{ ...activeRequest(), status: 'RESOLVED' }]),
    getSupportRequest: vi
      .fn()
      .mockResolvedValue({ ...activeRequest(), status: 'RESOLVED' }),
    getSupportSession: vi.fn(async () => currentSession),
    listSessionGuideDrafts: vi.fn().mockResolvedValue(reviewDrafts),
    getArtifactContent: vi.fn().mockResolvedValue(new Blob()),
    completeGuideReview,
  } as unknown as MiteApi
  const storage = new MemoryStorage()
  const props = {
    config,
    api,
    storage,
    liveSupport: quietLiveSupport(),
    eventStreamFactory: noEvents,
    pollIntervalMs: 60_000,
  }
  return {
    ...render(<FamilyClient {...props} />),
    props,
    storage,
    completeGuideReview,
  }
}

describe('FamilyClient guide review', () => {
  it('支援の全件を取得し、未展開のガイドも1回のAPIで確定する', async () => {
    const { completeGuideReview } = setupReviewFlow()
    await screen.findByRole('heading', {
      name: '今回の支援から2件のガイドを作成しました',
    })
    expect(
      screen.getByRole('button', { name: /住所を変更する.*1ステップ/ }),
    ).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'レビュー完了' }))
    await screen.findByRole('heading', { name: '支援が完了しました' })
    expect(completeGuideReview).toHaveBeenCalledExactlyOnceWith(
      'session_01',
      {
        expectedSessionRevision: 6,
        drafts: [
          { id: 'draft_1', expectedRevision: 2 },
          { id: 'draft_2', expectedRevision: 3 },
        ],
      },
      { idempotencyKey: expect.any(String) },
    )
  })

  it('応答不明でも完了表示に進めず、再起動後も同じ本文とキーで再送する', async () => {
    const { completeGuideReview, unmount, props, storage } = setupReviewFlow()
    completeGuideReview.mockRejectedValueOnce(new TypeError('offline'))
    await screen.findByRole('button', { name: 'レビュー完了' })
    fireEvent.click(screen.getByRole('button', { name: 'レビュー完了' }))
    await screen.findByRole('button', {
      name: '同じ内容でレビュー完了を確認する',
    })
    expect(
      screen.queryByRole('heading', { name: '支援が完了しました' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'レビュー完了' })).toBeDisabled()
    const originalCall = completeGuideReview.mock.calls[0]
    unmount()
    render(<FamilyClient {...props} />)
    await screen.findByRole('button', { name: 'レビュー完了' })
    expect(screen.getByRole('textbox', { name: /手順の名前/ })).toBeDisabled()
    fireEvent.click(
      screen.getByRole('button', { name: '同じ内容でレビュー完了を確認する' }),
    )
    await screen.findByRole('heading', { name: '支援が完了しました' })
    expect(completeGuideReview).toHaveBeenCalledTimes(2)
    expect(completeGuideReview.mock.calls[1]).toEqual(originalCall)
    expect(storage.getItem('mite.family.pendingGuideReview')).toBeNull()
  })

  it('確定の競合を表示し、全ガイドをレビュー画面に残す', async () => {
    const { completeGuideReview, storage } = setupReviewFlow()
    completeGuideReview.mockRejectedValueOnce(
      new MiteApiError(409, {
        error: {
          code: 'REVISION_CONFLICT',
          message: 'conflict',
          requestId: 'request_01',
        },
      }),
    )
    await screen.findByRole('button', { name: 'レビュー完了' })
    fireEvent.click(screen.getByRole('button', { name: 'レビュー完了' }))
    await waitFor(() => expect(completeGuideReview).toHaveBeenCalledOnce())
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'レビュー完了' }),
      ).toBeEnabled(),
    )
    expect(screen.getAllByRole('article')).toHaveLength(2)
    expect(
      screen.queryByRole('heading', { name: '支援が完了しました' }),
    ).not.toBeInTheDocument()
    expect(storage.getItem('mite.family.pendingGuideReview')).toBeNull()
  })
})
