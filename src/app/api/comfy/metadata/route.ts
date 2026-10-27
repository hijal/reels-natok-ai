import { NextRequest, NextResponse } from 'next/server'
import { writeMetaSidecar, clearPendingMeta } from '@/lib/pending-meta'
import { readDraftPrompt } from '@/lib/refine-meta'

/**
 * POST /api/comfy/metadata
 * Body: { filename, subfolder, params: {...} }
 * Client fast path: saves a .meta.json sidecar next to the output file.
 * The server-side pending copy is cleared for this job so it never
 * overwrites the fresher client data.
 *
 * GET /api/comfy/metadata?filename=&subfolder=
 * Reads output sidecar and returns draft prompt, cleaned up for
 * refine-conditioning (without audio sections and reference tags). Prefill
 * Caption of the "Refine" tab was removed (prompt/references resolved by server
 * /api/comfy/refine via readDraftSource) — endpoint remains as a
 * sidecar reading utility.
 */
export const dynamic = 'force-dynamic'

interface MetadataBody {
  filename: string
  subfolder?: string
  params: Record<string, unknown>
}

export async function GET(req: NextRequest) {
  const filename = req.nextUrl.searchParams.get('filename') || ''
  const subfolder = req.nextUrl.searchParams.get('subfolder') || ''
  if (!filename) {
    return NextResponse.json({ error: 'filename is required' }, { status: 400 })
  }
  const prompt = readDraftPrompt(subfolder, filename)
  return NextResponse.json({ exists: prompt !== null, prompt })
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as MetadataBody

    if (!body.filename || !body.params) {
      return NextResponse.json({ error: 'filename and params are required' }, { status: 400 })
    }

    // (fix 722) MERGE, not overwrite: the server-side writer (pending-meta)
    // might have already written its set of fields into this same sidecar — actually
    // applied custom LoRAs (`lora`), output_subfolder, flf_resolution,
    // etc. The client doesn't know about them, and full overwrite wiped them out
    // ("metadata is not recorded completely or everywhere"). New fields override
    // old ones, unfamiliar old fields are preserved.
    const metaFile = writeMetaSidecar(body.filename, body.subfolder || '', body.params, { merge: true })
    if (!metaFile) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }

    // Drop the server-side pending copy (client data wins)
    if (typeof body.params.job_id === 'string') {
      clearPendingMeta(body.params.job_id)
    }

    return NextResponse.json({ ok: true, path: metaFile })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save metadata' },
      { status: 500 },
    )
  }
}
