import type { SupportRequest, SupportSession } from '@mite/client-api'

export type UserSupportScreen =
  | 'HOME'
  | 'WAITING_FOR_FAMILY'
  | 'INCOMING_CALL'
  | 'ACTIVE_SUPPORT'
  | 'GUIDE_GENERATING'
  | 'GUIDE_DRAFT_REVIEW'
  | 'GUIDE_SAVED'
  | 'SUPPORT_ENDED'

export type FamilySupportScreen =
  | 'REQUEST_LIST'
  | 'REQUEST_DETAIL'
  | 'CALLING'
  | 'ACTIVE_SUPPORT'
  | 'GUIDE_GENERATING'
  | 'GUIDE_DRAFT_EDIT'
  | 'GUIDE_SAVED'
  | 'SUPPORT_ENDED'

export const deriveUserSupportScreen = (
  request: SupportRequest | null,
  session: SupportSession | null,
): UserSupportScreen => {
  if (!request) return 'HOME'
  if (!session) return 'WAITING_FOR_FAMILY'
  switch (session.status) {
    case 'RINGING':
      return 'INCOMING_CALL'
    case 'ACTIVE':
      return 'ACTIVE_SUPPORT'
    case 'GENERATING_GUIDE':
      return 'GUIDE_GENERATING'
    case 'REVIEWING_GUIDE':
      return 'GUIDE_DRAFT_REVIEW'
    case 'GUIDE_SAVED':
      return 'GUIDE_SAVED'
    case 'ENDED':
      return 'SUPPORT_ENDED'
  }
}

export const deriveFamilySupportScreen = (
  request: SupportRequest | null,
  session: SupportSession | null,
): FamilySupportScreen => {
  if (!request) return 'REQUEST_LIST'
  if (!session) return 'REQUEST_DETAIL'
  switch (session.status) {
    case 'RINGING':
      return 'CALLING'
    case 'ACTIVE':
      return 'ACTIVE_SUPPORT'
    case 'GENERATING_GUIDE':
      return 'GUIDE_GENERATING'
    case 'REVIEWING_GUIDE':
      return 'GUIDE_DRAFT_EDIT'
    case 'GUIDE_SAVED':
      return 'GUIDE_SAVED'
    case 'ENDED':
      return 'SUPPORT_ENDED'
  }
}

export const canContinueCall = (session: SupportSession | null): boolean =>
  !!session &&
  ['ACTIVE', 'GENERATING_GUIDE', 'REVIEWING_GUIDE', 'GUIDE_SAVED'].includes(
    session.status,
  )

export const canCaptureGuideMaterial = (
  session: SupportSession | null,
  sharing: boolean,
): boolean => session?.status === 'ACTIVE' && sharing

export const CAPTURE_INTERVAL_MS = 10_000
