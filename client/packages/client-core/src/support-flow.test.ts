import type { SupportRequest, SupportSession } from '@mite/client-api'
import { describe, expect, it } from 'vitest'
import {
  deriveFamilySupportScreen,
  deriveUserSupportScreen,
} from './support-flow'

const baseRequest: SupportRequest = {
  id: 'request_01',
  userId: 'user_demo',
  familyId: 'family_demo',
  initialScreenshotArtifactId: 'artifact_01',
  comment: '',
  status: 'PENDING',
  supportSessionId: null,
  guideContext: null,
  acknowledgedAt: null,
  acknowledgementKind: null,
  estimatedSupportAt: null,
  createdAt: '2026-09-03T00:00:00Z',
  updatedAt: '2026-09-03T00:00:00Z',
  revision: 1,
}

const session = (status: SupportSession['status']): SupportSession => ({
  id: 'session_01',
  supportRequestId: baseRequest.id,
  userId: 'user_demo',
  familyId: 'family_demo',
  livekitRoomName: 'mite-session_01',
  status,
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
  createdAt: '2026-09-03T00:00:00Z',
  updatedAt: '2026-09-03T00:00:00Z',
  revision: 1,
})

describe('support screen derivation', () => {
  it('利用者側の支援状態をサーバー状態から決める', () => {
    expect(deriveUserSupportScreen(null, null)).toBe('HOME')
    expect(deriveUserSupportScreen(baseRequest, null)).toBe(
      'WAITING_FOR_FAMILY',
    )
    expect(deriveUserSupportScreen(baseRequest, session('RINGING'))).toBe(
      'INCOMING_CALL',
    )
    expect(deriveUserSupportScreen(baseRequest, session('ACTIVE'))).toBe(
      'ACTIVE_SUPPORT',
    )
    expect(
      deriveUserSupportScreen(baseRequest, session('GENERATING_GUIDE')),
    ).toBe('GUIDE_GENERATING')
    expect(
      deriveUserSupportScreen(baseRequest, session('REVIEWING_GUIDE')),
    ).toBe('GUIDE_DRAFT_REVIEW')
    expect(deriveUserSupportScreen(baseRequest, session('ENDED'))).toBe(
      'SUPPORT_ENDED',
    )
  })

  it('家族側の支援状態をサーバー状態から決める', () => {
    expect(deriveFamilySupportScreen(null, null)).toBe('REQUEST_LIST')
    expect(deriveFamilySupportScreen(baseRequest, null)).toBe('REQUEST_DETAIL')
    expect(
      deriveFamilySupportScreen(baseRequest, session('REVIEWING_GUIDE')),
    ).toBe('GUIDE_DRAFT_EDIT')
    expect(deriveFamilySupportScreen(baseRequest, session('RINGING'))).toBe(
      'CALLING',
    )
    expect(deriveFamilySupportScreen(baseRequest, session('ACTIVE'))).toBe(
      'ACTIVE_SUPPORT',
    )
    expect(
      deriveFamilySupportScreen(baseRequest, session('GENERATING_GUIDE')),
    ).toBe('GUIDE_GENERATING')
    expect(deriveFamilySupportScreen(baseRequest, session('ENDED'))).toBe(
      'SUPPORT_ENDED',
    )
  })
})
