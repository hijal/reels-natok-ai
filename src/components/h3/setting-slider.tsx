'use client'

import * as React from 'react'
import { Slider } from '@/components/ui/slider'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface SettingSliderProps {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
  formatValue?: (value: number) => string
  unit?: string
  disabled?: boolean
  /** Manual input: allowable range bounds. Can be wider
   *  than the slider range (out-of-bounds input), but not narrower.
   *  If omitted, component doesn't show manual input. */
  inputMin?: number
  inputMax?: number
  /** Tooltip hint for input title (e.g. "higher than 30 = slower"). */
  inputHint?: string
  /** Tooltip description on label (instead of small gray text under slider). */
  labelTitle?: string
}

export function SettingSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  unit,
  disabled,
  inputMin,
  inputMax,
  inputHint,
  labelTitle,
}: SettingSliderProps) {
  // Guard against undefined/null from stale localStorage
  const safeValue = typeof value === 'number' && !isNaN(value) ? value : min
  const manual = inputMin !== undefined || inputMax !== undefined
  const inMin = inputMin ?? min
  const inMax = inputMax ?? max
  // Value outside slider range — mark visually
  // (Radix slider safely clamps such values to bounds).
  const outOfSlider = safeValue < min || safeValue > max

  // Draft input is stored as string: this correctly supports
  // "1.", "0.5", empty field — without getting stuck on NaN.
  const [draft, setDraft] = React.useState<string | null>(null)

  const commit = () => {
    if (draft === null) return
    const n = Number.parseFloat(draft.replace(',', '.'))
    setDraft(null)
    if (!Number.isFinite(n)) return // invalid — revert to current value
    let v = Math.min(inMax, Math.max(inMin, n))
    if (step > 0) v = Math.round(v / step) * step
    v = Math.round(v * 10000) / 10000 // floating point tail (0.05*3)
    if (v !== safeValue) onChange(v)
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs text-muted-foreground font-medium" title={labelTitle}>{label}</Label>
        {manual ? (
          // Manual input is the ONLY value display: duplicate badge
          // is not shown. Resolution (for MP sliders) is already visible
          // in the hint below.
          <input
            type="text"
            inputMode="decimal"
            aria-label={`${label}: manual input (${inMin}–${inMax})`}
            title={inputHint || `Allowed ${inMin}–${inMax}`}
            value={draft ?? String(safeValue)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => {
              // Select all so typing immediately replaces value
              setDraft(null)
              requestAnimationFrame(() => e.target.select())
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commit()
              } else if (e.key === 'Escape') {
                setDraft(null)
                ;(e.target as HTMLInputElement).blur()
              }
            }}
            disabled={disabled}
            className={cn(
              'h-6 w-16 shrink-0 rounded-md border bg-[var(--surface-2)] px-1.5 text-right font-mono text-xs tabular-nums',
              'focus:border-cyan-500/60 focus:outline-none focus:ring-1 focus:ring-cyan-500/40',
              outOfSlider ? 'border-amber-500/50 text-amber-300' : 'border-border text-foreground/80',
              disabled && 'opacity-40 pointer-events-none',
            )}
          />
        ) : (
          <span
            className={cn(
              'text-xs font-mono tabular-nums',
              outOfSlider ? 'text-amber-300' : 'text-foreground/80',
            )}
            title={outOfSlider ? 'Outside slider range (manual input)' : undefined}
          >
            {formatValue ? formatValue(safeValue) : safeValue}{unit ? ` ${unit}` : ''}
          </span>
        )}
      </div>
      <Slider
        value={[safeValue]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        disabled={disabled}
        className={cn(
          'py-1 [&_[role=slider]]:h-3.5 [&_[role=slider]]:w-3.5 [&_[role=slider]]:border-0 [&_[role=slider]]:bg-primary [&_[role=slider]]:shadow-[0_0_8px_rgba(139,92,246,0.4)] [&_[role=slider]]:hover:shadow-[0_0_12px_rgba(139,92,246,0.6)]',
          disabled && 'opacity-40 pointer-events-none',
        )}
      />
    </div>
  )
}