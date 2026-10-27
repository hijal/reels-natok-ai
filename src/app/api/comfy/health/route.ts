import { NextResponse } from 'next/server'
import { COMFY_URL } from '@/lib/comfy/minimax-h3-client'

/**
 * GET /api/comfy/health
 * Pings ComfyUI /system_stats to check connectivity and return system info.
 */
export async function GET() {
  try {
    // (fix 54) 12 s instead of 5 s: during active generation the ComfyUI event loop
    // is blocked by long GPU operations (diffusion steps,
    // unloading/loading models with dynamic VRAM), and /system_stats can
    // respond slowly. 5 s caused false 502s in the middle of running generation.
    const res = await fetch(`${COMFY_URL}/system_stats`, {
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      return NextResponse.json({ ok: false, error: `HTTP ${res.status}` }, { status: 502 })
    }
    const data = await res.json()
    return NextResponse.json({ ok: true, ...data })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: msg }, { status: 502 })
  }
}
