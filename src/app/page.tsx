'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { StudioSidebar, TabType } from '@/components/h3/sidebar'
import { GenerateView } from '@/components/h3/generate-view'
import { ExtendView } from '@/components/h3/extend-view'
import { RefineView } from '@/components/h3/refine-view'
import { UpscaleView } from '@/components/h3/upscale-view'
import { TileUpscaleView } from '@/components/h3/tile-upscale-view'
import { ControlNetView } from '@/components/h3/controlnet-view' // (fix 497)
import { FpsView } from '@/components/h3/fps-view'
import { FaceRefineView } from '@/components/h3/face-refine-view'
import { GalleryView } from '@/components/h3/gallery-view'
import { LearnView } from '@/components/h3/learn/learn-view'
import { QueueIndicator } from '@/components/queue-indicator'
import { SettingsDialog } from '@/components/h3/settings-dialog'
// (fix 112) Popup window with quick guide on first launch
import { WelcomeDialog } from '@/components/h3/welcome-dialog'
import { ModelsWarningBanner } from '@/components/h3/models-warning-banner'
import { initAssistantChatsSync } from '@/lib/assistant-chats-sync'
// (fix 718) Reconcile "whether generation is running" with live ComfyUI on startup:
// persistent store restores the "running" phase from localStorage, and without
// reconciliation the "Generation in progress" card would hang after every launch.
import {
  reconcileGenerationOnStartup,
  cleanupLostPendingQueueItems,
  cancelReconcile,
} from '@/lib/gen-startup-reconcile'
import { initComfyTurn } from '@/lib/comfy-turn'
import { sweepOrphanRefineItems } from '@/lib/refine-queue'
// (fix 442) Assistant is not a tab, but a right panel on "Generate" and
// "Extend"; the "open assistant" event expands the panel via the store.
import { useAssistantPanel } from '@/lib/assistant-panel-store'

const TAB_CONTENT = {
  generate: GenerateView,
  extend: ExtendView,
  refine: RefineView,
  upscale: UpscaleView,
  'tile-upscale': TileUpscaleView,
  controlnet: ControlNetView, // (fix 497)
  fps: FpsView,
  'face-refine': FaceRefineView,
  gallery: GalleryView,
  learn: LearnView,
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabType>('generate')
  const [settingsOpen, setSettingsOpen] = useState(false)

  // (fix 112) Welcome dialog on first launch.
  // (fix 113) "Don't show again" flag is written ONLY if the user
  // checked the box; otherwise the dialog appears on each launch.
  // Initialized in useEffect — SSR does not read localStorage.
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  useEffect(() => {
    try {
      if (!localStorage.getItem('h3_welcome_seen_v1')) setWelcomeOpen(true)
    } catch { /* private browsing mode etc. — simply do not show */ }
  }, [])
  const closeWelcome = (dontShowAgain: boolean) => {
    if (dontShowAgain) {
      try {
        localStorage.setItem('h3_welcome_seen_v1', '1')
      } catch { /* ignore */ }
    }
    setWelcomeOpen(false)
  }

  // (fix 116) "Show welcome dialog" from Settings → General:
  // component dispatches h3:show-welcome event (flag already reset by it),
  // we simply open the dialog on top.
  useEffect(() => {
    const showWelcome = () => setWelcomeOpen(true)
    window.addEventListener('h3:show-welcome', showWelcome)
    return () => window.removeEventListener('h3:show-welcome', showWelcome)
  }, [])

  // Cross-component navigation (e.g. MetaDialog's "→ To editor" button,
  // or the prompt editor's "Improve prompt" → assistant panel)
  useEffect(() => {
    const gotoGenerate = () => setActiveTab('generate')
    const gotoExtend = () => setActiveTab('extend')
    const gotoRefine = () => setActiveTab('refine')
    const gotoUpscale = () => setActiveTab('upscale')
    const gotoTileUpscale = () => setActiveTab('tile-upscale')
    const gotoControlNet = () => setActiveTab('controlnet') // (fix 497)
    const gotoFps = () => setActiveTab('fps')
    const gotoFaceRefine = () => setActiveTab('face-refine')
    // (fix 442) "Open assistant": "Assistant" tab no longer exists —
    // switch to the needed mode tab (generate/extend) and expand
    // the right panel. The store is modular: panel mounts already expanded.
    const openAssistantPanel = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: 'generate' | 'extend' | 'controlnet' }>).detail?.mode
      // (fix 502) 'controlnet' → "ControlNet" tab.
      setActiveTab(mode === 'extend' ? 'extend' : mode === 'controlnet' ? 'controlnet' : 'generate')
      useAssistantPanel.getState().setCollapsed(false)
    }
    window.addEventListener('h3:goto-generate', gotoGenerate)
    window.addEventListener('h3:goto-extend', gotoExtend)
    window.addEventListener('h3:goto-refine', gotoRefine)
    window.addEventListener('h3:goto-upscale', gotoUpscale)
    window.addEventListener('h3:goto-tile-upscale', gotoTileUpscale)
    window.addEventListener('h3:goto-controlnet', gotoControlNet) // (fix 497)
    window.addEventListener('h3:goto-fps', gotoFps)
    window.addEventListener('h3:goto-face-refine', gotoFaceRefine)
    window.addEventListener('h3:open-assistant-panel', openAssistantPanel)
    return () => {
      window.removeEventListener('h3:goto-generate', gotoGenerate)
      window.removeEventListener('h3:goto-extend', gotoExtend)
      window.removeEventListener('h3:goto-refine', gotoRefine)
      window.removeEventListener('h3:goto-upscale', gotoUpscale)
      window.removeEventListener('h3:goto-tile-upscale', gotoTileUpscale)
      window.removeEventListener('h3:goto-controlnet', gotoControlNet) // (fix 497)
      window.removeEventListener('h3:goto-fps', gotoFps)
      window.removeEventListener('h3:goto-face-refine', gotoFaceRefine)
      window.removeEventListener('h3:open-assistant-panel', openAssistantPanel)
    }
  }, [])

  // (fix 73) Synchronize assistant chats with project file
  // (data/assistant-chats.json) — portable storage.
  useEffect(() => {
    initAssistantChatsSync()
  }, [])

  // (fix 718) Reconcile active generations upon application startup.
  // ComfyUI takes ~30-60s to start up, so reconciliation waits for its response
  // (up to 5 minutes) and clears "stuck" state from localStorage. While
  // ComfyUI does not respond, state is UNTOUCHED — we don't know what is running.
  useEffect(() => {
    // First remove "lost" queue elements (their payload didn't survive
    // reload), then restore progress for a truly live ComfyUI task.
    cleanupLostPendingQueueItems()
    // Refine after reload lacks a live runner; without this its prompt_id
    // would never be finalized (global poller intentionally avoids stitching),
    // and the gateway would hold the turn until watchdog timeout.
    sweepOrphanRefineItems()
    initComfyTurn()
    void reconcileGenerationOnStartup()
    return () => cancelReconcile()
  }, [])

  const ContentComponent = TAB_CONTENT[activeTab]

  return (
    <div className="h-full w-full flex overflow-hidden">
      {/* Sidebar */}
      <StudioSidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {/* Main Content */}
      <main className="flex-1 min-w-0 relative flex flex-col">
        {/* Models not downloaded warning */}
        <ModelsWarningBanner onOpenSettings={() => setSettingsOpen(true)} />

        <div className="flex-1 min-h-0 relative">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="h-full flex"
          >
            <ContentComponent />
          </motion.div>
        </AnimatePresence>
        </div>

        {/* Queue indicator — bottom-right floating; (fix 442) shifted
            to the left of the assistant panel on "Generate"/"Extend" tabs */}
        <QueueIndicator activeTab={activeTab} />
      </main>

      {/* Settings dialog (connection, GPU memory) — opened from the sidebar */}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />

      {/* (fix 112) Welcome on first launch — on top of everything */}
      <AnimatePresence>
        {welcomeOpen && (
          <WelcomeDialog
            onClose={closeWelcome}
            onOpenSettings={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setSettingsOpen(true)
            }}
            onGoLearn={(dontShowAgain) => {
              closeWelcome(dontShowAgain)
              setActiveTab('learn')
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}
