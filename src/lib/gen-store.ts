/**
 * Persistent store for the generation form values.
 *
 * Uses Zustand + localStorage so that:
 *   - Switching between tabs doesn't lose form state (components unmount on switch)
 *   - Page refresh preserves the last-used parameters
 *   - Generated videos are loaded from ComfyUI's output directory,
 *     not stored here (only references are kept)
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/* ──────────────────────────── Video Gen ──────────────────────────── */

/**
 * One MiniMax H3 ref2va reference (reference manifest entry).
 * `path` is the ComfyUI input/ filename returned by /api/comfy/upload.
 */
export interface VideoRefItem {
  id: string
  kind: 'image' | 'video' | 'audio'
  /** ComfyUI input/ filename. */
  path: string
  /** Original file name (for display). */
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** Free text: who/what this reference is (max 500 chars server-side). */
  role: string
  /** Images: how the reference is used by ref2va. */
  imageIntent: 'identity' | 'scene' | 'style' | 'composition'
  /** Videos: include the reference's own audio track. */
  includeAudio: boolean
  /** (fix 493) Videos: compress to 480p before feeding into conditioning. */
  compress?: boolean
  /** (fix 302) Audio: reference trimming in seconds. trimEnd null/0 = until end.
      Virtual trimming (AudioTrim node) — no file copies created. */
  trimStart?: number
  trimEnd?: number | null
  /** (fix 694) Audio: reference volume 0–1 (default 0.5). Virtual
      (AudioGain node) — without file copies. */
  audioVolume?: number
}

/** FL2VA start/end frame upload slot. */
export interface VideoFrameSlot {
  /** ComfyUI input/ filename. */
  path: string
  name: string
  /** Local blob URL preview — runtime only, stripped on persist. */
  previewUrl: string
  /** (fix 152) Image width in pixels (from first frame — for aspect ratio). */
  width?: number
  /** (fix 152) Image height in pixels. */
  height?: number
}

export interface VideoGenState {
  prompt: string
  seed: number
  /** Selected model_type (single workflow: minimax_h3_ref2va). */
  modelType: string
  /** (fix 146) Generation mode: 'ref' | 't2v' | 'flf' | 'extend' (fix 161). Default 'ref'. */
  mode: 'ref' | 't2v' | 'flf' | 'extend'
  /** ref + audio-ref: guide generation with audio and insert original
   *  sound into final video (option on "Generation" tab). */
  audioGuide: boolean
  /** Pipeline: 'draft' — single pass on low-res canvas (fast draft,
   *  upgraded via Refine tab); 'full' — two passes, as before. Default 'full'. */
  pipeline: 'draft' | 'full'
  /** (fix 161) extend: clips for extension. (fix 587) id — stable
   *  card key (key={i} after deleting from middle carried MentionTextarea
   *  internal state to neighboring clip); absent in old entries. */
  extendClips: Array<{ prompt: string; duration: number; seed: number; id?: string }>
  /** (fix 162) extend: SEPARATE image refs for extension (not to be confused with refs!). */
  extendImageRefs: VideoRefItem[]
  /** (fix 164) extend: filename of source video in ComfyUI input/ (or staged). */
  extendSourceVideoPath: string
  /** (fix 291) Source video duration in seconds (client-side ffprobe upon
   *  selection/import). Displayed in badges and clip cards — user
   *  sees total duration including original. */
  extendSourceDuration: number
  /** (fix 363) extend: output subfolder where source GALLERY video came from
   *  ('' = output root). null = source from disk / not from gallery — then
   *  extension result goes to outputFolder as before. Source from gallery
   *  → result placed in original's folder (extension chains don't get scattered). */
  extendSourceSubfolder: string | null
  /** (fix 385) extend: NAME of original file in output/ (before importing to input/,
   *  where copy receives random name). Together with extendSourceSubfolder —
   *  source sidecar address: route resolves source LATENT with it
   *  (lossless seed and lossless portion of combined). null = from disk. */
  extendSourceName: string | null
  /** (fix 423) extend: two-pass mode (low-res pass 1 → upscale →
   *  pass 2 refine to source size). Default false = single pass. */
  extendTwoPass: boolean
  /** Resolution label — EXACT value (fix 124): "1280x720", "1920x1080", ... */
  resolution: string
  /** Total output frames (H3: 17n+5 grid, min 60 ≈ 2.5 s, fix 138). */
  videoLength: number
  /** ref2va reference detail: 'match' | 'max'. (fix 286) — in extend mode always 'match'. */
  referenceDetail: 'match' | 'max'
  /** FL2VA: first frame (image_prompt_type 'S'). */
  startFrame: VideoFrameSlot | null
  /** FL2VA: last frame (image_prompt_type 'E'). */
  endFrame: VideoFrameSlot | null
  /** ref2va reference manifest entries. */
  refs: VideoRefItem[]
  /** Two-pass latent upscaler: target resolution in MP (0 = auto from quality). */
  finalResolution: number
  /** Free-resolution mode: ignore quality presets, drive finalResolution directly. */
  freeResolution: boolean
  /** Pass 1 low-res resolution in MP (default 0.2). */
  lowResMP: number
  /** Pass 1 effective sampling steps (SplitSigmas split point, default 6, max 30). */
  firstSamplerSteps: number
  /**
   * TOTAL steps in BasicScheduler schedule for pass 1.
   * Default 6 — same as split takes ("6 of 6").
   * Configured separately to allow e.g. "6 of 8".
   */
  firstSamplerTotalSteps?: number
  /**
   * (fix 719) Clip steps in extend mode.
   *
   * In Extend this is NOT a split point: there is one BasicScheduler per clip
   * (steps = this value, denoise = 1, no split at all) — meaning is different
   * than in generation.
   * undefined = "auto": steps of source pass 1 from its .meta.json
   * (extension continues video — clip schedule is inherited from source),
   * without meta — firstSamplerSteps. Explicit value (2–30) overrides auto.
   * (history: previously field from UI was silently lost in hook and clips always
   * generated with firstSamplerSteps — now field actually reaches template)
   */
  extendClipSteps?: number
  /** Draft pipeline: direct step count of the single pass (default 4 = turbo-reference). */
  draftSteps: number
  /** Pass 2 sigma profile: '3step' | '4step' | '5step' | '6step' | '7step'. */
  sigmaVariant: string
  /** (fix 69) Pass 2 sampler (default 'euler'). */
  pass2Sampler: string
  /** (fix 70) Pass 1 sampler (default 'euler'). */
  pass1Sampler: string
  /** (fix 70) Pass 1 scheduler (default 'simple'). */
  pass1Scheduler: string
  /** (fix 70) Turbo LoRA strength (default 1.0). */
  turboLoraStrength: number
  /** (fix 168) Sparse Attention (Sol-Attn): speeds up long sequences. */
  sparseAttention: boolean
  /** (fix 466) Sol-Attn: sparsity threshold tau (0–4, default 1.3). */
  sparseTau: number
  /** (fix 466) Sol-Attn: start step fraction (0–0.9, default 0.2). */
  sparseStartPercent: number
  /** (fix 466) Sol-Attn: end step fraction (0.1–1, default 1.0). */
  sparseEndPercent: number
  /** (fix 466) Sol-Attn: minimum token count to enable (default 12288 — short clips remain dense). */
  sparseMinTokens: number
  /** (fix 466) Sol-Attn: extra context tokens (default 256). */
  sparseExtraTokens: number
  /** (fix 301) Veda Sparse Attention: trained predictor, for long videos. */
  vedaAttention: boolean
  /** (fix 400) Veda: generation sparsity, 'N%' (50–95, default '90%'). Higher = faster, but coarser. */
  vedaGeneratedSparsity: string
  /** (fix 400) Veda: reference sparsity, 'N%' (0–95, default '90%'). 0% = full attention to references (more accurate face, slower). */
  vedaReferenceSparsity: string
  /** (fix 400) Veda: 0-based DiT blocks with full attention ("0, 1, 47-49"; '' = all sparse). */
  vedaFullAttentionLayers: string
  /** (fix 400) Veda: 0-based sampler steps with full attention ("0, 1"; '' = none). */
  vedaFullAttentionSteps: string
  /** (fix 400) Veda: verbose node log (default false). */
  vedaVerbose: boolean
  /** MiniMaxLowVRAMAttention: head-chunked attention (saves VRAM). */
  lowVramAttention: boolean
  /** MiniMaxChunkFeedForward: chunked FFN for long sequences (saves VRAM). */
  chunkFeedForward: boolean
  /** ChunkFF: number of feed-forward chunks. */
  chunkFFChunks: number
  /** ChunkFF: sequence length threshold above which chunking kicks in. */
  chunkFFThreshold: number
  /** (fix 91) Active gallery folder: '' = root, otherwise name of output subfolder.
   *  "Generation" tab filters gallery by it and saves new videos into it. */
  outputFolder: string
}

export const DEFAULT_VIDEO_STATE: VideoGenState = {
  prompt: '',
  seed: -1,
  modelType: 'minimax_h3_ref2va',
  mode: 'ref', // (fix 146)
  audioGuide: false, // audio guide + original sound — optional, default off
  pipeline: 'full', // two passes (low-res → upscale → Pass 2) by default
  extendClips: [], // (fix 161) extend: clips for extension
  extendImageRefs: [], // (fix 162) extend: separate image refs
  extendSourceVideoPath: '', // (fix 164) extend: path to source video
  extendSourceDuration: 0, // (fix 291) source duration, sec (0 = unknown)
  extendSourceSubfolder: null, // (fix 363) source gallery subfolder (null = from disk)
  extendSourceName: null, // (fix 385) original filename in output/ (null = from disk)
  extendTwoPass: true, // (fix 437) extend: two passes — default ON (was OFF, fix 423)
  resolution: '854x480', // (fix 138) default 480p 16:9 — faster and cheaper in VRAM
  videoLength: 60, // (fix 138) min 2.5 s (60 frames at 24 fps, 17n+5 grid)
  referenceDetail: 'match', // (fix 286) default — Match (fast)
  startFrame: null,
  endFrame: null,
  refs: [],
  finalResolution: 0,
  freeResolution: false,
  lowResMP: 0.2,
  firstSamplerSteps: 6,
  // Total steps in pass 1 schedule. Default is same as
  // split takes — "6 of 6". Can be increased (e.g. "6 of 8").
  firstSamplerTotalSteps: 6,
  // Extend clip steps — undefined = "auto" (source steps from its metadata).
  extendClipSteps: undefined,
  draftSteps: 4, // turbo reference; min 2 — fastest draft
  sigmaVariant: '3step',
  pass2Sampler: 'euler',
  pass1Sampler: 'euler',
  pass1Scheduler: 'simple',
  turboLoraStrength: 1.0,
  // (fix 575) SOL-Attn enabled by default; on factory reset — also ON.
  sparseAttention: true,
  sparseTau: 1.3, // (fix 466)
  sparseStartPercent: 0.2, // (fix 466)
  sparseEndPercent: 1.0, // (fix 466)
  sparseMinTokens: 12288, // (fix 466)
  sparseExtraTokens: 256, // (fix 466)
  // (fix 575) Veda default and on factory reset — OFF, SOL-Attn takes precedence.
  vedaAttention: false,
  vedaGeneratedSparsity: '90%', // (fix 400)
  vedaReferenceSparsity: '90%', // (fix 400)
  vedaFullAttentionLayers: '', // (fix 400)
  vedaFullAttentionSteps: '', // (fix 400)
  vedaVerbose: false, // (fix 400)
  lowVramAttention: true,
  chunkFeedForward: true,
  chunkFFChunks: 2,
  chunkFFThreshold: 4096,
  outputFolder: '',
}

/* ──────────────────────────── Store ──────────────────────────── */

/**
 * Free preview blob-URL. URL.createObjectURL holds file in memory
 * until URL is revoked (or page is closed) — without revocation each
 * reference deletion/replacement accumulated blobs for the entire session.
 * Server URLs (/api/…) are left alone — revocation only applies to blob:.
 */
function revokePreview(url?: string): void {
  if (url && url.startsWith('blob:') && typeof URL !== 'undefined' && URL.revokeObjectURL) {
    try { URL.revokeObjectURL(url) } catch { /* already revoked */ }
  }
}

interface GenStoreState {
  video: VideoGenState

  // Video gen setters
  setVideoPrompt: (v: string) => void
  setVideoSeed: (v: number) => void
  setVideoModel: (v: string) => void
  setVideoResolution: (v: string) => void
  setVideoLength: (v: number) => void
  setVideoReferenceDetail: (v: 'match' | 'max') => void
  setVideoStartFrame: (slot: VideoFrameSlot | null) => void
  setVideoEndFrame: (slot: VideoFrameSlot | null) => void
  addVideoRefs: (items: VideoRefItem[]) => void
  updateVideoRef: (id: string, patch: Partial<Omit<VideoRefItem, 'id'>>) => void
  removeVideoRef: (id: string) => void
  moveVideoRef: (fromIndex: number, toIndex: number) => void
  clearVideoRefs: () => void
  /** Replace several video fields at once (model-change defaults). */
  patchVideo: (patch: Partial<VideoGenState>) => void
}

export const useGenStore = create<GenStoreState>()(
  persist(
    (set) => ({
      video: { ...DEFAULT_VIDEO_STATE },

      // Video gen setters
      setVideoPrompt: (v) => set((s) => ({ video: { ...s.video, prompt: v } })),
      setVideoSeed: (v) => set((s) => ({ video: { ...s.video, seed: v } })),
      setVideoModel: (v) => set((s) => ({ video: { ...s.video, modelType: v } })),
      setVideoResolution: (v) => set((s) => ({ video: { ...s.video, resolution: v } })),
      setVideoLength: (v) => set((s) => ({ video: { ...s.video, videoLength: v } })),
      setVideoReferenceDetail: (v) => set((s) => ({ video: { ...s.video, referenceDetail: v } })),
      // (fix 716) Revoke blob-URL compared by previewUrl, NOT by
      // object identity. Previously `slot !== s.video.startFrame` triggered
      // on equivalent new object ({...slot}) — revoking URL
      // that the new slot still displays (broken preview). In patchVideo
      // (fix 339) this was already fixed — here as well.
      setVideoStartFrame: (slot) =>
        set((s) => {
          if (s.video.startFrame && s.video.startFrame.previewUrl !== slot?.previewUrl) {
            revokePreview(s.video.startFrame.previewUrl)
          }
          return { video: { ...s.video, startFrame: slot } }
        }),
      setVideoEndFrame: (slot) =>
        set((s) => {
          if (s.video.endFrame && s.video.endFrame.previewUrl !== slot?.previewUrl) {
            revokePreview(s.video.endFrame.previewUrl)
          }
          return { video: { ...s.video, endFrame: slot } }
        }),
      addVideoRefs: (items) =>
        set((s) => ({ video: { ...s.video, refs: [...s.video.refs, ...items] } })),
      updateVideoRef: (id, patch) =>
        set((s) => ({
          video: {
            ...s.video,
            refs: s.video.refs.map((r) => {
              if (r.id !== id) return r
              if (patch.previewUrl && patch.previewUrl !== r.previewUrl) revokePreview(r.previewUrl)
              return { ...r, ...patch }
            }),
          },
        })),
      removeVideoRef: (id) =>
        set((s) => {
          const removed = s.video.refs.find((r) => r.id === id)
          if (removed) revokePreview(removed.previewUrl)
          return { video: { ...s.video, refs: s.video.refs.filter((r) => r.id !== id) } }
        }),
      moveVideoRef: (fromIndex, toIndex) =>
        set((s) => {
          const refs = [...s.video.refs]
          if (fromIndex < 0 || fromIndex >= refs.length || toIndex < 0 || toIndex >= refs.length) return s
          const [moved] = refs.splice(fromIndex, 1)
          refs.splice(toIndex, 0, moved)
          return { video: { ...s.video, refs } }
        }),
      clearVideoRefs: () =>
        set((s) => {
          for (const r of s.video.refs) revokePreview(r.previewUrl)
          return { video: { ...s.video, refs: [] } }
        }),
      patchVideo: (patch) =>
        set((s) => {
          // Complete replacement of lists/slots by patch (restore-from-meta) — revoke
          // blob-URLs of what was not carried over into new list
          if (patch.refs) {
            const kept = new Set(patch.refs.map((r) => r.previewUrl))
            for (const r of s.video.refs) {
              if (!kept.has(r.previewUrl)) revokePreview(r.previewUrl)
            }
          }
          // (fix 339) Revoke previewUrl only if the new slot has a
          // DIFFERENT URL — otherwise patch with the same blob revoked preview
          // that continues to be shown by new slot (broken image).
          if (patch.startFrame !== undefined && patch.startFrame?.previewUrl !== s.video.startFrame?.previewUrl) {
            revokePreview(s.video.startFrame?.previewUrl)
          }
          if (patch.endFrame !== undefined && patch.endFrame?.previewUrl !== s.video.endFrame?.previewUrl) {
            revokePreview(s.video.endFrame?.previewUrl)
          }
          return { video: { ...s.video, ...patch } }
        }),
    }),
    {
      name: 'h3-gen-store',
      // (fix 340) version 3: draftSteps 8→4 migration moved from merge
      // (it triggered on EVERY re-hydration and wiped user's deliberate
      // choice of "8 steps") to one-time migrate by persist version.
      // (fix 449) version 6: Veda back to default OFF (reverts fix 425).
      // version 7: new default pass 1 split point = 6.
      // (Below, in DEFAULT_VIDEO_STATE, total steps is also 6 — "6 of 6".)
      // version 8: extendClipSteps → "auto" (undefined). Field previously in UI
      // was silently lost in hook and did NOT affect generation; stored value
      // (usually old default 4) would suddenly start working — reset to auto
      // so behavior doesn't silently change. Manual choice is made AFTER
      // migration and is preserved faithfully.
      version: 8,
      // (fix 97) New default pass 1 steps = 4 (was 2).
      // Reset only value equal to old default (2) — it signifies
      // "user didn't touch slider". Deliberate choice (3–30) is preserved.
      migrate: (persisted: any, oldVersion: number) => {
        const state = (persisted ?? {}) as any
        if (oldVersion < 2 && state?.video && state.video.firstSamplerSteps === 2) {
          state.video = { ...state.video, firstSamplerSteps: 4 }
        }
        // (fix 340) One-time migration of old default draftSteps 8 → 4
        // (new turbo reference) — only for states saved before v3.
        if (oldVersion < 3 && state?.video && state.video.draftSteps === 8) {
          state.video = { ...state.video, draftSteps: 4 }
        }
        // (fix 449) Veda back to default OFF (reverts fix 425):
        // one-time reset of saved "on"; deliberate enable is done
        // via switch AFTER migration (same pattern as in fixes 340/425).
        if (oldVersion < 6 && state?.video && state.video.vedaAttention === true) {
          state.video = { ...state.video, vedaAttention: false }
        }
        // (fix 437) Two-pass extend is now default ON: saved
        // snapshots with old default false → true (same caveat as in 425:
        // deliberate "Draft" survives migration only if selected
        // AFTER it).
        if (oldVersion < 5 && state?.video && state.video.extendTwoPass === false) {
          state.video = { ...state.video, extendTwoPass: true }
        }
        // New default pass 1 split point: 4 → 6.
        // Reset ONLY old default value (4) — it signifies
        // "user didn't touch slider". Deliberate choice (2, 3, 5…30)
        // is preserved.
        if (oldVersion < 7 && state?.video && state.video.firstSamplerSteps === 4) {
          state.video = { ...state.video, firstSamplerSteps: 6 }
        }
        // version 8: extend clip steps — "auto" (see comment on version).
        if (oldVersion < 8 && state?.video && 'extendClipSteps' in state.video) {
          const { extendClipSteps: _wiped, ...rest } = state.video
          state.video = rest
        }
        return state
      },
      // Deep-merge persisted state with initial state so new fields get defaults
      merge: (persisted: any, current: any) => {
        const result = { ...current, ...persisted }
        if (persisted?.video) {
          result.video = { ...current.video, ...persisted.video }
          // Guard against undefined numeric fields from old localStorage
          if (typeof result.video.videoLength !== 'number' || isNaN(result.video.videoLength)) {
            result.video.videoLength = DEFAULT_VIDEO_STATE.videoLength
          }
          if (typeof result.video.lowResMP !== 'number' || isNaN(result.video.lowResMP)) {
            result.video.lowResMP = DEFAULT_VIDEO_STATE.lowResMP
          }
          if (typeof result.video.draftSteps !== 'number' || isNaN(result.video.draftSteps)) {
            result.video.draftSteps = DEFAULT_VIDEO_STATE.draftSteps
          }
          // (fix 340) draftSteps 8→4 migration moved to migrate
          // (version 3) — here it ran on every re-hydration
          // and erased user's deliberate choice.
          if (typeof result.video.finalResolution !== 'number' || isNaN(result.video.finalResolution)) {
            result.video.finalResolution = DEFAULT_VIDEO_STATE.finalResolution
          }
          if (typeof result.video.freeResolution !== 'boolean') {
            result.video.freeResolution = DEFAULT_VIDEO_STATE.freeResolution
          }
          if (typeof result.video.sigmaVariant !== 'string' || !result.video.sigmaVariant) {
            result.video.sigmaVariant = DEFAULT_VIDEO_STATE.sigmaVariant
          }
          if (result.video.pipeline !== 'draft' && result.video.pipeline !== 'full') {
            result.video.pipeline = DEFAULT_VIDEO_STATE.pipeline
          }
          if (typeof result.video.pass2Sampler !== 'string' || !result.video.pass2Sampler) {
            result.video.pass2Sampler = DEFAULT_VIDEO_STATE.pass2Sampler
          }
          if (typeof result.video.pass1Sampler !== 'string' || !result.video.pass1Sampler) {
            result.video.pass1Sampler = DEFAULT_VIDEO_STATE.pass1Sampler
          }
          if (typeof result.video.pass1Scheduler !== 'string' || !result.video.pass1Scheduler) {
            result.video.pass1Scheduler = DEFAULT_VIDEO_STATE.pass1Scheduler
          }
          if (typeof result.video.turboLoraStrength !== 'number' || isNaN(result.video.turboLoraStrength)) {
            result.video.turboLoraStrength = DEFAULT_VIDEO_STATE.turboLoraStrength
          }
          if (typeof result.video.sparseAttention !== 'boolean') {
            result.video.sparseAttention = DEFAULT_VIDEO_STATE.sparseAttention
          }
          // (fix 400) rehydration of old persist snapshots without veda settings
          if (typeof result.video.vedaGeneratedSparsity !== 'string') {
            result.video.vedaGeneratedSparsity = DEFAULT_VIDEO_STATE.vedaGeneratedSparsity
          }
          if (typeof result.video.vedaReferenceSparsity !== 'string') {
            result.video.vedaReferenceSparsity = DEFAULT_VIDEO_STATE.vedaReferenceSparsity
          }
          if (typeof result.video.vedaFullAttentionLayers !== 'string') {
            result.video.vedaFullAttentionLayers = DEFAULT_VIDEO_STATE.vedaFullAttentionLayers
          }
          if (typeof result.video.vedaFullAttentionSteps !== 'string') {
            result.video.vedaFullAttentionSteps = DEFAULT_VIDEO_STATE.vedaFullAttentionSteps
          }
          if (typeof result.video.vedaVerbose !== 'boolean') {
            result.video.vedaVerbose = DEFAULT_VIDEO_STATE.vedaVerbose
          }
          if (typeof result.video.lowVramAttention !== 'boolean') {
            result.video.lowVramAttention = DEFAULT_VIDEO_STATE.lowVramAttention
          }
          if (typeof result.video.chunkFeedForward !== 'boolean') {
            result.video.chunkFeedForward = DEFAULT_VIDEO_STATE.chunkFeedForward
          }
          if (typeof result.video.chunkFFChunks !== 'number' || isNaN(result.video.chunkFFChunks)) {
            result.video.chunkFFChunks = DEFAULT_VIDEO_STATE.chunkFFChunks
          }
          if (typeof result.video.chunkFFThreshold !== 'number' || isNaN(result.video.chunkFFThreshold)) {
            result.video.chunkFFThreshold = DEFAULT_VIDEO_STATE.chunkFFThreshold
          }
          if (!Array.isArray(result.video.refs)) {
            result.video.refs = []
          }
          if (!Array.isArray(result.video.extendClips)) {
            result.video.extendClips = []
          }
          if (!Array.isArray(result.video.extendImageRefs)) {
            result.video.extendImageRefs = []
          }
          if (typeof result.video.extendSourceVideoPath !== 'string') {
            result.video.extendSourceVideoPath = ''
          }
          if (typeof result.video.extendSourceDuration !== 'number' || isNaN(result.video.extendSourceDuration)) {
            result.video.extendSourceDuration = 0
          }
          // (fix 363) rehydration of old persist snapshots without field
          if (typeof result.video.extendSourceSubfolder !== 'string' && result.video.extendSourceSubfolder !== null) {
            result.video.extendSourceSubfolder = null
          }
          // (fix 385) rehydration of old persist snapshots without field
          if (typeof result.video.extendSourceName !== 'string' && result.video.extendSourceName !== null) {
            result.video.extendSourceName = null
          }
          // (fix 423) rehydration of old persist snapshots without field
          if (typeof result.video.extendTwoPass !== 'boolean') {
            result.video.extendTwoPass = DEFAULT_VIDEO_STATE.extendTwoPass
          }
          // (fix 466) rehydration of old persist snapshots without Sol-Attn fields
          for (const k of ['sparseTau', 'sparseStartPercent', 'sparseEndPercent', 'sparseMinTokens', 'sparseExtraTokens'] as const) {
            if (typeof result.video[k] !== 'number' || isNaN(result.video[k])) {
              result.video[k] = DEFAULT_VIDEO_STATE[k]
            }
          }
        }
        return result
      },
      // Persist form values. Preview blob URLs don't survive reload —
      // strip them and rebuild previews from the server-side input files.
      partialize: (state) => ({
        video: {
          ...state.video,
          startFrame: state.video.startFrame ? { ...state.video.startFrame, previewUrl: '' } : null,
          endFrame: state.video.endFrame ? { ...state.video.endFrame, previewUrl: '' } : null,
          refs: state.video.refs.map((r) => ({ ...r, previewUrl: '' })),
          extendImageRefs: state.video.extendImageRefs.map((r) => ({ ...r, previewUrl: '' })),
        },
      }),
    }
  )
)
