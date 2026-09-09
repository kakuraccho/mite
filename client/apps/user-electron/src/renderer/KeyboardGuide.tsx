interface Keycap {
  label: string
  key?: string
  width?: number
  height?: number
}

const key = (label: string, width = 1, value = label): Keycap => ({
  label,
  key: value,
  width,
})
const letters = (text: string) => [...text].map((letter) => key(letter))
// A compact Windows keyboard. Repeated modifiers use the left-hand key as
// the suggested position because the guidance protocol carries key names.
const rows: Keycap[][] = [
  [
    key('Esc'),
    ...Array.from({ length: 12 }, (_, i) => key(`F${i + 1}`)),
    key('PrtSc', 1.3, 'PrintScreen'),
    key('Delete', 1.3),
  ],
  [
    key('半角\n全角', 1.5, '`'),
    ...letters('1234567890'),
    key('-'),
    key('='),
    key('¥'),
    key('⌫', 1.7, 'Backspace'),
  ],
  [
    key('Tab', 1.5),
    ...letters('QWERTYUIOP'),
    key('['),
    key(']'),
    { ...key('Enter', 2), height: 120 },
  ],
  [
    key('Caps', 1.5, 'CapsLock'),
    ...letters('ASDFGHJKL'),
    key(';'),
    key("'"),
    key('\\'),
    { label: '', width: 2 },
  ],
  [
    key('Shift', 2.3),
    ...letters('ZXCVBNM'),
    key(','),
    key('.'),
    key('/'),
    { label: 'Shift', width: 1.5 },
    key('↑'),
    key('Home'),
  ],
  [
    key('Ctrl', 1.4),
    key('Win', 1.2, 'Windows'),
    key('Alt', 1.2),
    key('無変換', 1.5),
    key('Space', 3.8),
    key('変換', 1.3),
    key('かな', 1.3),
    { label: 'Ctrl', width: 1.4 },
    key('←'),
    key('↓'),
    key('→'),
    key('End'),
  ],
]

export function KeyboardGuide({ keys }: { keys: string[] }) {
  const pressed = new Set(keys)
  const shown = new Set(
    rows.flatMap((row) => row.flatMap((cap) => (cap.key ? [cap.key] : []))),
  )
  const extraKeys = keys.filter((name) => !shown.has(name))
  return (
    <div className="desktop-keyboard-guide" aria-label="家族のキーボード操作">
      <strong>家族が押しているキー</strong>
      <svg
        viewBox="0 0 1140 420"
        role="img"
        aria-label={`キーボード全体。押すキー: ${keys.join(' + ')}`}
      >
        <rect
          x="2"
          y="2"
          width="1136"
          height="416"
          rx="20"
          className="desktop-keyboard-case"
        />
        {rows.map((row, rowIndex) => {
          const unit =
            (1100 - (row.length - 1) * 6) /
            row.reduce((sum, cap) => sum + (cap.width ?? 1), 0)
          let x = 20
          return row.map((cap, index) => {
            const width = unit * (cap.width ?? 1)
            const left = x
            x += width + 6
            if (!cap.label) return null
            const height = cap.height ?? 56
            const lines = cap.label.split('\n')
            const active = !!cap.key && pressed.has(cap.key)
            return (
              <g
                key={`${rowIndex}:${index}`}
                data-key={cap.key}
                data-pressed={active}
                className="desktop-keyboard-key"
              >
                <rect
                  x={left}
                  y={20 + rowIndex * 64}
                  width={width}
                  height={height}
                  rx="7"
                />
                <text
                  x={left + width / 2}
                  y={
                    20 +
                    rowIndex * 64 +
                    height / 2 +
                    8 -
                    (lines.length - 1) * 13
                  }
                  textAnchor="middle"
                >
                  {lines.map((line, lineIndex) => (
                    <tspan
                      key={lineIndex}
                      x={left + width / 2}
                      dy={lineIndex ? 26 : 0}
                    >
                      {line}
                    </tspan>
                  ))}
                </text>
              </g>
            )
          })
        })}
      </svg>
      <div className="desktop-guidance-keys" aria-label="押しているキー">
        {keys.map((name, index) => (
          <span key={name}>
            {index ? ' + ' : ''}
            <kbd>{name}</kbd>
          </span>
        ))}
      </div>
      {extraKeys.length ? (
        <span>追加のキー：{extraKeys.join(' + ')}</span>
      ) : null}
    </div>
  )
}
