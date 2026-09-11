import {
  Room,
  createAudioAnalyser,
  RoomEvent,
  Track,
  type LocalTrackPublication,
  type RemoteTrack,
} from 'livekit-client'
import type { LiveKitConnectionInfo } from '@mite/client-api'
import {
  decodeMarkingMessage,
  decodeGuidanceMessage,
  MITE_GUIDANCE_TOPIC,
  type GuidanceMessage,
  MITE_MARKING_TOPIC,
  type MarkingMessage,
} from '@mite/client-core'

export type MediaConnectionState =
  'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED'

export interface UserMediaCallbacks {
  onStateChange(state: MediaConnectionState): void
  onGuidance?(message: GuidanceMessage | null): void
  onMarking(message: MarkingMessage): void
  onAudioLevel(level: number): void
  onLocalAudioLevel?(level: number): void
  onScreenShareStopped(): void
}

export interface UserMediaSession {
  connect(
    connection: LiveKitConnectionInfo,
    callbacks: UserMediaCallbacks,
    options?: { shareScreen?: boolean },
  ): Promise<{ screenTrackSid: string | null }>
  setMicrophoneEnabled(enabled: boolean): Promise<void>
  startScreenShare(): Promise<{ screenTrackSid: string }>
  stopScreenShare(): Promise<void>
  disconnect(): Promise<void>
}

export class LiveKitUserMediaSession implements UserMediaSession {
  #room: Room | null = null
  #stopMeter: (() => void) | null = null
  #callbacks: UserMediaCallbacks | null = null
  #guidanceSequence = new Map<string, number>()
  #screenTrackSid: string | null = null
  readonly #audioElements = new Set<HTMLMediaElement>()
  #screenOperation: Promise<unknown> = Promise.resolve()

  async connect(
    connection: LiveKitConnectionInfo,
    callbacks: UserMediaCallbacks,
    options: { shareScreen?: boolean } = {},
  ): Promise<{ screenTrackSid: string | null }> {
    await this.disconnect()
    this.#callbacks = callbacks
    callbacks.onStateChange('CONNECTING')
    const room = new Room({ adaptiveStream: true, dynacast: true })
    this.#room = room

    room.on(RoomEvent.Reconnecting, () => {
      if (this.#room !== room) return
      this.#stopMeter?.()
      callbacks.onGuidance?.(null)
      callbacks.onStateChange('RECONNECTING')
    })
    room.on(RoomEvent.Reconnected, () => {
      if (this.#room !== room) return
      this.#startMeter()
      callbacks.onStateChange('CONNECTED')
    })
    room.on(RoomEvent.Disconnected, () => {
      if (this.#room !== room) return
      this.#stopMeter?.()
      callbacks.onGuidance?.(null)
      callbacks.onStateChange('DISCONNECTED')
    })
    room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
      if (this.#room !== room) return
      const familyLevel = speakers
        .filter((speaker) => speaker.identity.startsWith('family:'))
        .reduce((maximum, speaker) => Math.max(maximum, speaker.audioLevel), 0)
      callbacks.onAudioLevel(familyLevel)
    })
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (this.#room !== room) return
      if (track.kind !== Track.Kind.Audio) return
      const element = track.attach()
      element.autoplay = true
      element.hidden = true
      document.body.append(element)
      this.#audioElements.add(element)
    })
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      if (this.#room !== room) return
      for (const element of track.detach()) {
        this.#audioElements.delete(element)
        element.remove()
      }
    })
    room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant, _kind, topic?: string) => {
        if (this.#room !== room || !participant?.identity.startsWith('family:'))
          return
        if (topic === MITE_GUIDANCE_TOPIC) {
          const message = decodeGuidanceMessage(payload)
          const sender = participant.sid
          if (
            !message ||
            message.trackSid !== this.#screenTrackSid ||
            message.sequence <= (this.#guidanceSequence.get(sender) ?? 0)
          )
            return
          this.#guidanceSequence.set(sender, message.sequence)
          callbacks.onGuidance?.(message)
          return
        }
        if (topic !== MITE_MARKING_TOPIC) return
        const message = decodeMarkingMessage(payload)
        if (!message || message.trackSid !== this.#screenTrackSid) return
        callbacks.onMarking(message)
      },
    )
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.#room !== room || !participant.identity.startsWith('family:'))
        return
      callbacks.onGuidance?.(null)
      if (this.#screenTrackSid)
        callbacks.onMarking({
          type: 'mark.clear',
          trackSid: this.#screenTrackSid,
          sentAt: new Date().toISOString(),
        })
    })
    room.on(
      RoomEvent.LocalTrackUnpublished,
      (publication: LocalTrackPublication) => {
        if (
          this.#room !== room ||
          publication.source !== Track.Source.ScreenShare
        )
          return
        this.#screenTrackSid = null
        callbacks.onGuidance?.(null)
        callbacks.onScreenShareStopped()
      },
    )

    try {
      await room.connect(connection.serverUrl, connection.token)
      if (this.#room !== room) throw new Error('通話は終了しています')
      await room.localParticipant.setMicrophoneEnabled(true)
      if (this.#room !== room) throw new Error('通話は終了しています')
      this.#startMeter()
      const sharing =
        options.shareScreen === false
          ? { screenTrackSid: null }
          : await this.startScreenShare()
      callbacks.onStateChange('CONNECTED')
      return sharing
    } catch (error) {
      if (this.#room === room) await this.disconnect()
      else await room.disconnect()
      callbacks.onStateChange('DISCONNECTED')
      throw error
    }
  }

  async setMicrophoneEnabled(enabled: boolean) {
    if (!this.#room) throw new Error('家族との通話に接続されていません')
    await this.#room.localParticipant.setMicrophoneEnabled(enabled)
    this.#startMeter()
  }

  startScreenShare() {
    const room = this.#room
    const operation = this.#screenOperation
      .catch(() => {})
      .then(async () => {
        if (!room || this.#room !== room)
          throw new Error('家族との通話に接続されていません')
        const publication = await room.localParticipant.setScreenShareEnabled(
          true,
          { audio: false },
        )
        if (this.#room !== room) {
          await room.disconnect()
          throw new Error('通話は終了しています')
        }
        if (!publication?.trackSid) throw new Error('画面を共有できません')
        this.#screenTrackSid = publication.trackSid
        return { screenTrackSid: publication.trackSid }
      })
    this.#screenOperation = operation
    return operation
  }

  stopScreenShare() {
    const room = this.#room
    this.#screenTrackSid = null
    this.#callbacks?.onGuidance?.(null)
    const operation = this.#screenOperation
      .catch(() => {})
      .then(async () => {
        if (!room || this.#room !== room) return
        await room.localParticipant.setScreenShareEnabled(false)
        this.#screenTrackSid = null
      })
    this.#screenOperation = operation
    return operation
  }

  #startMeter() {
    this.#stopMeter?.()
    this.#stopMeter = null
    const callbacks = this.#callbacks
    const room = this.#room
    callbacks?.onLocalAudioLevel?.(0)
    const track = room?.localParticipant.getTrackPublication(
      Track.Source.Microphone,
    )?.audioTrack
    if (!track || track.isMuted) return
    try {
      const analyser = createAudioAnalyser(track, {
        minDecibels: -70,
        maxDecibels: -10,
      })
      const timer = setInterval(() => {
        if (this.#room === room)
          callbacks?.onLocalAudioLevel?.(
            track.isMuted ? 0 : analyser.calculateVolume(),
          )
      }, 100)
      this.#stopMeter = () => {
        clearInterval(timer)
        void analyser.cleanup().catch(() => {})
        callbacks?.onLocalAudioLevel?.(0)
      }
    } catch {
      callbacks?.onLocalAudioLevel?.(0)
    }
  }

  async disconnect() {
    const room = this.#room
    this.#room = null
    this.#stopMeter?.()
    this.#stopMeter = null
    this.#callbacks?.onGuidance?.(null)
    this.#callbacks = null
    this.#guidanceSequence.clear()
    this.#screenTrackSid = null
    for (const element of this.#audioElements) element.remove()
    this.#audioElements.clear()
    if (room) await room.disconnect()
  }
}
