import type { GuideDraft } from '@mite/client-api'

export const isValidDraft = (draft: GuideDraft) => {
  const titleLength = Array.from(draft.title.trim()).length
  return (
    titleLength >= 1 &&
    titleLength <= 40 &&
    draft.steps.length >= 1 &&
    draft.steps.length <= 8 &&
    draft.steps.every((step) => {
      const length = Array.from(step.instruction.trim()).length
      return length >= 1 && length <= 120
    })
  )
}
