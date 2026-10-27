import { NextRequest } from 'next/server'
import path from 'path'
import { serveLocalFile, isPathInsideRoots } from '@/lib/local-file'
import { upscaleAllowedRoots } from '@/lib/upscale-paths'

/**
 * (fix 74) GET /api/upscale/file?path=<absolute path>
 * Result streaming (Range support, video seek). Paths are restricted to
 * allowed roots: shared ComfyUI output folder (results from fix 74.2),
 * data/upscale-output (legacy results), data/upscale-input, upscale/outputs.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get('path') ?? ''
  if (!raw) {
    return new Response('Missing path', { status: 400 })
  }
  const resolved = path.resolve(raw)
  // (fix 716) Segment-based check (isPathInsideRoots) instead of
  // prefix startsWith('..'): a legitimate file "..foo.mp4" inside
  // an allowed folder is no longer rejected with 403.
  if (!isPathInsideRoots(resolved, upscaleAllowedRoots())) {
    return new Response('Forbidden path', { status: 403 })
  }
  const res = await serveLocalFile(req, path.basename(resolved), resolved)
  if (!res) {
    return new Response('Not found', { status: 404 })
  }
  return res
}
