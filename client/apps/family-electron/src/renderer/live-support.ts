import type { LiveKitConnectionInfo } from '@mite/api-client'
import { encodeMarkingMessage, MITE_MARKING_TOPIC } from '@mite/client-core'
import {
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client'

export type LiveConnectionStatus =
  | 'IDLE'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'FAILED'

export interface LiveSupportSnapshot {
  connectionStatus: LiveConnectionStatus
  microphoneEnabled: boolean
  audioPlaybackBlocked: boolean
  screenTrackSid: string | null
  receivedAudioLevel: number
  errorMessage: string | null
}

export interface MarkPoint {
  x: number
  y: number
}

export interface FamilyLiveSupport {
  getSnapshot(): LiveSupportSnapshot
  subscribe(listener: (snapshot: LiveSupportSnapshot) => void): () => void
  connect(info: LiveKitConnectionInfo): Promise<void>
  disconnect(): Promise<void>
  setMicrophoneEnabled(enabled: boolean): Promise<void>
  startAudio(): Promise<void>
  attachScreen(element: HTMLVideoElement | null): void
  sendMark(point: MarkPoint): Promise<void>
  clearMarks(): Promise<void>
}

const initialSnapshot = (): LiveSupportSnapshot => ({
  connectionStatus: 'IDLE',
  microphoneEnabled: false,
  audioPlaybackBlocked: false,
  screenTrackSid: null,
  receivedAudioLevel: 0,
  errorMessage: null,
})

export class LiveKitFamilySupport implements FamilyLiveSupport {
  #room: Room | null = null
  #screenTrack: RemoteTrack | null = null
  #screenElement: HTMLVideoElement | null = null
  #audioElements = new Set<HTMLMediaElement>()
  #listeners = new Set<(snapshot: LiveSupportSnapshot) => void>()
  #snapshot = initialSnapshot()

  getSnapshot(): LiveSupportSnapshot {
    return this.#snapshot
  }

  subscribe(listener: (snapshot: LiveSupportSnapshot) => void): () => void {
    this.#listeners.add(listener)
    listener(this.#snapshot)
    return () => this.#listeners.delete(listener)
  }

  async connect(info: LiveKitConnectionInfo): Promise<void> {
    await this.disconnect()
    const room = new Room({ adaptiveStream: true, dynacast: true })
    this.#room = room
    this.#update({
      ...initialSnapshot(),
      connectionStatus: 'CONNECTING',
    })

    room.on(RoomEvent.Reconnecting, () => {
      this.#update({ connectionStatus: 'RECONNECTING', errorMessage: null })
    })
    room.on(RoomEvent.Reconnected, () => {
      this.#update({ connectionStatus: 'CONNECTED', errorMessage: null })
    })
    room.on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
      this.#update({ audioPlaybackBlocked: !playing })
    })
    room.on(RoomEvent.Disconnected, () => {
      if (this.#room !== room) return
      this.#clearRemoteMedia()
      this.#update({
        connectionStatus: 'DISCONNECTED',
        microphoneEnabled: false,
        audioPlaybackBlocked: false,
        errorMessage: '通話が切断されました。再接続してください。',
      })
    })
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (!participant.identity.startsWith('user:')) return
      this.#handleSubscribedTrack(track, publication)
    })
    room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
      this.#handleUnsubscribedTrack(track, publication)
    })
    room.on(RoomEvent.TrackUnpublished, (publication) => {
      if (publication.trackSid === this.#snapshot.screenTrackSid) {
        this.#setScreenTrack(null, null)
      }
    })
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const user = speakers.find((speaker) =>
        speaker.identity.startsWith('user:'),
      )
      this.#update({ receivedAudioLevel: user?.audioLevel ?? 0 })
    })

    try {
      await room.connect(info.serverUrl, info.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      this.#update({
        connectionStatus: 'CONNECTED',
        microphoneEnabled: true,
        audioPlaybackBlocked: !room.canPlaybackAudio,
        errorMessage: null,
      })
    } catch {
      if (this.#room === room) {
        this.#update({
          connectionStatus: 'FAILED',
          microphoneEnabled: false,
          errorMessage: '通話へ接続できませんでした。',
        })
      }
      await room.disconnect()
      throw new Error('LiveKit connection failed')
    }
  }

  async disconnect(): Promise<void> {
    const room = this.#room
    this.#room = null
    this.#clearRemoteMedia()
    if (room) await room.disconnect()
    this.#update(initialSnapshot())
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    const room = this.#room
    if (!room || this.#snapshot.connectionStatus !== 'CONNECTED') {
      throw new Error('LiveKit is not connected')
    }
    await room.localParticipant.setMicrophoneEnabled(enabled)
    this.#update({ microphoneEnabled: enabled })
  }

  async startAudio(): Promise<void> {
    const room = this.#room
    if (!room) throw new Error('LiveKit is not connected')
    await room.startAudio()
    this.#update({ audioPlaybackBlocked: false })
  }

  attachScreen(element: HTMLVideoElement | null): void {
    if (this.#screenElement && this.#screenTrack) {
      this.#screenTrack.detach(this.#screenElement)
    }
    this.#screenElement = element
    if (element && this.#screenTrack) this.#screenTrack.attach(element)
  }

  async sendMark(point: MarkPoint): Promise<void> {
    const room = this.#room
    const trackSid = this.#snapshot.screenTrackSid
    if (!room || !trackSid || this.#snapshot.connectionStatus !== 'CONNECTED') {
      throw new Error('Screen share is not available')
    }

    const payload = new Uint8Array(
      encodeMarkingMessage({
        type: 'mark.set',
        markId: crypto.randomUUID(),
        trackSid,
        x: point.x,
        y: point.y,
        shape: 'CIRCLE',
        ttlMs: 2_000,
        sentAt: new Date().toISOString(),
      }),
    )
    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: MITE_MARKING_TOPIC,
    })
  }

  async clearMarks(): Promise<void> {
    const room = this.#room
    const trackSid = this.#snapshot.screenTrackSid
    if (!room || !trackSid) return
    const payload = new Uint8Array(
      encodeMarkingMessage({
        type: 'mark.clear',
        trackSid,
        sentAt: new Date().toISOString(),
      }),
    )
    await room.localParticipant.publishData(payload, {
      reliable: true,
      topic: MITE_MARKING_TOPIC,
    })
  }

  #handleSubscribedTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) {
    if (track.kind === Track.Kind.Audio) {
      const element = track.attach()
      element.autoplay = true
      element.dataset.miteRemoteAudio = 'true'
      element.hidden = true
      document.body.append(element)
      this.#audioElements.add(element)
      return
    }
    if (
      track.kind === Track.Kind.Video &&
      publication.source === Track.Source.ScreenShare
    ) {
      this.#setScreenTrack(track, publication.trackSid)
    }
  }

  #handleUnsubscribedTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
  ) {
    for (const element of track.detach()) {
      this.#audioElements.delete(element)
      element.remove()
    }
    if (publication.trackSid === this.#snapshot.screenTrackSid) {
      this.#setScreenTrack(null, null)
    }
  }

  #setScreenTrack(track: RemoteTrack | null, trackSid: string | null) {
    if (this.#screenTrack && this.#screenElement) {
      this.#screenTrack.detach(this.#screenElement)
    }
    this.#screenTrack = track
    if (track && this.#screenElement) track.attach(this.#screenElement)
    this.#update({ screenTrackSid: trackSid })
  }

  #clearRemoteMedia() {
    if (this.#screenTrack && this.#screenElement) {
      this.#screenTrack.detach(this.#screenElement)
    }
    this.#screenTrack = null
    for (const element of this.#audioElements) element.remove()
    this.#audioElements.clear()
    this.#update({ screenTrackSid: null, receivedAudioLevel: 0 })
  }

  #update(patch: Partial<LiveSupportSnapshot>) {
    this.#snapshot = { ...this.#snapshot, ...patch }
    for (const listener of this.#listeners) listener(this.#snapshot)
  }
}
