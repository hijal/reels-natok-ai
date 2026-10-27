'use client'

/**
 * LearnRecipes — "Workflows" subtab under "Learn" (fix 485).
 *
 * Ready-to-use workflows for the studio in clear language for beginners:
 * how to combine generation, refine, and tile upscale depending
 * on hardware and task. Static guide cards.
 */
import {
  ZapIcon,
  LayersIcon,
  SearchIcon,
  CheckCircle2Icon,
} from 'lucide-react'
import type { ReactNode } from 'react'

interface Recipe {
  icon: ReactNode
  title: string
  subtitle: string
  when: string
  steps: string[]
  note?: string
}

const RECIPES: Recipe[] = [
  {
    icon: <ZapIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Workflow 1. "All at Once"',
    subtitle: 'A single run — finished high-resolution video',
    when: 'If you have a powerful GPU (lots of VRAM) and feel confident in your prompt. The fastest path, but if the prompt misses the mark, generation time is wasted.',
    steps: [
      'Open the "Generate" tab.',
      'Write your prompt (or ask the assistant on the right).',
      'Select a high resolution (e.g., 1080p) and the desired length.',
      'Launch and wait for the result — it will appear in the "Gallery".',
    ],
    note: 'Did not get the expected result? No worries — try Workflow 3: drafts first, then enhance the best one. Want to tune the "quality vs. speed" balance? In "Advanced Parameters" → Pass 1 check "Sampler Steps" and "Total Steps (pass 1)", with a live summary below showing how many steps go into the draft.',
  },
  {
    icon: <LayersIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Workflow 2. "Step-by-Step Enhancement"',
    subtitle: 'Low resolution → Refine in parts → Tile Upscale',
    when: 'If you have mid-range hardware and want high resolution. Each step progressively adds clarity without overloading the GPU.',
    steps: [
      'Generate a video in a lower resolution (e.g., 480p or 720p) — faster and easier on the GPU.',
      'In the "Gallery", click "Refine" on the video, select "Chunked" mode and a higher resolution (e.g., 1080p). The video will process in chunks and auto-stitch.',
      'Need even more detail? Click "Tile Upscale" on the refined result — it will cleanly upscale the video up to 1440p or 4K.',
    ],
    note: 'Refine synthesizes details and enhances clarity. Tile Upscale gently upscales the finished video tile by tile.',
  },
  {
    icon: <SearchIcon className="w-4.5 h-4.5 text-white" />,
    title: 'Workflow 3. "Drafts First"',
    subtitle: 'Generate fast drafts → pick the best → enhance',
    when: 'If you are exploring ideas and do not want to spend hours on unwanted iterations. A draft is a fast, lower-quality preview.',
    steps: [
      'On the "Generate" tab, enable the "Draft" pipeline (fast mode).',
      'Run several generations with different prompts or seeds — each takes significantly less time than a full render.',
      'In the "Gallery", review the options and select the best one.',
      'Send the best draft to "Refine" — it will become a full-quality video.',
      'Optionally apply "Tile Upscale" for even higher resolution.',
    ],
    note: 'This is the most time-efficient workflow: fast experimentation instead of lengthy blind generation runs.',
  },
]

export function LearnRecipes() {
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Three proven studio workflows. Pick one for your hardware and goals —
        or combine them: any clip from the "Gallery" can be sent at any time
        to Refine, Tile Upscale, FPS, or Extend in any sequence.
      </p>

      {RECIPES.map((r) => (
        <div
          key={r.title}
          className="rounded-xl border border-border bg-[var(--surface-2)]/40 p-4 space-y-3"
        >
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg gradient-creative flex items-center justify-center shrink-0 shadow-md shadow-emerald-500/20">
              {r.icon}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground leading-snug">{r.title}</p>
              <p className="text-xs text-cyan-300/90 leading-snug">{r.subtitle}</p>
            </div>
          </div>

          <p className="text-xs text-muted-foreground leading-relaxed">
            <span className="font-medium text-foreground/90">When to use: </span>
            {r.when}
          </p>

          <ol className="space-y-1.5">
            {r.steps.map((s, i) => (
              <li key={i} className="flex gap-2.5 text-xs text-foreground/85 leading-relaxed">
                <span className="w-4.5 h-4.5 rounded-full bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 text-[10px] font-bold flex items-center justify-center shrink-0 mt-px">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>

          {r.note && (
            <p className="text-[11px] text-muted-foreground/80 leading-relaxed border-t border-border/50 pt-2.5">
              {r.note}
            </p>
          )}
        </div>
      ))}

      <div className="flex gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3">
        <CheckCircle2Icon className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-xs text-emerald-200/80 leading-relaxed">
          <span className="font-medium text-emerald-300">Golden rule: </span>
          you cannot break anything. Every result is saved to the "Gallery", source files
          are never overwritten — experiment freely and combine steps however works best for you.
        </p>
      </div>
    </div>
  )
}
