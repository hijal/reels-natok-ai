'use client'

/**
 * Settings Dialog — tabbed settings:
 *   • General       — ComfyUI status, models
 *   • Appearance    — theme, sound on completion (fix 111)
 *   • LLM           — device, context, max response length
 *   • Optimization  — VRAM reserve, Dynamic VRAM
 *   • ComfyUI       — version, Python, GPU, VRAM breakdown
 */
import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  ServerIcon,
  RefreshCwIcon,
  CheckCircleIcon,
  AlertCircleIcon,
  Loader2Icon,
  CpuIcon,
  SunIcon,
  MoonIcon,
  SlidersHorizontalIcon,
  BotIcon,
  BoxIcon,
  LinkIcon,
  CopyIcon,
  FolderOpenIcon,
  AlertTriangleIcon,
  Trash2Icon,
  RotateCcwIcon,
  TrashIcon,
  MicIcon,
  PaletteIcon,
  SparklesIcon,
  ZoomInIcon,
  FileVideoIcon,
  InfoIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { ModelsPanel } from './models-panel'
import { LoraSettingsPanel } from './lora-settings-panel'
import { DiffusionModelSelector } from './diffusion-model-selector'
import { ModelMigrationPanel } from './model-migration-panel'
import { LlmModelSelector } from './llm-model-selector'
import { VoiceSettingsPanel } from './voice-settings-panel'
import { MODELS, MODEL_CATEGORIES } from '@/lib/models-config'
import { useGenStore, DEFAULT_VIDEO_STATE } from '@/lib/gen-store'
import { usePromptHistory } from '@/lib/prompt-history-store'
import { useGenDurations } from '@/lib/gen-duration-store'
import { useAssistantChats } from '@/lib/assistant-chats-store'
import { useGalleryRefresh } from '@/lib/gallery-refresh-store'
// (fix 557) reset queue/job stores on 'factory reset'
import { useGenQueue } from '@/lib/gen-queue-store'
import { useTileUpscaleJob } from '@/lib/tile-upscale-job-store'
import { useControlNetJob } from '@/lib/controlnet-job-store'
import { useFpsJob } from '@/lib/fps-job-store'
import { SettingSlider } from './setting-slider'
import { Label } from '@/components/ui/label'

/* ─── Types ─── */

type TabId = 'general' | 'appearance' | 'llm' | 'voice' | 'optimization' | 'video' | 'links' | 'about' | 'reset'

const TABS: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
  { id: 'general', label: 'General', icon: <BoxIcon className="w-4 h-4" /> },
  // (fix 111) Appearance: theme and sound — separated from 'General'
  { id: 'appearance', label: 'Appearance', icon: <PaletteIcon className="w-4 h-4" /> },
  { id: 'llm', label: 'LLM', icon: <BotIcon className="w-4 h-4" /> },
  // (fix 65) Voice input (whisper STT, CPU)
  { id: 'voice', label: 'Voice', icon: <MicIcon className="w-4 h-4" /> },
  { id: 'optimization', label: 'Optimization', icon: <SlidersHorizontalIcon className="w-4 h-4" /> },
  // (fix 386) Video save format: codec + quality, for all modes
  { id: 'video', label: 'Format', icon: <FileVideoIcon className="w-4 h-4" /> },
  { id: 'links', label: 'Links', icon: <LinkIcon className="w-4 h-4" /> },
  // About program information (author text)
  { id: 'about', label: 'About', icon: <InfoIcon className="w-4 h-4" /> },
  { id: 'reset', label: 'Reset', icon: <AlertTriangleIcon className="w-4 h-4" /> },
]

/* About tab text (fix 484 — author text).
 * Multiline: line breaks in text are preserved when rendered. */
const ABOUT_TEXT = `Dear friend! Thank you for using this application! My main goal is to make creative tools accessible and convenient. Since this project is developed by one person with enthusiasm, I would appreciate it if you could leave your feedback, comments, suggestions, or report any bugs. Also, if you would like to support the project with a donation, my page has links for fundraising.`

/** (fix 484) Author links — TG group, TG channel, YouTube, fundraising. */
const ABOUT_LINKS: Array<{ label: string; url: string; hint: string }> = [
  { label: 'TG Group', url: 'https://t.me/rublev_cg_dev', hint: 'by request, accepting everyone' },
  { label: 'TG Channel', url: 'https://t.me/rublev_cgai', hint: '' },
  { label: 'YouTube', url: 'https://www.youtube.com/@Rublev_CG', hint: '' },
  { label: 'Fundraising', url: 'https://spasibomir.ru/pay/35238', hint: 'support project' },
]

/** (fix 484) Technical info about the studio composition. */
const ABOUT_TECH: Array<{ label: string; value: string }> = [
  { label: 'Generation Model', value: 'MiniMax H3 (video + audio), ComfyUI' },
  { label: 'Pipelines', value: 'Generation (2 passes), Extend, Refine, Tile Upscale' },
  { label: 'LLM Assistant', value: 'Local model (llama.cpp), offline' },
  { label: 'Voice Input', value: 'whisper.cpp (CPU), local' },
  { label: 'Video Processing', value: 'ffmpeg (concat, trim, convert)' },
]

/* ─── Component ─── */

/**
 * (release) Error text from server.
 *
 * API /api/config returns specific reason in `error` JSON field
 * ("Model file not found: ...", "No .gguf model in folder: ...", etc.),
 * but UI showed generic "Failed to save" — user did not understand
 * what to fix. Now reason is shown to user.
 */
async function saveErrorText(res: Response, fallback = 'Failed to save'): Promise<string> {
  try {
    const d = await res.json()
    if (d && typeof d.error === 'string' && d.error.trim()) return d.error
  } catch {
    /* response is not JSON — show fallback text */
  }
  return fallback
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [tab, setTab] = useState<TabId>('general')
  const [loading, setLoading] = useState(false)
  const [connected, setConnected] = useState<boolean | null>(null)
  const [reserveVram, setReserveVram] = useState(3)
  const [dynamicVram, setDynamicVram] = useState(true)
  // (fix 490) Extra free VRAM headroom (--vram-headroom), 0 = off
  const [vramHeadroom, setVramHeadroom] = useState(2)
  const [llmDevice, setLlmDevice] = useState<'auto' | 'gpu' | 'cpu'>('auto')
  // (fix 257) custom LLM (.gguf + mmproj)
  const [llmCustomModel, setLlmCustomModel] = useState('')
  const [llmCustomMmproj, setLlmCustomMmproj] = useState('')
  // (fix 467) Current [llm] model value from config — required so
  // saveLlm does not overwrite selector choice (see conditional llm_model send).
  const [llmModelCurrent, setLlmModelCurrent] = useState('')
  // (fix 119) default context — 25K tokens
  const [llmCtxSize, setLlmCtxSize] = useState(25600)
  // (fix 313) value is no longer sent anywhere (see saveLlm) —
  // keep only setter for resets; the number from GET is not needed.
  const [, setLlmMaxOut] = useState(4096)
  // (fix 53) Assistant video vision — ON by default: digest
  // of video refs is compressed and cached by file content.
  const [llmVideoVision, setLlmVideoVision] = useState(true)
  // (fix 109) LLM KV-cache quantization; (fix 119) q4_0 by default
  const [llmKvCache, setLlmKvCache] = useState<'off' | 'q8_0' | 'q5_1' | 'q4_0'>('q4_0')
  // (fix 140) Fine sampling tuning REMOVED from UI: using
  // model-aware values from src/lib/llm-sampling.ts. Manual escape-hatch
  // remains only via config.ini ([llm] sampling_override=1 + values).
  // (fix 54) reset counter: after 'Reset Settings', model selectors
  // reload config (they only read it on mount).
  const [resetTick, setResetTick] = useState(0)
  // (fix 467) Remount LLM selector after saving custom model:
  // selector reads llm_custom_model from config on mount —
  // without tick custom model only appeared after reopening
  // settings (user feedback).
  const [llmSelTick, setLlmSelTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'reset' | 'clean' | 'delete' | 'factory' | null>(null)
  const [executing, setExecuting] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  // (fix 386) video save format ([video] in config.ini)
  const [videoCodec, setVideoCodec] = useState<'h264' | 'h265' | 'nvenc_h264' | 'nvenc_h265'>('h264')
  const [videoCrf, setVideoCrf] = useState(12)
  const [videoNvencBitrate, setVideoNvencBitrate] = useState(16)

  /* VRAM generation optimizations (Low VRAM / Chunk FF) — reside in same
     zustand store as before in 'Advanced params'; generation reads them from there. */
  const video = useGenStore((s) => s.video)
  const patchVideo = useGenStore((s) => s.patchVideo)

  const checkConnection = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/comfy/health')
      setConnected(res.ok)
    } catch {
      setConnected(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open) {
      checkConnection()
      fetch('/api/config')
        .then((r) => r.json())
        .then((d) => {
          // server clamps to 1–16 (fix 315): `|| 3`
          // turned saved 0 into 3 on each dialog open
          setReserveVram(typeof d.reserve_gb === 'number' ? d.reserve_gb : 3)
          setDynamicVram(d.dynamic_vram !== false)
          setVramHeadroom(typeof d.vram_headroom === 'number' ? d.vram_headroom : 2) // (fix 490)
          if (['auto', 'gpu', 'cpu'].includes(d.llm_device)) setLlmDevice(d.llm_device)
          if (typeof d.llm_context_size === 'number') setLlmCtxSize(d.llm_context_size)
          if (typeof d.llm_max_output_tokens === 'number') setLlmMaxOut(d.llm_max_output_tokens)
          if (typeof d.llm_video_vision === 'boolean') setLlmVideoVision(d.llm_video_vision)
          // (fix 109)
          if (['off', 'q8_0', 'q5_1', 'q4_0'].includes(d.llm_kv_cache)) setLlmKvCache(d.llm_kv_cache)
          // (fix 257)
          setLlmCustomModel(d.llm_custom_model || '')
          setLlmCustomMmproj(d.llm_custom_mmproj || '')
          setLlmModelCurrent(d.llm_model || '') // (fix 467)
          if (typeof d.sound_on === 'boolean') setSoundOn(d.sound_on)
          // (fix 386)
          if (['h264', 'h265', 'nvenc_h264', 'nvenc_h265'].includes(d.video_codec)) setVideoCodec(d.video_codec)
          if (typeof d.video_crf === 'number') setVideoCrf(d.video_crf)
          if (typeof d.video_nvenc_bitrate === 'number') setVideoNvencBitrate(d.video_nvenc_bitrate)
        })
        .catch(() => {
          setReserveVram(3); setDynamicVram(true); setVramHeadroom(0); setLlmDevice('auto')
          setLlmCtxSize(25600); setLlmMaxOut(4096); setLlmVideoVision(false)
          setLlmKvCache('q4_0')
        })
    }
  }, [open, checkConnection])

  /** Save LLM settings (applied at next model load). */
  const saveLlm = useCallback(async () => {
    setSaving(true)
    try {
      // (fix 477) Decide llm_model from LIVE config, not state from dialog open:
      // model selector saves choice immediately by itself, and stale llmModelCurrent
      // overwrote this fresh choice (after 'Save' model 'reset to standard').
      let liveModel = llmModelCurrent
      try {
        const cfgRes = await fetch('/api/config')
        if (cfgRes.ok) {
          const cfgJson = await cfgRes.json()
          if (typeof cfgJson.llm_model === 'string') liveModel = cfgJson.llm_model.trim()
        }
      } catch { /* could not read — decide by dialog state */ }

      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          llm_device: llmDevice,
          llm_context_size: llmCtxSize,
          // (fix 313) do NOT send llm_max_output_tokens: no UI control
          // in UI (text states "calculated automatically"),
          // and unconditional send overwrote manual value from config.ini.
          // Server clamps max_output to context (fix 313 in app-config).
          llm_video_vision: llmVideoVision,
          // (fix 109) KV-cache quantization
          llm_kv_cache: llmKvCache,
          // (fix 257) custom LLM
          llm_custom_model: llmCustomModel,
          llm_custom_mmproj: llmCustomMmproj,
          // (fix 467) Synchronize selector selection: specified path of custom
          // model = 'Custom model' item in list (marker 'llm_custom');
          // cleared path with previously selected custom model = return to
          // default. Without this llmBackend considered custom active whenever
          // path was non-empty, but selector did not show it — model did not
          // appear in list.
          // (fix 477) Explicit selection of built-in model in selector (live —
          // file name, not 'llm_custom') UNTOUCHED even if path is set:
          // user just consciously switched to it.
          ...(llmCustomModel.trim()
            ? (liveModel === '' || liveModel === 'llm_custom' ? { llm_model: 'llm_custom' } : {})
            : liveModel === 'llm_custom' ? { llm_model: '' } : {}),
        })
      })
      if (res.ok) {
        setLlmModelCurrent(liveModel) // (fix 477) state = live config
        setLlmSelTick((t) => t + 1) // (fix 467) selector reloads config
        toast.success('LLM settings saved', {
          // (fix 54) specifically: device/context — on next model launch,
          // video vision and max length — immediately (per-request).
          description: 'Device/context/custom model on next model launch; other settings immediately.',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }, [llmDevice, llmCtxSize, llmVideoVision, llmKvCache, llmCustomModel, llmCustomMmproj, llmModelCurrent])

  /** Save optimization settings (applied at ComfyUI restart). */
  const saveOptimization = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reserve_gb: reserveVram,
          dynamic_vram: dynamicVram,
          vram_headroom: vramHeadroom, // (fix 490)
        }),
      })
      if (res.ok) {
        toast.success('Optimization settings saved', {
          description: 'Will apply on ComfyUI restart.',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }, [reserveVram, dynamicVram, vramHeadroom]) // (fix 490) + vramHeadroom

  /** (fix 386) Save video format ([video] config.ini). */
  const saveVideoFormat = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          video_codec: videoCodec,
          video_crf: videoCrf,
          video_nvenc_bitrate: videoNvencBitrate,
        }),
      })
      if (res.ok) {
        toast.success('Video format saved', {
          description: 'Applies to all NEW jobs in all modes (generation, refine, extend, upscales, trim).',
        })
      } else {
        toast.error(await saveErrorText(res))
      }
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }, [videoCodec, videoCrf, videoNvencBitrate])

  /* ── Danger Zone: confirmation config ── */
  const CONFIRM: Record<string, { title: string; desc: string; button: string }> = {
    reset: {
      title: 'Reset settings?',
      // (fix 54) text matches actual behavior: ALL parameters reset,
      // including model choice (LLM quant, base model),
      // video vision and sound.
      desc: 'All parameters (VRAM, LLM, model selection, generation, resolution, steps, sound) will return to defaults. Action is irreversible.',
      button: 'Reset',
    },
    clean: {
      title: 'Clear cache?',
      desc: 'ALL files from ComfyUI input folder will be deleted (references, frames, uploads). Action is irreversible.',
      button: 'Clear',
    },
    delete: {
      title: 'Delete all content?',
      desc: 'ALL generated videos, assistant chat history, prompt history, and current prompt will be deleted. Action is irreversible.',
      button: 'Delete',
    },
    factory: {
      title: 'Full reset?',
      // (fix 130 + full reset) Full factory reset: settings +
      // LoRA + cache + content + upscale + attachments/chats + prompts + logs.
      desc: 'ALL your data will be deleted: generated videos (output), cache and uploads (input), upscale files and logs, chat attachments, assistant chat history, prompt history and favorites, current prompt, job log, startup logs, and internal ComfyUI logs (including database and saved workflows). Settings (VRAM, LLM, models, LoRA, video format, sound) will return to factory defaults, and browser storage will be cleared. Program will reload; action is irreversible.',
      button: 'Reset All',
    },
  }

  const executeAction = useCallback(async (action: 'reset' | 'clean' | 'delete' | 'factory') => {
    setExecuting(true)
    try {
      if (action === 'factory') {
        /* (fix 130 + full reset) Full factory reset.
         *
         * Server (/api/reset/full) deletes:
         *   ComfyUI content (output), cache (input), temp, chat attachments,
         *   upscale files and logs, chats, task journal, logs,
         *   LoRA settings, external model folders, and config.ini.
         * Client clears Zustand stores, localStorage, and sessionStorage,
         * then reloads — leaving nothing in memory.
         */
        // 1) ComfyUI queue + inflight — before deleting files so tasks
        //    do not write into already cleared folders.
        await fetch('/api/comfy/purge-queue', { method: 'POST' }).catch(() => {})

        // 2) Server full reset.
        const res = await fetch('/api/reset/full', { method: 'POST' })
        const data = await res.json().catch(() => null)
        const failed = !res.ok || !data?.ok
        const reason = Array.isArray(data?.errors) && data.errors.length
          ? data.errors.join('; ')
          : (data?.error || `HTTP ${res.status}`)

        // 3) Client stores (in memory). Clear even on partial server error:
        //    otherwise surviving in-memory chats would sync back
        //    into already deleted data/assistant-chats.json.
        useAssistantChats.getState().clearAll()
        useAssistantChats.getState().setAssistantMode('generate')
        usePromptHistory.getState().clear()
        useGenStore.setState({ video: { ...DEFAULT_VIDEO_STATE } })
        useGenDurations.getState().clear()
        useGenQueue.setState({ items: [] })
        useTileUpscaleJob.getState().reset()
        useControlNetJob.getState().reset()
        useFpsJob.getState().reset()
        useGalleryRefresh.getState().bump()

        // 4) All local storage — entirely (theme, UI scale, welcome,
        //    prompt history, chats, queues, progress, jobs).
        try { localStorage.clear() } catch { /* private mode */ }
        try { sessionStorage.clear() } catch { /* private mode */ }

        if (failed) {
          toast.error('Full reset completed partially', {
            description: `Failed: ${reason}. Verify program is running and try again.`,
          })
          return
        }

        // 5) Reload: ensures no store remains in memory
        //    with stale data.
        toast.success('Full reset completed. Program is reloading...')
        window.setTimeout(() => window.location.reload(), 1200)
        return
      }

      if (action === 'reset') {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reserve_gb: 3,
            dynamic_vram: true,
            vram_headroom: 2, // (fix 490) factory VRAM headroom
            llm_device: 'auto',
            llm_context_size: 25600,       // (fix 119) default context — 25K
            llm_max_output_tokens: 4096,
            // (fix 54) reset all parameters to defaults:
            llm_video_vision: true, // video vision (fix 53) → enabled (digest + cache)
            llm_kv_cache: 'q4_0',    // KV-cache quantization (fixes 109/119) → q4_0
            // (fix 140) sampling — always model-aware values
            llm_sampling_override: false,
            sound_on: true,          // sound → on
            llm_model: 'Qwen3.5-9B-Q4_K_M.gguf', // default assistant model
            diffusion_model: '',     // base model → default
            // (fix 311) custom LLM and external model folders also reset
            // (as in factory reset; previously settings reset did not touch them)
            llm_custom_model: '',
            llm_custom_mmproj: '',
            model_extra_paths: [],
            // (fix 65) voice input → default values
            stt_enabled: true,
            stt_dir: '',
            stt_model: '',
            stt_language: 'ru',
            stt_threads: 0,
          }),
        })
        useGenStore.setState({ video: { ...DEFAULT_VIDEO_STATE } })
        useGenDurations.getState().clear()
        // (fix 435) Assistant after reset — in "Generate" mode
        // (default), not last selected "Extend" mode.
        useAssistantChats.getState().setAssistantMode('generate')
        setReserveVram(3)
        setDynamicVram(true)
        setVramHeadroom(0) // (fix 490)
        setLlmDevice('auto')
        setLlmCtxSize(25600)
        setLlmMaxOut(4096)
        setLlmVideoVision(false)
        setLlmKvCache('q4_0')
        setSoundOn(true)
        setLlmCustomModel('')   // (fix 311)
        setLlmCustomMmproj('')  // (fix 311)
        setResetTick((t) => t + 1) // (fix 54) model selectors reload config
        // Unload loaded LLM: otherwise after reset it would continue
        // responding with old model/config (chat route already reads new ones) —
        // glitchy initial replies. Guarded by signature in ensureLlm.
        void fetch('/api/llm/stop', { method: 'POST' }).catch(() => {})
        toast.success('Settings reset to default values')
      } else if (action === 'clean') {
        const res = await fetch('/api/comfy/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'input' }),
        })
        const data = await res.json()
        if (data.ok) {
          useGenStore.getState().clearVideoRefs()
          useGenStore.setState((s) => ({
            video: { ...s.video, startFrame: null, endFrame: null },
          }))
          toast.success(`Cache cleared (deleted: ${data.deleted})`)
        } else {
          toast.error(data.error || 'Failed to clear cache')
        }
      } else if (action === 'delete') {
        const res = await fetch('/api/comfy/clean', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ target: 'output' }),
        })
        const data = await res.json()
        if (data.ok) {
          useAssistantChats.getState().clearAll()
          useGenDurations.getState().clear()
          usePromptHistory.getState().clear()
          useGenStore.setState((s) => ({ video: { ...s.video, prompt: '' } }))
          // (fix 134) Gallery: refresh signal — videos deleted on
          // backend, gallery empties immediately (without waiting for tab switch).
          useGalleryRefresh.getState().bump()
          toast.success(`Content deleted (deleted: ${data.deleted})`)
        } else {
          toast.error(data.error || 'Failed to delete content')
        }
      }
    } catch (err) {
      console.error('Action failed:', err)
      toast.error('An error occurred while performing action')
    } finally {
      setExecuting(false)
      setConfirmAction(null)
    }
  }, [])

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* FIXED size (never resizes between tabs) + internal scroll area —
          nothing sticks out past the side edges. */}
      <DialogContent className="w-[950px] max-w-[96vw] sm:max-w-[950px] h-[920px] max-h-[96vh] flex flex-col overflow-hidden gap-0 p-0">
        <DialogHeader className="px-6 pt-5 pb-2 shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ServerIcon className="w-5 h-5" />
            Settings
          </DialogTitle>
          <DialogDescription>
            Connection, models, LLM, GPU memory, ComfyUI, and manual download links
          </DialogDescription>
        </DialogHeader>

        {/* Tab bar */}
        <div className="px-6 shrink-0">
          {/* (fix 566→571) All nine tabs in ONE row, filling it
              completely: compact padding/font (total ~790px min
              width < ~890px available) + flex-1 — buttons share row equally,
              no empty tail after "Reset". If content stops
              fitting (narrow window/new tab) — min-width:auto preserves
              readability, overflow-x-auto triggers. */}
          <div className="flex items-center gap-0.5 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border mb-2 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  // (fix 120) whitespace-nowrap: "Appearance" — two-word name,
                  // prevent line break across multiple rows
                  'flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-[11px] font-medium transition-colors whitespace-nowrap',
                  tab === t.id
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    : 'text-muted-foreground border border-transparent hover:text-foreground',
                )}
              >
                <span className="shrink-0 [&_svg]:w-3.5 [&_svg]:h-3.5">{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Scrollable tab content — the ONLY scrolling region */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-6 pb-5">
        {/* ─────────── General ─────────── */}
        {tab === 'general' && (
          <div className="space-y-4 py-2">
            {/* Connection status */}
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">ComfyUI:</span>
              {loading ? (
                <Badge variant="secondary" className="gap-1">
                  <Loader2Icon className="w-3 h-3 animate-spin" />
                  Checking...
                </Badge>
              ) : connected ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 gap-1">
                  <CheckCircleIcon className="w-3 h-3" />
                  Connected
                </Badge>
              ) : (
                <Badge variant="destructive" className="gap-1">
                  <AlertCircleIcon className="w-3 h-3" />
                  Unavailable
                </Badge>
              )}
            </div>
            {!connected && (
              <p className="text-xs text-muted-foreground">
                Ensure ComfyUI is running on port 8188.
              </p>
            )}

            {/* Model Migration (fix 47) — at the very top */}
            <ModelMigrationPanel />

            {/* Models */}
            <div className="space-y-2 pt-2 border-t border-border">
              <ModelsPanel />
            </div>

            {/* (fix 257) Custom Model Folders — collections outside studio folder
                (moved from removed "ComfyUI" tab);
                (fix 321) key — reload after reset, same as model
                selectors (reads /api/config only on mount) */}
            <ExtraModelPathsPanel key={`emp-${resetTick}`} />

            {/* Diffusion Model (fix 45); key — reload after reset (fix 54) */ }
            <DiffusionModelSelector key={`dm-${resetTick}`} />

            {/* Custom LoRAs (fix 44; fix 95 — turbo LoRA in general list) */ }
            <LoraSettingsPanel />

            {/* (fix 111) Theme and sound moved to 'Appearance' tab */ }

            {/* (fix 116) Welcome window — restore if "Do not show again" checkbox
             * was checked: reset flag in browser localStorage
             * (h3_welcome_seen_v1) and fire h3:show-welcome event — Home listens
             * and opens WelcomeDialog. Settings dialog closes so welcome
             * renders on top cleanly.
             * */}
            <div className="space-y-2 pt-2 border-t border-border">
              <div>
                <span className="text-xs text-muted-foreground">Startup welcome</span>
                <p className="text-[10px] text-muted-foreground/60">
                  Popup window with quick instructions. If checked
                  "Do not show again" — restore it with this button.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => {
                  try {
                    localStorage.removeItem('h3_welcome_seen_v1')
                  } catch { /* ignore */ }
                  window.dispatchEvent(new CustomEvent('h3:show-welcome'))
                  onOpenChange(false)
                }}
              >
                <SparklesIcon className="w-3.5 h-3.5" />
                Show welcome dialog
              </Button>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={checkConnection}
              disabled={loading}
              className="w-full"
            >
              <RefreshCwIcon className={loading ? 'animate-spin' : ''} />
              Re-check
            </Button>


          </div>
        )}

        {/* ─────────── Appearance (fix 111) ─────────── */ }
        {tab === 'appearance' && (
          <div className="space-y-4 py-2">
            {/* (fix 111) Theme — moved from 'General' */ }
            <ThemeSwitcher first />

            {/* (fix 445) UI scale (like browser zoom) */ }
            <UiScaleSwitcher />

            {/* (fix 111) Completion sound — moved from 'General' */ }
            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div>
                <span className="text-xs text-muted-foreground">Completion sound</span>
                <p className="text-[10px] text-muted-foreground/60">
                  Short audio chime when generation finishes
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={soundOn}
                onClick={async () => {
                  const newVal = !soundOn
                  setSoundOn(newVal)
                  try {
                    await fetch('/api/config', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ sound_on: newVal }),
                    })
                  } catch { /* ignore */ }
                }}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors',
                  soundOn ? 'bg-cyan-600' : 'bg-muted-foreground/30',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none block h-4 w-4 rounded-full bg-white shadow-lg transition-transform',
                  soundOn ? 'translate-x-4' : 'translate-x-0.5',
                  )}
                />
              </button>
            </div>
          </div>
        )}

        {/* ─────────── LLM ─────────── */}
        {tab === 'llm' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BotIcon className="w-4 h-4 text-cyan-400" />
              LLM Assistant
            </div>
            <p className="text-xs text-muted-foreground/70 -mt-2">
              Device and context parameters for chat model (Gemma 4 12B / Qwen3.5 9B).
            </p>

            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs text-muted-foreground">Device</span>
                  <p className="text-[10px] text-muted-foreground/60">
                    Where chat model is computed
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border">
                {([
                  ['auto', 'Auto', 'GPU when VRAM available, otherwise CPU'],
                  ['gpu', 'GPU', 'Fast (~40+ tok/s), shares VRAM with generation'],
                  ['cpu', 'CPU', 'Slower, but leaves VRAM untouched'],
                ] as const).map(([id, label, title]) => (
                  <button
                    key={id}
                    type="button"
                    title={title}
                    onClick={() => setLlmDevice(id)}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                      llmDevice === id
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'text-muted-foreground border border-transparent hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">LLM Context</span>
                <span className="text-xs font-mono text-cyan-300">
                  {(llmCtxSize / 1024).toFixed(llmCtxSize % 1024 === 0 ? 0 : 1)}K tokens
                </span>
              </div>
              <input
                type="range"
                min={8192}
                max={102400}
                step={1024}
                value={llmCtxSize}
                onChange={(e) => setLlmCtxSize(parseInt(e.target.value, 10))}
                className="w-full h-2 cursor-pointer accent-cyan-400"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground/50">
                <span>8K</span><span>100K</span>
              </div>
            </div>

            {/* (fix 109) KV-cache quantization: saves VRAM/RAM, slight quality impact */ }
            <div className="space-y-1.5 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">KV-cache quantization</span>
              <p className="text-[10px] text-muted-foreground/60">
                Compresses chat model context cache (less memory for same context).
                Default q4_0 — maximum memory savings (fix 119); q8_0 — near-lossless; off — uncompressed.
              </p>
              <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--surface-2)]/60 border border-border">
                {([
                  ['off', 'Off (fp16)', 'Full precision, more memory usage'],
                  ['q8_0', 'Q8', 'Recommended: near lossless quality'],
                  ['q5_1', 'Q5', 'Moderate memory savings'],
                  ['q4_0', 'Q4', 'Maximum memory savings'],
                ] as const).map(([id, label, title]) => (
                  <button
                    key={id}
                    type="button"
                    title={title}
                    onClick={() => setLlmKvCache(id)}
                    className={cn(
                      'flex-1 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                      llmKvCache === id
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'text-muted-foreground border border-transparent hover:text-foreground',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* (fix 53) Assistant video vision — ON by default */ }
            <div className="space-y-1.5 pt-2 border-t border-border">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="text-xs text-muted-foreground">Assistant video vision</span>
                  <p className="text-[10px] text-muted-foreground/60">
                    On: assistant receives compressed digest of video refs (cached by
                    file content). Off: only aware of video presence and does not
                    invent its content.
                  </p>
                </div>
                <button
                  type="button"
                  title={llmVideoVision ? 'Disable video vision' : 'Enable video vision'}
                  onClick={() => setLlmVideoVision(!llmVideoVision)}
                  className={cn(
                    'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                    llmVideoVision ? 'bg-cyan-500/70' : 'bg-[var(--surface-4)]',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                      llmVideoVision && 'translate-x-[18px]',
                    )}
                  />
                </button>
              </div>
            </div>

            {/* LLM Model Selector (fix 48); key — reload after reset
                (fix 54) and after saving custom model (fix 467) */}
            <LlmModelSelector key={`llm-${resetTick}-${llmSelTick}`} />

            {/* (fix 257) Custom assistant model: absolute path to .gguf.
                Non-empty path overrides model selection above (banner about
                assistant models hides). mmproj is optional
                for vision; without it assistant runs in text-only mode. */}
            <div className="space-y-1.5 pt-2 border-t border-border">
              <span className="text-xs text-muted-foreground">Custom Model (GGUF)</span>
              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                {/* (fix 308) Server accepts both folder and file: folder
                    resolves to first .gguf inside it on save. */}
                Folder with .gguf model or path to file itself — assistant
                will launch with it (studio engine, no downloading or copying).
                Empty = model from list above. Example: <span className="font-mono">D:\models</span>
              </p>
              {/* (fix 278) "Browse folder" button — native dialog
                  (same as in "Custom Model Folders"); manual input remains
                  as fallback. */}
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start font-normal"
                onClick={async () => {
                  try {
                    const res = await fetch('/api/dialog/folder', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ title: 'Select folder with .gguf model' }),
                    })
                    const data = await res.json()
                    if (!res.ok) {
                      toast.error(data.error || 'Failed to open folder selection dialog.')
                      return
                    }
                    if (data.path) setLlmCustomModel(data.path as string)
                  } catch {
                    toast.error('Failed to open folder selection dialog.')
                  }
                }}
              >
                <FolderOpenIcon className="w-3.5 h-3.5 mr-1.5 shrink-0" />
                Browse folder on disk...
              </Button>
              <input
                type="text"
                value={llmCustomModel}
                onChange={(e) => setLlmCustomModel(e.target.value)}
                placeholder="...or enter path manually: D:\models"
                className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
              <span className="text-xs text-muted-foreground block pt-1">mmproj (vision projector, optional)</span>
              {/* (fix 308) Also file or folder: first file from folder
                  with 'mmproj' in name is used. */}
              <input
                type="text"
                value={llmCustomMmproj}
                onChange={(e) => setLlmCustomMmproj(e.target.value)}
                placeholder="D:\models\my-model-mmproj-F16.gguf"
                className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              />
            </div>

            <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
              Max response length is calculated automatically from context.
              Applies on next model launch.
              GPU mode automatically yields memory during video generation.
            </p>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveLlm()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}

        {/* ─────────── Voice input (fix 65) ─────────── */}
        {tab === 'voice' && <VoiceSettingsPanel />}

        {/* ─────────── Optimization ─────────── */}
        {tab === 'optimization' && (
          <div className="space-y-5 py-2">
            {/* ── ComfyUI GPU memory (config.ini, applied at restart) ── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm font-medium">
                <CpuIcon className="w-4 h-4 text-amber-400" />
                GPU Memory (ComfyUI)
              </div>
              <p className="text-xs text-muted-foreground/70 -mt-1.5">
                ComfyUI VRAM reserve and dynamic allocation. Applies on restart.
              </p>

              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">VRAM Reserve</span>
                  <span className="text-xs font-mono">{reserveVram} GB</span>
                </div>
                <input
                  type="range"
                  /* (fix 315) Range unified with server: 1–16 GB */
                  min={1}
                  max={16}
                  step={0.5}
                  value={reserveVram}
                  onChange={(e) => setReserveVram(parseFloat(e.target.value))}
                  className="w-full h-2 cursor-pointer accent-amber-400"
                />
                {/* Positions on real scale 1-16: 8 GB is at ~47%, not
                    centered (justify-between aligned to 50% incorrectly) */}
                <div className="relative h-3 text-[10px] text-muted-foreground/50">
                  <span className="absolute left-0">1 GB</span>
                  <span className="absolute" style={{ left: '47%' }}>8 GB</span>
                  <span className="absolute right-0">16 GB</span>
                </div>
              </div>

              {/* (fix 490) Extra free VRAM margin (--vram-headroom):
                  accounted for by native DynamicVRAM (comfy-aimdo) layer —
                  monitors actual free VRAM via NVML including
                  third-party apps. Primary guaranteed mechanism is
                  "VRAM Reserve": ComfyUI model manager subtracts from
                  available memory when loading weights so models
                  unload/offload earlier. */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Free VRAM Headroom</span>
                  <span className="text-xs font-mono">{vramHeadroom > 0 ? `${vramHeadroom} GB` : 'Off'}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={8}
                  step={0.5}
                  value={vramHeadroom}
                  onChange={(e) => setVramHeadroom(parseFloat(e.target.value))}
                  className="w-full h-2 cursor-pointer accent-amber-400"
                />
                <div className="relative h-3 text-[10px] text-muted-foreground/50">
                  <span className="absolute left-0">Off</span>
                  <span className="absolute" style={{ left: '22%' }}>2 GB</span>
                  <span className="absolute right-0">8 GB</span>
                </div>
                <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                  Additional margin accounted for by native DynamicVRAM
                  (comfy-aimdo) layer during VRAM allocation — including
                  third-party apps. Guaranteed lever is "VRAM Reserve":
                  ComfyUI model manager subtracts it when loading weights.
                </p>
              </div>

              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Dynamic VRAM</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      ComfyUI Dynamic VRAM Management
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDynamicVram(!dynamicVram)}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      dynamicVram ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        dynamicVram && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>
              </div>

              <p className="text-[10px] text-muted-foreground/60 leading-relaxed">
                Applies on ComfyUI restart — restart studio (start.bat) after saving.
              </p>
            </div>

            {/* ── Generation optimizations (per-generation workflow params, applied immediately) ── */}
            <div className="space-y-3 pt-4 border-t border-border">
              <div className="flex items-center gap-2 text-sm font-medium">
                <SlidersHorizontalIcon className="w-4 h-4 text-emerald-400" />
                Generation Optimization (VRAM)
              </div>
              <p className="text-xs text-muted-foreground/70 -mt-1.5">
                Memory saving modes for generation nodes. Applies immediately to all
                new generations without restarting ComfyUI.
              </p>

              {/* (fix 168) Sparse Attention (Sol-Attn) */ }
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Sparse Attention (Sol-Attn)</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Accelerates long sequences (~1.2–2.5x);
                      short ones remain dense automatically
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.sparseAttention}
                    onClick={() => patchVideo({ sparseAttention: !video.sparseAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.sparseAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.sparseAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {/* (fix 466) Sol-Attn node settings — visible when enabled
                    toggle (like Veda block, fix 406). Previously values were
                    hardcoded in workflow template (tau 1.3, 0.2–1.0, 12288, 256). */}
                {video.sparseAttention && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Sparsity threshold (tau)"
                      labelTitle="How aggressively to skip attention computations. Higher is faster, but quality may degrade. Default 1.3."
                      value={video.sparseTau}
                      onChange={(v) => patchVideo({ sparseTau: v })}
                      min={0}
                      max={4}
                      step={0.1}
                      inputMin={0}
                      inputMax={4}
                    />
                    <SettingSlider
                      label="Start ratio from generation start"
                      labelTitle="First generation steps establish composition — best computed precisely. 20% default: first steps dense, then accelerated."
                      value={Math.round(video.sparseStartPercent * 100)}
                      onChange={(v) => patchVideo({ sparseStartPercent: v / 100 })}
                      min={0}
                      max={90}
                      step={5}
                      formatValue={(v) => `${Math.round(v)}%`}
                    />
                    <SettingSlider
                      label="End ratio until generation end"
                      labelTitle="Up to what point acceleration is applied. 100% default: up to last step (fastest). Reduce if output looks soft."
                      value={Math.round(video.sparseEndPercent * 100)}
                      onChange={(v) => patchVideo({ sparseEndPercent: v / 100 })}
                      min={10}
                      max={100}
                      step={5}
                      formatValue={(v) => `${Math.round(v)}%`}
                    />
                    <SettingSlider
                      label="Minimum video length (tokens)"
                      labelTitle="Sol-Attn does not accelerate short videos — always computed densely. Decrease value to enable acceleration on shorter clips."
                      value={video.sparseMinTokens}
                      onChange={(v) => patchVideo({ sparseMinTokens: Math.round(v) })}
                      min={1024}
                      max={65536}
                      step={1024}
                      inputMin={1024}
                      inputMax={131072}
                    />
                    <SettingSlider
                      label="Additional context (tokens)"
                      labelTitle="Token margin above base length — prevents losing fine details during acceleration. Default 256."
                      value={video.sparseExtraTokens}
                      onChange={(v) => patchVideo({ sparseExtraTokens: Math.round(v) })}
                      min={0}
                      max={2048}
                      step={128}
                      inputMin={0}
                      inputMax={8192}
                    />
                  </div>
                )}
              </div>

              {/* (fix 301) Veda Sparse Attention */ }
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Veda Sparse Attention</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      For long videos (10+ sec) / 8+ steps; replaces Sol-Attn
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.vedaAttention}
                    onClick={() => patchVideo({ vedaAttention: !video.vedaAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.vedaAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.vedaAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {/* (fix 406) Advanced Veda settings — visible when toggle is enabled */}
                {video.vedaAttention && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Generation sparsity, %"
                      value={(() => { const n = Number.parseFloat(video.vedaGeneratedSparsity); return Number.isFinite(n) ? n : 90 })()}
                      onChange={(v) => patchVideo({ vedaGeneratedSparsity: `${Math.round(v)}%` })}
                      min={50}
                      max={95}
                      step={5}
                    />
                    <p className="text-[10px] text-muted-foreground/60 -mt-1.5 leading-snug">
                      Percentage of key tiles skipped during generation. Higher % = faster, but coarser image.
                    </p>
                    <SettingSlider
                      label="Reference sparsity, %"
                      value={(() => { const n = Number.parseFloat(video.vedaReferenceSparsity); return Number.isFinite(n) ? n : 90 })()}
                      onChange={(v) => patchVideo({ vedaReferenceSparsity: `${Math.round(v)}%` })}
                      min={0}
                      max={95}
                      step={5}
                    />
                    <p className="text-[10px] text-muted-foreground/60 -mt-1.5 leading-snug">
                      Same for references. 0% = full attention to references — more accurate character face, but slower.
                    </p>
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Dense attention layers</span>
                      <input
                        type="text"
                        value={video.vedaFullAttentionLayers}
                        onChange={(e) => patchVideo({ vedaFullAttentionLayers: e.target.value })}
                        placeholder="0, 1, 47-49"
                        className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <p className="text-[10px] text-muted-foreground/60 leading-snug">
                        0-based DiT block numbers always computed densely. Empty = all layers sparse.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <span className="text-xs text-muted-foreground">Dense attention steps</span>
                      <input
                        type="text"
                        value={video.vedaFullAttentionSteps}
                        onChange={(e) => patchVideo({ vedaFullAttentionSteps: e.target.value })}
                        placeholder="0, 1"
                        className="w-full rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
                      />
                      <p className="text-[10px] text-muted-foreground/60 leading-snug">
                        0-based sampler step numbers with dense attention. Empty = all steps sparse.
                      </p>
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={video.vedaVerbose}
                        onChange={(e) => patchVideo({ vedaVerbose: e.target.checked })}
                        className="w-3.5 h-3.5 accent-emerald-500"
                      />
                      <span className="text-xs text-muted-foreground">Verbose logging</span>
                    </label>
                  </div>
                )}
              </div>

              {/* Low VRAM Attention */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Low VRAM Attention</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Chunked attention (4 heads) — saves VRAM
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.lowVramAttention}
                    onClick={() => patchVideo({ lowVramAttention: !video.lowVramAttention })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.lowVramAttention ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.lowVramAttention && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>
              </div>

              {/* Chunk FeedForward + settings */}
              <div className="space-y-1.5 pt-2 border-t border-border">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-muted-foreground">Chunk FeedForward</span>
                    <p className="text-[10px] text-muted-foreground/60">
                      Chunked FeedForward on long sequences — saves VRAM
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={video.chunkFeedForward}
                    onClick={() => patchVideo({ chunkFeedForward: !video.chunkFeedForward })}
                    className={cn(
                      'relative w-10 h-5.5 rounded-full transition-colors shrink-0',
                      video.chunkFeedForward ? 'bg-emerald-500/70' : 'bg-[var(--surface-4)]',
                    )}
                  >
                    <span
                      className={cn(
                        'absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform',
                        video.chunkFeedForward && 'translate-x-[18px]',
                      )}
                    />
                  </button>
                </div>

                {video.chunkFeedForward && (
                  <div className="space-y-3 pl-3 border-l border-border/60">
                    <SettingSlider
                      label="Chunk FF: number of chunks"
                      value={typeof video.chunkFFChunks === 'number' ? video.chunkFFChunks : 2}
                      onChange={(v) => patchVideo({ chunkFFChunks: Math.round(v) })}
                      min={1}
                      max={8}
                      step={1}
                    />
                    <SettingSlider
                      label="Chunk FF: sequence threshold"
                      value={typeof video.chunkFFThreshold === 'number' ? video.chunkFFThreshold : 4096}
                      onChange={(v) => patchVideo({ chunkFFThreshold: Math.round(v) })}
                      min={1024}
                      max={16384}
                      step={512}
                    />
                  </div>
                )}
              </div>
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveOptimization()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}

        {/* ─────────── Video output format (fix 386) ─────────── */ }
        {tab === 'video' && (
          <div className="space-y-6 py-2">
            {/* Codec */ }
            <div className="space-y-2">
              <Label className="text-xs">Video Codec</Label>
              <div className="grid grid-cols-2 gap-1.5">
                {([
                  ['h264', 'H.264 (x264)', 'Maximum compatibility — plays anywhere'],
                  ['h265', 'H.265 (x265)', 'File is 30–50% smaller, encoding is slower'],
                  ['nvenc_h264', 'NVENC H.264 (GPU)', 'NVIDIA hardware encoder — very fast'],
                  ['nvenc_h265', 'NVENC H.265 (GPU)', 'Fast and compact (bitrate instead of CRF)'],
                ] as const).map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setVideoCodec(id)}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors',
                      videoCodec === id
                        ? 'border-cyan-500/50 bg-cyan-500/10'
                        : 'border-border bg-[var(--surface-2)] hover:border-cyan-500/30',
                    )}
                  >
                    <p className={cn(
                      'text-xs font-medium',
                      videoCodec === id ? 'text-cyan-300' : 'text-foreground',
                    )}>{label}</p>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">{hint}</p>
                  </button>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground">
                NVENC uses dedicated GPU hardware; switch back to software encoder if saving fails.
              </p>
            </div>

            {/* Quality */ }
            {videoCodec === 'h264' || videoCodec === 'h265' ? (
              <div className="space-y-2">
                <SettingSlider
                  label="Quality (CRF — lower is better)"
                  value={videoCrf}
                  min={0}
                  max={30}
                  step={1}
                  onChange={(v) => setVideoCrf(Math.round(v))}
                  formatValue={(v) =>
                    v <= 14 ? `${v} — maximum` : v <= 19 ? `${v} — high` : v <= 25 ? `${v} — standard` : `${v} — compact`
                  }
                />
                <p className="text-[10px] leading-snug text-muted-foreground">
                  12 — archival quality. 17–19 — 'high', visually near-identical.
                  23+ — compact drafts. H.265 yields significantly smaller files than H.264.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <SettingSlider
                  label="NVENC Bitrate"
                  value={videoNvencBitrate}
                  min={4}
                  max={40}
                  step={1}
                  unit=" Mbps"
                  onChange={(v) => setVideoNvencBitrate(Math.round(v))}
                />
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Hardware encoders use bitrate instead of CRF. For 1080p: 16 Mbps ≈ high
                  quality, 24+ — maximum, 8 — compact.
                </p>
              </div>
            )}

            <p className="text-[10px] leading-snug text-muted-foreground/70">
              Applies to all NEW tasks: generation (draft/full), refine "Full" and "Parts",
              extend, Tile Upscale, FPS, trim, and concat. Existing files are not re-encoded.
              Setting takes effect immediately — no restart needed.
            </p>

            <Button
              variant="outline"
              size="sm"
              onClick={() => void saveVideoFormat()}
              disabled={saving}
              className="w-full"
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
          </div>
        )}

        {/* ─────────── Manual download links ─────────── */}
        {tab === 'links' && <ManualDownloadPanel />}

        {/* ─────────── About ─────────── */ }
        {tab === 'about' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-3">
              <img src="/logo.svg" alt="" className="w-10 h-10" />
              <div>
                <div className="text-sm font-medium">Minimax H3 Studio</div>
                <div className="text-xs text-muted-foreground">Version 7.0.0</div>
              </div>
            </div>
            {/* (fix 484) Author text — ABOUT_TEXT constant above */ }
            <p className="text-xs text-muted-foreground whitespace-pre-line leading-relaxed">
              {ABOUT_TEXT}
            </p>

            {/* (fix 484) Author links */ }
            <div className="space-y-1.5">
              {ABOUT_LINKS.map((l) => (
                <div key={l.url} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0">{l.label}:</span>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-400 hover:text-blue-300 underline underline-offset-2 break-all"
                  >
                    {l.url}
                  </a>
                  {l.hint && <span className="text-muted-foreground/60">({l.hint})</span>}
                </div>
              ))}
            </div>

            {/* (fix 484) Technical information */ }
            <div className="border-t border-border/50 pt-3 space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Technical Information</div>
              {ABOUT_TECH.map((t) => (
                <div key={t.label} className="flex items-baseline gap-2 text-xs">
                  <span className="text-muted-foreground/70 shrink-0">{t.label}:</span>
                  <span className="text-muted-foreground">{t.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─────────── Reset (Danger Zone) ─────────── */ }
        {tab === 'reset' && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2">
              <AlertTriangleIcon className="w-4 h-4 text-red-400" />
              <span className="text-sm font-medium text-red-400">Danger Zone</span>
            </div>
            <p className="text-xs text-muted-foreground/70 -mt-2">
              Irreversible operations. Proceed with caution.
            </p>

            <div className="space-y-4">
              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('reset')}
                >
                  <RotateCcwIcon className="w-3.5 h-3.5" />
                  Reset Settings
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  All parameters (VRAM, LLM, model selection, generation, resolution, steps, sound) will return to defaults.
                </p>
              </div>

              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-amber-400 border-amber-500/30 hover:bg-amber-500/10"
                  onClick={() => setConfirmAction('clean')}
                >
                  <Trash2Icon className="w-3.5 h-3.5" />
                  Clear Cache
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Deletes all files from ComfyUI input folder (references, frames, temporary uploads).
                </p>
              </div>

              <div className="space-y-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-red-400 border-red-500/30 hover:bg-red-500/10"
                  onClick={() => setConfirmAction('delete')}
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                  Delete Content
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Deletes ALL generated videos (output folder), assistant
                  chat history, prompt history, and CURRENT prompt in generate input.
                </p>
              </div>

              {/* (fix 130 + full reset) Full factory reset */ }
              <div className="space-y-1.5 border-t border-border/40 pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-red-500 border-red-500/50 bg-red-500/5 hover:bg-red-500/15 font-medium"
                  onClick={() => setConfirmAction('factory')}
                >
                  <SparklesIcon className="w-3.5 h-3.5" />
                  Full Factory Reset (All)
                </Button>
                <p className="text-xs text-muted-foreground/60 pl-1">
                  Deletes ALL user data: videos, cache, upscale files, chat attachments and history, prompts, logs, and local data. Settings, LoRA, and config.ini return to factory defaults.
                </p>
              </div>
            </div>
          </div>
        )}
        </div>
      </DialogContent>
    </Dialog>

    {/* Confirmation dialog */}
    {confirmAction && CONFIRM[confirmAction] && (
      <Dialog open onOpenChange={(v) => { if (!v) setConfirmAction(null) }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-400">
              <AlertTriangleIcon className="w-5 h-5" />
              {CONFIRM[confirmAction].title}
            </DialogTitle>
            <DialogDescription>
              {CONFIRM[confirmAction].desc}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end mt-4">
            <Button variant="outline" size="sm" onClick={() => setConfirmAction(null)} disabled={executing}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-red-600 hover:bg-red-700 text-white"
              onClick={() => void executeAction(confirmAction)}
              disabled={executing}
            >
              {executing ? 'Processing...' : CONFIRM[confirmAction].button}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    )}
    </>
  )
}

/* ─── (fix 257) Custom model folders — collections outside studio folder ─── */

function ExtraModelPathsPanel() {
  // (fix 262) exists — folder existence flag (server checks via statSync)
  const [entries, setEntries] = useState<Array<{ path: string; category: string; exists?: boolean }>>([])
  const [newPath, setNewPath] = useState('')
  const [adding, setAdding] = useState(false)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        setEntries(Array.isArray(d.model_extra_paths) ? d.model_extra_paths : [])
      })
      .catch(() => setEntries([]))
  }, [])

  /** Add folder: server parses root with standard ComfyUI structure
   *  into categories automatically; assigns chosen category to flat folder
   *  (or guessed by name). Path from native dialog
   *  (pathArg) or manual text input. */
  const add = async (pathArg?: string) => {
    const p = (pathArg ?? newPath).trim()
    if (!p) return
    setAdding(true)
    try {
      const res = await fetch('/api/models/extra-paths', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        toast.error(d.error || 'Folder unavailable')
        return
      }
      const found: Array<{ path: string; category: string }> = d.entries || []
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => `${e.path}|${e.category}`))
        return [...prev, ...found.filter((e) => !seen.has(`${e.path}|${e.category}`))]
      })
      setNewPath('')
      setDirty(true)
      toast.success(
        found.length > 1
          ? `Categories added: ${found.length} (ComfyUI structure)`
          : 'Folder added',
      )
    } catch {
      toast.error('Failed to verify folder')
    } finally {
      setAdding(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // (fix 262) Send only path+category — exists is not stored
        body: JSON.stringify({
          model_extra_paths: entries.map(({ path, category }) => ({ path, category })),
        }),
      })
      const d = await res.json()
      if (!res.ok || d.error) {
        toast.error(typeof d?.error === 'string' && d.error ? d.error : 'Failed to save')
        return
      }
      setDirty(false)
      if (d.restart_required) {
        toast.success('Folders saved', {
          description: 'Restart start.bat — ComfyUI will pick up external folders on startup.',
          duration: 10000,
        })
      } else {
        toast.success('Folders saved')
      }
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2 text-xs font-medium">
        <FolderOpenIcon className="w-3.5 h-3.5 text-amber-400" />
        Custom Model Folders
      </div>
      <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
        Model folders OUTSIDE studio folder (collections from other machines, shared
        network storage) — without copying. A folder with standard structure
        (like <span className="font-mono">models</span> in ComfyUI) is sorted
        into categories automatically. Restart start.bat after changes.
      </p>

      {entries.length > 0 && (
        <div className="space-y-1.5">
          {entries.map((e, i) => (
            <div key={`${e.path}|${e.category}`} className="flex items-center gap-1.5">
              {/* (fix 262) Indicator: folder does not exist on disk */ }
              {e.exists === false && (
                <span
                  title="Folder not found on disk — remove or fix path"
                  className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30"
                >
                  missing
                </span>
              )}
              <input
                type="text"
                value={e.path}
                onChange={(ev) => {
                  const v = ev.target.value
                  setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, path: v, exists: undefined } : x)))
                  setDirty(true)
                }}
                className={`flex-1 min-w-0 rounded-md border bg-[var(--surface-2)] px-2 py-1 text-[10px] font-mono text-foreground focus:outline-none focus:ring-1 ${
                  e.exists === false
                    ? 'border-red-500/40 focus:ring-red-500/50'
                    : 'border-border focus:ring-cyan-500/50'
                }`}
              />
              <select
                value={e.category}
                onChange={(ev) => {
                  const v = ev.target.value
                  setEntries((prev) => prev.map((x, j) => (j === i ? { ...x, category: v } : x)))
                  setDirty(true)
                }}
                className="rounded-md border border-border bg-[var(--surface-2)] px-1.5 py-1 text-[10px] text-foreground focus:outline-none"
                title="Category (ComfyUI folder)"
              >
                {EXTRA_CATEGORY_OPTIONS.map(([k, label]) => (
                  <option key={k} value={k}>{label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setEntries((prev) => prev.filter((_, j) => j !== i))
                  setDirty(true)
                }}
                className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 shrink-0"
                title="Remove folder"
              >
                <Trash2Icon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Native folder picker */ }
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-start font-normal"
        disabled={adding}
        onClick={async () => {
          try {
            const res = await fetch('/api/dialog/folder', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ title: 'Select folder with models' }),
            })
            const data = await res.json()
            if (!res.ok) {
              toast.error(data.error || 'Failed to open folder selection dialog.')
              return
            }
            if (data.path) void add(data.path as string)
          } catch {
            toast.error('Failed to open folder selection dialog.')
          }
        }}
      >
        <FolderOpenIcon className="w-3.5 h-3.5 mr-1.5 shrink-0" />
        {adding ? 'Adding...' : 'Browse folder on disk...'}
      </Button>

      <div className="flex gap-1.5">
        <input
          type="text"
          value={newPath}
          onChange={(e) => setNewPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void add()
            }
          }}
          placeholder="...or enter path manually: D:\AI\models"
          className="flex-1 rounded-md border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-xs font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-cyan-500"
        />
        <Button variant="outline" size="sm" onClick={() => void add()} disabled={adding || !newPath.trim()} className="h-8 px-3">
          {adding ? '...' : 'Add'}
        </Button>
      </div>

      <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving || !dirty} className="w-full">
        {saving ? 'Saving...' : 'Save Folders'}
      </Button>
    </div>
  )
}

const EXTRA_CATEGORY_OPTIONS: Array<[string, string]> = [
  ['diffusion_models', 'Video Models'],
  ['loras', 'LoRA'],
  ['vae', 'VAE'],
  ['vae_approx', 'VAE Approx (TAE)'],
  ['veda', 'Veda Sparse Attention'],
  ['text_encoders', 'Text Encoders (CLIP)'],
  ['latent_upscale_models', 'Latent Upscalers'],
  ['upscale_models', 'Pixel Upscalers'],
]

/* ─── Manual download links (all models: URLs + target paths) ─── */

function ManualDownloadPanel() {
  const [comfyDir, setComfyDir] = useState('')
  const [bonsaiDir, setBonsaiDir] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((d) => {
        setComfyDir(d.comfy_dir || '')
        setBonsaiDir(d.llm_bonsai_dir || '')
      })
      .catch(() => {
        setComfyDir('')
        setBonsaiDir('')
      })
  }, [])

  const comfyModelsRoot = comfyDir ? `${comfyDir}\\ComfyUI\\models\\` : '<ComfyUI-Easy-Install>\\ComfyUI\\models\\'
  const bonsaiModelsRoot = bonsaiDir ? `${bonsaiDir}\\` : '<Bonsai_2_27B>\\'

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(`${what} copied`)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <div className="space-y-3 py-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <LinkIcon className="w-4 h-4 text-cyan-400" />
        Manual Model Download
      </div>
      <p className="text-xs text-muted-foreground/70 -mt-1 leading-relaxed">
        If downloading from the app does not work (e.g. huggingface.co is unreachable) —
        download files manually via direct links and place them in specified paths.
        The application will discover them automatically.
      </p>

      {/* Models root paths */}
      <div className="space-y-1.5">
        <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--surface-2)] border border-border">
          <FolderOpenIcon className="w-4 h-4 text-amber-400 shrink-0" />
          <code className="flex-1 min-w-0 text-[10px] font-mono text-foreground/80 break-all">
            ComfyUI: {comfyModelsRoot}
          </code>
          <button
            type="button"
            onClick={() => void copy(comfyModelsRoot, 'Path')}
            className="p-1 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
            title="Copy path"
          >
            <CopyIcon className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 p-2 rounded-md bg-[var(--surface-2)] border border-border">
          <FolderOpenIcon className="w-4 h-4 text-violet-400 shrink-0" />
          <code className="flex-1 min-w-0 text-[10px] font-mono text-foreground/80 break-all">
            Bonsai: {bonsaiModelsRoot}
          </code>
          <button
            type="button"
            onClick={() => void copy(bonsaiModelsRoot, 'Path')}
            className="p-1 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
            title="Copy path"
          >
            <CopyIcon className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {MODEL_CATEGORIES.map(({ key, label }) => {
        const models = MODELS.filter((m) => m.category === key)
        if (!models.length) return null
        return (
          <div key={key} className="space-y-1.5 pt-2 border-t border-border">
            <div className="text-xs font-medium text-foreground/80">{label}</div>
            {models.map((m) => {
              const isBonsai = m.target === 'bonsai'
              const fullRoot = isBonsai ? bonsaiModelsRoot : comfyModelsRoot
              const fullPath = fullRoot + m.relPath
              return (
              <div
                key={m.id}
                className="p-2 rounded-md bg-[var(--surface-2)]/60 border border-border space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-foreground/90 truncate" title={m.label}>
                    {m.label}
                  </span>
                  <Badge variant="secondary" className="text-[10px] shrink-0">{m.sizeLabel}</Badge>
                </div>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 text-[10px] font-mono text-cyan-300/80 truncate" title={fullPath}>
                    {fullPath}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(fullPath, 'Path')}
                    className="p-0.5 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
                    title="Copy full path"
                  >
                    <CopyIcon className="w-3 h-3" />
                  </button>
                </div>
                <div className="flex items-center gap-1.5">
                  <a
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 min-w-0 text-[10px] text-muted-foreground hover:text-cyan-300 truncate underline decoration-dotted underline-offset-2"
                    title={m.url}
                  >
                    {m.url.replace('?download=true', '')}
                  </a>
                  <button
                    type="button"
                    onClick={() => void copy(m.url, 'URL')}
                    className="p-0.5 rounded hover:bg-[var(--surface-3)] text-muted-foreground hover:text-foreground shrink-0"
                    title="Copy link"
                  >
                    <CopyIcon className="w-3 h-3" />
                  </button>
                </div>
              </div>
              )
            })}
          </div>
        )
      })}

      <p className="text-[10px] text-muted-foreground/60 leading-relaxed pt-1">
        File name must match exactly (browser may append "(1)" — rename it).
        If huggingface.co does not open, replace domain in link with{' '}
        <code className="text-cyan-300/80">hf-mirror.com</code>. After downloading
        verify file size (see badge) — smaller size indicates interrupted download.
      </p>
    </div>
  )
}

/* ─── Theme Switcher ─── */

/** (fix 111) `first` — first block of 'Appearance' tab: no top border. */
function ThemeSwitcher({ first = false }: { first?: boolean }) {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  if (!mounted) return <div className="h-10" />

  const btnBase = 'flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border text-sm transition-all'
  const btnActive = 'border-cyan-500/50 bg-cyan-500/10 text-foreground'
  const btnIdle = 'border-border text-muted-foreground hover:border-border/80'

  return (
    <div className={cn('space-y-2', !first && 'pt-2 border-t border-border')}>
      <div className="flex items-center gap-2">
        <SunIcon className="w-4 h-4 text-amber-400" />
        <span className="text-sm font-medium">Color Theme</span>
      </div>
      {/* (fix 98) Light theme removed — dark only.
          (fix 441) + "Studio" theme (dark-calm, Calm Studio). */}
      <div className="grid grid-cols-3 gap-2">
        <button
          type="button"
          onClick={() => setTheme('dark-gray')}
          className={cn(btnBase, theme === 'dark-gray' ? btnActive : btnIdle)}
        >
          <MoonIcon className="w-4 h-4" />
          Gray
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark')}
          className={cn(btnBase, theme === 'dark' ? btnActive : btnIdle)}
        >
          <MoonIcon className="w-4 h-4" />
          Black
        </button>
        <button
          type="button"
          onClick={() => setTheme('dark-calm')}
          className={cn(btnBase, theme === 'dark-calm' ? btnActive : btnIdle)}
        >
          <SparklesIcon className="w-4 h-4" />
          Studio
        </button>
      </div>
    </div>
  )
}

/**
 * (fix 445) UI scale (user set 90% in browser and
 * requested same from settings). Stored in localStorage ('h3-ui-scale'),
 * applied instantly; picked up on app launch by inline script
 * in layout.tsx (no unscaled UI flash). Mechanism — see 451 below.
 */
const UI_SCALE_PRESETS = [80, 90, 100, 110, 125] as const
const UI_SCALE_KEY = 'h3-ui-scale'

/**
 * (fix 451) FINAL option: scale ONLY via root font-size.
 * History: CSS `zoom` (445) did not recalculate vw/vh → blank margins (fix 446
 * compensating width/height); then found user engine
 * silently ignores zoom, while width compensation applied → content shifted
 * offscreen; CSS.supports detect (450) failed — supports=true but render
 * zoom still does not occur, and zoom effectiveness cannot be measured from JS
 * (getBoundingClientRect returns unscaled layout pixels).
 * font-size on <html>: all Tailwind in rem → entire layout scales
 * with text, true reflow, no offscreen spill. Caveat:
 * hardcoded px values (text-[10px], w-[420px], etc.) do not scale.
 */
function applyUiScale(pct: number) {
  document.documentElement.style.fontSize = pct === 100 ? '' : `${pct}%`
}

function UiScaleSwitcher() {
  // (fix 579) default UI scale — 80%
  const [scale, setScale] = useState(80)
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    try {
      // (fix 579) default UI scale — 80%
      const s = parseInt(localStorage.getItem(UI_SCALE_KEY) || '80', 10)
      if (!Number.isNaN(s)) setScale(s)
    } catch { /* private mode */ }
  }, [])

  const apply = (pct: number) => {
    setScale(pct)
    try {
      localStorage.setItem(UI_SCALE_KEY, String(pct))
      applyUiScale(pct)
    } catch { /* ignore */ }
  }

  if (!mounted) return <div className="h-10" />

  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <div className="flex items-center gap-2">
        <ZoomInIcon className="w-4 h-4 text-cyan-400" />
        <span className="text-sm font-medium">Interface Scale</span>
      </div>
      <div className="grid grid-cols-5 gap-2">
        {UI_SCALE_PRESETS.map((pct) => (
          <button
            key={pct}
            type="button"
            onClick={() => apply(pct)}
            className={cn(
              'flex items-center justify-center px-2 py-2.5 rounded-lg border text-sm transition-all tabular-nums',
              scale === pct
                ? 'border-cyan-500/50 bg-cyan-500/10 text-foreground'
                : 'border-border text-muted-foreground hover:border-border/80',
            )}
          >
            {pct}%
          </button>
        ))}
      </div>
      <p className="text-[10px] text-muted-foreground/60">
        Changes base font size — entire interface scales with it. Applied immediately and remembered.
      </p>
    </div>
  )
}
