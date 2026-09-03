import type { SupportRequest, SupportSession } from '@mite/api-client'

export type UserSupportScreen =
  | 'HOME'
  | 'WAITING_FOR_FAMILY'
  | 'INCOMING_CALL'
  | 'ACTIVE_SUPPORT'
  | 'GUIDE_GENERATING'
  | 'GUIDE_DRAFT_REVIEW'
  | 'SUPPORT_ENDED'

export type FamilySupportScreen =
  | 'REQUEST_LIST'
  | 'REQUEST_DETAIL'
  | 'CALLING'
  | 'ACTIVE_SUPPORT'
  | 'GUIDE_GENERATING'
  | 'GUIDE_DRAFT_EDIT'
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
    case 'ENDED':
      return 'SUPPORT_ENDED'
  }
}
