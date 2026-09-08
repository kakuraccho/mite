export const MITE_GUIDANCE_TOPIC = 'mite.guidance.v1'
export const GUIDANCE_TTL_MS = 2_000
export type GuidanceMode = 'CURSOR_MOUSE' | 'KEYBOARD'
export interface GuidanceState {
  mode: GuidanceMode
  x: number
  y: number
  buttons: number
  keys: string[]
}
interface GuidanceEnvelope {
  trackSid: string
  sequence: number
  sentAt: string
}
export type GuidanceMessage = GuidanceEnvelope &
  (
    | ({ type: 'guidance.set'; ttlMs: number } & GuidanceState)
    | { type: 'guidance.clear' }
  )

const labels: Record<string, string> = {
  ControlLeft: 'Ctrl',
  ControlRight: 'Ctrl',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
  AltLeft: 'Alt',
  AltRight: 'Alt',
  MetaLeft: 'Windows',
  MetaRight: 'Windows',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Esc',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Convert: '変換',
  NonConvert: '無変換',
  KanaMode: 'かな',
  Lang1: 'かな',
  Lang2: '英数',
  IntlYen: '¥',
  IntlRo: '\\',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadDecimal: '.',
  CapsLock: 'CapsLock',
  NumLock: 'NumLock',
  PrintScreen: 'PrintScreen',
}
export const guidanceKeyLabel = (code: string): string | null => {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code.slice(6)
  if (/^F([1-9]|1[0-2])$/.test(code)) return code
  return labels[code] ?? null
}
const allowedKeys = new Set([
  ...Object.values(labels),
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
])
export const isGuidanceState = (value: unknown): value is GuidanceState => {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    (v.mode === 'CURSOR_MOUSE' || v.mode === 'KEYBOARD') &&
    typeof v.x === 'number' &&
    Number.isFinite(v.x) &&
    v.x >= 0 &&
    v.x <= 1 &&
    typeof v.y === 'number' &&
    Number.isFinite(v.y) &&
    v.y >= 0 &&
    v.y <= 1 &&
    typeof v.buttons === 'number' &&
    Number.isInteger(v.buttons) &&
    v.buttons >= 0 &&
    v.buttons <= 7 &&
    Array.isArray(v.keys) &&
    v.keys.length <= 8 &&
    new Set(v.keys).size === v.keys.length &&
    v.keys.every(
      (key: unknown) => typeof key === 'string' && allowedKeys.has(key),
    ) &&
    (v.mode === 'KEYBOARD' ? v.buttons === 0 : v.keys.length === 0)
  )
}
export const encodeGuidanceMessage = (message: GuidanceMessage): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(message))
export const decodeGuidanceMessage = (
  payload: Uint8Array,
): GuidanceMessage | null => {
  if (payload.byteLength > 2048) return null
  try {
    const v = JSON.parse(new TextDecoder().decode(payload)) as Record<
      string,
      unknown
    >
    if (
      !v ||
      typeof v !== 'object' ||
      typeof v.trackSid !== 'string' ||
      !v.trackSid ||
      v.trackSid.length > 256 ||
      typeof v.sequence !== 'number' ||
      !Number.isSafeInteger(v.sequence) ||
      v.sequence < 1 ||
      typeof v.sentAt !== 'string' ||
      !Number.isFinite(Date.parse(v.sentAt))
    )
      return null
    if (v.type === 'guidance.clear') return v as unknown as GuidanceMessage
    return v.type === 'guidance.set' &&
      v.ttlMs === GUIDANCE_TTL_MS &&
      isGuidanceState(v)
      ? (v as unknown as GuidanceMessage)
      : null
  } catch {
    return null
  }
}
