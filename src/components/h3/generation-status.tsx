'use client'

/**
 * Generation status card — phase readout, animated progress bar, elapsed
 * timer, live ComfyUI preview and error state. Pinned to the bottom of
 * the parameters panel so it stays visible while adjusting settings.
 * (The CTA button lives next to the prompt — see GenerateView.)
 */
import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useGenProgress } from '@/lib/gen-progress-store' // (edit 696)
// (edit 719) Preview with full-screen viewer — matching "Generate".
import { RefPreviewThumb } from '@/components/h3/ref-preview-thumb'

interface GenerationStatusProps {
  phase: string
  isGenerating: boolean
  progressPercent: number
  statusMessage: string | null
  error: string | null
  onInterrupt: () => void
  onReset: () => void
  /** Timestamp (Date.now()) when generation started — drives the elapsed timer. */
  startedAt?: number | null
  /** Current prompt_id for the live preview. */
  promptId?: string | null
  /**
   * (edit 255) How to label stages in preview/status caption:
   * 'passes' — "Pass 1/2 · draft/detail" (generation, default);
   * 'clips'  — "Clip 1/3" (extend: stage = chain clip);
   * 'clips2' — "Clip 1/2 · pass 1/2" (edit 430: two-pass extend —
   *   stages in tracker clips*2 (pass 1 + pass 2 per clip), show pair);
   * 'chunks' — "Chunk 1/4" (chunked refine);
   * 'single' — without pass numbering (full refine, draft);
   * 'tile' — "Tile Upscale" (edit 478: Tile Upscale tab had label
   *   'Refine' because it shared 'single' with full refine).
   */
  stageKind?: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet'
}

/** Caption for current stage considering tab view (edits 255, 478). */
function stageLabel(
  kind: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet',
  stage: number,
  totalStages: number,
): string {
  // (edit 478+479) Tile Upscale tab label: "Tile X/Y"
  if (kind === 'tile') return totalStages > 0 ? `Tile ${stage}/${totalStages}` : 'Tile Upscale'
  // (edit 497) ControlNet tab — single pass, without numbering
  if (kind === 'controlnet') return 'ControlNet'
  if (kind === 'clips') return `Clip ${stage}/${totalStages}`
  // (edit 430) Two-pass extend stages come in pairs [p1_i, p2_i]:
  // odd = pass 1 (draft), even = pass 2 (detail) for that clip.
  if (kind === 'clips2') {
    const clip = Math.ceil(stage / 2)
    const totalClips = Math.ceil(totalStages / 2)
    const pass = ((stage - 1) % 2) + 1
    return `Clip ${clip}/${totalClips} · pass ${pass}/2${pass === 1 ? ' · draft' : ' · detail'}`
  }
  if (kind === 'chunks') return `Chunk ${stage}/${totalStages}`
  if (kind === 'single') return 'Refine'
  // passes: single pass (draft) is not numbered as "1/1"
  if (totalStages <= 1) return 'Pass'
  return `Pass ${stage}/${totalStages}${stage === 1 ? ' · draft' : ' · detail'}`
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function ElapsedTimer({ startedAt }: { startedAt: number }) {
  const [, forceTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  return <span className="text-[10px] font-mono text-muted-foreground tabular-nums">{formatElapsed(Date.now() - startedAt)}</span>
}

/** Live preview of the current denoising step (from ComfyUI WebSocket). */
function GenPreview({
  promptId,
  active,
  stageKind,
  isGenerating,
}: {
  promptId: string | null
  active: boolean
  stageKind: 'passes' | 'clips' | 'clips2' | 'chunks' | 'single' | 'tile' | 'controlnet'
  /** (edit 696) true during active generation — use frozen kind. */
  isGenerating: boolean
}) {
  // (edit 696) Frozen stageKind from store — before all early-returns (hook order).
  const frozenKind = useGenProgress((s) => s.video.frozenStageKind)
  const [previewData, setPreviewData] = useState<{
    url: string
    mime: string
    step: number
    total: number
    width: number
    height: number
    stage?: {
      stage: number
      totalStages: number
      step: number
      total: number
      /** (edit 487) tile-upscale: model is still preparing, sampling has not started. */
      preparing?: boolean
    } | null
  } | null>(null)

  useEffect(() => {
    if (!active || !promptId) return
    let cancelled = false
    const poll = async () => {
      try {
        // Cache-busting: append timestamp to prevent browser caching
        const res = await fetch(`/api/comfy/preview?prompt_id=${encodeURIComponent(promptId)}&_t=${Date.now()}`)
        if (!res.ok) return
        const data = await res.json()
        if (cancelled) return
        // Stage must update even WITHOUT a new preview image: during pass 2
        // the KJ preview override (pass 1 only) emits nothing, so the last
        // pass-1 frame stays on screen while the label must move to 2/2.
        if (data.stage) {
          const s = data.stage as { stage: number; totalStages: number; step: number; total: number; preparing?: boolean }
          setPreviewData((prev) =>
            prev ? { ...prev, stage: s } : {
              url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: s,
            },
          )
        }
        if (data.preview?.image) {
          setPreviewData((prev) => {
            const base = prev ?? { url: '', mime: 'image/jpeg', step: 0, total: 0, width: 0, height: 0, stage: null }
            return {
              ...base,
              url: data.preview.image,
              mime: data.preview.mime || 'image/jpeg',
              step: data.preview.step || 0,
              total: data.preview.total || 0,
              width: data.preview.width || 0,
              height: data.preview.height || 0,
            }
          })
        }
      } catch { /* ignore */ }
    }
    poll()
    const timer = setInterval(poll, 1500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [promptId, active])

  if (!previewData || !previewData.url) {
    // No preview frame yet (or pass 2, where none is emitted) — still show
    // which pass is running so the label is never stale/empty.
    const stageOnly = previewData?.stage
    return (
      <div className="rounded-lg border border-dashed border-border bg-[var(--surface-1)]/50 h-28 flex flex-col items-center justify-center gap-1">
        <span className="text-[10px] text-muted-foreground/50 creative-pulse">Waiting for preview…</span>
        {stageOnly && (
          <span className="text-[10px] text-cyan-300 font-medium">
            {/* (edit 487) model preparation phase — no false "Tile 1/N";
                edit 696 — frozen kind during generation */}
            {stageOnly.preparing
              ? 'Preparing model…'
              : <>{stageLabel(isGenerating ? (frozenKind ?? stageKind) : stageKind, stageOnly.stage, stageOnly.totalStages)}{stageOnly.total > 0 ? ` · step ${stageOnly.step}/${stageOnly.total}` : ''}</>}
          </span>
        )}
      </div>
    )
  }

  const isVideo = previewData.mime === 'video/mp4'
  const isAnimatedWebp = previewData.mime === 'image/webp'

  // (edit 696) During active generation use stageKind captured at launch
  // — toggling "Draft/Full" does not alter caption template. Outside generation —
  // current stageKind (actual settings).
  const activeKind = isGenerating ? (frozenKind ?? stageKind) : stageKind

  // Stage label across the WHOLE generation (not just the pass the preview
  // image comes from): "Pass 1/2" during low-res, "Pass 2/2" during the
  // high-res refinement. Step/total prefer the stage tracker (works even on
  // pass 2, where no KJ preview image is emitted) and fall back to the
  // preview image's own counters.
  const stage = previewData.stage
  const passLabel = stage
    // (edit 487) model preparation phase — no false "Tile 1/N"
    ? (stage.preparing ? 'Preparing model…' : stageLabel(activeKind, stage.stage, stage.totalStages))
    : 'Preview'
  const step = stage && stage.total > 0 ? stage.step : previewData.step
  const total = stage && stage.total > 0 ? stage.total : previewData.total
  const stepLabel = !stage?.preparing && total > 0 ? ` · step ${step}/${total}` : ''

  return (
    // (edit 447) Preview border — neutral border-border, without cyan outline.
    <div className="relative rounded-lg overflow-hidden border border-border bg-black/40">
      {/* (edit 719) Click on preview — full-screen viewer (matching "Generate" tab). */}
      <RefPreviewThumb
        kind={isVideo ? 'video' : 'image'}
        name="Generation preview"
        url={previewData.url}
        className="block w-full"
        title="Open preview full screen"
      >
        {isVideo ? (
          <video
            src={previewData.url}
            autoPlay
            loop
            muted
            className="w-full h-auto max-h-48 object-contain"
          />
        ) : (
          <img
            src={previewData.url}
            alt="Preview"
            className="w-full h-auto max-h-48 object-contain cursor-zoom-in"
            draggable={false}
          />
        )}
      </RefPreviewThumb>
      {isAnimatedWebp && (
        <span className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/50 rounded text-[10px] text-cyan-300">anim</span>
      )}
      <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-cyan-300 font-medium flex items-center gap-1.5">
        <span>{passLabel}{stepLabel}</span>
        {previewData.width > 0 && previewData.height > 0 && (
          <span className="text-white/40 font-normal">{previewData.width}×{previewData.height}</span>
        )}
      </div>
    </div>
  )
}

export function GenerationStatus({
  phase,
  isGenerating,
  progressPercent,
  statusMessage,
  error,
  onInterrupt,
  onReset,
  startedAt,
  promptId,
  stageKind = 'passes',
}: GenerationStatusProps) {
  return (
    <div className="space-y-2">
      {/* Phase + elapsed */}
      <div className="flex items-center justify-between gap-2 text-xs">
        <span
          className={cn(
            'font-medium shrink-0',
            phase === 'running'
              ? 'text-cyan-400'
              : phase === 'queued' || phase === 'submitting'
                ? 'text-yellow-400'
                : phase === 'done'
                  ? 'text-green-400'
                  : phase === 'error'
                    ? 'text-red-400'
                    : 'text-muted-foreground',
          )}
        >
          {phase === 'idle' && 'Ready to generate'}
          {phase === 'submitting' && 'Submitting…'}
          {phase === 'queued' && 'Queued…'}
          {phase === 'running' && (progressPercent > 0 ? `Generating… ${progressPercent}%` : 'Generating…')}
          {phase === 'done' && 'Done ✓'}
          {phase === 'error' && 'Error'}
        </span>
        <div className="flex items-center gap-2 min-w-0">
          {startedAt && isGenerating && <ElapsedTimer startedAt={startedAt} />}
          {statusMessage && (
            <span className="text-muted-foreground/60 truncate max-w-[140px]" title={statusMessage}>
              {statusMessage}
            </span>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
        {isGenerating ? (
          phase === 'queued' || phase === 'submitting' || (phase === 'running' && progressPercent === 0) ? (
            <div
              className={cn(
                'h-full w-1/3 rounded-full animate-pulse',
                phase === 'running'
                  ? 'bg-gradient-to-r from-cyan-500/80 to-blue-500/80'
                  : 'bg-gradient-to-r from-yellow-500/80 to-amber-500/80',
              )}
            />
          ) : (
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${progressPercent}%` }}
              transition={{ duration: 0.3, ease: 'easeInOut' }}
              className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full"
            />
          )
        ) : phase === 'done' ? (
          <div className="h-full w-full bg-gradient-to-r from-green-500/60 to-emerald-500/60 rounded-full" />
        ) : null}
      </div>

      {/* Live preview — only while a job is active */}
      {isGenerating && (
        <GenPreview
          promptId={promptId ?? null}
          active={phase === 'running' || phase === 'queued'}
          stageKind={stageKind}
          isGenerating={isGenerating}
        />
      )}

      {/* Stop */}
      {isGenerating && (
        <button
          onClick={onInterrupt}
          className="w-full text-xs text-red-400/70 hover:text-red-400 py-1 transition-colors"
        >
          Stop
        </button>
      )}

      {/* Error */}
      {error && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg"
        >
          <span className="text-sm text-red-400 font-medium shrink-0">Error</span>
          <div className="space-y-1 min-w-0">
            <p className="text-xs text-red-300/70 break-words">{error}</p>
            <Button
              variant="ghost"
              size="sm"
              onClick={onReset}
              className="h-auto p-1 text-xs text-red-400 hover:text-red-300 hover:bg-red-500/20"
            >
              Try again
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  )
}
