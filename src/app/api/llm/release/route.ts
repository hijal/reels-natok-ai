import { NextRequest, NextResponse } from 'next/server'
import { forceReleaseAssistantLock } from '@/lib/vram-arbiter'

export const dynamic = 'force-dynamic'

/**
 * POST /api/llm/release — (fix 110) forced release of assistant lock
 * (stuck streaming counter). Invoked by UI fallback when
 * the "Generate" button remains locked for more than 60 s, even though
 * there is no active stream on the client anymore. A fresh lock (stream actually running) is NOT released:
 * forceReleaseAssistantLock checks lock age.
 *
 * (fix 692) `?force=1` — unconditional reset: ignores minAge, clears
 * streamingCount + chatActive immediately. Used by second pass of client
 * fallback when the first (non-force) did not help.
 */
export async function POST(req: NextRequest) {
  const force = req.nextUrl.searchParams.get('force') === '1'
  const released = forceReleaseAssistantLock(60_000, force)
  return NextResponse.json({ ok: true, released, forced: force })
}
