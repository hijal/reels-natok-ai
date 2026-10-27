'use client'

/**
 * PromptGuide — sub-tab of the Learn section.
 * Based on the official MiniMax H3 prompt guide (v2).
 *
 * Sections:
 *   1. Technical specs & limits
 *   2. Mode selection (T2VA/I2VA/FL2VA/L2VA/Ref2VA)
 *   2b. What the studio assistant outputs (format by tab)
 *   3. Prompt formula (3 blocks)
 *   4. Final structure (alignment + 3 fields)
 *   5. Writing the 3 core fields
 *   6. Camera movement (types, amplitude, speed)
 *   7. Speaking characters & dialogue
 *   8. On-screen text
 *   9. Soundscape & music
 *   10. Full examples (4 modes)
 *   11. Common mistakes (table)
 *   12. Ref2VA deep dive (6 sections, labels, rules)
 *   13. Checklist
 *   14. Built-in LLM assistant (Bonsai 2 27B default / Gemma 4 12B / Qwen3.5 9B)
 *   15. History / favorites / examples
 *   16. Hover previews
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import {
  BookOpenIcon,
  CopyIcon,
  CheckIcon,
  SparklesIcon,
  BotIcon,
  HistoryIcon,
  MousePointerClickIcon,
  CameraIcon,
  AlertTriangleIcon,
  ListOrderedIcon,
  TagIcon,
  MonitorPlayIcon,
  MessageSquareQuoteIcon,
  TypeIcon,
  MusicIcon,
  ClipboardCheckIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

/* ──────────────────── copy helper ──────────────────── */

async function copyText(text: string, okMsg: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(okMsg)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
    toast.success(okMsg)
  }
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-7 gap-1.5 text-xs"
      onClick={async () => {
        await copyText(text, 'Copied to clipboard')
        setDone(true)
        setTimeout(() => setDone(false), 2000)
      }}
    >
      {done ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
      {label}
    </Button>
  )
}

/* ──────────────────── building blocks ──────────────────── */

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ReactNode
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center shrink-0 text-cyan-400">
          {icon}
        </span>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

/** Renders a prompt string with highlighted tags — the SAME palette the
 *  editor, chat and hover previews use:
 *    <Picture N> purple · <Video N> cyan · <Audio N> emerald
 *    <Subject N> rose · <Scene N>/<Location N> sky · <d>…</d> amber.
 */
function PromptSample({ text, note }: { text: string; note?: string }) {
  const parts = text.split(/(<(?:Picture|Video|Audio|Subject) \d+>|<Scene \d+>|<Location \d+>|<d>[\s\S]*?<\/d>)/g)
  return (
    <div className="rounded-xl border border-border bg-[var(--surface-0)]/70 overflow-hidden">
      <div className="p-3.5 text-sm text-foreground/90 leading-relaxed">
        {parts.map((p, i) => {
          if (/^<(?:Picture|Video|Audio|Subject) \d+>$/.test(p)) {
            const isVideo = p.startsWith('<Video')
            const isAudio = p.startsWith('<Audio')
            const isSubject = p.startsWith('<Subject')
            const cls = isVideo
              ? 'bg-cyan-500/15 text-cyan-300'
              : isAudio
                ? 'bg-emerald-500/15 text-emerald-300'
                : isSubject
                  ? 'bg-pink-500/15 text-pink-300'
                  : 'bg-purple-500/15 text-purple-300'
            return (
              <span key={i} className={cn('px-1.5 py-0.5 rounded font-mono text-xs font-medium', cls)}>
                {p}
              </span>
            )
          }
          if (/^<(?:Scene|Location) \d+>$/.test(p)) {
            return (
              <span key={i} className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-300 font-mono text-xs font-medium">
                {p}
              </span>
            )
          }
          if (/^<d>[\s\S]*<\/d>$/.test(p)) {
            return (
              <span key={i} className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-mono text-xs">
                {p}
              </span>
            )
          }
          return <span key={i}>{p}</span>
        })}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border bg-[var(--surface-2)]/40 px-3.5 py-2">
        <p className="text-xs text-muted-foreground min-w-0">{note}</p>
        <CopyButton text={text} label="" />
      </div>
    </div>
  )
}

/* ──────────────────── examples ──────────────────── */

/** Ready-made example prompts — ENGLISH texts (the model follows English
 *  noticeably better); titles/notes in English. Shared with the Generate
 *  tab "Examples" menu. */
export const EXAMPLES: Array<{ title: string; note: string; text: string }> = [
  {
    title: 'T2VA (text only)',
    note: 'Pure text description — the model creates everything from scratch.',
    text: 'integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker\'s final words carry over from the previous shot.\n\noverall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.\n\nnon_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.',
  },
  {
    title: 'I2VA (start frame)',
    note: 'Single image — starting point, the scene unfolds forward.',
    text: 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the book in her lap to the window, rain streaking the glass, her reflection visible in the dark pane. She says softly: <d>[English] We\'re almost there.</d>\n\noverall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.\n\nnon_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.',
  },
  {
    title: 'FL2VA (first + last frame)',
    note: 'Two images — beginning and end, describing the progression between them.',
    text: 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.\n\nintegrated_multimodal_description: [Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella, and opens it with a sharp snap. Water droplets fly in a radial burst as the canopy expands. By the final frame, she stands upright, fully covered, the bicycle parked at her side, matching Picture 2.\n\noverall_soundscape: Rain falls steadily on the pavement, followed by the metallic click of the umbrella runner and the soft snap of the canopy opening. Water drips from the bicycle frame as distant traffic passes.\n\nnon_diegetic_music: N/A',
  },
  {
    title: 'Ref2VA (references + voice)',
    note: 'Multimodal input: character, location, voice.',
    text: 'subject_definitions:\n<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.\n<Subject 2> is the fluffy white Samoyed in <Picture 2>, with thick white fur, pointed ears, and a curved tail.\n<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt.\n<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.\n\nsummary:\n[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 2> lunges toward the cookie. The exchange uses <Audio 1> as the voice-timbre reference for <Subject 3>.\n\nretention_analysis:\n<Subject 1> (appears in [Shot 1], [Shot 2]): fully_preserved - the exposed brick wall, orange sofa, and wooden table are retained.\n<Subject 3> (appears in [Shot 1], [Shot 2]): fully_preserved - her long blonde hair and light-pink shirt are retained.\n<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.\n\ndetailed_description:\n[Shot 1] A medium shot establishes <Subject 1>, the coffee shop. <Subject 3> (S1), the young woman with long blonde hair, sits on the sofa holding a cookie. <Subject 2> lunges toward her hand. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance: <d>[English] Hey! Watch your dog!</d>\n\noverall_soundscape:\nSoft indoor coffee-shop room tone continues throughout the scene.\n\nnon_diegetic_music:\nN/A',
  },
]

const DONT_LIST = [
  '\"First show the street, then cut to a close-up\" — the model does not perform montage and cuts: this is a single continuous take.',
  'Listing reference tags separately at the end of the prompt — a tag must be placed right where the reference appears in the scene.',
  'Long monologues inside <d>...</d> — voiceover is designed for short lines (up to ~10 words); longer ones distort.',
  '\"Make it cinematic and pretty...\" — specify concrete details: lighting, camera angle, camera motion, sound.',
  'Contradicting references (different clothing/hair/setting) — the model adheres closely to the image/video.',
  'Asking for a \"known character\" without references — describe their appearance in words; the model does not know arbitrary characters without description.',
  'Too many actions packed into 30 seconds — prefer one continuous motion, not a 5-scene screenplay.',
  'Mixing first/last-frame roles with reference media roles — the API requires that role families do not overlap.',
  'Providing audio as the only media reference for Ref2VA — always attach an image or video.',
]

/** Camera/light vocabulary — ENGLISH phrases inserted verbatim into the
 *  prompt (the model follows English noticeably better). Shared with the
 *  fullscreen prompt editor panel. */
export const CAMERA_WORDS = [
  'slow push-in on the face', 'smooth pan left to right', 'static shot, close-up',
  'camera pulls back', 'camera follows the character', 'subtle handheld shake',
  'low-angle shot', 'backlight / silhouette', 'warm side lighting', 'neon lighting',
  'soft morning light', 'atmospheric haze', 'shallow depth of field, blurred background',
  'Zoom In with small amplitude at slow speed',
  'Pan Left with large amplitude at fast speed',
  'Truck Right with small amplitude at moderate speed',
  'Tilt Up with large amplitude at slow speed',
  'Arc Shot around the subject',
  'Tracking Shot following the character',
  'Shake Slightly for a handheld feel',
  'POV — point of view',
  'Roll Clockwise for a disorienting effect',
]

/* ──────────────────── component ──────────────────── */

export function PromptGuide() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-8 pb-4"
    >
      {/* ── 1. Technical specs ── */}
      <Section
        icon={<MonitorPlayIcon className="w-4 h-4" />}
        title="Technical Specifications"
        subtitle="MiniMax H3 limits and requirements"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Output</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Resolution: <span className="text-foreground/80 font-mono">480p / 720p / 1080p</span></li>
                <li>• Duration: <span className="text-foreground/80 font-mono">~2.5–30 sec</span> (17n+5 frame alignment)</li>
                <li>• Aspect ratio: 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 + custom resolution</li>
              </ul>
            </div>
            <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
              <p className="text-xs font-semibold text-foreground mb-2">Input (References)</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                <li>• Images: up to <span className="text-foreground/80 font-mono">9</span></li>
                <li>• Videos: up to <span className="text-foreground/80 font-mono">3</span></li>
                <li>• Audio: up to <span className="text-foreground/80 font-mono">3</span></li>
                <li>• Mixed input: maximum <span className="text-foreground/80 font-mono">15 files</span> total</li>
                <li>• Total video + audio duration: ≤ <span className="text-foreground/80 font-mono">15 sec</span></li>
              </ul>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            💡 All generations run <span className="text-foreground/80">locally on your computer</span> via ComfyUI — no internet connection required.
          </p>
        </div>
      </Section>

      {/* ── 2. Mode selection ── */}
      <Section
        icon={<MonitorPlayIcon className="w-4 h-4" />}
        title="Generation Mode Selection"
        subtitle="Identify what inputs you have — do not choose a mode by guesswork"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-[var(--surface-1)]/60">
                <th className="text-left px-3 py-2 font-semibold text-foreground">Mode</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Input</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Prompt Objective</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Best For</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['T2VA', 'Text only', 'Build a full audiovisual timeline from scratch', 'New ideas from text'],
                ['I2VA', 'Single start image', 'Prompt body + first frame instruction + forward progression', 'Animating a finished composition'],
                ['FL2VA', 'First and last image', 'Align both images and describe the transition path between them', 'Controlling start and end transitions'],
                ['L2VA', 'Single end image', 'Build a plausible preceding sequence terminating at the target frame', 'Reveals or backwards transformation'],
                ['Ref2VA', 'References (images/videos/audio)', 'Assign each asset a role via full reference format', 'Controlling identity, style, motion, camera, or sound across multiple sources'],
              ].map(([mode, input, task, use]) => (
                <tr key={mode} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 font-mono text-foreground">{mode}</td>
                  <td className="px-3 py-2 text-muted-foreground">{input}</td>
                  <td className="px-3 py-2 text-muted-foreground">{task}</td>
                  <td className="px-3 py-2 text-muted-foreground">{use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 2b. What the assistant writes in studio ── */}
      <Section
        icon={<ListOrderedIcon className="w-4 h-4" />}
        title="What the Studio Assistant Outputs"
        subtitle="Format is automatically chosen based on the active tab mode"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-[var(--surface-2)]/60">
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Studio Tab</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">H3 Mode</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Prompt Format</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['"Text"', 'T2VA', '3 fields: integrated_multimodal_description · overall_soundscape · non_diegetic_music'],
                  ['"Frames"', 'FL2VA / I2VA', 'same 3 fields'],
                  ['"References"', 'Ref2VA', '6 fields: subject_definitions · summary · retention_analysis · detailed_description · overall_soundscape · non_diegetic_music'],
                  ['"Extend"', 'extend', 'same 3 fields, describing only the NEW action'],
                  ['"ControlNet"', 'Ref2VA', '6 fields + dedicated rules for the control video'],
                ].map(([tab, mode, fmt]) => (
                  <tr key={tab} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{tab}</td>
                    <td className="px-3 py-2 font-mono text-muted-foreground">{mode}</td>
                    <td className="px-3 py-2 text-muted-foreground">{fmt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
            <li>• No manual configuration needed: the assistant detects the tab mode and selects the correct structure automatically.</li>
            <li>• Tags <span className="font-mono text-[10px]">&lt;Picture N&gt;</span> / <span className="font-mono text-[10px]">&lt;Video N&gt;</span> / <span className="font-mono text-[10px]">&lt;Subject N&gt;</span> are <span className="text-foreground/80">forbidden</span> in "Text" and "Frames" — in "Text", only <span className="font-mono text-[10px]">&lt;Audio N&gt;</span> is allowed, and only if an audio ref is actually attached.</li>
            <li>• There is no standalone "end frame only" (L2VA) mode in the studio — "Text", "Frames", and "References" are available, alongside dedicated "Extend" and "ControlNet" tabs.</li>
            <li>• The generated prompt arrives in a markdown code block — ready for instant copying into the prompt field.</li>
          </ul>
        </div>
      </Section>

      {/* ── 3. Formula ── */}
      <Section
        icon={<SparklesIcon className="w-4 h-4" />}
        title="Prompt Formula"
        subtitle="Three blocks in strict order (official MiniMax manual)"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <div className="flex flex-wrap items-center gap-2">
            {[
              ['Reference Notes', 'what each file does (only for I2VA/FL2VA/L2VA/Ref2VA)'],
              ['Core Idea', 'subject, setting, event, style'],
              ['Shot-by-Shot Scene Breakdown', 'movement across time, with timestamps'],
            ].map(([k, v], i) => (
              <div key={k} className="flex items-center gap-2">
                <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/10 px-2.5 py-1.5">
                  <p className="text-xs font-semibold text-cyan-300">{k}</p>
                  <p className="text-[10px] text-muted-foreground">{v}</p>
                </div>
                {i < 2 && <span className="text-muted-foreground/50 text-xs">→</span>}
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-3 leading-relaxed">
            The first block is omitted when no files are uploaded (T2VA).
          </p>
        </div>
      </Section>

      {/* ── 4. Final structure ── */}
      <Section
        icon={<ListOrderedIcon className="w-4 h-4" />}
        title="Final Prompt Structure"
        subtitle="Two parts: alignment instruction + three core fields"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Part 1 — Instruction (first line)</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80 font-mono">T2VA</span>: no instruction, starts directly with the three fields.</li>
              <li>• <span className="text-foreground/80 font-mono">I2VA</span>: <span className="font-mono text-[10px]">For the target video, at 0.00 seconds into the target video, &lt;Picture 1&gt; (from [Shot 1]) is fully referenced.</span></li>
              <li>• <span className="text-foreground/80 font-mono">FL2VA</span>: <span className="font-mono text-[10px]">How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark...</span></li>
            </ul>
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed mt-2 border-l-2 border-cyan-500/40 pl-2">
              In the studio, you <span className="text-foreground/80">do not need</span> to write this line: frames and time alignment
              are handled automatically by the application, and the assistant always starts the prompt with the first field
              (<span className="font-mono text-[10px]">integrated_multimodal_description</span> or
              <span className="font-mono text-[10px]">subject_definitions</span>). The lines above serve as a reference to the
              official MiniMax API if drafting prompts for external wrappers.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Part 2 — Three Core Fields</p>
            <div className="space-y-1.5">
              {[
                ['integrated_multimodal_description', 'Main prompt body: visuals, actions, shots, speakers, dialogue, singing, synchronized sound along the timeline.'],
                ['overall_soundscape', 'Summary of ambient sound, physical action audio, and non-verbal human sounds across the entire video.'],
                ['non_diegetic_music', 'Background score heard only by the audience (inaudible to characters in the scene).'],
              ].map(([field, desc]) => (
                <div key={field} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <p className="font-mono text-xs text-foreground/90">{field}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </Section>

      {/* ── 5. Writing the 3 fields ── */}
      <Section
        icon={<BookOpenIcon className="w-4 h-4" />}
        title="Writing the Three Core Fields"
        subtitle="Details for each field"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.1 integrated_multimodal_description</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Develop the description chronologically along the timeline. Every element should correspond to something visible or audible: style, starting composition, subject appearance and positioning, scene and key props, actions and reactions, shot transitions, spoken language, synchronized sound effects.
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              At the start of <span className="font-mono text-[10px]">[Shot 1]</span>, declare the overall style and initial framing. Common styles: <span className="text-foreground/80">Cinematic, live-action, 2D-animated, 3D CG, claymation, watercolor, vintage film</span>.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.2 Shot Structure and Cuts</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80">Do not assign a timestamp to the first shot.</span></li>
              <li>• For subsequent shots, use numbering <span className="font-mono text-[10px]">[Shot 2]</span>, <span className="font-mono text-[10px]">[Shot 3]</span>, etc., beginning each with a <span className="text-foreground/80">strictly increasing</span> cut timestamp within the total video duration.</li>
              <li>• For standard hard cuts, use: <span className="font-mono text-[10px]">the camera cuts to</span>, <span className="font-mono text-[10px]">the shot cuts to</span>, <span className="font-mono text-[10px]">the shot transitions to</span>, <span className="font-mono text-[10px]">the shot changes to</span>, <span className="font-mono text-[10px]">the shot switches to</span>.</li>
              <li>• Cross-dissolves, fades, and wipes should only be specified when explicitly requested.</li>
              <li>• A cut should introduce new information regarding the subject, space, condition, viewpoint, or time.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">5.3 Keyframes (I2VA / FL2VA / L2VA)</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80 font-mono">I2VA</span>: describe the first image as the starting point in <span className="font-mono text-[10px]">[Shot 1]</span>, then explain how the scene develops forward. Pattern: <em>opening frame → initial movement → continuous action → final reaction</em>.</li>
              <li>• <span className="text-foreground/80 font-mono">FL2VA</span>: do not describe both static images twice — describe the <span className="text-foreground/80">motion</span> bridging them together. Pattern: <em>starting state → intermediate physical transformations → approaching final composition → ending state</em>.</li>
              <li>• <span className="text-foreground/80 font-mono">L2VA</span>: construct a plausible preceding progression that converges toward the specified ending frame. <span className="text-foreground/80">The studio does not offer this isolated mode</span> — end frames are paired with start frames in "Frames" mode.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 6. Camera movement ── */}
      <Section
        icon={<CameraIcon className="w-4 h-4" />}
        title="Camera Movement"
        subtitle="Three dimensions: type, amplitude, speed"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div className="grid sm:grid-cols-3 gap-2">
            {[
              ['Movement Type', 'how the camera moves'],
              ['Amplitude', 'small / large amplitude'],
              ['Speed', 'slow / moderate / fast speed'],
            ].map(([k, v]) => (
              <div key={k} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-xs font-semibold text-foreground">{k}</p>
                <p className="text-[10px] text-muted-foreground mt-1">{v}</p>
              </div>
            ))}
          </div>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-[var(--surface-1)]/60">
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Type</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Expression</th>
                  <th className="text-left px-3 py-2 font-semibold text-foreground">Description</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Zoom In / Out', 'Zoom In, Zoom Out', 'Focal length changes while camera stays stationary'],
                  ['Pan Left / Right', 'Pan Left, Pan Right', 'Camera stationary, lens pivots horizontally'],
                  ['Truck Left / Right', 'Truck Left, Truck Right', 'Camera physically moves horizontally'],
                  ['Tilt Up / Down', 'Tilt Up, Tilt Down', 'Camera stationary, lens pivots vertically'],
                  ['Pedestal Up / Down', 'Pedestal Up, Pedestal Down', 'Entire camera moves vertically up/down'],
                  ['Arc Shot', 'Arc Shot', 'Camera moves along a curved arc around the subject'],
                  ['Tracking Shot', 'Tracking Shot', 'Camera tracks along with a moving subject'],
                  ['Static Shot', 'Static Shot', 'Camera position and framing remain locked and stationary'],
                  ['Shake', 'Shake Slightly / Shake Strongly', 'Subtle or vigorous camera shake'],
                  ['POV', 'POV', 'First-person point of view'],
                  ['Roll', 'Roll Clockwise / Counterclockwise', 'Camera rolls around the optical axis'],
                ].map(([type, expr, desc]) => (
                  <tr key={type} className="border-b border-border/50 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{type}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-foreground/80">{expr}</td>
                    <td className="px-3 py-2 text-muted-foreground">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">
            💡 Camera movement is described as natural English action inside the shot:
          </p>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.<br/>
              The camera pans right with large amplitude at fast speed, revealing the open doorway.<br/>
              The camera holds a static shot as the runner exits the frame.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 7. Speaking characters ── */}
      <Section
        icon={<MessageSquareQuoteIcon className="w-4 h-4" />}
        title="Speaking Characters, Dialogue & Singing"
        subtitle="IDs, voiceover, dialogue bridging across cuts"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <ul className="space-y-1.5 text-xs text-muted-foreground leading-relaxed">
            <li>• Subjects speaking, singing, or vocalizing receive consistent identifiers <span className="font-mono text-[10px]">(S1)</span>, <span className="font-mono text-[10px]">(S2)</span>, etc. When multiple already-numbered speakers vocalize together, use a composite ID <span className="font-mono text-[10px]">(S1,S2)</span>.</li>
            <li>• Identifiers persist across shots; characters who never utter spoken words receive <span className="text-foreground/80">no</span> ID.</li>
            <li>• On first appearance of a speaker, provide enough identity detail: character type, age, gender, on/off-screen status, pitch, vocal timbre, speaking pace, or accent.</li>
          </ul>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Dialogue Line Format</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Identifying phrases, ID, action, and delivery are placed <span className="text-foreground/80">outside</span> <span className="font-mono text-[10px]">&lt;d&gt;</span>. Inside <span className="font-mono text-[10px]">&lt;d&gt;</span>, include only the language tag and the verbatim spoken line. Keep every word and punctuation mark intact; do not translate or rewrite them.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The young woman with a quiet, breathy voice (S1) says: &lt;d&gt;[English] I get off at the next station.&lt;/d&gt;<br/>
              The two children (S1,S2) shout together, &lt;d&gt;[English] Wait for us!&lt;/d&gt;
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Off-Screen Voiceover</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Use the exact phrasing <span className="font-mono text-[10px]">says in an off-screen voiceover</span>. Immediately after each <span className="font-mono text-[10px]">&lt;d&gt;</span> block, explicitly state that the character's visible lips remain closed:
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              The man (S1) says in an off-screen voiceover: &lt;d&gt;[English] I still remember that road.&lt;/d&gt; while his lips remain completely closed.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Dialogue Bridging Across Cuts</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              If a single line or verse crosses a cut, use <span className="font-mono text-[10px]">&lt;scenetrans&gt;</span> at the junction points of both segments and explicitly state that the audio carries across the cut. For speech truncated at the video end, use <span className="font-mono text-[10px]">&lt;cutoff&gt;</span>.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 8. On-screen text ── */}
      <Section
        icon={<TypeIcon className="w-4 h-4" />}
        title="On-Screen Text"
        subtitle="Banners, signs, captions, subtitles"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <p className="text-xs text-muted-foreground leading-relaxed">
            Any banner, sign, caption, subtitle, or neon text actually visible on screen should be enclosed in <span className="text-foreground/80">English double quotes</span>, preserving original characters and punctuation verbatim without translation:
          </p>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3 mt-2">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              A red neon sign reading \"OPEN\" glows above the doorway.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 9. Soundscape & music ── */}
      <Section
        icon={<MusicIcon className="w-4 h-4" />}
        title="Soundscape & Music"
        subtitle="overall_soundscape and non_diegetic_music"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">overall_soundscape</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Use <span className="text-foreground/80">1–4 sentences</span> in a single continuous paragraph summarizing ambient atmosphere, physical action audio, and non-verbal human sounds across the entire video (wind, rain, traffic, footsteps, rustling fabric, impacts, breathing, laughter, gasps).
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              ⚠️ Spoken dialogue, singing, and diegetic music belong in <span className="font-mono text-[10px]">integrated_multimodal_description</span> and <span className="text-foreground/80">must not be repeated</span> here.
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">non_diegetic_music</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Use <span className="text-foreground/80">1–3 sentences</span> to describe background score heard only by the audience. Emphasize instrumentation, tempo, rhythm, and dynamic shifts; <span className="text-foreground/80">do not use vague mood descriptors</span> or explain emotional intent.
            </p>
            <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
              ⚠️ Singing, live instruments, radios, TVs, or phone audio heard by characters are diegetic events and must reside in <span className="font-mono text-[10px]">integrated_multimodal_description</span>.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-3">
            <p className="text-xs font-mono text-foreground/90 leading-relaxed">
              overall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath. The entrance bell rings once, followed by wet footsteps and the soft scrape of a chair.<br/><br/>
              non_diegetic_music: Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out.
            </p>
          </div>
        </div>
      </Section>

      {/* ── 10. Examples ── */}
      <Section
        icon={<BookOpenIcon className="w-4 h-4" />}
        title="Complete Prompt Examples"
        subtitle="Four modes — ready to copy and adapt"
      >
        <div className="space-y-3">
          {EXAMPLES.map((ex) => (
            <div key={ex.title} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-foreground">{ex.title}</span>
                <span className="text-[10px] text-muted-foreground">— {ex.note}</span>
              </div>
              <PromptSample text={ex.text} note="Click the icon on the right to copy" />
            </div>
          ))}
        </div>
      </Section>

      {/* ── 11. Common mistakes ── */}
      <Section
        icon={<AlertTriangleIcon className="w-4 h-4" />}
        title="Common Mistakes"
        subtitle="What degrades generation quality and how to fix it"
      >
        <div className="rounded-xl border border-border overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border bg-[var(--surface-1)]/60">
                <th className="text-left px-3 py-2 font-semibold text-foreground">Problem</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Cause</th>
                <th className="text-left px-3 py-2 font-semibold text-foreground">Fix</th>
              </tr>
            </thead>
            <tbody>
              {[
                ['Wrong person speaking', 'IDs shifted or speaker identity was never established', 'Assign stable (S1) and (S2) on the first appearance of each voice, then reuse them consistently'],
                ['Dialogue duplicated in soundscape', 'Spoken words were copied into multiple fields', 'Keep the spoken line strictly within integrated_multimodal_description'],
                ['Wrong image starts/ends the video', 'Image was attached as reference instead of exact start frame', 'Use Start Frame mode and begin the prompt with the official first-frame alignment instruction'],
                ['Detailed reference elements lost or blurred', 'Prompt conflicts with reference visuals or duration is too short', 'Assign each reference a single clear role, streamline the prompt, and select a suitable duration for the sequence'],
                ['Model ignores reference', 'Role is ambiguous', 'Specify exact subject, attribute, shot range, and intended relationship'],
                ['Two sources conflict over a single attribute', 'No primary controlling asset designated', 'Select the primary controlling asset and exclude contradictory elements from the other'],
              ].map(([problem, cause, fix]) => (
                <tr key={problem} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 text-foreground">{problem}</td>
                  <td className="px-3 py-2 text-muted-foreground">{cause}</td>
                  <td className="px-3 py-2 text-muted-foreground">{fix}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* ── 12. Ref2VA deep dive ── */}
      <Section
        icon={<TagIcon className="w-4 h-4" />}
        title="Reference Mode (Ref2VA)"
        subtitle="Six-section structure, tags, and rules"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3">
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Six-Section Structure</p>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[
                ['subject_definitions', 'Entities present: <Subject N>, mapped to <Picture N>, <Video N>, <Audio N>'],
                ['summary', 'Concise summary: task, target video, relationships between references'],
                ['retention_analysis', 'What is retained (fully_preserved) / referenced (reference) / modified'],
                ['detailed_description', 'Main body: shots [Shot 1], [Shot 2]... in sequence'],
                ['overall_soundscape', 'Ambient environmental and physical action sounds'],
                ['non_diegetic_music', 'Background score for audience (or N/A)'],
              ].map(([k, v], i) => (
                <div key={k} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <span className="w-4 h-4 rounded-full bg-cyan-500/15 text-cyan-300 text-[10px] font-bold flex items-center justify-center">{i + 1}</span>
                    <span className="font-mono text-[10px] text-foreground/90">{k}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{v}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Reference Tags</p>
            <div className="grid sm:grid-cols-2 gap-2">
              {[
                ['<Subject N>', 'Visible content abstracted from reference assets; can be reused or modified in the target video'],
                ['<Picture N>', 'Reference image serving as first/last frame, keyframe, or compositional anchor'],
                ['<Video N>', 'Reference video as source for editing, continuation, or overarching temporal structure'],
                ['<Audio N>', 'Audio signal that is copied or referenced'],
              ].map(([tag, desc]) => (
                <div key={tag} className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                  <p className="font-mono text-xs text-foreground/90">{tag}</p>
                  <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed">{desc}</p>
                </div>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Numbering Rules and Independent Tracks</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="font-mono text-[10px]">&lt;Video N&gt;</span> and <span className="font-mono text-[10px]">&lt;Audio N&gt;</span> are numbered <span className="text-foreground/80">independently</span> — index numbers do not imply a pair between them.</li>
              <li>• If an image is used only to define character or style, do not add a separate <span className="font-mono text-[10px]">&lt;Picture N&gt;</span> entry — specify the source within the respective <span className="font-mono text-[10px]">&lt;Subject N&gt;</span>.</li>
              <li>• If a <span className="font-mono text-[10px]">&lt;Picture N&gt;</span>/<span className="font-mono text-[10px]">&lt;Video N&gt;</span> asset merely identifies another reference and is not analyzed independently, reference it within that asset\'s definition.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Retention Relationships (Relationship Markers)</p>
            <div className="grid sm:grid-cols-2 gap-2">
              <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-[10px] font-semibold text-foreground mb-1">For Visual Content</p>
                <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                  <li>• <span className="font-mono text-[10px]">fully_preserved</span> — geometry, colors, and fine details fully preserved</li>
                  <li>• <span className="font-mono text-[10px]">weak_reference</span> — only general categorical or stylistic similarity is preserved</li>
                </ul>
              </div>
              <div className="rounded-lg border border-border bg-[var(--surface-1)]/60 p-2.5">
                <p className="text-[10px] font-semibold text-foreground mb-1">For Audio</p>
                <ul className="space-y-0.5 text-[10px] text-muted-foreground">
                  <li>• <span className="font-mono text-[10px]">fully_copy</span> — source audio is reused 1:1 as the final audio track</li>
                  <li>• <span className="font-mono text-[10px]">reference</span> — not copied verbatim; transfers vocal timbre, rhythm, musical style, or dialogue context</li>
                  <li>• <span className="font-mono text-[10px]">weak_reference</span> — broad similarity in category, genre, or atmosphere</li>
                </ul>
              </div>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Speaking Characters and IDs</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• Reuse the global speaker ID <span className="font-mono text-[10px]">(Sx)</span> on every real vocal event.</li>
              <li>• An <span className="font-mono text-[10px]">&lt;Audio N&gt;</span> linked to a target speaker reuses the same <span className="font-mono text-[10px]">(Sx)</span>, but <span className="text-foreground/80">never</span> assigns a new ID on its own.</li>
              <li>• Do not write <span className="font-mono text-[10px]">(Sx)</span> inside <span className="font-mono text-[10px]">retention_analysis</span>.</li>
              <li>• Voices physically produced by a specific character use <span className="font-mono text-[10px]">(Sx)</span>. Music or dialogue directly reused from soundtrack assets refer to <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>.</li>
            </ul>
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground mb-2">Important Warnings</p>
            <ul className="space-y-1 text-xs text-muted-foreground leading-relaxed">
              <li>• <span className="text-foreground/80">Do not mix</span> first/last-frame roles with reference media roles. The API requires that role families do not intersect in the same request.</li>
              <li>• Reference audio <span className="text-foreground/80">cannot be the sole</span> media reference for H3-Base-Ref2VA — always attach an image or video.</li>
              <li>• If only timbre is referenced — do not copy the source dialogue verbatim into the resulting video.</li>
            </ul>
          </div>
        </div>
      </Section>

      {/* ── 13. Checklist ── */}
      <Section
        icon={<ClipboardCheckIcon className="w-4 h-4" />}
        title="Pre-Generation Checklist"
        subtitle="Verify all items before submitting"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4">
          <ul className="space-y-1.5">
            {[
              'The correct mode is selected for available inputs: \"Text\", \"Frames\", or \"References\".',
              'The prompt begins with the correct field: integrated_multimodal_description (standard mode) or subject_definitions (references).',
              'Shots are ordered sequentially: [Shot 1], [Shot 2]... — first shot has no timestamp.',
              'Descriptions of the same subject remain consistent across all shots.',
              'Each speaking character retains a consistent ID (Sx).',
              'Each spoken line is preserved with exact language tag and wording inside <d>.',
              'Visible text is enclosed in English double quotes.',
              'Physical and environmental sounds are placed in overall_soundscape, score for audience in non_diegetic_music, or marked N/A.',
              'Requested actions fit comfortably within the selected clip duration.',
              'Every attached reference is cited in the prompt with its respective tag (<Picture N> / <Video N> / <Audio N>).',
              'In retention_analysis, preserved elements (fully_preserved) and changes are explicitly specified.',
              'Acceptance criteria prioritize key aspects: character identity, on-screen text, transition, timing, audio, or end frame.',
            ].map((item, i) => (
              <li key={i} className="flex gap-2 text-xs text-muted-foreground leading-relaxed">
                <span className="text-cyan-400 shrink-0 mt-0.5">☐</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      </Section>

      {/* ── 14. LLM assistant ── */}
      <Section
        icon={<BotIcon className="w-4 h-4" />}
        title="Studio LLM Assistant"
        subtitle="Built-in local assistant (Bonsai 2 27B default / Gemma 4 12B / Qwen3.5 9B) — inspects references, and video frames when enabled in Settings → LLM"
      >
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <span className="w-8 h-8 rounded-lg bg-violet-500/15 border border-violet-500/30 flex items-center justify-center shrink-0">
              <BotIcon className="w-4 h-4 text-violet-300" />
            </span>
            <div className="space-y-1">
              <p className="text-xs text-foreground leading-relaxed">
                <span className="text-violet-300 font-medium">\"Assistant\"</span> is the right-hand panel on the \"Generate\" and \"Extend\" tabs (resizable border, header button collapses into a narrow rail). It runs a local LLM (default: Bonsai 2 27B ternary vision; alternatives: Gemma 4 12B, Qwen3.5 9B) directly on your GPU. It knows the full MiniMax H3 prompt engineering guide, <span className="text-violet-300 font-medium">inspects attached images and video frames</span>, and can accurately ground characters and settings in the prompt. The assistant detects the active generation mode and avoids unsupported tags.
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Chat in natural language, and receive the finalized prompt in English. If no references are attached, it omits tags; when references are present, it binds only active tags: <span className="font-mono text-[10px]">&lt;Picture N&gt;</span>, <span className="font-mono text-[10px]">&lt;Video N&gt;</span>, <span className="font-mono text-[10px]">&lt;Audio N&gt;</span>.
              </p>
            </div>
          </div>
          <div className="grid sm:grid-cols-3 gap-2.5">
            {[
              ['Open the \"Assistant\" panel', 'On the right side of the \"Generate\" or \"Extend\" tab. Describe your concept in natural words. Attached references are automatically visible to the model.'],
              ['Or \"Refine Prompt\"', 'The ✦ button beside the prompt input (and in the fullscreen editor header): prompts for what to adjust, sends your draft and instructions to the LLM, and expands the chat panel automatically.'],
              ['Paste the final prompt', 'Copy the assistant response directly into the prompt box — tags and character definitions are already mapped to your references.'],
            ].map(([t, d]) => (
              <div key={t} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
                <p className="text-xs font-semibold text-violet-400">{t}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      {/* ── 15. History / favorites / examples ── */}
      <Section
        icon={<HistoryIcon className="w-4 h-4" />}
        title="History, Favorites & Examples"
        subtitle="Your prompts are saved automatically and available in one click"
      >
        <div className="grid sm:grid-cols-3 gap-2.5">
          {[
            ['📜 History', 'Every submitted prompt is saved (up to 30). Click to restore. Available in the prompt editor (\"History\" tab) and in the \"History\" menu on the Generate tab.'],
            ['⭐ Favorites', 'Star effective prompts to pin them to the top — they remain protected when history rotates (up to 20).'],
            ['📚 Examples', 'Ready-made English prompt templates for different scenarios (T2VA, I2VA, FL2VA, Ref2VA). Available in the editor and in the \"Examples\" menu.'],
          ].map(([t, d]) => (
            <div key={t} className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-3">
              <p className="text-xs font-semibold text-foreground">{t}</p>
              <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{d}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── 16. Hover previews ── */}
      <Section
        icon={<MousePointerClickIcon className="w-4 h-4" />}
        title="Hover Reference Previews"
        subtitle="Hover over any tag to preview the corresponding asset"
      >
        <div className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 flex items-start gap-3">
          <span className="w-8 h-8 rounded-lg bg-cyan-500/10 border border-cyan-500/25 flex items-center justify-center shrink-0">
            <MousePointerClickIcon className="w-4 h-4 text-cyan-400" />
          </span>
          <div className="space-y-1">
            <p className="text-xs text-foreground leading-relaxed">
              In the prompt input, editor, and LLM chat, hovering over a <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-purple-500/15 text-purple-300">&lt;Picture N&gt;</span> or <span className="font-mono text-[10px] px-1 py-0.5 rounded bg-cyan-500/15 text-cyan-300">&lt;Video N&gt;</span> tag reveals a floating preview card showing the image or video poster. This prevents mixing up asset numbers in complex prompts.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Audio references (<span className="font-mono text-[10px]">&lt;Audio N&gt;</span>) do not show visual previews as sound has no standalone visual preview.
            </p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Clicking on the preview thumbnail opens the asset fullscreen for inspecting fine details (consistent across all studio tabs).
            </p>
          </div>
        </div>
      </Section>

      {/* ── 17. Camera vocabulary (quick insert) ── */}
      <Section
        icon={<CameraIcon className="w-4 h-4" />}
        title="Cinematic Vocabulary (Quick Insert)"
        subtitle="Phrases the model understands and responds to well — insert directly into your prompt"
      >
        <div className="flex flex-wrap gap-2">
          {CAMERA_WORDS.map((w) => (
            <span key={w} className="px-2.5 py-1 rounded-full border border-border bg-[var(--surface-2)]/60 text-xs text-foreground/80">
              {w}
            </span>
          ))}
        </div>
      </Section>

      {/* ── 18. Don'ts (summary) ── */}
      <Section
        icon={<AlertTriangleIcon className="w-4 h-4" />}
        title="What NOT to Do (Summary)"
        subtitle="Quick reference of anti-patterns to avoid"
      >
        <ul className="space-y-1.5">
          {DONT_LIST.map((t, i) => (
            <li key={i} className="flex gap-2.5 rounded-lg border border-border bg-[var(--surface-2)]/40 px-3 py-2">
              <span className="text-red-400 text-xs shrink-0 mt-0.5">✕</span>
              <p className="text-xs text-muted-foreground leading-relaxed">{t}</p>
            </li>
          ))}
        </ul>
      </Section>
    </motion.div>
  )
}
