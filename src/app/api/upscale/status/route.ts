import { NextResponse } from 'next/server'
import { getAppConfig } from '@/lib/app-config'
import { upscaleStatus, upscaleDir, upscalePort, fetchUpscaleHealth } from '@/lib/upscale-runner'

/**
 * (fix 74) GET /api/upscale/status
 * Upscale tab (DLSS bridge): config + service state + bridge health.
 *
 * (fix 77) Pure read — without side effects. Autostart was removed from here:
 * previously every GET that caught the service "not running" spawned ensureUpscale —
 * with an orphan/zombie on the port this caused infinite process spam.
 * Autostart now lives in the client singleton useUpscaleService
 * (src/lib/upscale-service.ts) and survives tab switching.
 *
 * While service is starting, we do a best-effort health check: the bridge may already
 * be responding, so UI sees a live log_tail ("Preparing runtime...")
 * instead of a dead "starting..." spinner.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const cfg = getAppConfig()
  const service = upscaleStatus()

  let health: unknown = null
  if (service.running) {
    try {
      health = await fetchUpscaleHealth(2500)
    } catch {
      health = null
    }
  } else if (service.starting) {
    try {
      health = await fetchUpscaleHealth(1200)
    } catch {
      health = null
    }
  }

  return NextResponse.json({
    enabled: cfg.upscaleEnabled,
    port: upscalePort(),
    dir: upscaleDir(),
    service,
    health,
  })
}
