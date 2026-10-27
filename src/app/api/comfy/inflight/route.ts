import { NextRequest, NextResponse } from 'next/server'
import { lookupInflight } from '@/lib/inflight-journal'

/**
 * (fix 331) GET /api/comfy/inflight?token=<clientToken>
 * Restores prompt_id after page reload during POST
 * /api/comfy/generate: frontend sent clientToken in POST body, server
 * recorded the mapping when queued in ComfyUI. 404 — task is not yet
 * queued (POST is still being processed) or token is unknown.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const token = searchParams.get('token')
  if (!token || token.length > 100) {
    return NextResponse.json({ error: 'token required' }, { status: 400 })
  }
  const promptId = lookupInflight(token)
  if (!promptId) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  return NextResponse.json({ prompt_id: promptId })
}
