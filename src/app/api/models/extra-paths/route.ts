import { NextRequest, NextResponse } from 'next/server'
import { statSync } from 'fs'
import { detectExtraEntries } from '@/lib/extra-model-paths'

export const dynamic = 'force-dynamic'

/**
 * POST /api/models/extra-paths — prepare folder for addition to "Custom model
 * folders" (fix 257). Checks existence and categorizes root with standard
 * ComfyUI structure by categories (see detectExtraEntries).
 *
 * Body: { path: string } — absolute folder path.
 * Response: { ok, entries: [{path, category}] }.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as { path?: string }
    const p = (body?.path ?? '').trim()
    if (!p) {
      return NextResponse.json({ error: 'Specify folder path' }, { status: 400 })
    }
    let isDir = false
    try {
      isDir = statSync(p).isDirectory()
    } catch {
      return NextResponse.json({ error: `Folder not found: ${p}` }, { status: 404 })
    }
    if (!isDir) {
      return NextResponse.json({ error: 'This is a file, a folder is required' }, { status: 400 })
    }
    return NextResponse.json({ ok: true, entries: detectExtraEntries(p) })
  } catch {
    return NextResponse.json({ error: 'Failed to verify folder' }, { status: 500 })
  }
}
