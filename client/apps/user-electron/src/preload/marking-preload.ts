import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  DesktopMark,
  MarkingOverlayBridge,
} from '../shared/marking-overlay'

const bridge: MarkingOverlayBridge = Object.freeze({
  onMarksChanged: (listener: (marks: DesktopMark[]) => void) => {
    const receive = (_event: IpcRendererEvent, marks: DesktopMark[]) =>
      listener(marks)
    ipcRenderer.on('marking:changed', receive)
    ipcRenderer.send('marking:ready')
    return () => ipcRenderer.removeListener('marking:changed', receive)
  },
})

contextBridge.exposeInMainWorld('miteMarking', bridge)
