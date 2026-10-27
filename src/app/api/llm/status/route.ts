import { NextResponse } from 'next/server'
import { llmStatus, activeLlmModelId, llmModelPath, llmBackend, llmBonsaiPaths } from '@/lib/llm-runner'
import { llmStreaming, comfyBusy, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { existsSync, statSync } from 'fs'
import { basename } from 'path'

export const dynamic = 'force-dynamic'

/** (fix 258) comfyBusy() is a network request to ComfyUI (timeout up to 4 s);
 *  every /api/llm/status poll paid this cost and hung when ComfyUI
 *  was unavailable. We cache the result for 3 s: fresh enough for UI polling,
 *  while eliminating the cost and hang. */
let busyCache: { at: number; busy: boolean } | null = null
async function comfyBusyCached(): Promise<boolean> {
  if (busyCache && Date.now() - busyCache.at < 3000) return busyCache.busy
  const busy = await comfyBusy()
  busyCache = { at: Date.now(), busy }
  return busy
}

/** GET /api/llm/status — runner state + model presence (for the chat tab). */
export async function GET() {
  const s = llmStatus()
  const backend = llmBackend()
  // (fix 136) For Bonsai, the "model" is a GGUF in the external build folder.
  const modelFile = backend === 'bonsai' ? llmBonsaiPaths().model : llmModelPath()
  let modelBytes = 0
  try {
    modelBytes = statSync(modelFile).size
  } catch {
    modelBytes = 0
  }
  // (fix 257) Custom models have a lower threshold (lightweight quants < 100 MB are valid)
  const minBytes = backend === 'custom' ? 1_000_000 : 100_000_000
  return NextResponse.json({
    ...s,
    // Assistant is currently streaming a response (generation lock)
    streaming: llmStreaming(),
    // Assistant is busy: loading model (chatActive) OR writing a response —
    // this exact state should lock the generation button in the UI
    assistantBusy: assertGenerationAllowed() !== null,
    // Video generation in progress — chat locked in the UI
    blockedByGeneration: await comfyBusyCached(),
    modelId: activeLlmModelId(),
    // (fix 257) Model file name — for UI labels (custom model)
    modelName: basename(modelFile),
    modelBytes,
    modelReady: s.modelExists && modelBytes > minBytes,
    // Cheap existence check that also works before any spawn
    fileExists: existsSync(modelFile),
  })
}
