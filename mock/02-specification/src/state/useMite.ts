import { useContext } from 'react'
import { MiteContext } from './mite-context'

export const useMite = () => {
  const value = useContext(MiteContext)
  if (!value) throw new Error('useMite must be used inside MiteProvider')
  return value
}
