import { NextRequest, NextResponse } from 'next/server'
import {
  createGalleryFolder,
  deleteGalleryFolder,
  listGalleryFolders,
  renameGalleryFolder,
} from '@/lib/gallery-folders'

/**
 * Gallery folders (fix 91) — subfolders of the ComfyUI output directory.
 * GET    → { folders: string[] }            (common folder '' is not included)
 * POST   → { name } create
 * PATCH  → { from, to } rename (fix 122)
 * DELETE → { name } delete (empty only)
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ folders: await listGalleryFolders() })
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const r = await createGalleryFolder(String(body?.name ?? ''))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, name: r.name, folders: await listGalleryFolders() })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json()
    const r = await renameGalleryFolder(String(body?.from ?? ''), String(body?.to ?? ''))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, name: r.name, folders: await listGalleryFolders() })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json()
    const r = await deleteGalleryFolder(String(body?.name ?? ''))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    return NextResponse.json({ ok: true, folders: await listGalleryFolders() })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
