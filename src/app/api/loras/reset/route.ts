import { NextResponse } from 'next/server'
import { resetLorasToDefaults } from '@/lib/loras-config'

/**
 * POST /api/loras/reset — (fix 130) Factory reset for LoRA settings.
 *
 * All LoRAs are disabled (enabled=false), strength reset to 1.0,
 * triggers cleared. File data/loras.json is rewritten with "clean"
 * state. Called from "Factory reset" in settings.
 */
export async function POST() {
  try {
    const defaults = resetLorasToDefaults()
    return NextResponse.json({
      ok: true,
      count: defaults.length,
      message: `LoRA settings reset (${defaults.length} LoRAs)`,
    })
  } catch (e) {
    console.error('[loras/reset] error:', e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed to reset LoRA settings' },
      { status: 500 },
    )
  }
}
