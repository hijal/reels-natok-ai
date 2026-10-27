import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { buildFpsWorkflow } from '@/lib/comfy/fps-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readMetaImageRefs } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)

/**
 * POST /api/comfy/fps — frame interpolation (VFI): RIFE VFI / FILM VFI. (fix 268)
 *
 * Body:
 *   sourceFilename  — file name in ComfyUI output folder (or inputSource)
 *   sourceSubfolder — output subfolder
 *   mode?           — 'rife' | 'film'. Default 'rife'.
 *   multiplier?     — FPS multiplier (2–1000). Default 2.
 *   (fix 269) rifeModel/filmModel are not accepted: one model per
 *   mode, fixed in fps-template.ts (rife49.pth / film_net_fp32.pt).
 *   rifeBatchSize?  — RIFE batch_size (1–64). Default 4.
 *   rifeScale?      — RIFE scale_factor (0.25|0.5|1|2|4). Default 1.
 *   rifeDtype?      — RIFE dtype (float32|float16|bfloat16). Default 'float16'.
 *   rifeFastMode?   — RIFE fast_mode. Default false.
 *   rifeEnsemble?   — RIFE ensemble. Default true.
 *   clearCacheAfterNFrames? — anti-OOM (1–1000). Default 4.
 *   inputSource?    — file name already in ComfyUI input/ (file from disk).
 *
 * Pipeline: copy output → input (or reuse), ffprobe (width/height/frames/fps),
 * assemble workflow (buildFpsWorkflow) and submit via shared VRAM arbiter.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      mode?: 'rife' | 'film'
      multiplier?: number
      rifeBatchSize?: number
      rifeScale?: number
      rifeDtype?: string
      rifeFastMode?: boolean
      rifeEnsemble?: boolean
      clearCacheAfterNFrames?: number
      inputSource?: string
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (or inputSource) is required' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // ─── Copy output → input ───
    // (fix 495) Nested folders: subfolder — multi-level relative
    // path ('a/b'); '.'/'..' segments are dropped (fix 317).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    const workflowParams = {
      mode: body.mode,
      multiplier: body.multiplier,
      // (fix 269) RIFE/FILM models are fixed in fps-template.ts.
      rifeBatchSize: body.rifeBatchSize,
      rifeScale: body.rifeScale,
      rifeDtype: body.rifeDtype,
      rifeFastMode: body.rifeFastMode,
      rifeEnsemble: body.rifeEnsemble,
      clearCacheAfterNFrames: body.clearCacheAfterNFrames,
      outputSubfolder: '',
    }

    // (fix 722) Common FPS sidecar fields. Previously, frame interpolation
    // metadata had NEITHER pipeline, NOR seed, NOR RIFE settings themselves — from the
    // result sidecar it was impossible to tell how exactly it was produced.
    // Final geometry (frames/resolution/duration) is added by
    // finalizePendingMeta — via probe of the file itself (FPS has ×multiplier
    // more frames than source, planned numbers were inadequate).
    const fpsCommonMeta = {
      pipeline: 'full',
      ...(body.mode === 'rife' && {
        rife_batch_size: body.rifeBatchSize ?? null,
        rife_scale: body.rifeScale ?? null,
        rife_dtype: body.rifeDtype ?? null,
        rife_fast_mode: body.rifeFastMode === true,
        rife_ensemble: body.rifeEnsemble === true,
      }),
      ...(body.clearCacheAfterNFrames != null && {
        clear_cache_after_n_frames: body.clearCacheAfterNFrames,
      }),
    }

    // ─── File from disk (inputSource) ───
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `File not found in input: ${inName}` }, { status: 404 })
      }
      let probe: { width: number; height: number; frames: number; durationSec: number; fps?: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }

      // (fix 268) fps from r_frame_rate (probe.fps), fallback — frames/duration.
      const srcFps = probe.fps ?? Math.max(1, Math.min(120, Math.round((probe.frames / Math.max(probe.durationSec, 0.01)) * 100) / 100))
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildFpsWorkflow({ sourceVideo: inName, sourceFps: srcFps, ...workflowParams, videoFormat: getVideoFormatSettings() }),
        ),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          model_type: 'minimax_h3_fps',
          workflow: 'fps-RIFE-VFI|FILM-VFI',
          generation_mode: 'fps',
          fps_mode: body.mode ?? 'rife',
          fps_multiplier: body.multiplier ?? 2,
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
          input_source: true,
          ...fpsCommonMeta, // (fix 722)
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
      })
    }

    // ─── File from gallery (output) ───
    const sourcePath = path.join(cfg.outputDir, sub, safeName)
    // (fix 318) Safeguard: target path must remain inside outputDir.
    const outputRoot = path.resolve(cfg.outputDir)
    if (!path.resolve(sourcePath).startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
    if (!existsSync(sourcePath)) {
      return NextResponse.json({ error: `File not found: ${safeName}` }, { status: 404 })
    }

    await fs.mkdir(cfg.inputDir, { recursive: true })
    let destName = safeName
    let destPath = path.join(cfg.inputDir, destName)
    let n = 1
    while (true) {
      try {
        // (fix 346) COPYFILE_EXCL — atomically, without unlink window;
        // catch ONLY EEXIST, rethrow other errors.
        await fs.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const ext = path.extname(safeName)
        const stem = safeName.slice(0, safeName.length - ext.length)
        // (fix 362) Old pattern skipped _fps1 and gave collisions without number.
        destName = `${stem}_fps${n++}${ext}`
        destPath = path.join(cfg.inputDir, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }

    let probe: { width: number; height: number; frames: number; durationSec: number; fps?: number }
    try {
      probe = await probeVideoFile(destPath)
    } catch (e) {
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json(
        { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      )
    }

    // (fix 319) Inheritance from source sidecar: prompt chain
    // (for extend-combined — entire chain "source → clips") and image references.
    // No meta / empty — do not add fields.
    const fpsPrompt = readPromptChain(sub, safeName)
    const fpsMetaRefs = readMetaImageRefs(sub, safeName)

    // (fix 268) fps from r_frame_rate (probe.fps), fallback — frames/duration.
    const srcFps = probe.fps ?? Math.max(1, Math.min(120, Math.round((probe.frames / Math.max(probe.durationSec, 0.01)) * 100) / 100))
    const run = await runGeneration(() =>
      submitWorkflowJson(
        buildFpsWorkflow({ sourceVideo: destName, sourceFps: srcFps, ...workflowParams, outputSubfolder: sub, videoFormat: getVideoFormatSettings() }), // (fix 367) result into original folder
      ),
    )
    if (!run.ok) {
      // (fix 344) Rollback copy in input/ — otherwise orphaned file.
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      recordPendingMetaRaw(run.result.prompt_id, {
        model_type: 'minimax_h3_fps',
        workflow: 'fps-RIFE-VFI|FILM-VFI',
        generation_mode: 'fps',
        fps_mode: body.mode ?? 'rife',
        fps_multiplier: body.multiplier ?? 2,
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
        ...fpsCommonMeta, // (fix 722)
        // (fix 319) inherit prompt chain and references of source
        ...(fpsPrompt && { prompt: fpsPrompt }),
        ...(fpsMetaRefs.length > 0 && {
          references: fpsMetaRefs.map((r) => ({ type: 'image', path: r.path, role: r.role })),
        }),
      })
    }
    return NextResponse.json({
      ...run.result,
      source: { width: probe.width, height: probe.height, frames: probe.frames, fps: srcFps },
    })
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    )
  }
}
