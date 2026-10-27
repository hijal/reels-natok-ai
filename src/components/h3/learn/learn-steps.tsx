'use client'

/**
 * Learn tab content: step definitions for the beginner tutorial.
 * Each step = a mockup of the relevant screen area (learn-mockups.tsx)
 * with numbered <Hl> highlights + callouts explaining "what / why / how".
 * INVARIANT: every callout number n has exactly one matching <Hl n> zone.
 *
 * (fix 114) Complete tutorial update for current app functionality:
 *   + welcome dialog (fixes 112–113),
 *   + dictation in prompt field (fixes 65/74),
 *   + hotkey R/K for dictation (fix 118),
 *   + chat attachments live only in chat (fix 108), LLM KV cache (fix 109),
 *   + manual value entry for sliders (fix 107),
 *   + two Upscale modes and gallery badges (fixes 74/77/78),
 *   + dedicated LoRA step: turbo LoRA in list, strength, triggers (fixes 44/95/96),
 *   + "Appearance" tab and 8 settings tabs (fix 111),
 *   + pass 1 steps: 2–30, default 4, manual entry 1–128 (fixes 63–77).
 *
 * (fix 163) Update for fixes 136–162:
 *   + 3 generation modes: Text / Frames / References (fix 146),
 *   + Bonsai 2 27B — default LLM (fix 162),
 *   + Assistant sees video frames on Bonsai (fix 162),
 *   + RTX VSR: HDR removed (fix 162), DLSS 1.5× works (fix 162),
 *   + Bonsai light — optional, banner does not require it (fix 162),
 *   + Aspect ratio in "Frames" mode from first frame (fix 152),
 *   + Assistant knows active mode and preserves prompt structure (fix 150).
 *
 * (code alignment) Reconciliation and simplified language:
 *   + extend: minimum 3s per clip (fix 434, was 5 — fix 309), 24 fps, auto-stitch,
 *     result saved in original folder (fix 363);
 *   + Refine: "Whole" / "Chunked" modes, Match/Max, references from metadata;
 *   + "Full" / "Draft" pipeline and red Draft badge (fixes 310/313);
 *   + audio reference trimming in player (fix 326);
 *   + LoRA: strength −10…+10; VRAM reserve 1–16 GB (fix 315);
 *   + sidebar tab is called "DLSS", 10 tabs total (added
 *     "Face Refine", fix 722).
 *
 * (fix 486) Update for current state:
 *   + NINE settings tabs: added "Format" (video codec/quality,
 *     fix 386) and "About" (fix 484); dedicated "ComfyUI" tab removed —
 *     status and "Recheck" live in "General", VRAM/GPU/RAM meters in sidebar;
 *   + Assistant "Video Vision" ON by default (compressed digest with cache);
 *   + diffusion model — FastH3 VSA DataFree 4-step INT8 (fix 293);
 *   + Refine: targets "Same as source / 720p / 1080p", steps 2–5,
 *     "Refine Influence" slider (σ 0.30–0.95, default 60%);
 *   + Tile Upscale: denoise 0.05–1 (default 0.2), steps 2–8 (default 2),
 *     SyncTile (fix 481) — in advanced parameters, on by default;
 *   + Extend: clip 3–30 s, two-pass mode (Draft/Full);
 *   + user LoRAs also work in Refine, Tile Upscale, and
 *     Extend (fix 483);
 *   + danger zone: four buttons (added "Factory Reset (All)");
 *   + added "Workflows" subtab under "Learn" (fix 485).
 *
 * (fix 497) New tab "ControlNet" (sidebar, tour section, MockSidebar):
 *   generation guided by control video (Fun ControlNet: depth/canny guide
 *   motion frame by frame, appearance guided by prompt). Nine tabs total.
 *
 * (fix 719) Update for current application state:
 *   + separated "split point" and "total steps" pass 1: default is now
 *     6 of 12 (was "4 of 8"), added "Total steps (pass 1)" slider
 *     and live "N of M" summary with σ-boundaries (fix 719);
 *   + Extend: clip steps moved to separate field (standard = 4);
 *   + clicking reference preview opens full-screen view across all
 *     tabs (fix 719);
 *   + on launch app confirms generation is actually running, avoiding
 *     stuck "in progress" state for non-existent job (fix 719);
 *   + prompt field buttons arranged in vertical column (fix 717);
 *   + built-in turbo LoRA back in LoRA list and enabled by default;
 *     in "Frames" mode with audio it is skipped, user LoRAs are not;
 *   + Refine: "Pass (steps)" — 2/3/4/5, default 3.
 */
import type { ReactNode } from 'react'
import {
  Hl,
  MockSidebar,
  MockRefDropzone,
  MockRefCard,
  MockPrompt,
  MockCtaButton,
  MockSelect,
  MockSlider,
  MockToggle,
  MockBar,
  MockLabel,
  MockQueuePill,
  MockGalleryTile,
  MockLightbox,
  MockMetaDialog,
  MockStats,
  MockWarningBanner,
  MockModelsList,
  MockSettingsGeneral,
  MockSettingsAppearance,
  MockSettingsLlm,
  MockSettingsDanger,
  MockSettingsComfyLinks,
  MockSettingsVoice,
  MockSettingsOpt,
  MockLoraList,
  MockUpscalePanel,
  MockWelcomeDialog,
} from './learn-mockups'

export interface LearnCallout {
  n: number
  title: string
  text: string
}

export interface LearnStep {
  id: string
  title: string
  /** One-line teaser shown in the "What's next" strip. */
  short: string
  mock: ReactNode
  callouts: LearnCallout[]
  tip?: string
}

/* ── helper: wrapper for mockup areas ── */
function Stage({ children }: { children: ReactNode }) {
  return <div className="w-full flex items-center justify-center gap-3 flex-wrap">{children}</div>
}

export const LEARN_STEPS: LearnStep[] = [
  /* ═══════════════ PART 1. GETTING STARTED ═══════════════ */
  {
    id: 'welcome',
    title: 'Welcome — What is this software?',
    short: 'Local studio: MiniMax H3 neural network on your PC powered by start.bat.',
    mock: (
      <Stage>
        <Hl n={1}><MockWelcomeDialog /></Hl>
        <Hl n={2}><MockSidebar /></Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-xs font-mono text-cyan-300 font-semibold">start.bat</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">One click starts everything:</p>
            <div className="space-y-1 pt-1">
              <p className="text-[10px] text-foreground/80">• ComfyUI (neural network, port 8188)</p>
              <p className="text-[10px] text-foreground/80">• web interface</p>
              <p className="text-[10px] text-foreground/80">• browser</p>
            </div>
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-xs text-foreground font-semibold">🖥 Everything on your PC</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              The neural network runs on your GPU, not in the cloud. No internet is needed for generation — only for initial model downloads.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Welcome Dialog', text: 'Appears every time you start the app — until you check "Do not show this window again". Contains a quick 3-step guide: download models → generate first video → inspect results. You can open settings or this tour directly from it. If the window was dismissed — restore it in Settings → General → "Show Welcome Dialog".' },
      { n: 2, title: 'Sidebar Tabs', text: '"Generate" — create video (3 modes: Text / Frames / References), "Extend" — continue an existing clip, "Refine" — enhance video quality, "ControlNet" — exact motion transfer from control video (3D blockouts), "Tile Upscale" and "DLSS" — two ways to increase resolution, "FPS" — smooth motion interpolation, "Face Refine" — redraw distant or small faces, "Gallery" — all generated videos, "Learn" — this tour. The Assistant (prompt chat helper, Bonsai 2 27B) lives on the right panel in "Generate" and "Extend". The sidebar can be collapsed.' },
      { n: 3, title: 'start.bat — Your Control Panel', text: 'The single launch point: starts the ComfyUI backend, interface, and opens your browser. If anything goes wrong — simply restart it.' },
      { n: 4, title: 'Local and Offline', text: 'Videos generate entirely on your graphics card. After downloading the models once, internet connection is no longer needed.' },
    ],
    tip: 'On first launch, the interface may wait while ComfyUI loads — this is normal, wait for the green indicator.',
  },
  /* (fix 132) System requirements — pagefile, common source of errors */
  {
    id: 'sys-reqs',
    title: 'System Requirements — Pagefile',
    short: 'Increase pagefile to 32 GB, otherwise "out of memory" errors will occur.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-xl border border-amber-400/40 bg-amber-500/10 p-3.5 space-y-2.5">
            <div className="flex items-center gap-2">
              <span className="w-9 h-9 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <svg className="w-4.5 h-4.5 text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
                  <path d="M12 9v4"/>
                  <path d="M12 17h.01"/>
                </svg>
              </span>
              <div>
                <p className="text-sm font-semibold text-amber-300">Pagefile</p>
                <p className="text-[10px] text-muted-foreground">Virtual Memory / Page File</p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 leading-relaxed">
              The app consumes a significant amount of RAM. If the pagefile is small, Windows will report out-of-memory errors.
            </p>
            <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-[10px] text-foreground/70 leading-relaxed space-y-1">
              <p className="font-medium text-foreground">Minimum: 32 GB (32768 MB)</p>
              <p>Recommended: 64 GB (65536 MB)</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-xl border border-border bg-[var(--surface-1)] p-3.5 space-y-2">
            <p className="text-xs font-semibold text-foreground">How to increase (Windows):</p>
            <div className="space-y-1.5 text-[10px] text-muted-foreground leading-relaxed">
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">1</span> Win + R → <code className="font-mono bg-[var(--surface-2)] px-1 rounded">sysdm.cpl</code> → Enter</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">2</span> "Advanced" tab</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">3</span> "Performance" → "Settings" → "Change..."</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">4</span> Uncheck "Automatically manage paging file size"</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">5</span> Select drive (usually C:)</p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">6</span> Set "Maximum size" = <b className="text-foreground">32768</b></p>
              <p><span className="inline-block w-4 h-4 rounded bg-cyan-500/20 text-cyan-300 text-[10px] font-bold text-center leading-4">7</span> "Set" → "OK" → <b className="text-foreground">restart PC</b></p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-red-400/30 bg-red-500/5 p-3 space-y-1.5">
            <p className="text-[10px] font-semibold text-red-400">❌ Without this:</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Errors such as "Not enough memory" / "CUDA out of memory" / app crashes during generation.
            </p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Why it matters', text: 'The application (ComfyUI + MiniMax H3 neural network) consumes 10–20+ GB of RAM during generation. The pagefile (virtual memory) is backup storage on disk when RAM runs low. If it is too small (Windows default is 1–4 GB), the application will crash or throw errors.' },
      { n: 2, title: 'How to increase', text: 'Win + R → sysdm.cpl → "Advanced" → "Performance" → "Settings" → "Change". Uncheck "Automatically manage", choose drive, set "Maximum size" to 32768 (or higher), click "Set" → "OK" → restart your PC. Takes only 30 seconds.' },
      { n: 3, title: 'Symptoms', text: 'If you encounter "Not enough memory", "CUDA out of memory", "Page file" errors or spontaneous crashes during generation, your pagefile is likely insufficient. Increase it and restart your PC.' },
    ],
    tip: 'This only needs to be configured once. After increasing the pagefile, memory exhaustion crashes are resolved permanently.',
  },
  {
    id: 'first-run',
    title: 'First Launch — Downloading Models',
    short: 'Yellow banner → Settings → Download. One-time download, ~50 GB.',
    mock: (
      <Stage>
        <Hl n={1}><MockWarningBanner /></Hl>
        <Hl n={2}><MockModelsList /></Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Model Statuses</p>
            <p className="text-[10px] text-muted-foreground">✓ — ready</p>
            <p className="text-[10px] text-muted-foreground">○ — not downloaded</p>
            <p className="text-[10px] text-cyan-300">⬇ — downloading (% and speed)</p>
            <p className="text-[10px] text-red-400">! — error (retry)</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Top Banner', text: 'Appears when required models have not yet been downloaded — generation cannot function properly without them. "Download in Settings" opens settings, ✕ temporarily hides the banner.' },
      { n: 2, title: 'Two Model Groups', text: '"Minimax H3 (generation)" — video engine: diffusion model (FastH3 VSA DataFree 4-step INT8, ~22.9 GB), text encoder (~15.7 GB), VAE, upscaler, Turbo LoRA (~1.8 GB), etc. — ~44.5 GB total required; Turbo LoRA is enabled by default in all modes (except "Frames" with audio); "Download All" grabs it with base models. "LLM Assistant" — chat model: default Qwen3.5 9B (~5.7 GB, vision), alternatives — Gemma 4 12B (Q3/Q4/Q5) or Bonsai 2 27B (ternary, ~7.2 GB, vision). Optional: FPS models (RIFE + FILM VFI). Selecting ONE LLM model is sufficient.' },
      { n: 3, title: 'Background Downloads', text: 'Click ⬇ next to a model to see percentage and speed. You can close settings at any time: downloads continue in the background, with status visible in the banner. Click ✕ to pause and resume later. Downloaded models reside in the models directory.' },
    ],
    tip: 'Already downloaded models with an earlier build? Settings → General → "Migrate models from older version": select the previous folder and the app migrates them automatically.',
  },
  {
    id: 'interface',
    title: 'Interface — Layout Overview',
    short: 'Tabs, system meters, ComfyUI indicator, and settings.',
    mock: (
      <Stage>
        <Hl n={1}><MockSidebar active="generate" /></Hl>
        <Hl n={2}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>"Generate" Tab</MockLabel>
            <div className="border-2 border-dashed border-border rounded-lg py-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">references (optional)</p>
            </div>
            <MockPrompt withMention />
            <MockSelect value="1280×704 · 720p" />
            <MockCtaButton label="Generate Video" />
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              <span className="text-[10px] text-muted-foreground">ComfyUI connected</span>
            </div>
            <MockStats />
          </div>
        </Hl>
        <Hl n={4}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">⚙ Settings — 9 tabs</p>
            <p className="text-[10px] text-muted-foreground">General · Appearance · LLM · Voice</p>
            <p className="text-[10px] text-muted-foreground">Optimization · Format · Links</p>
            <p className="text-[10px] text-muted-foreground">About · Reset</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Sidebar', text: 'Ten tabs — "Generate", "Extend", "Refine", "ControlNet", "Tile Upscale", "FPS", "Face Refine", "DLSS", "Gallery", "Learn". The Assistant lives on the right panel in "Generate" and "Extend" (draggable width, collapsible). At the bottom: ComfyUI indicator (green dot = backend running) and Settings gear.' },
      { n: 2, title: '"Generate" Workspace', text: 'The full pipeline in one place: Mode (Text / Frames / References) → prompt → references (depending on mode) → resolution & length → "Generate Video". Below is the status card and recent gallery.' },
      { n: 3, title: 'Indicator and System Meters', text: 'Red indicator means ComfyUI is offline: generation is unavailable (gallery and settings remain accessible). VRAM / GPU / RAM meters show hardware headroom.' },
      { n: 4, title: 'Settings — 9 Tabs', text: 'Full control: models & LoRAs, appearance, assistant, voice input, memory optimization, output format (codec & quality), manual download links, "About" (credits & links), and "Reset" (danger zone).' },
    ],
    tip: 'The sidebar can be collapsed to provide maximum space for prompt editing.',
  },
  /* ═══════════════ PART 2. PATH TO VIDEO ═══════════════ */
  {
    id: 'modes',
    title: 'Step 1 — Generation Mode',
    short: 'Three modes: Text · Frames · References — select based on your source assets.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <MockLabel>Generation Mode</MockLabel>
          <div className="grid grid-cols-3 gap-1.5">
            <Hl n={1}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Text</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">description only</p>
              </div>
            </Hl>
            <Hl n={2}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">Frames</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">1–2 images → video</p>
              </div>
            </Hl>
            <Hl n={3}>
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">References</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">up to 15 files</p>
              </div>
            </Hl>
          </div>
          <div className="rounded-md bg-[var(--surface-2)] px-2 py-1.5 space-y-1">
            <p className="text-[10px] text-muted-foreground"><b>Text:</b> prompt + audio references (voice/dialogue). Images and video are not used.</p>
            <p className="text-[10px] text-muted-foreground"><b>Frames:</b> first and (optional) last frame + audio. Aspect ratio matches frame. Paste screenshot via Ctrl+V.</p>
            <p className="text-[10px] text-muted-foreground"><b>References:</b> up to 15 files — 9 images, 3 videos, 3 audio. Full creative control.</p>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Text — Video from Description', text: 'The simplest mode: you provide a scene prompt, and the model synthesizes everything. You can attach audio files (WAV, MP3…) — such as voice samples for dialogue. Images and video are not used in this mode.' },
      { n: 2, title: 'Frames — Video from Images', text: 'Provide the first frame (required) and optionally the last. The prompt describes action between them. You can paste images directly with Ctrl+V. Aspect ratio is locked to match the first frame automatically to prevent distortion. Audio can also be attached.' },
      { n: 3, title: 'References — Full Control', text: 'Up to 15 reference assets: 9 images (characters, objects, style), 3 videos (motion, scenes), 3 audio tracks (voice, sound effects). Each file is assigned a role defining how it influences generation.' },
    ],
    tip: 'The Assistant adapts to the selected mode and omits unsupported tags: switching to "Text" automatically strips <Picture N> and <Video N> tags.',
  },
  {
    id: 'refs',
    title: 'Step 2 — References ("References" Mode)',
    short: 'Up to 15 files: 9 images, 3 videos, 3 audio tracks. Or zero — text-only works too.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>References</MockLabel>
            <span className="text-[10px] text-muted-foreground">1/9 img · 1/3 vid · 0/3 aud</span>
          </div>
          <Hl n={1}><MockRefDropzone /></Hl>
          <Hl n={2}><MockRefCard /></Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[var(--surface-2)] p-2">
              <div className="w-9 h-9 rounded bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] text-cyan-300 font-bold">VID</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-foreground truncate font-mono">scene_walk.mp4</p>
                <p className="text-[10px] text-muted-foreground">scene · motion</p>
              </div>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0">
                <span className="w-3 h-3 rounded-sm border border-cyan-500/50 bg-cyan-500/30 inline-flex items-center justify-center text-[10px] text-cyan-200">✓</span>
                use audio
              </span>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Optional Asset Input', text: 'In "References" mode, generation can run purely on prompt text. References provide precision: up to 15 files — 9 images, 3 videos, 3 audio. Images guide appearance, video guides motion, audio guides voice and sound. Screenshots can be pasted with Ctrl+V. In "Text" mode only audio is used; in "Frames" mode images are set via First/Last frame fields. Clicking any reference thumbnail opens full-screen preview to inspect fine details across all tabs.' },
      { n: 2, title: 'Reference Role', text: 'Each file has an assigned role: "character / object", "scene", "style", "composition". This tells the model what to extract: face, background palette, or camera angle.' },
      { n: 3, title: 'Video and Audio', text: 'For video references, enable "use audio" to take sound directly from the clip. Audio files can be tagged with intent: "Voice", "Tempo / rhythm", or "Style". Audio clips can be trimmed in-app by clicking the file and setting start/end in the player.' },
    ],
    tip: 'Close-up, well-lit portraits and clear subjects yield best results. For speech, use clean recordings without background music.',
  },
  {
    id: 'prompt',
    title: 'Step 3 — Writing the Prompt',
    short: 'Language drives everything: @ tags, dialogue in <d>…</d>, voice dictation.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          {/* Prompt field + vertical buttons column */}
          <div className="flex gap-2">
            <div className="flex-1 min-w-0">
              <Hl n={1}><MockPrompt withMention /></Hl>
            </div>
            <div className="flex flex-col items-center gap-1.5 shrink-0">
              <Hl n={3}>
                <div className="flex flex-col items-center gap-1">
                  <span className="w-5 h-5 rounded border border-border bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-muted-foreground">✎</span>
                  <span className="w-5 h-5 rounded border border-border bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-muted-foreground">🗑</span>
                  <span className="w-5 h-5 rounded border border-violet-500/30 bg-[var(--surface-3)] flex items-center justify-center text-[9px] text-violet-300">✦</span>
                </div>
              </Hl>
              <Hl n={2}>
                <span className="w-5 h-5 rounded-full bg-red-500/20 border border-red-400/40 flex items-center justify-center text-[9px]">🎙</span>
              </Hl>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground/70 leading-snug">
            <span className="text-foreground/80">✎</span> editor ·{' '}
            <span className="text-foreground/80">🗑</span> clear ·{' '}
            <span className="text-violet-300">✦</span> enhance with assistant
          </p>
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">Type <span className="font-mono text-foreground/70">@</span> to see list of references</span>
          </div>
          <div className="flex justify-end"><Hl n={4}><MockCtaButton label="Generate Video" /></Hl></div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Prompt Field & Tags', text: 'Describe the scene: subject, action, environment. The model understands ENGLISH best — feel free to draft ideas in your native language, then translate them (the "Examples" button provides pre-tested English prompts). Typing @ inserts a <Picture 1> tag to ground specific elements. Wrap spoken dialogue in <d>…</d> for synchronized speech synthesis.' },
      { n: 2, title: 'Voice Input (Dictation)', text: 'Click the microphone icon inside the prompt box to speak — click again to transcribe directly into text. Also available in the full-screen editor and Assistant chat. Global hotkey: R (press when focus is not inside a text input to start/stop). Configurable under Settings → Voice.' },
      { n: 3, title: 'Action Buttons', text: 'To the right of the prompt field: ✎ opens full-screen editor (great for complex scripts), 🗑 clears text, ✦ launches "Enhance Prompt" with the assistant. Below sits the dictation mic.' },
      { n: 4, title: 'Start Generation', text: 'Active whenever a prompt is present. Ctrl+Enter starts generation immediately from the prompt input.' },
    ],
    tip: 'Use cinematic terminology: "slow camera push-in", "warm sunset rim light", "speaks in a whisper" — descriptive cues significantly elevate fidelity.',
  },
  {
    id: 'llm-assistant',
    title: 'Assistant — Prompt Engineering Copilot',
    short: 'Local LLM (Bonsai 2 27B) sees references and drafts structured prompts.',
    mock: (
      <Stage>
        <div className="w-[310px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center">
              <span className="text-[10px] text-violet-300 font-bold">AI</span>
            </div>
            <div>
              <p className="text-[10px] font-medium text-foreground">Assistant · Bonsai 2 27B (default)</p>
              <p className="text-[10px] text-emerald-400">● local · analyzes images AND video frames</p>
            </div>
          </div>
          <Hl n={1}>
            <div className="rounded-lg border border-border bg-[var(--surface-2)] p-2 space-y-1">
              <p className="text-[10px] text-muted-foreground">You: Describe a scene: girl from reference walks through market, says hello</p>
              <p className="text-[10px] text-foreground/90 leading-relaxed">A girl with <span className="px-1 py-0.5 rounded bg-purple-500/15 text-purple-300 text-[10px]">&lt;Picture 1&gt;</span> walks through the evening market, string lights… She says: <span className="px-1 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10px] font-mono">&lt;d&gt;Hi there!&lt;/d&gt;</span> Smooth pan, warm light.</p>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-dashed border-violet-500/30 bg-violet-500/5 p-2 flex items-center gap-2">
              <div className="w-7 h-7 rounded bg-purple-500/20 border border-purple-500/30 flex items-center justify-center shrink-0">
                <span className="text-[10px] text-purple-300 font-bold">IMG</span>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] text-foreground/90 font-mono truncate">photo_girl.png</p>
                <p className="text-[10px] text-muted-foreground">visible only to Assistant — not added to generation references</p>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">✕</span>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="flex items-center gap-2">
              <div className="flex-1 rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-1.5 text-[10px] text-muted-foreground">Describe your scene concept…</div>
              <div className="w-7 h-7 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center text-violet-300 text-[10px]">➤</div>
            </div>
          </Hl>
          <div className="flex items-center justify-between gap-2">
            <Hl n={4}>
              <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-2.5 py-1.5 text-[10px] text-violet-300 font-medium text-center">✨ Enhance prompt (from editor)</div>
            </Hl>
            <Hl n={5}>
              <div className="rounded-lg border border-border bg-[var(--surface-2)] px-2 py-1.5 flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">KV Cache:</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Off</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q8</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Q5</span>
                <span className="px-1 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium">Q4</span>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Local Model', text: 'Default — Qwen3.5 9B (Q4_K_M, ~5.7 GB, vision). Alternatives: Gemma 4 12B (Q3/Q4/Q5) or Bonsai 2 27B (ternary, ~7.2 GB, vision). Runs entirely on your GPU without cloud calls. The assistant analyzes attached images and video frames, describes their visual features, and locks character identity into the prompt.' },
      { n: 2, title: 'Chat Attachments Stay in Chat', text: 'Media files attached in the Assistant chat remain strictly within the conversation: they do not transfer to generation references or the gallery. Their sole purpose is helping the LLM compose the prompt. Use paperclip or Ctrl+V to attach.' },
      { n: 3, title: 'Natural Language Ideation', text: 'Describe concepts naturally in your language. The assistant understands full MiniMax H3 syntax, injects proper tags (<Picture N>, <Video N>, <Audio N>), and outputs structured English prompts. Use "Enhance prompt" in the full-screen editor to refine existing text.' },
      { n: 4, title: 'Video Vision', text: 'The assistant parses video references: observing actions, subject movement, and environment shifts across frames. Enabled by default with cached frame digests. Can be toggled in Settings → LLM.' },
      { n: 5, title: 'Long Context Memory — KV Cache', text: 'Extended conversations consume VRAM. KV cache quantization (Settings → LLM: Q8 / Q5 / Q4) drastically cuts memory usage with negligible impact on output quality. Q4 is enabled by default.' },
    ],
    tip: 'The assistant never hallucinates reference tags: without attached files it avoids <Picture N>; with files it links only existing reference IDs.',
  },
  {
    id: 'resdur',
    title: 'Step 4 — Resolution & Duration',
    short: '480p for drafting, 1080p for master renders; up to ~30 seconds. In "Frames" mode aspect ratio is locked.',
    mock: (
      <Stage>
        <div className="w-[290px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-3">
          <div className="space-y-1.5">
            <MockLabel>Resolution</MockLabel>
            <Hl n={1}>
              <div className="space-y-1.5">
                <MockSelect value="1280×704 · 720p" />
                <div className="flex gap-1 flex-wrap">
                  {['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'].map((a) => (
                    <span key={a} className={a === '16:9' ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{a}</span>
                  ))}
                </div>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Custom Resolution</MockLabel>
            <Hl n={2}>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="px-2 py-1 rounded-md bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-medium">Custom Resolution · on</span>
                  <span className="text-[10px] font-mono text-cyan-300/90">0.70 MP (1280×704)</span>
                </div>
                <MockSlider value={40} max={100} />
                <p className="text-[10px] text-muted-foreground/70">slider: 0.2–3 MP · <span className="text-cyan-300/80">manual input: up to 16 MP</span></p>
              </div>
            </Hl>
          </div>
          <div className="space-y-1.5">
            <MockLabel>Duration</MockLabel>
            <Hl n={3}>
              <div className="space-y-1">
                <MockSlider value={45} />
                <p className="text-[10px] text-muted-foreground/60">60–719 frames · 17n+5 grid · ≈ 2.5–30s · <span className="text-cyan-300/80">manual frame input</span></p>
              </div>
            </Hl>
          </div>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Presets & Aspect Ratio', text: 'Output fidelity: 480p — fast drafts, 720p — balanced, 1080p — maximum detail. Aspect ratios: 16:9, vertical 9:16, square 1:1, 4:3, 3:4, or cinematic 21:9. In "Frames" mode aspect ratio is locked to the first frame automatically.' },
      { n: 2, title: 'Custom Resolution + Manual Input', text: 'Overrides presets: set total pixel budget in megapixels, with dimensions derived from the chosen aspect ratio. Slider covers 0.2–3 MP; numeric input allows scaling up to 16 MP (note: >3 MP increases VRAM and compute time).' },
      { n: 3, title: 'Duration', text: 'Ranges from 2.5 to 30 seconds. The model steps in 17n+5 frame increments, causing discrete slider intervals — this is standard model architecture. Manual frame counts (60–719) automatically snap to grid boundaries.' },
    ],
    tip: 'Run initial exploratory tests at 480p with short duration to iterate quickly on prompt concepts.',
  },
  {
    id: 'queue',
    title: 'Launching and Task Queue',
    short: 'Queue multiple generations sequentially — processed in background FIFO.',
    mock: (
      <div className="w-full flex flex-col items-center gap-4">
        <div className="flex items-center gap-3 flex-wrap justify-center">
          <Hl n={1}><MockCtaButton label="Generate Video" /></Hl>
          <Hl n={2}><MockCtaButton label="Queue Another" /></Hl>
        </div>
        <Hl n={3}><MockQueuePill expanded /></Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Dispatching Jobs', text: 'Click once to submit. While running, the button becomes "Queue Another" to stack subsequent prompts.' },
      { n: 2, title: 'Sequential Processing', text: 'Jobs run sequentially. You can browse the gallery or reload the web interface while the queue processes. Upon restart, the studio verifies active tasks against ComfyUI and cleans up orphans.' },
      { n: 3, title: 'Floating Queue Pill (Bottom-Right)', text: 'Displays real-time status, progress percentages, and queued count. Click to expand full list; click ✕ to cancel a job without affecting completed renders.' },
    ],
    tip: 'Cancelling a job produces a graceful "Generation cancelled" notice rather than an error banner.',
  },
  {
    id: 'progress',
    title: 'Generation Progress',
    short: 'Global progress 0→100% across both passes with live draft frame preview.',
    mock: (
      <Stage>
        <div className="space-y-2 rounded-lg border border-border bg-[var(--surface-1)] p-3 w-full max-w-[280px]">
          <Hl n={1}>
            <div className="space-y-2">
              <div className="flex items-center justify-between text-[10px]">
                <span className="text-cyan-400 font-medium">Generating… 42%</span>
                <span className="text-muted-foreground font-mono">0:47</span>
              </div>
              <MockBar pct={42} />
            </div>
          </Hl>
          <Hl n={2}>
            <div className="rounded-lg border border-cyan-500/20 bg-black/40 h-20 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-cyan-950/60 to-blue-950/40" />
              <div className="absolute top-1 left-1 px-1.5 py-0.5 bg-black/60 rounded text-[10px] text-cyan-300 font-medium">Pass 1 · step 2/3</div>
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-16 h-9 rounded bg-[var(--surface-3)]/60 border border-cyan-500/30 creative-pulse" />
              </div>
            </div>
          </Hl>
          <Hl n={3}>
            <p className="text-[10px] text-red-400/70 text-center py-0.5">Stop</p>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Status Card (Sidebar Bottom)', text: 'Tracks state ("Queued" → "Generating… 42%" → "Done ✓"), timer, and progress bar.' },
      { n: 2, title: 'Live Preview & Unified Progress', text: 'Displays low-resolution latent decodes during generation across both passes. The progress bar spans 0→100% across the entire pipeline without resetting between passes.' },
      { n: 3, title: 'Stop', text: 'Cancels active generation tasks cleanly.' },
    ],
    tip: 'A ~5-second clip at 480p typically renders in 1–3 minutes; 1080p requires additional time.',
  },
  {
    id: 'gallery',
    title: 'Video Gallery',
    short: 'All clips with hover playback, source tags (Draft, DLSS 5, Refined…).',
    mock: (
      <div className="w-full max-w-[330px]">
        <div className="flex items-center justify-between mb-1.5">
          <span className="px-2 py-0.5 rounded-md bg-[var(--surface-2)] border border-border text-[10px] text-foreground">5 videos</span>
          <span className="text-[10px] text-muted-foreground">↻</span>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          <Hl n={1}><MockGalleryTile index={5} /></Hl>
          <Hl n={2}><MockGalleryTile hovered index={4} /></Hl>
          <Hl n={3}><MockGalleryTile index={3} /></Hl>
          <Hl n={4}><MockGalleryTile upscaled index={2} /></Hl>
          <MockGalleryTile index={1} />
          <MockGalleryTile index={0} />
        </div>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Posters and Sorting', text: 'Clips appear newest first. Hovering plays preview playback in the grid.' },
      { n: 2, title: 'Hover Action Menu', text: 'Click "⋮" in the top-right corner to open actions: download, metadata, reuse prompt, upscale (DLSS 5), Refine, Tile Upscale, Face Refine, ControlNet, FPS, extend, trim, or delete. Click thumbnail to open full player. Ctrl+click two cards to compare before/after.' },
      { n: 3, title: 'Render Time Badge', text: 'Shows generation duration (e.g. "1 min 12 sec") pulled from metadata.' },
      { n: 4, title: 'Source Badges', text: 'Top-left badge identifies origin: "Upscale" (cyan) / "DLSS 5" (pink), "Refined" (green), "Tile" (magenta), "FPS" (purple), "Extended" (blue), "ControlNet" (orange), "Face Refine" (lime), "Edited" (yellow), "Draft" (red). Always shows latest processing step.' },
    ],
    tip: 'The ↻ icon manually refreshes the gallery.',
  },
  /* (fix 91/122) Project folders — gallery organization */
  {
    id: 'folders',
    title: 'Project Folders — Gallery Organization',
    short: 'Organize clips into folders: create, drag & drop, rename.',
    mock: (
      <Stage>
        <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <MockLabel>Gallery · folders</MockLabel>
            <span className="text-[10px] text-muted-foreground">+ New Folder</span>
          </div>
          <Hl n={1}>
            <div className="flex gap-1 flex-wrap">
              {['All Videos', 'Ads', 'Vacation', 'Tests'].map((f, i) => (
                <span
                  key={f}
                  className={
                    i === 0
                      ? 'px-2 py-1 rounded-md text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium'
                      : 'px-2 py-1 rounded-md text-[10px] border border-border text-muted-foreground'
                  }
                >
                  {f}
                </span>
              ))}
            </div>
          </Hl>
          <Hl n={2}>
            <div className="grid grid-cols-3 gap-1.5">
              <MockGalleryTile index={5} />
              <MockGalleryTile index={4} />
              <div className="rounded-md border border-dashed border-cyan-500/40 bg-cyan-500/5 aspect-video flex items-center justify-center">
                <span className="text-[10px] text-cyan-300">↔ drag video here</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">"Generate" Tab</p>
            <div className="rounded-md border border-border bg-[var(--surface-2)] px-2 py-1.5 text-[10px] text-foreground/80">
              📁 Project Folder: <span className="text-cyan-300">Vacation</span> ▾
            </div>
            <p className="text-[10px] text-muted-foreground leading-relaxed">New videos will be saved to the selected folder</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Folders in Gallery', text: 'Create subfolders in the output directory to group work. Click a folder to filter the grid; "All Videos" displays everything.' },
      { n: 2, title: 'Drag & Drop and Renaming', text: 'Drag clips directly into folders. Renaming preserves files and metadata without moving data.' },
      { n: 3, title: 'Folder Selection in "Generate"', text: 'Pick a default output folder next to the generate button: all new clips from the session route there automatically.' },
    ],
    tip: 'Metadata and render time stats move seamlessly along with the files.',
  },
  {
    id: 'player',
    title: 'Video Player',
    short: 'Click video to toggle pause, click backdrop to close.',
    mock: (
      <div className="w-full max-w-[320px] space-y-2">
        <Hl n={1}><MockLightbox /></Hl>
        <Hl n={2}>
          <div className="flex items-center justify-center gap-3 text-[10px] text-muted-foreground border border-border rounded-lg py-1.5 bg-[var(--surface-2)]/60">
            <span>Space — pause</span><span>M — mute</span><span>←→ — seek</span><span>Esc — exit</span>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="flex items-center justify-center gap-3 text-[10px]">
            <span className="p-1.5 rounded-lg bg-white/10 text-white">⬇ Download</span>
            <span className="p-1.5 rounded-lg bg-red-500/40 text-white">🗑 Delete</span>
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Full-Screen Player', text: 'Click any thumbnail to open. Click the video itself to toggle pause; click the dark overlay to exit. Bottom bar handles scrubbing.' },
      { n: 2, title: 'Keyboard Shortcuts', text: 'Space — play/pause, M — mute/unmute, ← → — next/previous clip, Esc — close player.' },
      { n: 3, title: 'Download and Delete', text: '⬇ saves to local storage. Trash icon removes the file from disk after confirmation.' },
    ],
    tip: 'Audio is rendered simultaneously: dialogue from <d>…</d> tags and audio reference styles are embedded.',
  },
  {
    id: 'upscale',
    title: 'Upscale — Enhance Video Clarity',
    short: 'Two modes: Neural Rendering (DLSS 5) and RTX VSR 1×–4×.',
    mock: (
      <Stage>
        <Hl n={1}><MockUpscalePanel /></Hl>
        <Hl n={2}>
          <div className="w-[220px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <p className="text-[10px] font-semibold text-foreground">Result in main gallery</p>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-sky-300 border border-sky-400/40">✦ Upscale</span>
                <p className="text-[10px] text-muted-foreground">RTX VSR</p>
              </div>
              <div className="rounded-md border border-border bg-[var(--surface-2)]/70 p-1.5 space-y-1">
                <span className="inline-flex items-center gap-0.5 rounded bg-black/60 px-1 py-0.5 text-[10px] font-semibold text-fuchsia-300 border border-fuchsia-400/40">✦ DLSS 5</span>
                <p className="text-[10px] text-muted-foreground">Neural Rendering</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[180px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1">
            <p className="text-[10px] font-semibold text-foreground">Requirements</p>
            <p className="text-[10px] text-muted-foreground">• NVIDIA RTX graphics card</p>
            <p className="text-[10px] text-muted-foreground">• video only (MP4 / MOV / MKV…)</p>
            <p className="text-[10px] text-muted-foreground">• processed locally on your GPU</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Two Processing Modes', text: 'Neural Rendering (DLSS 5) uses generative neural synthesis with controls for noise, tone, structure, and presets. RTX Video Super Resolution (1×–4×) provides fast, lightweight driver-level upscaling.' },
      { n: 2, title: 'Output Location', text: 'Upscaled clips are saved to the source project folder and receive "Upscale" or "DLSS 5" badges.' },
      { n: 3, title: 'System Requirements', text: 'Requires NVIDIA RTX GPU. Supports video containers (MP4, MOV, MKV, etc.). Computed locally.' },
    ],
    tip: 'When uncertain, start with RTX VSR 2× for rapid, artifact-free resolution enhancement.',
  },
  /* ═══════════════ EXTENDED TABS ═══════════════ */
  {
    id: 'extend',
    title: 'Extend — Continue Video',
    short: 'Seamlessly extend an existing video by N seconds.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Source Video</MockLabel>
            <div className="border-2 border-dashed border-cyan-500/40 rounded-lg py-3 text-center">
              <p className="text-[10px] text-cyan-300 font-medium">Drag video or click to select</p>
              <p className="text-[10px] text-muted-foreground mt-1">MP4 / MOV / MKV</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Extension Duration</MockLabel>
              <MockSlider value={45} />
              <p className="text-[10px] text-muted-foreground/60">3 to 30 seconds per new segment</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Extension Prompt</MockLabel>
              <div className="rounded-lg border border-border bg-[var(--surface-2)] px-2.5 py-2 text-[10px] text-muted-foreground">Describe what should happen next…</div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">How it works</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">The final frame becomes the first frame of the new segment. Prompt guides narrative progression.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Video Input', text: 'Drop a video or select from disk. Video clips from the gallery can be dragged in directly. Input is automatically resampled to 24 fps.' },
      { n: 2, title: 'Parameters', text: 'Configure duration (3–30s) and prompt for each continuation chunk. "Full" quality runs two passes; "Draft" runs a single pass. Sampler steps default to auto (inherited from source metadata).' },
      { n: 3, title: 'Seamless Stitching', text: 'The system stitches original and extended clips into a single continuous file in the original folder.' },
    ],
    tip: 'Write narrative continuations: "The camera follows her as she turns the corner and sees the ocean".',
  },
  {
    id: 'refine',
    title: 'Refine — Elevate Video Quality',
    short: 'Second-pass neural synthesis using source references at higher resolution.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Target Resolution</MockLabel>
            <MockSelect value="Same as source (detail enhancement only)" />
            <div className="flex gap-1 flex-wrap">
              {['Source', '720p', '1080p'].map((r, i) => (
                <span key={r} className={i === 0 ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{r}</span>
              ))}
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Pass (steps)</MockLabel>
              <MockSelect value="3 steps — fast (standard)" />
              <p className="text-[10px] text-muted-foreground/70">2 steps — fastest · <span className="text-cyan-300/80">default 3</span> · 4–7 — more detail</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Refine Influence</MockLabel>
              <MockSlider value={60} />
              <p className="text-[10px] text-muted-foreground/70">30–95% · higher means stronger resynthesis</p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">What Refine does</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Re-runs the video through the neural network at higher resolution using original metadata. Generates rich micro-details rather than basic scaling.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Resolution & Processing Mode', text: 'Four targets: "Same as source" (detail sharpening without scaling), "720p", "1080p", and "Custom" (up to 4K). Modes: "Whole" processes single-piece; "Chunked" processes in 3/5/8s slices with seamless stitching to save VRAM.' },
      { n: 2, title: 'Steps & Strength', text: 'Pass steps: 2 (fastest), 3 (default baseline), 4–7 (higher detail). "Refine Influence" (30–95%, default 60%) governs resynthesis strength. Uses original prompt and reference metadata automatically.' },
      { n: 3, title: 'Refine vs DLSS', text: 'Refine is generative diffusion re-synthesis (reconstructing textures, skin, cloth) rather than spatial interpolation. Perfect for polishing draft renders.' },
    ],
    tip: 'For a 720p source, set target to 1080p. If the result diverges too far from the original, lower Refine Influence to 40–50%.',
  },
  {
    id: 'tile-upscale',
    title: 'Tile Upscale — Chunked Upscaling',
    short: 'Tile-based upscale: saves VRAM, scales 720p–2160p cleanly.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Resolution</MockLabel>
            <div className="flex gap-1 flex-wrap">
              {['720p', '1080p', '1440p', '2160p'].map((r, i) => (
                <span key={r} className={i === 1 ? 'px-1.5 py-0.5 rounded text-[10px] border border-cyan-500/50 bg-cyan-500/15 text-cyan-300 font-medium' : 'px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground'}>{r}</span>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-1">Safety: cannot select lower resolution than source</p>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Denoise</MockLabel>
              <MockSlider value={20} />
              <p className="text-[10px] text-muted-foreground/70">0.05–1.0 · default 0.2 (conservative)</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Steps</MockLabel>
              <MockSelect value="2 steps (default) · up to 8" />
            </div>
            <div className="space-y-1.5">
              <MockLabel>▼ Advanced Parameters</MockLabel>
              <MockSelect value="SyncTile (seamless blending): On" />
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">How it works</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Video is subdivided into spatial tiles upscaled independently. Saves VRAM — allows 4K rendering even on 12 GB GPUs.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Resolution', text: 'Select 720p, 1080p, 1440p, or 2160p. Lower resolutions than source are disabled.' },
      { n: 2, title: 'Parameters', text: 'Denoise (0.05–1.0, default 0.2) controls generative strength. Steps: 2 to 8 (2 is optimal). SyncTile blends tile seams seamlessly without flicker and is enabled by default.' },
      { n: 3, title: 'Tiling Benefits', text: 'Tiling allows massive resolution scaling without out-of-memory errors on consumer GPUs.' },
    ],
    tip: 'For 720p footage, target 1080p or 1440p. Use 2160p only with 12+ GB VRAM.',
  },
  {
    id: 'controlnet',
    title: 'ControlNet — Precise Motion Transfer',
    short: 'Generate guided by control video: 3D animatics drive motion and camera frame by frame.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Control Video (Animatic)</MockLabel>
            <div className="rounded-md border border-dashed border-orange-500/40 bg-orange-500/5 px-2 py-2 text-center">
              <p className="text-[10px] text-orange-300">Drag video from gallery or select from disk</p>
            </div>
            <MockLabel>Control Type</MockLabel>
            <div className="flex gap-1">
              <span className="px-1.5 py-0.5 rounded text-[10px] border border-orange-500/50 bg-orange-500/15 text-orange-300 font-medium">Depth</span>
              <span className="px-1.5 py-0.5 rounded text-[10px] border border-border text-muted-foreground">Canny</span>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Control Strength</MockLabel>
              <MockSlider value={50} />
              <p className="text-[10px] text-muted-foreground/70">0–2 · default 1.0</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Prompt</MockLabel>
              <p className="text-[10px] text-muted-foreground/70">Description of NEW scene: characters, style, lighting, sound</p>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">How it works</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Extracts depth maps or edge contours frame by frame, generating a new video matching exact motion and camera choreography.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Control Video Input', text: 'Input source: 3D previz (Blender animatic), draft animation, or any clip whose camera and subject motion you wish to mimic. Visual appearance is ignored — only kinetics transfer. Depth Anything V2 Small preprocessor is used.' },
      { n: 2, title: 'Control Types', text: '"Depth" transfers volume and camera movement. "Canny" tracks edges. Control Strength (default 1.0) dictates compliance.' },
      { n: 3, title: 'Use Cases', text: 'Choose ControlNet when motion must match frame-accurately. For loose visual inspiration, standard "References" mode suffices.' },
    ],
    tip: 'Output length conforms to control video duration. Write prompts describing the new scene rather than camera motions.',
  },
  {
    id: 'face-refine',
    title: 'Face Refine — Redraw Distant Faces',
    short: 'Detect, crop, high-res diffusion redraw, blend back.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Target Face</MockLabel>
            <div className="rounded-md border border-dashed border-border px-2 py-2 text-center">
              <p className="text-[10px] text-muted-foreground">◎ Click on face in frame</p>
            </div>
            <MockSelect value="Largest Face" />
            <MockLabel>Person Reference Photo</MockLabel>
            <div className="rounded-md border border-dashed border-yellow-500/40 bg-yellow-500/5 px-2 py-2 text-center">
              <p className="text-[10px] text-yellow-300">Upload person photo</p>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Denoise</MockLabel>
              <MockSlider value={35} />
              <p className="text-[10px] text-muted-foreground/70">0.05–0.6 · default 0.35</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Canvas</MockLabel>
              <MockSelect value="512" />
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-yellow-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">How it works</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Faces are detected, cropped at high resolution, regenerated via diffusion, and composited back into the original frame.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Face Selection', text: 'Three tracking methods: direct click on face in frame (highest precision), heuristic rules ("Largest face", "Closest to center"), or reference face comparison via InsightFace.' },
      { n: 2, title: 'Denoise and Canvas', text: 'Denoise controls modification degree (0.25–0.40 recommended). Canvas sets generation resolution: 512 is VRAM-friendly for 12 GB GPUs; 768 is master quality.' },
      { n: 3, title: 'When to Use', text: 'Essential when subjects in wide shots suffer from soft or distorted facial features. Uses original prompt and identity references.' },
    ],
    tip: 'Live frame preview shows progress. Output appears in the gallery with the "Face Refine" tag.',
  },
  {
    id: 'fps',
    title: 'FPS — Frame Rate Interpolation',
    short: 'RIFE VFI and FILM VFI: smooth motion synthesis.',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Mode</MockLabel>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="rounded-md border border-cyan-500/50 bg-cyan-500/15 px-2 py-1.5 text-center">
                <p className="text-[10px] font-semibold text-cyan-300">RIFE VFI</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">faster</p>
              </div>
              <div className="rounded-md border border-border px-2 py-1.5 text-center">
                <p className="text-[10px] text-muted-foreground">FILM VFI</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">higher quality</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[280px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="space-y-1.5">
              <MockLabel>Multiplier</MockLabel>
              <MockSelect value="×2 (48 fps from 24)" />
              <p className="text-[10px] text-muted-foreground/70">×2, ×3, ×4 — frame rate multiplier</p>
            </div>
            <div className="space-y-1.5">
              <MockLabel>Source Video</MockLabel>
              <div className="border-2 border-dashed border-cyan-500/40 rounded-lg py-2 text-center">
                <p className="text-[10px] text-cyan-300">Drag or click to select</p>
              </div>
            </div>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-violet-500/25 bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">What is VFI</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">Video Frame Interpolation synthesizes intermediate frames between existing ones: 24 fps → 48 fps (×2) for fluid motion.</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Two Modes', text: 'RIFE VFI is fast and resource-efficient. FILM VFI provides premium optical flow handling. Both run locally.' },
      { n: 2, title: 'Multiplier', text: '×2 doubles frame rate (24→48), ×3 triples (24→72), ×4 quadruples (24→96).' },
      { n: 3, title: 'Output', text: 'Interpolated video saves to the main gallery without modifying the source file.' },
    ],
    tip: 'Begin with ×2 for ideal speed and smoothness.',
  },
  {
    id: 'meta',
    title: 'Metadata — Video Recipe',
    short: 'Prompt + seed = exact reproducibility of successful renders.',
    mock: (
      <Stage>
        <div className="flex items-center gap-4 flex-wrap justify-center">
          <Hl n={1}><MockMetaDialog /></Hl>
          <Hl n={2}>
            <div className="w-[120px] aspect-video rounded-lg border border-border bg-[var(--surface-2)] relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-violet-900/30 to-cyan-900/20" />
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="p-1.5 rounded-lg bg-white/20 text-[10px] text-white">ⓘ</span>
              </div>
            </div>
          </Hl>
        </div>
        <Hl n={3}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-1.5 text-[10px] text-muted-foreground">
            📋 Copy prompt and seed → recreate generation
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'What is Stored', text: 'Prompt, seed, resolution, pass step counts, references and roles, generation time, and date — the exact synthesis recipe.' },
      { n: 2, title: 'How to View', text: 'Click ⓘ on any gallery card to open metadata.' },
      { n: 3, title: 'Reproducing Results', text: 'Copy the prompt and seed to re-render nearly identical results or make subtle variations.' },
    ],
    tip: 'Metadata is stored alongside videos in <filename>.meta.json files.',
  },
  /* (fixes 728–730) Side-by-side comparison */
  {
    id: 'compare',
    title: 'Side-by-Side Comparison — Before / After Splitter',
    short: 'Ctrl+click two gallery cards → "Compare" (or Enter).',
    mock: (
      <Stage>
        <Hl n={1}>
          <div className="w-[240px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <MockLabel>Gallery · selection</MockLabel>
            <div className="grid grid-cols-2 gap-1.5">
              <div className="relative rounded-md overflow-hidden border-2 border-cyan-500/70">
                <div className="aspect-video bg-gradient-to-br from-cyan-900/50 to-blue-950/40" />
                <span className="absolute top-1 left-1 px-1.5 py-0.5 rounded bg-cyan-500 text-black text-[9px] font-bold">A</span>
                <span className="absolute bottom-1 left-1 text-[9px] text-cyan-300 font-mono">before · left</span>
              </div>
              <div className="relative rounded-md overflow-hidden border-2 border-fuchsia-500/70">
                <div className="aspect-video bg-gradient-to-br from-fuchsia-900/50 to-purple-950/40" />
                <span className="absolute top-1 right-1 px-1.5 py-0.5 rounded bg-fuchsia-500 text-black text-[9px] font-bold">B</span>
                <span className="absolute bottom-1 left-1 text-[9px] text-fuchsia-300 font-mono">after · right</span>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground/70">third Ctrl+click replaces the oldest selection</p>
          </div>
        </Hl>
        <Hl n={2}>
          <div className="w-[240px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2">
            <div className="relative h-24 rounded-lg overflow-hidden bg-black/60">
              <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-950/40 to-black" />
              <div className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-br from-cyan-950/50 to-black border-r-2 border-white/80" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-white text-black flex items-center justify-center text-[10px] font-bold">⇔</div>
              <span className="absolute top-1 left-1 px-1 py-0.5 rounded bg-black/60 text-[9px] text-cyan-300 font-bold border border-cyan-400/40">A</span>
              <span className="absolute top-1 right-1 px-1 py-0.5 rounded bg-black/60 text-[9px] text-fuchsia-300 font-bold border border-fuchsia-400/40">B</span>
            </div>
            <p className="text-[10px] text-muted-foreground/70">drag split slider with mouse or touch</p>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1">
            <p className="text-[10px] font-semibold text-foreground">Hotkeys</p>
            <p className="text-[10px] text-muted-foreground">Enter — open comparison</p>
            <p className="text-[10px] text-muted-foreground">Space — pause / play</p>
            <p className="text-[10px] text-muted-foreground">← → — step frames (Frame mode)</p>
            <p className="text-[10px] text-muted-foreground">Esc — close · clear selection</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Selecting Pairs', text: 'Ctrl+click (⌘ on Mac) two cards: first becomes A (left), second B (right). Press Enter or click Compare.' },
      { n: 2, title: 'Splitter & Modes', text: '"Video" mode syncs synchronized playback. "Frame" mode enables frame-by-frame scrutiny (24 fps) with a timeline scrub bar.' },
      { n: 3, title: 'Controls', text: 'Drag the split divider. Space toggles play/pause, Esc exits. Speaker icon toggles audio from clip A.' },
    ],
    tip: 'The split viewer is the most reliable way to inspect upscaler sharpness on fine textures (eyes, cloth, hair).',
  },
  /* ═══════════════ PART 3. IN DEPTH ═══════════════ */
  {
    id: 'advanced',
    title: 'Pipeline & Advanced Parameters',
    short: '"Full" (two-pass) or "Draft" (single-pass), steps, seed. Optional tuning.',
    mock: (
      <Stage>
        <div className="w-[300px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-2.5">
          <p className="text-[10px] text-muted-foreground">▼ Advanced Parameters</p>
          <Hl n={1}>
            <div className="space-y-2">
              <div className="space-y-1">
                <MockLabel>Pass 1 (draft): resolution, MP</MockLabel>
                <MockSlider value={20} max={200} />
                <p className="text-[10px] text-muted-foreground/70">from 0.2 MP · <span className="text-cyan-300/80">no larger than final resolution (min 1.0 MP ceiling)</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 1: steps (split point)</MockLabel>
                <MockSlider value={13} max={100} />
                <p className="text-[10px] text-muted-foreground/70">sigmas allocated to draft · slider 2–30 · <span className="text-cyan-300/80">default 6</span></p>
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 1: total steps</MockLabel>
                <MockSlider value={30} max={100} />
                <p className="text-[10px] text-muted-foreground/70">total schedule length · <span className="text-cyan-300/80">default matches split (6 of 6)</span></p>
              </div>
              <p className="text-[10px] font-mono text-cyan-300/80">Pass 1: 6 of 6 · σ 1.0 → 0.167</p>
              <div className="space-y-1">
                <MockLabel>Sampler / scheduler · references</MockLabel>
                <MockSelect value="euler · simple · Match (fast)" />
              </div>
              <div className="space-y-1">
                <MockLabel>Pass 2 (enhancement): steps</MockLabel>
                <MockSelect value="3 steps (faster) · 4–7 — quality" />
              </div>
            </div>
          </Hl>
          <Hl n={2}>
            <div className="space-y-1.5">
              <MockToggle on label="Low VRAM Attention" />
              <p className="text-[10px] text-muted-foreground/70 -mt-0.5">and Chunk FeedForward — in Settings → Optimization</p>
            </div>
          </Hl>
          <Hl n={3}>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <MockLabel>Seed</MockLabel>
                <span className="text-[10px] font-mono text-muted-foreground">-1 (random)</span>
              </div>
              <p className="text-[10px] text-muted-foreground/70">custom LoRAs — in Settings → General → LoRAs</p>
            </div>
          </Hl>
        </div>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Full vs Draft', text: '"Full" mode uses two passes: low-res draft followed by high-res refinement. "Draft" runs single-pass draft rendering (tagged red "Draft" in gallery). Pass 1 steps configured via split point and total steps with live sigma summary.' },
      { n: 2, title: 'Memory Optimizations', text: 'Low VRAM Attention and Chunk FeedForward reduce VRAM consumption (configured in Settings → Optimization).' },
      { n: 3, title: 'Seed', text: 'Randomness seed: -1 generates a new variation every run; fixed values reproduce scenes.' },
    ],
    tip: 'Beginners can leave these at defaults — factory values are calibrated for optimal results.',
  },
  {
    id: 'lora',
    title: 'LoRA Models — Style and Speed',
    short: 'Custom LoRAs: toggle on/off, strength −10 to +10, trigger words.',
    mock: (
      <Stage>
        <Hl n={1}><MockLoraList /></Hl>
        <Hl n={2}>
          <div className="w-[200px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Why LoRAs</p>
            <p className="text-[10px] text-muted-foreground leading-relaxed">LoRA is an adapter layer over the base model: injecting characters, art styles, or objects.</p>
            <p className="text-[10px] text-foreground/80">Strength from −10 to +10 · trigger words inserted automatically</p>
          </div>
        </Hl>
        <Hl n={3}>
          <div className="w-[190px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Where they live</p>
            <p className="text-[10px] text-muted-foreground">Settings → General → LoRAs</p>
            <p className="text-[10px] text-muted-foreground">Files copied to app LoRA folder</p>
            <p className="text-[10px] text-muted-foreground">Copy progress visible in list</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'LoRA List', text: 'Lists all .safetensors models in the LoRA directory. Includes built-in turbo LoRA (4-step, enabled by default). Custom LoRAs include trigger words appended to prompts automatically.' },
      { n: 2, title: 'LoRA Capabilities', text: 'Adjust strength with slider (typically ~1.0). Enabled LoRAs carry over across Refine, Tile Upscale, and Extend.' },
      { n: 3, title: 'Adding Custom LoRAs', text: 'Click "Add" in Settings → General → LoRAs to copy files into the studio library.' },
    ],
    tip: 'If an art style LoRA produces artifacts, check model compatibility or try an alternative base model.',
  },
  /* ═══════════════ PART 4. SETTINGS ═══════════════ */
  {
    id: 'settings-general',
    title: 'Settings → General & Appearance',
    short: 'Models, migration, base model + theme and completion sound.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsGeneral /></Hl>
        <Hl n={2}><MockSettingsAppearance /></Hl>
        <Hl n={3}>
          <div className="w-[210px] rounded-lg border border-border bg-[var(--surface-1)] p-2.5 space-y-1.5">
            <p className="text-[10px] font-semibold text-foreground">Settings Tab List</p>
            <p className="text-[10px] text-muted-foreground">General · Appearance · LLM · Voice</p>
            <p className="text-[10px] text-muted-foreground">Optimization · Format · Links</p>
            <p className="text-[10px] text-muted-foreground">About · Reset</p>
          </div>
        </Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Models & Migration', text: '"Migrate models from older version" scans and moves assets automatically. Manages base diffusion models, custom model paths, and GGUF quantization.' },
      { n: 2, title: 'Appearance', text: 'Choose color theme (Gray by default, or Dark) and toggle audio chime upon completion.' },
      { n: 3, title: 'Nine Settings Tabs', text: 'Covers General, Appearance, LLM, Voice, Optimization, Format, Links, About, and Reset.' },
    ],
    tip: 'Switch base model under General if a specific LoRA requires alternative architecture.',
  },
  {
    id: 'settings-llm-voice',
    title: 'Settings → LLM & Voice',
    short: 'Assistant model, context window, KV cache + voice dictation.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsLlm /></Hl>
        <Hl n={2}><MockSettingsVoice /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Assistant & Memory', text: 'Select chat model: default Qwen3.5 9B (~5.7 GB, vision) or alternatives Gemma 4 12B / Bonsai 2 27B. Device: Auto / GPU / CPU. Context: 8K–100K tokens. Video Vision on by default. KV cache quantization (Q4 by default) conserves memory during long sessions.' },
      { n: 2, title: 'Voice Input', text: 'Whisper speech recognition runs on CPU without consuming VRAM. Microphone icon appears in prompt bar, full editor, and assistant chat. Global hotkey: R/K.' },
    ],
    tip: 'On 8–12 GB GPUs, select Qwen3.5 9B or Gemma Q3 and increase VRAM reserve under Optimization.',
  },
  {
    id: 'settings-opt-comfy',
    title: 'Settings → Optimization, Format, Links, Reset',
    short: 'VRAM, video encoding format, manual links, and danger zone.',
    mock: (
      <Stage>
        <Hl n={1}><MockSettingsOpt /></Hl>
        <Hl n={2}><MockSettingsComfyLinks /></Hl>
        <Hl n={3}><MockSettingsDanger /></Hl>
      </Stage>
    ),
    callouts: [
      { n: 1, title: 'Memory Optimization', text: 'VRAM Reserve (1–16 GB, default 3) and Dynamic VRAM manage backend memory headroom. Low VRAM Attention and Chunk FeedForward apply instantly to new runs.' },
      { n: 2, title: 'Format & Links', text: 'Configure video codec (H.264 / H.265 via NVENC) and quality. Links tab provides direct URLs and mirrors.' },
      { n: 3, title: 'Reset (Danger Zone)', text: 'Reset Settings (defaults), Clear Cache (ComfyUI input temp files), Delete Content (outputs and chats), or Factory Reset (All).' },
    ],
    tip: 'Factory 25K token context provides ample room for full prompt instructions.',
  },
  /* ═══════════════ FINALE ═══════════════ */
  {
    id: 'checklist',
    title: 'First Generation Checklist',
    short: 'Eleven steps from zero to completed video.',
    mock: (
      <div className="w-full max-w-[400px] space-y-3">
        <Hl n={1}>
          <div className="rounded-xl border border-cyan-500/20 bg-[var(--surface-2)]/60 p-4 space-y-2.5 w-full">
            {[
              'Download models (Welcome window → Settings → Download; runs in background)',
              'Choose mode: Text / Frames / References',
              'Load references (if in "References" mode) — or proceed without them',
              'Describe scene in prompt — text, voice (🎙), or via Assistant (Bonsai 2 27B)',
              'Link references using @, dialogue inside <d>…</d>',
              'Set 480p and short duration',
              'Click "Generate Video" and monitor preview',
              'Done: view in gallery, recipe under ⓘ',
              'Enhance: Refine / Tile Upscale / DLSS (RTX VSR or Neural Rendering)',
              'Extend: "Extend" tab or button on video card',
              'Smoothness: "FPS" tab — RIFE VFI / FILM VFI (×2–×4)',
            ].map((t, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <span className="w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/40 text-cyan-300 text-[10px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                <span className="text-xs text-foreground/90">{t}</span>
              </div>
            ))}
          </div>
        </Hl>
        <Hl n={2}>
          <div className="flex items-center gap-2 justify-center rounded-lg border border-border bg-[var(--surface-2)]/60 px-4 py-2 text-[10px] text-muted-foreground">
            ▶ If something goes wrong — restart start.bat
          </div>
        </Hl>
      </div>
    ),
    callouts: [
      { n: 1, title: 'Congratulations — Tour Completed!', text: 'Run your first generation using the checklist, and explore metadata to see how parameters shape output. Check the "Workflows" subtab for recipe guides. Compare before/after with Ctrl+click.' },
      { n: 2, title: 'Troubleshooting Common Issues', text: 'Red indicator or generation failure → restart start.bat. Temporary backend latency resolves automatically — do not interrupt. Out of memory → increase pagefile (Step 2) and enable Low VRAM Attention in Settings.' },
    ],
  },
]
