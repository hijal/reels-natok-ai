import { NextResponse } from 'next/server'
import { deleteModel } from '@/lib/model-downloader'
import { activeLlmModelId, llmBackend } from '@/lib/llm-runner'

export const dynamic = 'force-dynamic'

/**
 * POST /api/models/delete — delete downloaded model files (fix 139).
 *
 * Guards:
 *  • Active LLM quantization (llm_assistant*, llm_assistant_qwen) — cannot delete:
 *    first switch the assistant model in the selector.
 *  • Bonsai selected as assistant → main PQ2_0 quant, engine, mmproj —
 *    locked (required by running backend). Lightweight optional PTQ1_0 —
 *    can be deleted freely: backend picks it up only if PQ2_0 is absent.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}))
    const modelId: string = body.modelId || ''

    if (!modelId) {
      return NextResponse.json({ error: 'Specify modelId' }, { status: 400 })
    }

    // (fix 164) Lightweight Bonsai quant (optional) — do not block even when
    // Bonsai is selected: backend will pick up PTQ1_0 only if PQ2_0 is absent.
    // Deleting it is a valid action (reclaiming space when PQ2_0 is installed).
    const isBonsaiLight = modelId === 'bonsai_model_light'

    // Main Bonsai model (PQ2_0), engine, mmproj — locked when
    // Bonsai is selected as assistant: without them backend will not start.
    if (llmBackend() === 'bonsai' && modelId.startsWith('bonsai_') && !isBonsaiLight) {
      return NextResponse.json(
        { error: 'Bonsai is currently selected as the assistant model. First switch the assistant model (Settings → LLM), then delete.' },
        { status: 409 },
      )
    }

    // Active LLM quantization (Gemma/Qwen) — locked.
    if (modelId === activeLlmModelId()) {
      return NextResponse.json(
        { error: 'This model is currently selected as the assistant. First switch the assistant model (Settings → LLM), then delete.' },
        { status: 409 },
      )
    }

    const result = deleteModel(modelId)
    if (!result.ok) {
      return NextResponse.json(result, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    )
  }
}
