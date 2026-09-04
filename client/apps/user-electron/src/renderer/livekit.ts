import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client'
import type { LiveKitConnectionInfo } from '@mite/client-api'
import {
  decodeMarkingMessage,
  MITE_MARKING_TOPIC,
  type MarkingMessage,
} from '@mite/client-core'

export type MediaConnectionState =
  'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'

export interface UserMediaCallbacks {
  onStateChange(state: MediaConnectionState): void
  onMarking(message: MarkingMessage): void
  onAudioLevel(level: number): void
  onScreenShareStopped(): void
}

export interface UserMediaSession {
  connect(
    connection: LiveKitConnectionInfo,
    callbacks: UserMediaCallbacks,
  ): Promise<{ screenTrackSid: string }>
  setMicrophoneEnabled(enabled: boolean): Promise<void>
  startScreenShare(): Promise<{ screenTrackSid: string }>
  stopScreenShare(): Promise<void>
  disconnect(): Promise<void>
}

export class LiveKitUserMediaSession implements UserMediaSession {
  #room: Room | null = null
  #screenTrackSid: string | null = null
  readonly #audioElements = new Set<HTMLMediaElement>()

  async connect(
    connection: LiveKitConnectionInfo,
    callbacks: UserMediaCallbacks,
  ): Promise<{ screenTrackSid: string }> {
    await this.disconnect()
    callbacks.onStateChange('CONNECTING')
    const room = new Room({ adaptiveStream: true, dynacast: true })
    this.#room = room

    room.on(RoomEvent.Reconnecting, () => {
      callbacks.onStateChange('RECONNECTING')
    })
    room.on(RoomEvent.Reconnected, () => {
      callbacks.onStateChange('CONNECTED')
    })
    room.on(RoomEvent.Disconnected, () => {
      callbacks.onStateChange('DISCONNECTED')
    })
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      const familyLevel = speakers
        .filter((speaker) => speaker.identity.startsWith('family:'))
        .reduce((maximum, speaker) => Math.max(maximum, speaker.audioLevel), 0)
      callbacks.onAudioLevel(familyLevel)
    })
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return
      const element = track.attach()
      element.autoplay = true
      element.hidden = true
      document.body.append(element)
      this.#audioElements.add(element)
    })
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      for (const element of track.detach()) {
        this.#audioElements.delete(element)
        element.remove()
      }
    })
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, _participant, _kind, topic?: string) => {
        if (topic !== MITE_MARKING_TOPIC) return
        const message = decodeMarkingMessage(payload)
        if (!message || message.trackSid !== this.#screenTrackSid) return
        callbacks.onMarking(message)
      },
    )
    room.on(
      RoomEvent.LocalTrackUnpublished,
      (publication: LocalTrackPublication) => {
        if (publication.source !== Track.Source.ScreenShare) return
        this.#screenTrackSid = null
        callbacks.onScreenShareStopped()
      },
    )

    try {
      await room.connect(connection.serverUrl, connection.token)
      await room.localParticipant.setMicrophoneEnabled(true)
      const publication = await room.localParticipant.setScreenShareEnabled(
        true,
        { audio: false },
      )
      if (!publication?.trackSid) throw new Error('画面を共有できません')
      this.#screenTrackSid = publication.trackSid
      callbacks.onStateChange('CONNECTED')
      return { screenTrackSid: publication.trackSid }
    } catch (error) {
      await this.disconnect()
      callbacks.onStateChange('DISCONNECTED')
      throw error
    }
  }

  async setMicrophoneEnabled(enabled: boolean) {
    if (!this.#room) throw new Error('家族との通話に接続されていません')
    await this.#room.localParticipant.setMicrophoneEnabled(enabled)
  }

  async startScreenShare() {
    if (!this.#room) throw new Error('家族との通話に接続されていません')
    const publication = await this.#room.localParticipant.setScreenShareEnabled(
      true,
      { audio: false },
    )
    if (!publication?.trackSid) throw new Error('画面を共有できません')
    this.#screenTrackSid = publication.trackSid
    return { screenTrackSid: publication.trackSid }
  }

  async stopScreenShare() {
    if (!this.#room) return
    await this.#room.localParticipant.setScreenShareEnabled(false)
    this.#screenTrackSid = null
  }

  async disconnect() {
    const room = this.#room
    this.#room = null
    this.#screenTrackSid = null
    for (const element of this.#audioElements) element.remove()
    this.#audioElements.clear()
    if (room) await room.disconnect()
  }
}
