import {
  useEffect,
  useMemo,
  useReducer,
  type PropsWithChildren,
} from 'react'
import { createInitialState } from '../domain/fixtures'
import { miteReducer } from '../domain/reducer'
import {
  findMockMatchingGuide,
  getMockDelays,
} from '../services/mockMiteService'
import { MiteContext } from './mite-context'

export function MiteProvider({
  children,
  initialState = createInitialState('A'),
}: PropsWithChildren<{ initialState?: ReturnType<typeof createInitialState> }>) {
  const [state, dispatch] = useReducer(miteReducer, initialState)
  const matchingGuideId = findMockMatchingGuide(state)?.id ?? null

  useEffect(() => {
    if (state.supportRequest?.status !== 'matching') return

    const delays = getMockDelays(state.settings.fastMode)
    const timer = window.setTimeout(() => {
      dispatch(
        matchingGuideId
          ? { type: 'GUIDE_MATCH_FOUND', guideId: matchingGuideId }
          : { type: 'GUIDE_MATCH_NOT_FOUND' },
      )
    }, delays.matching)

    return () => window.clearTimeout(timer)
  }, [
    matchingGuideId,
    state.settings.fastMode,
    state.supportRequest?.status,
  ])

  useEffect(() => {
    if (state.supportSession.status !== 'connecting') return

    const timer = window.setTimeout(
      () => dispatch({ type: 'CONNECTION_ESTABLISHED' }),
      getMockDelays(state.settings.fastMode).connecting,
    )
    return () => window.clearTimeout(timer)
  }, [state.settings.fastMode, state.supportSession.status])

  useEffect(() => {
    if (state.supportSession.status !== 'guideGenerating') return

    const timer = window.setTimeout(
      () => dispatch({ type: 'GUIDE_DRAFT_GENERATED' }),
      getMockDelays(state.settings.fastMode).guideGeneration,
    )
    return () => window.clearTimeout(timer)
  }, [state.settings.fastMode, state.supportSession.status])

  useEffect(() => {
    if (state.supportSession.status !== 'supporting') return

    const timer = window.setInterval(
      () => dispatch({ type: 'MOCK_CAPTURE_TICK' }),
      getMockDelays(state.settings.fastMode).captureInterval,
    )
    return () => window.clearInterval(timer)
  }, [state.settings.fastMode, state.supportSession.status])

  const value = useMemo(() => ({ state, dispatch }), [state])

  return <MiteContext.Provider value={value}>{children}</MiteContext.Provider>
}
