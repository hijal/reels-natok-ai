'use client'

/**
 * WelcomeDialog — popup dialog on first launch.
 * "Don't show again" checkbox: flag is set only if the checkbox is checked;
 * otherwise the dialog appears on each launch.
 *
 * Brief quick start guide:
 *   1. Settings → "General" → download models (one-time);
 *   2. "Generation" → prompt → "Generate Video";
 *   3. Results go to "Gallery", upscale in "Upscale".
 * More detailed information is available on the "Learning" tab.
 */
import { useState } from 'react'
import { motion } from 'framer-motion'
import { SparklesIcon, SettingsIcon, GraduationCapIcon, XIcon, ArrowRightIcon, AlertTriangleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface WelcomeDialogProps {
  /**
   * Close dialog. dontShowAgain=true — mark as do not show again;
   * false — close, but show again on next launch.
   */
  onClose: (dontShowAgain: boolean) => void
  /** Close dialog and open settings (download models). */
  onOpenSettings: (dontShowAgain: boolean) => void
  /** Close dialog and switch to "Learning" tab. */
  onGoLearn: (dontShowAgain: boolean) => void
}

interface StepDef {
  title: string
  text: string
}

function Step({ n, title, text }: { n: number } & StepDef) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border bg-[var(--surface-2)] px-3.5 py-3">
      <span className="w-7 h-7 rounded-lg gradient-creative text-white text-sm font-bold flex items-center justify-center shrink-0 shadow-md shadow-cyan-500/20">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{text}</p>
      </div>
    </div>
  )
}

export function WelcomeDialog({ onClose, onOpenSettings, onGoLearn }: WelcomeDialogProps) {
  const [hideForever, setHideForever] = useState(false)

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      onClick={() => onClose(hideForever)}
    >
      <motion.div
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="w-full max-w-lg max-h-[85vh] rounded-2xl border border-border bg-[var(--surface-3)] shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Accent gradient bar */}
        <div className="h-1.5 gradient-creative shrink-0" />

        {/* Header */}
        <div className="aurora-bg overflow-hidden flex items-center gap-3.5 px-5 pt-4 pb-3.5 border-b border-border shrink-0">
          <span className="w-12 h-12 rounded-2xl gradient-creative flex items-center justify-center shrink-0 shadow-lg shadow-cyan-500/25">
            <SparklesIcon className="w-6 h-6 text-white" />
          </span>
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-foreground leading-tight">
              Welcome to <span className="gradient-creative-text">MiniMax H3 Studio 7</span>
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Video generation with sound — directly on your GPU
            </p>
          </div>
          <button
            type="button"
            onClick={() => onClose(hideForever)}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--surface-2)] transition-colors shrink-0"
            title="Close"
          >
            <XIcon className="w-4.5 h-4.5" />
          </button>
        </div>

        {/* Steps */}
        <div className="px-5 py-4 space-y-2.5 overflow-y-auto">
          <p className="text-xs uppercase tracking-wider text-muted-foreground/70 font-medium">
            Get started in three steps
          </p>
          <Step
            n={1}
            title="Download models"
            text="Settings (gear icon at sidebar bottom) → 'General' → 'Download All'. This is a one-time setup — no internet connection required afterwards."
          />
          <Step
            n={2}
            title="Generate your first video"
            text="On the 'Generation' tab: choose a mode (Text / Frames / References), describe the scene (or ask Assistant), set resolution and duration — click 'Generate Video'."
          />
          <Step
            n={3}
            title="View results"
            text="Completed videos are saved in 'Gallery'. You can increase clarity on the 'Upscale' tab."
          />

          {/* Virtual memory warning */}
          <div className="rounded-xl border border-amber-400/40 bg-amber-500/10 px-3.5 py-3 space-y-2">
            <div className="flex items-center gap-2">
              <span className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                <AlertTriangleIcon className="w-4 h-4 text-amber-400" />
              </span>
              <p className="text-sm font-semibold text-amber-300">Important: Increase virtual memory (paging file)</p>
            </div>
            <p className="text-xs text-muted-foreground leading-relaxed">
              The application requires a large virtual memory paging file. If it is too small, out of memory errors may occur.
            </p>
            <div className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-xs text-foreground/80 leading-relaxed space-y-1">
              <p className="font-medium text-foreground">How to increase:</p>
              <p>1. Win + R → <code className="font-mono bg-[var(--surface-3)] px-1 rounded">sysdm.cpl</code> → Enter</p>
              <p>2. 'Advanced' tab → 'Performance' → 'Settings' → 'Advanced' → 'Virtual memory' → 'Change'</p>
              <p>3. Uncheck 'Automatically manage paging file size for all drives'</p>
              <p>4. Select drive, set 'Maximum size (MB)' = 32768 (or higher)</p>
              <p>5. Click 'Set' → 'OK' → <b>restart your PC</b></p>
            </div>
          </div>

          {/* Learning link */}
          <div className="rounded-xl border border-cyan-400/25 bg-cyan-500/10 px-3.5 py-2.5 flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg bg-cyan-500/15 flex items-center justify-center shrink-0">
              <GraduationCapIcon className="w-4 h-4 text-cyan-300" />
            </span>
            <p className="text-xs text-cyan-100/90 flex-1 min-w-0 leading-relaxed">
              Detailed step-by-step tour with visual guides — on the <span className="font-semibold text-cyan-100">'Learning'</span> tab
            </p>
            <button
              type="button"
              onClick={() => onGoLearn(hideForever)}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-cyan-100 bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-400/30 transition-colors"
            >
              Open
              <ArrowRightIcon className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border bg-[var(--surface-2)]/40 px-5 py-3.5 space-y-3 shrink-0">
          <label className="flex items-center gap-2.5 cursor-pointer select-none group">
            <input
              type="checkbox"
              checked={hideForever}
              onChange={(e) => setHideForever(e.target.checked)}
              className="w-4 h-4 rounded accent-cyan-500 cursor-pointer shrink-0"
            />
            <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors">
              Don't show this window again
            </span>
          </label>
          <div className="flex items-center gap-2.5">
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => onOpenSettings(hideForever)}
            >
              <SettingsIcon className="w-3.5 h-3.5" />
              Open Settings
            </Button>
            <Button size="sm" className="flex-1" onClick={() => onClose(hideForever)}>
              Got it
            </Button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  )
}
