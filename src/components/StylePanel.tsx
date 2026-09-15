import { useEffect, useRef, useState } from 'react'
import { HexColorPicker, HexColorInput } from 'react-colorful'

// CSS theme model: a set of editable custom properties
export interface ThemeVars {
  '--doc-font': string
  '--doc-font-size': string
  '--doc-text-color': string
  '--doc-bg': string
  '--doc-heading-color': string
  '--doc-accent': string
  '--doc-code-font': string
  '--doc-code-bg': string
  '--doc-max-width': string
}

export const DEFAULT_THEME: ThemeVars = {
  '--doc-font': "Georgia, 'Times New Roman', serif",
  '--doc-font-size': '17px',
  '--doc-text-color': '#1f2328',
  '--doc-bg': '#ffffff',
  '--doc-heading-color': '#111111',
  '--doc-accent': '#0969da',
  '--doc-code-font': "'Cascadia Code', Consolas, monospace",
  '--doc-code-bg': '#f3f4f6',
  '--doc-max-width': '760px',
}

const BUILTIN_THEMES: Record<string, ThemeVars> = {
  'Default': DEFAULT_THEME,
  'Dark': {
    ...DEFAULT_THEME,
    '--doc-text-color': '#e6e6e6',
    '--doc-bg': '#1b1d21',
    '--doc-heading-color': '#ffffff',
    '--doc-accent': '#58a6ff',
    '--doc-code-bg': '#2a2d33',
  },
  'Compact Sans': {
    ...DEFAULT_THEME,
    '--doc-font': "'Segoe UI', system-ui, sans-serif",
    '--doc-font-size': '14px',
    '--doc-max-width': '900px',
  },
}

// Curated list of specific fonts, grouped by category. Each entry maps to a
// full CSS font-family stack with sensible fallbacks.
const FONT_GROUPS: { label: string; fonts: { name: string; stack: string }[] }[] = [
  {
    label: 'Serif',
    fonts: [
      { name: 'Georgia', stack: "Georgia, 'Times New Roman', serif" },
      { name: 'Times New Roman', stack: "'Times New Roman', Times, serif" },
      { name: 'Garamond', stack: "Garamond, 'Palatino Linotype', serif" },
      { name: 'Palatino Linotype', stack: "'Palatino Linotype', 'Book Antiqua', serif" },
      { name: 'Book Antiqua', stack: "'Book Antiqua', Palatino, serif" },
      { name: 'Cambria', stack: "Cambria, Georgia, serif" },
    ],
  },
  {
    label: 'Sans-serif',
    fonts: [
      { name: 'Segoe UI', stack: "'Segoe UI', system-ui, sans-serif" },
      { name: 'Arial', stack: 'Arial, Helvetica, sans-serif' },
      { name: 'Helvetica', stack: "Helvetica, Arial, sans-serif" },
      { name: 'Verdana', stack: 'Verdana, Geneva, sans-serif' },
      { name: 'Tahoma', stack: 'Tahoma, Geneva, sans-serif' },
      { name: 'Trebuchet MS', stack: "'Trebuchet MS', sans-serif" },
      { name: 'Calibri', stack: 'Calibri, Candara, sans-serif' },
    ],
  },
  {
    label: 'Monospace',
    fonts: [
      { name: 'Cascadia Code', stack: "'Cascadia Code', Consolas, monospace" },
      { name: 'Consolas', stack: "Consolas, 'Courier New', monospace" },
      { name: 'Courier New', stack: "'Courier New', Courier, monospace" },
      { name: 'JetBrains Mono', stack: "'JetBrains Mono', Consolas, monospace" },
      { name: 'Fira Code', stack: "'Fira Code', Consolas, monospace" },
    ],
  },
]

const CUSTOM = '__custom__'

// Color field: a swatch button that opens a react-colorful popover
// (saturation square + hue slider + hex input). The popover is a plain
// <div> overlay — clicking the fixed backdrop closes it — so it can't
// trigger the controlled <input type=color> reopen bug that native
// pickers had here. `onChange` fires on every drag for live preview.
function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const place = () => {
    const r = btnRef.current!.getBoundingClientRect()
    setPos({
      top: Math.min(r.bottom + 4, window.innerHeight - 260),
      left: Math.min(r.left, window.innerWidth - 220),
    })
  }
  return (
    <div className="color-field">
      <button
        ref={btnRef}
        type="button"
        className="color-swatch"
        style={{ background: value }}
        title={value}
        onClick={() => { place(); setOpen(true) }}
      />
      {open && (
        <>
          <div className="color-popover-backdrop" onClick={() => setOpen(false)} />
          <div className="color-popover" style={pos}>
            <HexColorPicker color={value} onChange={onChange} />
            <HexColorInput color={value} onChange={onChange} prefixed />
          </div>
        </>
      )}
    </div>
  )
}

function FontSelect({ value, onChange }: { value: string; onChange: (stack: string) => void }) {
  const known = FONT_GROUPS.flatMap((g) => g.fonts).some((f) => f.stack === value)
  const [customMode, setCustomMode] = useState(!known)
  const [customValue, setCustomValue] = useState(value)

  useEffect(() => {
    const isKnown = FONT_GROUPS.flatMap((g) => g.fonts).some((f) => f.stack === value)
    setCustomMode(!isKnown)
    if (!isKnown) setCustomValue(value)
  }, [value])

  return (
    <>
      <select
        value={customMode ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) {
            setCustomMode(true)
            onChange(customValue)
          } else {
            setCustomMode(false)
            onChange(e.target.value)
          }
        }}
      >
        {FONT_GROUPS.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.fonts.map((f) => (
              <option key={f.name} value={f.stack} style={{ fontFamily: f.stack }}>
                {f.name}
              </option>
            ))}
          </optgroup>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {customMode && (
        <input
          value={customValue}
          placeholder="e.g. 'My Font', sans-serif"
          onChange={(e) => { setCustomValue(e.target.value); onChange(e.target.value) }}
        />
      )}
    </>
  )
}

export function themeToCss(vars: ThemeVars): string {
  return `:root {\n${Object.entries(vars).map(([k, v]) => `  ${k}: ${v};`).join('\n')}\n}\n`
}

export function cssToTheme(css: string): ThemeVars {
  const vars = { ...DEFAULT_THEME }
  for (const key of Object.keys(vars) as (keyof ThemeVars)[]) {
    const m = css.match(new RegExp(`${key}\\s*:\\s*([^;]+);`))
    if (!m) continue
    const value = m[1].trim()
    // Reject values containing `<`/`>`: a malicious sidecar .css can't break
    // out of a <style> block (e.g. `--doc-bg: x}</style><script>...`) when the
    // value is later re-emitted into print/export HTML. Legitimate theme values
    // (colors, sizes, font stacks) never contain angle brackets.
    if (/[<>]/.test(value)) continue
    vars[key] = value
  }
  return vars
}

interface Props {
  theme: ThemeVars
  themeName: string
  onChange: (vars: ThemeVars, name: string) => void
  onClose: () => void
}

export default function StylePanel({ theme, themeName, onChange, onClose }: Props) {
  const [vars, setVars] = useState(theme)
  useEffect(() => setVars(theme), [theme])

  const set = (k: keyof ThemeVars, v: string) => {
    const next = { ...vars, [k]: v }
    setVars(next)
    onChange(next, themeName)
  }

  return (
    <div className="style-panel">
      <div className="panel-header">
        <strong>Style Theme</strong>
        <button className="tb-btn" onClick={onClose}>✕</button>
      </div>
      <label>Theme preset
        <select
          value={themeName}
          onChange={(e) => {
            const name = e.target.value
            if (BUILTIN_THEMES[name]) {
              setVars(BUILTIN_THEMES[name])
              onChange(BUILTIN_THEMES[name], name)
            }
          }}
        >
          {Object.keys(BUILTIN_THEMES).map((n) => <option key={n}>{n}</option>)}
          {!BUILTIN_THEMES[themeName] && <option>{themeName}</option>}
        </select>
      </label>
      <label>Body font
        <FontSelect value={vars['--doc-font']} onChange={(v) => set('--doc-font', v)} />
      </label>
      <label>Code font
        <FontSelect value={vars['--doc-code-font']} onChange={(v) => set('--doc-code-font', v)} />
      </label>
      <label>Font size
        <input value={vars['--doc-font-size']} onChange={(e) => set('--doc-font-size', e.target.value)} />
      </label>
      <div className="field-label">Text color
        <ColorField value={vars['--doc-text-color']} onChange={(v) => set('--doc-text-color', v)} />
      </div>
      <div className="field-label">Background
        <ColorField value={vars['--doc-bg']} onChange={(v) => set('--doc-bg', v)} />
      </div>
      <div className="field-label">Heading color
        <ColorField value={vars['--doc-heading-color']} onChange={(v) => set('--doc-heading-color', v)} />
      </div>
      <div className="field-label">Accent (links)
        <ColorField value={vars['--doc-accent']} onChange={(v) => set('--doc-accent', v)} />
      </div>
      <div className="field-label">Code background
        <ColorField value={vars['--doc-code-bg']} onChange={(v) => set('--doc-code-bg', v)} />
      </div>
      <label>Page width
        <input value={vars['--doc-max-width']} onChange={(e) => set('--doc-max-width', e.target.value)} />
      </label>
      <details>
        <summary>Generated CSS</summary>
        <pre className="css-preview">{themeToCss(vars)}</pre>
      </details>
    </div>
  )
}
