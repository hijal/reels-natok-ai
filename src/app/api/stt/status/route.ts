import { NextResponse } from 'next/server'
import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getAppConfig } from '@/lib/app-config'
import { sttStatus, STT_PORT } from '@/lib/stt-runner'

/**
 * (fix 65) GET /api/stt/status
 * Voice input: config, list of models in the built-in stt/ folder, and service state.
 */
export const dynamic = 'force-dynamic'

function listModels(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => {
        const e = f.toLowerCase()
        if (!e.endsWith('.bin') && !e.endsWith('.gguf')) return false
        try {
          return statSync(join(dir, f)).isFile()
        } catch {
          return false
        }
      })
      .sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

export async function GET() {
  const cfg = getAppConfig()
  const sttDir = cfg.sttDir

  const modelDirs = [
    join(sttDir, 'models'),
    join(sttDir, 'resources', 'models'),
  ]
  const byDir = modelDirs.map((d) => ({ dir: d, files: listModels(d) }))
  const allModels = byDir.flatMap((d) => d.files)

  let health: Record<string, unknown> | null = null
  if (sttStatus().running) {
    try {
      const r = await fetch(`http://127.0.0.1:${STT_PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) health = await r.json()
    } catch {
      health = null
    }
  }

  return NextResponse.json({
    enabled: cfg.sttEnabled,
    sttDir,
    model: cfg.sttModel,
    models: allModels,
    modelDirs: byDir,
    language: cfg.sttLanguage,
    threads: cfg.sttThreads,
    service: sttStatus(),
    health,
  })
}
