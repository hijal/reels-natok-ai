/**
 * restoreFromMeta — restores ALL generation parameters from .meta.json
 * into useGenStore and switches to the "Generation" tab.
 *
 * Used by the "Retry" button on gallery cards and in the metadata dialog.
 */
import { toast } from 'sonner'
import { useGenStore, type VideoRefItem } from './gen-store'
import { FALLBACK_H3_PRESETS, collectResolutionValues } from '@/components/h3/video-shared'

/** (edit 124) All preset nominals — so "Retry" returns preset mode
 *  rather than free MP (otherwise the result wouldn't be exact). */
const PRESET_RESOLUTIONS = new Set<string>(collectResolutionValues(FALLBACK_H3_PRESETS))

/* ─── Meta JSON shape (sidecar written by use-video-gen) ─── */
interface MetaReference {
  type?: string
  path?: string
  role?: string
  image_intent?: string
  audio_intent?: string
  include_audio?: boolean
  /** (edit 493) Video ref: compression to 480p. */
  compress?: boolean
  /** (edit 1) Audio ref trimming, seconds (trim_end null/0 = to end). */
  trim_start?: number
  trim_end?: number | null
}

interface MetaJson {
  prompt?: string
  seed?: number
  /** (edit 146) Generation mode: 'ref' | 't2v' | 'flf'. */
  generation_mode?: string
  /** ref + audio guide; keep_original_audio — server audio track swap. */
  audio_guide?: boolean
  keep_original_audio?: boolean
  /** (edit 146) FL2VA: filename of first frame in ComfyUI input/. */
  first_frame?: string | null
  /** (edit 146) FL2VA: filename of last frame in ComfyUI input/. */
  last_frame?: string | null
  /** (edit 157) FL2VA: width of first frame (px) — for "Retry". */
  first_frame_width?: number | null
  /** (edit 157) FL2VA: height of first frame (px) — for "Retry". */
  first_frame_height?: number | null
  /** (edit 158) FL2VA: final nominal WxH — "Retry" restores exact dimensions. */
  flf_resolution?: string | null
  model_type?: string
  resolution?: string
  aspect_ratio?: string
  final_resolution_mp?: number
  low_res_mp?: number
  video_length?: number
  duration_seconds?: number
  fps?: number
  pass1_steps?: number
  /** Total steps in pass 1 schedule (for "6 of 6"; old sidecars lacked this field). */
  pass1_total_steps?: number
  pass2_steps?: number
  /** (edit 722) Generation pipeline: 'draft' (single pass) | 'full'. */
  pipeline?: string
  /** (edit 722) Steps for single pass in "Draft" mode. */
  draft_steps?: number
  sigma_variant?: string
  pass2_sampler?: string
  pass1_sampler?: string
  pass1_scheduler?: string
  turbo_lora_strength?: number
  minimax_h3_reference_detail?: string
  sparse_attention?: boolean // (edit 168)
  sparse_tau?: number // (edit 466)
  sparse_start_percent?: number // (edit 466)
  sparse_end_percent?: number // (edit 466)
  sparse_min_tokens?: number // (edit 466)
  sparse_extra_tokens?: number // (edit 466)
  veda_attention?: boolean // (edit 301)
  veda_generated_sparsity?: string // (edit 405)
  veda_reference_sparsity?: string // (edit 405)
  veda_full_attention_layers?: string // (edit 405)
  veda_full_attention_steps?: string // (edit 405)
  veda_verbose?: boolean // (edit 405)
  low_vram_attention?: boolean
  chunk_feed_forward?: boolean
  chunk_ff_chunks?: number
  chunk_ff_threshold?: number
  references?: MetaReference[]
  minimax_h3_references?: MetaReference[]
  job_id?: string
  created_at?: number
  generation_time?: number
  params?: Record<string, unknown>
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p
}

let refIdCounter = 0
function genId(): string {
  return `restore-${Date.now()}-${++refIdCounter}`
}

/** Map meta references → store VideoRefItem[]. */
function mapRefs(metaRefs: MetaReference[]): VideoRefItem[] {
  return metaRefs
    .filter((r) => r.path)
    .map((r) => {
      const kind = (r.type || 'image').toLowerCase() as 'image' | 'video' | 'audio'
      const role = r.role || r.image_intent || ''
      return {
        id: genId(),
        kind,
        path: r.path!,
        name: basename(r.path!),
        previewUrl: '', // will be loaded from server
        role,
        imageIntent: (r.image_intent || r.role || 'identity') as VideoRefItem['imageIntent'],
        includeAudio: r.include_audio !== false,
        compress: r.compress === true, // (edit 493)
        // (edit 1) Restore audio ref trim from meta.
        trimStart: typeof r.trim_start === 'number' ? r.trim_start : undefined,
        trimEnd: typeof r.trim_end === 'number' ? r.trim_end : (r.trim_end ?? undefined),
      }
    })
}

/**
 * Fetch the .meta.json for a generated video and restore all parameters
 * into the generation store. Then switch to the Generate tab.
 *
 * @param filePath  Relative path: `subfolder/filename`
 */
export async function restoreFromMeta(filePath: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/comfy/meta?path=${encodeURIComponent(filePath)}`)
    if (!res.ok) {
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('json')) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || `HTTP ${res.status}`)
      }
      throw new Error(`HTTP ${res.status}`)
    }

    const meta: MetaJson = await res.json()

    // Meta may nest params under `params` (old schema)
    const params = (meta.params && typeof meta.params === 'object' && !Array.isArray(meta.params))
      ? { ...meta, ...(meta.params as object) }
      : meta

    const store = useGenStore.getState()

    // ── Build the patch ──
    const patch: Record<string, unknown> = {}

    // Prompt
    if (typeof params.prompt === 'string' && params.prompt) {
      patch.prompt = params.prompt
    }

    // Seed
    if (typeof params.seed === 'number' && params.seed >= 0) {
      patch.seed = params.seed
    }

    // Model type
    if (typeof params.model_type === 'string' && params.model_type) {
      patch.modelType = params.model_type
    }

    // Video length (frames)
    if (typeof params.video_length === 'number' && params.video_length > 0) {
      patch.videoLength = params.video_length
    }

    // Reference detail
    if (typeof params.minimax_h3_reference_detail === 'string') {
      const detail = params.minimax_h3_reference_detail
      if (detail === 'match' || detail === 'max') {
        patch.referenceDetail = detail
      }
    }

    // Pass 1 steps
    if (typeof params.pass1_steps === 'number') {
      patch.firstSamplerSteps = params.pass1_steps
    }
    if (typeof params.pass1_total_steps === 'number') {
      patch.firstSamplerTotalSteps = params.pass1_total_steps
    }

    // (edit 722) Pipeline "Draft"/"Full" — from sidecar. Previously it was
    // written there but NOT restored: "Retry" on a draft clip opened the form
    // in "Full" mode (two passes instead of one) — meaning the retry was a
    // completely different generation.
    if (params.pipeline === 'draft' || params.pipeline === 'full') {
      patch.pipeline = params.pipeline
    }

    // (edit 722) Steps of the SINGLE pass in draft. Sidecar stored them,
    // but the form did not pick them up — draft was retried with default 4 steps
    // instead of the ones actually used.
    if (typeof params.draft_steps === 'number' && params.draft_steps > 0) {
      patch.draftSteps = params.draft_steps
    }

    // Sigma variant (pass 2 steps)
    if (typeof params.sigma_variant === 'string' && params.sigma_variant) {
      patch.sigmaVariant = params.sigma_variant
    }

    // Samplers
    if (typeof params.pass2_sampler === 'string' && params.pass2_sampler) {
      patch.pass2Sampler = params.pass2_sampler
    }
    if (typeof params.pass1_sampler === 'string' && params.pass1_sampler) {
      patch.pass1Sampler = params.pass1_sampler
    }
    if (typeof params.pass1_scheduler === 'string' && params.pass1_scheduler) {
      patch.pass1Scheduler = params.pass1_scheduler
    }

    // Turbo lora
    if (typeof params.turbo_lora_strength === 'number') {
      patch.turboLoraStrength = params.turbo_lora_strength
    }

    // VRAM / chunking
    if (typeof params.sparse_attention === 'boolean') {
      patch.sparseAttention = params.sparse_attention // (edit 168)
    }
    // (edit 466) Sol-Attn settings — "Retry" restores node parameters
    if (typeof params.sparse_tau === 'number') patch.sparseTau = params.sparse_tau
    if (typeof params.sparse_start_percent === 'number') patch.sparseStartPercent = params.sparse_start_percent
    if (typeof params.sparse_end_percent === 'number') patch.sparseEndPercent = params.sparse_end_percent
    if (typeof params.sparse_min_tokens === 'number') patch.sparseMinTokens = params.sparse_min_tokens
    if (typeof params.sparse_extra_tokens === 'number') patch.sparseExtraTokens = params.sparse_extra_tokens
    if (typeof params.veda_attention === 'boolean') {
      patch.vedaAttention = params.veda_attention // (edit 301)
    }
    // (edit 405) veda settings — "Retry" restores node parameters
    if (typeof params.veda_generated_sparsity === 'string') {
      patch.vedaGeneratedSparsity = params.veda_generated_sparsity
    }
    if (typeof params.veda_reference_sparsity === 'string') {
      patch.vedaReferenceSparsity = params.veda_reference_sparsity
    }
    if (typeof params.veda_full_attention_layers === 'string') {
      patch.vedaFullAttentionLayers = params.veda_full_attention_layers
    }
    if (typeof params.veda_full_attention_steps === 'string') {
      patch.vedaFullAttentionSteps = params.veda_full_attention_steps
    }
    if (typeof params.veda_verbose === 'boolean') {
      patch.vedaVerbose = params.veda_verbose
    }
    if (typeof params.low_vram_attention === 'boolean') {
      patch.lowVramAttention = params.low_vram_attention
    }
    if (typeof params.chunk_feed_forward === 'boolean') {
      patch.chunkFeedForward = params.chunk_feed_forward
    }
    if (typeof params.chunk_ff_chunks === 'number') {
      patch.chunkFFChunks = params.chunk_ff_chunks
    }
    if (typeof params.chunk_ff_threshold === 'number') {
      patch.chunkFFThreshold = params.chunk_ff_threshold
    }

    // Resolution (edit 124): known nominal → preset mode
    // (freeResolution off, MP = 0) — retry reproduces EXACT dimensions
    // (16:9 1080p → 1920×1080). Otherwise — free resolution by MP.
    // (edit 158) FL2VA: nominal from flfNominalDimensions (frame + UI preset) —
    // not in PRESET_RESOLUTIONS (e.g. 854x480 for 16:9 frame), but this is
    // the REAL generation size. Restore as free resolution (MP) so UI badge
    // matches the actual one.
    const metaRes = typeof params.resolution === 'string' ? params.resolution.trim() : ''
    const metaFlfRes = typeof params.flf_resolution === 'string' ? params.flf_resolution.trim() : ''
    const isFlfMode = (params.generation_mode || '').toLowerCase() === 'flf'

    if (isFlfMode && metaFlfRes) {
      // FL2VA: exact nominal from metadata → free resolution by MP
      const flfMatch = metaFlfRes.match(/(\d+)\s*x\s*(\d+)/i)
      if (flfMatch) {
        const fw = parseInt(flfMatch[1], 10)
        const fh = parseInt(flfMatch[2], 10)
        if (fw > 0 && fh > 0) {
          const flfMP = Math.round((fw * fh) / 1e6 * 100) / 100
          patch.finalResolution = flfMP
          patch.freeResolution = true
          // resolution = flf nominal (orientation from frame)
          patch.resolution = metaFlfRes
        }
      }
    } else if (metaRes && PRESET_RESOLUTIONS.has(metaRes)) {
      patch.resolution = metaRes
      patch.freeResolution = false
      patch.finalResolution = 0
    } else if (typeof params.final_resolution_mp === 'number' && params.final_resolution_mp > 0) {
      patch.finalResolution = params.final_resolution_mp
      patch.freeResolution = true
    }

    // Low-res MP (pass 1)
    if (typeof params.low_res_mp === 'number' && params.low_res_mp > 0) {
      patch.lowResMP = params.low_res_mp
    }

    // (edit 147) Generation mode — restore BEFORE references in order to
    // filter refs for the mode (t2v/flf support audio only).
    const metaMode = typeof params.generation_mode === 'string'
      ? params.generation_mode.trim().toLowerCase()
      : ''
    if (metaMode === 't2v' || metaMode === 'flf' || metaMode === 'ref') {
      patch.mode = metaMode
    } else {
      // Legacy metadata without generation_mode — was always ref mode.
      patch.mode = 'ref'
    }
    const effMode: 'ref' | 't2v' | 'flf' = (patch.mode as string) as 'ref' | 't2v' | 'flf'
    // ref + audio guide: restore checkbox along with refs.
    patch.audioGuide =
      effMode === 'ref' && (params.audio_guide === true || params.keep_original_audio === true)

    // ── References (filtered for mode) ──
    const allMetaRefs: MetaReference[] = Array.isArray(params.references)
      ? params.references
      : Array.isArray(params.minimax_h3_references)
        ? params.minimax_h3_references
        : []

    // (edit 147) Only audio references are supported in t2v/flf.
    // Old "Retry" restored ALL refs — image/video in t2v/flf were silently
    // ignored by generation, while shown as active in UI.
    // Filter immediately so the store only gets what is actually used.
    const metaRefs: MetaReference[] =
      effMode === 'ref'
        ? allMetaRefs
        : allMetaRefs.filter((r) => (r.type || 'image').toLowerCase() === 'audio')
    const droppedByMode = allMetaRefs.length - metaRefs.length

    // (edit 147) FL2VA: frames are separate files in input/, restore into
    // startFrame/endFrame slots (check existence just like refs).
    const firstFramePath = typeof params.first_frame === 'string' ? params.first_frame : ''
    const lastFramePath = typeof params.last_frame === 'string' ? params.last_frame : ''
    const frameSlots: Array<{ slot: 'start' | 'end'; path: string; name: string }> = []
    if (effMode === 'flf') {
      if (firstFramePath) frameSlots.push({ slot: 'start', path: firstFramePath, name: basename(firstFramePath) })
      if (lastFramePath) frameSlots.push({ slot: 'end', path: lastFramePath, name: basename(lastFramePath) })
    }

    // References and frames in ComfyUI input/ are ephemeral (input cleanup,
    // ComfyUI reinstall). "Retry" with non-existent file would fail mid-generation
    // with raw FileNotFoundError. Check existence and honestly warn if not all
    // were restored.
    // (edit 587) Probe existence using a SINGLE list: empty paths are filtered out,
    // whereas exists[] flags were previously indexed against un-filtered metaRefs —
    // causing flag index shifts if any ref had empty path. Compute and consume
    // filteredRefs (identical behavior for non-empty paths).
    const filteredRefs: MetaReference[] = metaRefs.filter((r) => r.path)
    const refAndFramePaths: string[] = [
      ...filteredRefs.map((r) => r.path!),
      ...frameSlots.map((f) => f.path),
    ]

    if (refAndFramePaths.length > 0) {
      const exists: boolean[] = await Promise.all(
        refAndFramePaths.map(async (p) => {
          try {
            const res = await fetch(`/api/comfy/file?type=input&filename=${encodeURIComponent(p)}`, {
              method: 'HEAD',
              signal: AbortSignal.timeout(5000),
            })
            return res.ok
          } catch {
            return true // server unreachable — don't discard silently
          }
        }),
      )

      // (edit 587) exists[] is indexed by filteredRefs (see above).
      const presentRefs = filteredRefs.filter((_, i) => exists[i])
      const missingRefs = metaRefs.length - presentRefs.length
      if (presentRefs.length > 0) {
        patch.refs = mapRefs(presentRefs)
      }
      if (missingRefs > 0) {
        toast.warning(`${missingRefs} ref(s) not found in ComfyUI`, {
          description: 'Files were removed from input/. Remaining parameters restored.',
        })
      }

      // Frames: if first frame file is missing — generation in flf mode
      // cannot start at all (start frame is required). Honestly warn
      // and DO NOT enable flf mode if frame was lost.
      if (frameSlots.length > 0) {
        const refOffset = filteredRefs.length // (edit 587) frame offset — relative to filteredRefs
        let missingFrames = 0
        const restored: Partial<{ startFrame: typeof frameSlots[number]; endFrame: typeof frameSlots[number] }> = {}
        for (let i = 0; i < frameSlots.length; i++) {
          const fs = frameSlots[i]
          if (exists[refOffset + i]) {
            if (fs.slot === 'start') restored.startFrame = fs
            else restored.endFrame = fs
          } else {
            missingFrames++
          }
        }
        if (restored.startFrame) {
          // (edit 157) Restore frame dimensions from metadata —
          // without them flf branch of use-video-gen won't work and orientation
          // will be taken from UI preset rather than frame.
          patch.startFrame = {
            path: restored.startFrame.path,
            name: restored.startFrame.name,
            previewUrl: '',
            width: typeof params.first_frame_width === 'number' ? params.first_frame_width : undefined,
            height: typeof params.first_frame_height === 'number' ? params.first_frame_height : undefined,
          }
        }
        if (restored.endFrame) {
          patch.endFrame = { path: restored.endFrame.path, name: restored.endFrame.name, previewUrl: '' }
        }
        if (missingFrames > 0) {
          toast.warning(`${missingFrames} frame(s) not found in ComfyUI`, {
            description: 'Frame files were removed from input/. Drag and drop them again if flf mode is needed.',
          })
          // If start frame is lost — flf generation cannot start,
          // degrade to t2v so "Retry" can at least run.
          if (!restored.startFrame && effMode === 'flf') {
            patch.mode = 't2v'
          }
        }
      }
    }

    if (droppedByMode > 0) {
      // Informational toast: only audio is supported in t2v/flf mode,
      // image/video from metadata were dropped (they would be silently ignored).
      toast.info('Image/video references dropped', {
        description: `Mode ${effMode} uses audio references only. ${droppedByMode} item(s) skipped.`,
      })
    }

    // ── Apply to store ──
    store.patchVideo(patch as Parameters<typeof store.patchVideo>[0])

    // ── Switch to Generate tab ──
    window.dispatchEvent(new CustomEvent('h3:goto-generate'))

    // (edit 147) Final toast takes mode and frames into account.
    const modeShort = effMode === 'flf' ? 'Frames' : effMode === 't2v' ? 'Text' : 'References'
    const restoredFrames = (patch.startFrame ? 1 : 0) + (patch.endFrame ? 1 : 0)
    const bits: string[] = ['Prompt', 'seed', `mode "${modeShort}"`]
    if (restoredFrames > 0) bits.push(`${restoredFrames} frame(s)`)
    if (metaRefs.length > 0) bits.push(`${metaRefs.length} ref(s)`)
    toast.success('Generation parameters restored', {
      description: bits.join(', ') + ' loaded into generation form.',
    })

    return true
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    toast.error('Failed to restore parameters', { description: msg })
    return false
  }
}
