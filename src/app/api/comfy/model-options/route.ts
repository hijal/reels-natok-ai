import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/comfy/model-options?model_type=minimax_h3_ref2va
 * Returns H3 model options for the UI.
 */
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const modelType = searchParams.get('model_type') || ''

  if (!modelType.includes('minimax_h3')) {
    return NextResponse.json({}, { status: 404 })
  }

  return NextResponse.json({
    model_type: modelType,
    fps: 24,
    // Bounds of the H3 model: 60 = 2.5 s min, 719 = 17·42+5 ≈ 30 s max.
    // (fix 59) max increased from 14.4 s (345) to 30 s — in fact the model
    // generates 30-second clips as well, there is no real hard limit of 14.4 s.
    // (fix 55): min 124 is lower bound, backend raises lower values itself.
    // (fix 131) min decreased 124 → 42: minimum is now ~2 s (42 frames = 1.75 s
    // at 24 fps, closest to 2 s on 17n+5 grid).
    // (fix 138) min increased 42 → 60: minimum 2.5 s (60 frames at 24 fps),
    // 1.75 s (42 frames) completely removed from range.
    frames_minimum: 60,
    frames_maximum: 719,
    frames_steps: 17,
    default_num_inference_steps: 4,
    turbo_available: true,
    // (fix 124) Values = EXACT final resolution (short side
    // = quality, aspect ratio exact). Generation is slightly larger (each
    // axis rounded up to multiple of 32), with crop at the end exactly to this nominal:
    // 16:9 1080p → generation 1920×1088 → final 1920×1080.
    resolution_presets: {
      '480p': {
        label: '480p',
        values: {
          '16:9': '854x480',
          '9:16': '480x854',
          '1:1': '480x480',
          '4:3': '640x480',
          '3:4': '480x640',
          '21:9': '1120x480',
        },
      },
      '720p': {
        label: '720p',
        values: {
          '16:9': '1280x720',
          '9:16': '720x1280',
          '1:1': '720x720',
          '4:3': '960x720',
          '3:4': '720x960',
          '21:9': '1680x720',
        },
      },
      '1080p': {
        label: '1080p',
        values: {
          '16:9': '1920x1080',
          '9:16': '1080x1920',
          '1:1': '1080x1080',
          '21:9': '2520x1080',
        },
      },
    },
    resolution_preset_order: ['480p', '720p', '1080p'],
    minimax_h3_text_encoder_choices: [
      { value: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', label: 'Qwen3VL 32B (recommended)' },
    ],
    minimax_h3_text_encoder_default: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    omni_reference_limits: { image: 9, video: 3, audio: 3, total: 15 },
    omni_reference_detail_choices: [
      ['Match output (recommended)', 'match'],
      ['Maximum detail', 'max'],
    ],
  }, {
    // Static stub data — safe for the browser to cache for the session
    headers: { 'Cache-Control': 'private, max-age=300' },
  })
}
