import { createContext, type Dispatch } from 'react'
import type { AppAction, AppState } from '../domain/types'

export interface MiteContextValue {
  state: AppState
  dispatch: Dispatch<AppAction>
}

export const MiteContext = createContext<MiteContextValue | null>(null)
