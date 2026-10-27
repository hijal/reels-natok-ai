'use client'

/**
 * Stylized replicas of the real UI pieces used by the Learn tab.
 * They are static (no logic), reuse the app's theme classes, and wrap
 * focus areas with <Hl> — a pulsing cyan ring with a numbered marker
 * that matches the numbered callouts in the explanation panel.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/* ──────────────────── Highlight wrapper ──────────────────── */

export function Hl({ n, children, className }: { n: number; children: ReactNode; className?: string }) {
  return (
    <div className={cn('relative', className)}>
      <div className="pointer-events-none absolute -inset-[3px] rounded-[10px] border-2 border-cyan-400 z-20 animate-pulse shadow-[0_0_18px_rgba(34,211,238,0.35)]" />
      <span className="absolute -top-2 -left-2 z-30 w-5 h-5 rounded-full bg-cyan-500 text-white text-xs font-bold flex items-center justify-center shadow-lg shadow-cyan-500/50 pointer-events-none">
        {n}
      </span>
      {children}
    </div>
  )
}

/* ──────────────────── Small building blocks ──────────────────── */

export function MockLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">{children}</p>
}

export function MockSelect({ value }: { value: string }) {
  return (
    <div className="h-9 rounded-md bg-[var(--surface-2)] border border-border flex items-center justify-between px-3 text-sm text-foreground/90">
      <span>{value}</span>
      <span className="text-muted-foreground text-[10px]">▼</span>
    </div>
  )
}

export function MockToggle({ on, label }: { on: boolean; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full',
          on ? 'bg-emerald-500' : 'bg-[var(--surface-3)] border border-border',
        )}
      >
        <span className={cn('inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform', on ? 'translate-x-[18px]' : 'translate-x-[3px]')} />
      </span>
    </div>
  )
}

export function MockSlider({ value, max = 100 }: { value: number; max?: number }) {
  return (
    <div className="relative h-1.5 rounded-full bg-[var(--surface-3)] w-full">
      <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500" style={{ width: `${(value / max) * 100}%` }} />
      <div
        className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-white border-2 border-cyan-500 shadow"
        style={{ left: `${(value / max) * 100}%` }}
      />
    </div>
  )
}

export function MockBar({ pct, className }: { pct: number; className?: string }) {
  return (
    <div className={cn('h-2 bg-[var(--surface-2)] rounded-full overflow-hidden', className)}>
      <div className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full" style={{ width: `${pct}%` }} />
    </div>
  )
}

/* ──────────────────── Sidebar replica ──────────────────── */

export function MockSidebar({ active = 'generate' }: { active?: 'generate' | 'upscale' | 'gallery' | 'learn' }) {
  const item = (label: string, color: string, isActive: boolean) => (
    <div
      className={cn(
        'relative flex items-center gap-2.5 rounded-lg px-2.5 py-2',
        isActive ? 'bg-[var(--surface-3)]' : '',
      )}
    >
      {isActive && <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 rounded-r-full" style={{ backgroundColor: color }} />}
      <div className="w-3.5 h-3.5 rounded-md shrink-0" style={{ backgroundColor: color }} />
      <span className={cn('text-xs truncate', isActive ? 'text-foreground font-medium' : 'text-muted-foreground')}>{label}</span>
    </div>
  )
  return (
    <div className="w-[150px] shrink-0 rounded-lg border border-border bg-[var(--surface-1)] flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-border shrink-0">
        <div className="w-5 h-5 rounded gradient-creative flex items-center justify-center">
          <span className="text-[10px] font-bold text-white">H3</span>
        </div>
        <span className="text-[10px] font-semibold text-foreground truncate">MiniMax H3 Studio 7</span>
      </div>
      <div className="flex-1 px-1.5 py-2 space-y-1">
        {item('Generate', '#06B6D4', active === 'generate')}
        {item('Extend', '#06B6D4', false)}
        {item('Refine', '#10B981', false)}
        {item('ControlNet', '#FB923C', false)}
        {item('Tile Upscale', '#EC4899', false)}
        {item('FPS', '#22D3EE', false)}
        {item('Face Refine', '#FACC15', false)}
        {item('DLSS', '#F472B6', active === 'upscale')}
        {item('Gallery', '#8B5CF6', active === 'gallery')}
        {item('Learn', '#10B981', active === 'learn')}
      </div>
      <div className="px-2.5 py-2 border-t border-border space-y-1.5">
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
          <span className="text-[10px] text-muted-foreground">ComfyUI connected</span>
        </div>
        <div className="text-[10px] text-muted-foreground">⚙ Settings</div>
      </div>
    </div>
  )
}

/* ──────────────────── Generate screen pieces ──────────────────── */

export function MockRefDropzone() {
  return (
    <div className="border-2 border-dashed border-border rounded-lg py-4 text-center">
      <p className="text-xs text-muted-foreground">
        Drag & drop, <span className="text-cyan-400 underline">browse</span> or paste with <span className="font-mono text-cyan-400">Ctrl+V</span>
      </p>
      <p className="text-[10px] text-muted-foreground/60 mt-0.5">images, videos and audio — up to 15 · optional</p>
    </div>
  )
}

export function MockRefCard() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2">
      <div className="w-9 h-9 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
        <span className="text-[10px] text-purple-300 font-bold">IMG</span>
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-foreground truncate font-mono">photo_girl.png</p>
        <p className="text-[10px] text-muted-foreground">character / object</p>
      </div>
    </div>
  )
}

export function MockPrompt({ withMention }: { withMention?: boolean }) {
  return (
    <div className="rounded-lg border border-border bg-[var(--surface-2)] p-2.5 text-xs text-foreground/90 leading-relaxed min-h-[64px]">
      {withMention ? (
        <>
          A girl with{' '}
          <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px]">&lt;Picture 1&gt;</span>{' '}
          walks through the market and says:{' '}
          <span className="px-1 py-0.5 rounded bg-cyan-500/10 text-cyan-300 text-[10px] font-mono">&lt;d&gt;Almost there.&lt;/d&gt;</span>
        </>
      ) : (
        'A girl walks through an evening market, neon lights…'
      )}
    </div>
  )
}

export function MockCtaButton({ label }: { label: string }) {
  return (
    <div className="h-10 px-5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-xs font-semibold flex items-center justify-center shadow-lg shadow-cyan-500/20 whitespace-nowrap">
      {label}
    </div>
  )
}

/* ──────────────────── Queue pill replica ──────────────────── */

export function MockQueuePill({ expanded }: { expanded?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2 pl-3 pr-2 py-2 rounded-xl border bg-[var(--surface-1)]/90 shadow-lg shadow-black/30" style={{ borderColor: '#06b6d440' }}>
        <span className="relative w-2 h-2">
          <span className="absolute inset-0 rounded-full bg-cyan-400 animate-ping opacity-60" />
          <span className="relative w-2 h-2 rounded-full bg-cyan-400" />
        </span>
        <div className="flex flex-col items-start">
          <span className="text-[10px] font-medium text-foreground leading-tight">Video: Generating…</span>
          <span className="text-[10px] text-muted-foreground font-mono leading-tight">42%</span>
        </div>
        <span className="min-w-[18px] h-4 px-1 rounded-md bg-cyan-400 text-white text-[10px] font-bold flex items-center justify-center">2</span>
      </div>
      {expanded && (
        <div className="w-[210px] rounded-xl border bg-[var(--surface-1)]/95 border-border shadow-xl overflow-hidden">
          <p className="px-2.5 py-1.5 border-b border-border text-[10px] font-semibold text-foreground">Generation Queue</p>
          <div className="p-1.5 space-y-1">
            <div className="flex items-center gap-1.5 p-1.5 rounded-lg bg-[var(--surface-3)]">
              <span className="w-3 h-3 rounded-full border-2 border-cyan-400 border-t-transparent animate-spin" />
              <span className="text-[10px] text-foreground truncate flex-1">Girl walking through market…</span>
              <span className="text-[10px] text-muted-foreground">✕</span>
            </div>
            <div className="flex items-center gap-1.5 p-1.5 rounded-lg bg-[var(--surface-2)]/60">
              <span className="text-[10px] text-muted-foreground">🕐</span>
              <span className="text-[10px] text-foreground truncate flex-1">Sunset over city…</span>
              <span className="text-[10px] text-muted-foreground">✕</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ──────────────────── Gallery replicas ──────────────────── */

export function MockGalleryTile({ hovered, index, upscaled }: { hovered?: boolean; index: number; upscaled?: boolean }) {
  return (
    <div className="relative aspect-video rounded-lg overflow-hidden border border-border bg-[var(--surface-2)] group">
      <div className="absolute inset-0 bg-gradient-to-br from-cyan-900/30 to-violet-900/20" />
      {upscaled && (
        <span className="absolute top-1 left-1 inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-fuchsia-300 border border-fuchsia-400/40">✦ DLSS 5</span>
      )}
      {hovered && (
        /* (fix 719) In the real gallery on hover, instead of an icon panel,
           a single "⋮" button appears in the top right — opening an action
           dropdown menu. */
        <button
          type="button"
          className="absolute top-1 right-1 z-10 w-5 h-5 rounded bg-black/60 border border-border/60 text-[11px] text-white/80 flex items-center justify-center"
        >
          ⋮
        </button>
      )}
      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 py-1 flex items-center justify-between">
        <span className="text-[10px] text-white/70 font-mono">{String(index).padStart(3, '0')}</span>
        <span className="text-[10px] text-cyan-300/80">1 min 12 sec</span>
      </div>
    </div>
  )
}

export function MockLightbox() {
  return (
    <div className="relative rounded-xl overflow-hidden bg-black flex flex-col">
      <div className="flex items-center justify-between px-3 py-2 bg-gradient-to-b from-black/70 to-transparent">
        <span className="text-[10px] text-white/90 font-medium truncate">Minimax_Studio_00012-audio.mp4</span>
        <span className="text-[10px] text-white/40 font-mono">1/5</span>
      </div>
      <div className="h-32 flex items-center justify-center relative">
        <div className="w-40 h-[88px] rounded bg-gradient-to-br from-cyan-950 to-violet-950 border border-cyan-500/20" />
        <span className="absolute w-10 h-10 rounded-full bg-black/40 flex items-center justify-center text-white/80 text-sm">▶</span>
      </div>
      <div className="px-3 pb-2 space-y-1.5 bg-gradient-to-t from-black/70 to-transparent">
        <MockBar pct={58} className="h-1" />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-white/80 text-[10px]">
            <span>⏸</span>
            <span>🔊</span>
            <span className="font-mono text-white/60">0:03 / 0:05</span>
          </div>
          <div className="flex items-center gap-1 text-white/70 text-[10px]">
            <span>‹</span>
            <span>›</span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function MockMetaDialog() {
  const cell = (l: string, v: string) => (
    <div className="space-y-0.5">
      <p className="text-[10px] font-medium text-muted-foreground uppercase">{l}</p>
      <p className="text-[10px] text-foreground/90">{v}</p>
    </div>
  )
  return (
    <div className="rounded-xl border border-border bg-[var(--surface-3)] shadow-2xl overflow-hidden w-full max-w-[320px]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <span className="text-cyan-400 text-[10px]">ⓘ</span>
        <span className="text-[10px] font-medium text-foreground truncate">…00012-audio.mp4</span>
      </div>
      <div className="p-3 space-y-2">
        <div className="rounded-md bg-[var(--surface-2)] border border-border p-2 text-[10px] text-foreground/90 font-mono max-h-12 overflow-hidden">
          A girl with &lt;Picture 1&gt; walks through the market and says: &lt;d&gt;Almost there.&lt;/d&gt;
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2">
          {cell('Seed', '1234567')}
          {cell('Resolution', '960×544')}
          {cell('Steps (pass1+2)', '2 + 3')}
          {cell('Generation time', '1 min 12 sec')}
          {cell('Date', '12.05.2026')}
        </div>
      </div>
    </div>
  )
}

/* ──────────────────── Stats replicas ──────────────────── */

export function MockStats() {
  return (
    <div className="space-y-2 w-full max-w-[220px]">
      <div className="space-y-1">
        <div className="flex justify-between text-[10px] text-muted-foreground">
          <span>VRAM</span>
          <span className="font-mono text-cyan-300">8.1 / 12 GB</span>
        </div>
        <MockBar pct={68} />
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>GPU</span><span className="font-mono">96% · 65°C</span>
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>RAM</span><span className="font-mono">14.2 / 32 GB</span>
      </div>
    </div>
  )
}

/* ──────────────────── First-run: warning banner + model downloads (fix 56) ──────────────────── */

export function MockWarningBanner() {
  return (
    <div className="w-full max-w-[360px] flex items-center gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
      <span className="w-4 h-4 rounded-md bg-amber-500/25 text-amber-300 text-[10px] font-bold flex items-center justify-center shrink-0">!</span>
      <p className="text-[10px] text-amber-100/90 leading-snug flex-1">
        Models not downloaded (Gemma 4 12B Q4_K_M, …). Generation will not work properly.
      </p>
      <span className="px-2.5 py-1 rounded-md border border-amber-500/40 bg-amber-500/15 text-amber-200 text-[10px] font-medium whitespace-nowrap shrink-0">Download in Settings</span>
    </div>
  )
}

export function MockModelRow({ name, size, state }: { name: string; size: string; state: 'ready' | 'download' | 'missing' | 'error' }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-[var(--surface-2)]/70 px-2 py-1.5">
      <span className={cn('w-3.5 h-3.5 rounded-full border flex items-center justify-center text-[10px] shrink-0', state === 'ready' ? 'border-emerald-500/60 text-emerald-400' : state === 'error' ? 'border-red-500/60 text-red-400' : 'border-border text-muted-foreground')}>
        {state === 'ready' ? '✓' : state === 'error' ? '!' : '○'}
      </span>
      <span className="text-[10px] text-foreground/90 truncate flex-1">{name}</span>
      <span className="text-[10px] text-muted-foreground font-mono shrink-0">{size}</span>
      {state === 'download' ? (
        <span className="flex items-center gap-1 shrink-0">
          <span className="w-10 h-1 rounded-full bg-[var(--surface-3)] overflow-hidden">
            <span className="block h-full w-3/5 bg-gradient-to-r from-cyan-500 to-blue-500" />
          </span>
          <span className="text-[10px] font-mono text-cyan-300">42%</span>
          <span className="text-[10px] text-muted-foreground">✕</span>
        </span>
      ) : (
        <span className="text-[10px] text-cyan-300 shrink-0">⬇</span>
      )}
    </div>
  )
}

export function MockModelsList() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2.5">
      <p className="text-[10px] font-semibold text-foreground">Minimax H3 (generation)</p>
      <div className="space-y-1">
        <MockModelRow name="Diffusion Model (VSA int8)" size="21 GB" state="ready" />
        <MockModelRow name="Text Encoder (Qwen3VL NVFP4)" size="15.7 GB" state="download" />
        <MockModelRow name="Video VAE · Audio VAE · Turbo LoRA …" size="9 GB" state="missing" />
      </div>
      <p className="text-[10px] font-semibold text-foreground pt-0.5">LLM Assistant</p>
      <div className="space-y-1">
        <MockModelRow name="Gemma 4 12B (Q4_K_M)" size="7.1 GB" state="missing" />
        <MockModelRow name="Qwen3.5 9B (Q4_K_M) — alternative" size="5.7 GB" state="missing" />
        <MockModelRow name="Vision Projector (mmproj)" size="~175 MB" state="missing" />
      </div>
    </div>
  )
}

/* ──────────────────── Settings replicas (fix 56) ──────────────────── */

function SettingsRow({ label, sub, right }: { label: string; sub?: string; right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border/50 last:border-0">
      <div className="min-w-0">
        <p className="text-[10px] text-foreground/90 truncate">{label}</p>
        {sub && <p className="text-[10px] text-muted-foreground/80 truncate">{sub}</p>}
      </div>
      <div className="shrink-0 flex items-center gap-1.5">{right}</div>
    </div>
  )
}

function TogglePill({ on }: { on: boolean }) {
  return (
    <span
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full',
        on ? 'bg-emerald-500' : 'bg-[var(--surface-3)] border border-border',
      )}
    >
      <span className={cn('inline-block h-3 w-3 rounded-full bg-white', on ? 'translate-x-[14px]' : 'translate-x-[2px]')} />
    </span>
  )
}

function MockButton({ children }: { children: ReactNode }) {
  return <span className="px-2 py-1 rounded-md border border-cyan-500/40 bg-cyan-500/10 text-cyan-300 text-[10px] font-medium whitespace-nowrap">{children}</span>
}

export function MockSettingsGeneral() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-foreground mb-1">General</p>
      <SettingsRow label="Migrate models from older version" sub="choose folder with previous build" right={<MockButton>Select folder</MockButton>} />
      <SettingsRow label="Base Model" sub="FastVideo VSA DataFree 1300-step 4-step int8" right={<MockButton>Default</MockButton>} />
      <SettingsRow label="Custom LoRAs" sub="toggle on/off, strength, trigger words" right={<MockButton>＋ Add</MockButton>} />
    </div>
  )
}

/** (fix 114) "Appearance" — separate settings tab (fix 111): theme (gray/black) + sound. */
export function MockSettingsAppearance() {
  return (
    <div className="w-[260px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-foreground mb-1">Appearance</p>
      <div className="py-1.5 border-b border-border/50">
        <p className="text-[10px] text-foreground/90 mb-1.5">Color Theme</p>
        <div className="flex gap-1.5">
          <span className="flex-1 px-2 py-1 rounded-md text-[10px] font-medium text-center border border-cyan-500/50 bg-cyan-500/15 text-cyan-300">Gray</span>
          <span className="flex-1 px-2 py-1 rounded-md text-[10px] text-center border border-border text-muted-foreground">Dark</span>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 py-1.5">
        <div className="min-w-0">
          <p className="text-[10px] text-foreground/90">Sound on finish</p>
          <p className="text-[10px] text-muted-foreground/80">short chime</p>
        </div>
        <TogglePill on />
      </div>
    </div>
  )
}

export function MockSettingsLlm() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-foreground mb-1">LLM</p>
      <SettingsRow label="Device" sub="auto — GPU/CPU" right={<MockButton>Auto</MockButton>} />
      <SettingsRow label="Context" sub="8K — 100K tokens" right={<MockButton>25K</MockButton>} />
      <SettingsRow label="Video Vision" sub="enabled by default" right={<TogglePill on />} />
      {/* (fix 114) KV cache (fix 109) — previously this row was missing in mock */}
      <SettingsRow
        label="KV Cache Quantization"
        sub="chat memory optimization"
        right={
          <span className="flex items-center gap-1">
            {/* (fix 119) default — q4_0 */}
            <span className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Off</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q8</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q5</span>
            <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-cyan-500/50 bg-cyan-500/15 text-cyan-300">Q4</span>
          </span>
        }
      />
      <SettingsRow label="Assistant Model" sub="Bonsai 2 27B (default) / Gemma / Qwen" right={<MockButton>Bonsai 2 27B</MockButton>} />
    </div>
  )
}

export function MockSettingsDanger() {
  const danger = (label: string, sub: string) => (
    <SettingsRow label={label} sub={sub} right={<span className="px-2 py-1 rounded-md border border-red-500/40 bg-red-500/10 text-red-300 text-[10px] font-medium whitespace-nowrap">Action</span>} />
  )
  return (
    <div className="w-[300px] rounded-lg border border-red-500/30 bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-red-300 mb-1">Reset · Danger Zone</p>
      {danger('Reset Settings', 'reset all parameters to defaults')}
      {danger('Clear Cache', 'ComfyUI input folder (references and temporary files)')}
      {danger('Delete Content', 'output folder, assistant chats and prompt history')}
      {/* (fix 486) fourth button added later — factory reset */}
      {danger('Factory Reset (All)', 'settings + cache + content in one action')}
    </div>
  )
}

/** (fix 114) "Voice" tab — voice input (fixes 65/72/74). */
export function MockSettingsVoice() {
  return (
    <div className="w-[260px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-foreground mb-1">Voice</p>
      <SettingsRow label="Voice Input" sub="dictation: prompt, editor, chat" right={<TogglePill on />} />
      <SettingsRow label="Recognition Model" sub="whisper · CPU, does not use VRAM" right={<MockButton>small</MockButton>} />
      <SettingsRow label="Speech Language" sub="Russian / English / Auto" right={<MockButton>English</MockButton>} />
      <div className="flex items-center gap-1.5 py-1.5">
        <span className="w-4 h-4 rounded-full bg-red-500/70 border border-red-400/50 flex items-center justify-center shrink-0" />
        <span className="text-[10px] text-muted-foreground flex-1">live test: recording → transcribed text</span>
        <MockButton>Test</MockButton>
      </div>
    </div>
  )
}

/** (fix 114) "Optimization" tab — ComfyUI VRAM + generation modes. */
export function MockSettingsOpt() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      <p className="text-[10px] font-semibold text-foreground mb-1">Optimization</p>
      <div className="space-y-1 py-1.5 border-b border-border/50">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-foreground/90">VRAM Reserve</span>
          <span className="text-[10px] font-mono text-foreground/80">3 GB</span>
        </div>
        <MockSlider value={25} max={100} />
        <p className="text-[10px] text-muted-foreground/70">1–16 GB · applies after ComfyUI restart</p>
      </div>
      <SettingsRow label="Dynamic VRAM" sub="dynamic VRAM management" right={<TogglePill on />} />
      <SettingsRow label="Low VRAM Attention" sub="save generation memory" right={<TogglePill on />} />
      <SettingsRow label="Chunk FeedForward" sub="long sequence in chunks" right={<TogglePill on />} />
      <p className="text-[10px] text-muted-foreground/70 pt-1">Low VRAM / Chunk FF — applies immediately to new generations, no restart needed</p>
    </div>
  )
}

/** (fix 114) LoRAs list: built-in turbo (ON by default) +
 *  user files (OFF by default). */
export function MockLoraList() {
  return (
    <div className="w-[320px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-foreground">LoRAs</p>
        <MockButton>＋ Add</MockButton>
      </div>
      {/* Built-in turbo LoRA — in list and enabled by default. */}
      <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-foreground font-mono truncate">minimax_h3_ref2v_turbo_4step...safetensors</p>
            <p className="text-[10px] text-muted-foreground">1.8 GB · enabled</p>
          </div>
          <span className="text-cyan-400 text-xs shrink-0">⏻</span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Strength</span>
            <MockSlider value={50} max={100} />
            <span className="text-[10px] font-mono text-muted-foreground">1.00</span>
          </div>
        </div>
      </div>
      <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-foreground font-mono truncate">my_style_v2.safetensors</p>
            <p className="text-[10px] text-muted-foreground">96 MB · disabled</p>
          </div>
          <span className="text-muted-foreground/40 text-xs shrink-0">⏻</span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Strength</span>
            <MockSlider value={50} max={100} />
            <span className="text-[10px] font-mono text-muted-foreground">1.00</span>
          </div>
        </div>
      </div>
      {/* Custom — enabled, with triggers */}
      <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[10px] font-medium text-foreground font-mono truncate">anime_style.safetensors</p>
            <p className="text-[10px] text-muted-foreground">214 MB</p>
          </div>
          <span className="text-emerald-400 text-xs shrink-0">⏻</span>
        </div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">Strength</span>
            <MockSlider value={60} max={100} />
            <span className="text-[10px] font-mono text-muted-foreground">0.60</span>
          </div>
          <div>
            <div className="h-5 rounded border border-border bg-[var(--surface-3)] px-1.5 flex items-center text-[10px] text-muted-foreground font-mono">anime style, vivid</div>
            <p className="text-[10px] text-muted-foreground/70">trigger words — appended to prompt</p>
          </div>
        </div>
      </div>
    </div>
  )
}

/** (fix 114) "Upscale" tab (fixes 74/77/78): Neural Rendering + RTX VSR. */
export function MockUpscalePanel() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-semibold text-foreground">Upscale</p>
        <span className="px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300 text-[10px] border border-violet-400/30 font-medium">NVIDIA RTX</span>
      </div>
      <div className="border-2 border-dashed border-border rounded-lg py-2 text-center">
        <p className="text-[10px] text-muted-foreground">upload a video (MP4 / MOV / MKV…)</p>
      </div>
      <div className="flex gap-1">
        <span className="flex-1 px-1.5 py-1 rounded-md text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium text-center">Neural Rendering (DLSS 5)</span>
        <span className="flex-1 px-1.5 py-1 rounded-md text-[10px] border border-border text-muted-foreground text-center">RTX VSR 1×–4×</span>
      </div>
      <div className="space-y-1">
        <MockLabel>Preset · noise / tone / structure</MockLabel>
        <MockSelect value="Balanced" />
      </div>
      <div className="flex justify-end">
        <span className="px-2.5 py-1.5 rounded-lg bg-gradient-to-r from-cyan-500 to-blue-600 text-white text-[10px] font-semibold">Start processing (DLSS 5)</span>
      </div>
      <p className="text-[10px] text-muted-foreground/70">result appears in "Gallery" labeled "Upscale" or "DLSS 5"</p>
    </div>
  )
}

/** (fix 114) Welcome dialog on first launch (fixes 112–113). */
export function MockWelcomeDialog() {
  return (
    <div className="w-[300px] rounded-xl border border-border bg-[var(--surface-2)] overflow-hidden shadow-xl">
      <div className="h-1 gradient-creative" />
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
        <span className="w-6 h-6 rounded-lg gradient-creative flex items-center justify-center text-[10px] text-white shrink-0">✦</span>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold text-foreground">Welcome to MiniMax H3 Studio 7</p>
          <p className="text-[10px] text-muted-foreground">Video generation with audio — powered by your GPU</p>
        </div>
        <span className="text-[10px] text-muted-foreground shrink-0">✕</span>
      </div>
      <div className="px-3 py-2.5 space-y-1.5">
        {[
          ['1', 'Download Models', 'Settings → "General" → "Download All"'],
          ['2', 'Generate First Video', '"Generate" → prompt → "Generate Video"'],
          ['3', 'View Results', 'Gallery · enhance quality — "Upscale"'],
        ].map(([n, t, s]) => (
          <div key={n} className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-1)] px-2 py-1.5">
            <span className="w-4 h-4 rounded gradient-creative text-white text-[10px] font-bold flex items-center justify-center shrink-0">{n}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] font-medium text-foreground">{t}</p>
              <p className="text-[10px] text-muted-foreground truncate">{s}</p>
            </div>
          </div>
        ))}
        <div className="rounded-lg border border-cyan-400/25 bg-cyan-500/10 px-2 py-1.5 flex items-center justify-between">
          <span className="text-[10px] text-cyan-100/90">Detailed Tour — "Learn"</span>
          <span className="text-[10px] text-cyan-200 font-medium">Open →</span>
        </div>
        <div className="flex items-center gap-1.5 pt-1">
          <span className="w-3 h-3 rounded-sm border border-border bg-[var(--surface-3)] flex items-center justify-center text-[10px] text-cyan-300 shrink-0">✓</span>
          <span className="text-[10px] text-muted-foreground">Do not show this window again</span>
        </div>
      </div>
    </div>
  )
}

export function MockSettingsComfyLinks() {
  return (
    <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
      {/* (fix 486) Dedicated "ComfyUI" tab removed: connection status
          and "Recheck" button now live on the "General" tab, while
          VRAM/GPU/RAM meters are sidebar bars. */}
      <p className="text-[10px] font-semibold text-foreground mb-1">General — ComfyUI status</p>
      <div className="flex items-center gap-1.5 py-1">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        <span className="text-[10px] text-muted-foreground">Connected · port 8188</span>
        <span className="ml-auto"><MockButton>Recheck</MockButton></span>
      </div>
      <p className="text-[10px] text-muted-foreground/70 pb-1 border-b border-border/50">VRAM / GPU / RAM meters — sidebar bars</p>
      <p className="text-[10px] font-semibold text-foreground pt-1 mb-1">Links</p>
      <SettingsRow label="Diffusion Model (VSA int8)" sub="huggingface.co/…/minimax_h3_vsa_int8…" right={<span className="text-[10px] text-cyan-300">⧉</span>} />
      <p className="text-[10px] text-muted-foreground/70 pt-1">If huggingface.co is unavailable, use the hf-mirror.com mirror</p>
    </div>
  )
}
