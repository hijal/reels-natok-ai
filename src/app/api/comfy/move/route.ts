import { NextRequest, NextResponse } from 'next/server'
import { moveOutputFile } from '@/lib/gallery-folders'

/**
 * POST /api/comfy/move — move output file between gallery folders
 * (drag&drop in shared gallery, fix 91). Body:
 *   { filename, from: string ('' = shared), to: string }
 * Along with the file, its .meta.json sidecar is moved.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const r = await moveOutputFile(String(body?.filename ?? ''), String(body?.from ?? ''), String(body?.to ?? ''))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
