import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopMark,
  DesktopGuidance,
  MarkingOverlayBridge,
} from '../shared/marking-overlay'

const bridge: MarkingOverlayBridge = Object.freeze({
  onGuidanceChanged: (listener: (guidance: DesktopGuidance | null) => void) => {
    const receive = (
      _event: IpcRendererEvent,
      guidance: DesktopGuidance | null,
    ) => listener(guidance)
    ipcRenderer.on('guidance:changed', receive)
    ipcRenderer.send('marking:ready')
    return () => ipcRenderer.removeListener('guidance:changed', receive)
  },
  onMarksChanged: (listener: (marks: DesktopMark[]) => void) => {
    const receive = (_event: IpcRendererEvent, marks: DesktopMark[]) =>
      listener(marks)
    ipcRenderer.on('marking:changed', receive)
    ipcRenderer.send('marking:ready')
    return () => ipcRenderer.removeListener('marking:changed', receive)
  },
})

contextBridge.exposeInMainWorld('miteMarking', bridge)
