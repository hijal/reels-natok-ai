import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { buildTileUpscaleWorkflow, computeTileGeometry, DEFAULT_TILE_UPSCALE_PROMPT } from '@/lib/comfy/tile-upscale-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readMetaImageRefs, resolveSourceLatent } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)
import { enabledCustomLoras, loraTriggerSuffix } from '@/lib/loras-config' // (fix 483)

/**
 * POST /api/comfy/tile-upscale — tiled latent upscale (MMH3UltimateUpscale).
 *
 * Body:
 *   sourceFilename  — file name in ComfyUI output folder (or inputSource)
 *   sourceSubfolder — output subfolder
 *   prompt?         — caption (default: enhance prompt)
 *   seed?           — (-1/undefined = random)
 *   tileSize?       — tile size, px (multiple of 32). Default 768.
 *                     Number of tiles is computed automatically (specific_size).
 *   overlap?        — spatial overlap, px. Default 128.
 *   fade?           — fade width, px. Default 64.
 *   chunkFrames?    — temporal chunk length, frames (multiple of 17). Default 136.
 *   temporalOverlap?— temporal overlap, frames. Default 17.
 *   anchorStrength?— 0–1. Default 0.999.
 *   inputSource?    — file name already in ComfyUI input/ (file from disk).
 *
 * Pipeline: copy output → input (or reuse), ffprobe, assemble workflow
 * (buildTileUpscaleWorkflow) and submit via shared VRAM arbiter.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      prompt?: string
      seed?: number
      tileSize?: number
      overlap?: number
      fade?: number
      chunkFrames?: number
      temporalOverlap?: number
      anchorStrength?: number
      inputSource?: string
      targetResolution?: number
      denoise?: number
      steps?: number
      syncTiles?: boolean
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (or inputSource) is required' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // (fix 483) LoRA from settings — same as in /api/comfy/generate: model
    // receives them via customLoras chain (turbo lora is normal entry, ON by
    // default), trigger words are appended to conditioning prompt.
    // In meta the prompt is written WITHOUT triggers — "Retry" will add them again based on
    // current list, otherwise they would accumulate (fix 89).
    const customLoraEntries = enabledCustomLoras()
    const customLoras = customLoraEntries.length > 0
      ? customLoraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    const loraSuffix = loraTriggerSuffix(customLoraEntries)
    // Generation prompt: clean prompt + triggers; if there is no prompt
    // at all, but there are triggers — default enhance prompt serves as base.
    const promptWithTriggers = (p: string | undefined): string | undefined => {
      if (!loraSuffix) return p
      const base = (p ?? '').trim() || DEFAULT_TILE_UPSCALE_PROMPT
      return `${base} ${loraSuffix}`
    }

    // ─── Copy output → input ───
    // (fix 495) Nested folders: subfolder — multi-level relative
    // path ('a/b'); '.'/'..' segments are dropped (fix 317).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    // (fix 722) Tile upscale parameters — into sidecar. Previously
    // metadata had NOT A SINGLE one of them (no tile size, no overlaps,
    // no denoise/steps): from result sidecar one could not understand how it was
    // constructed. Values are defaults from tile-upscale-template.ts.
    const tileCommonMeta = {
      pipeline: 'full',
      tile_size: body.tileSize ?? 768,
      tile_overlap: body.overlap ?? 128,
      tile_fade: body.fade ?? 64,
      chunk_frames: body.chunkFrames ?? 136,
      temporal_overlap: body.temporalOverlap ?? 17,
      anchor_strength: body.anchorStrength ?? 0.999,
      target_resolution: body.targetResolution ?? 1080,
      denoise: body.denoise ?? 0.1,
      // pass1_steps — unified contract for "Steps" row of MetaDialog (same as
      // refine/face-refine). steps field is retained: written by older sidecars.
      pass1_steps: body.steps ?? 2,
      steps: body.steps ?? 2,
      ...(body.syncTiles === true && { sync_tiles: true }),
      ...(customLoras ? { lora: customLoras.map((l) => l.name).join(', ') } : {}),
    }

    // ─── File from disk (inputSource) ───
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `File not found in input: ${inName}` }, { status: 404 })
      }
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      let probe: { width: number; height: number; frames: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }

      // (fix 479) tile geometry for monotonic progress
      const tuGeom = computeTileGeometry({
        sourceWidth: probe.width,
        sourceHeight: probe.height,
        targetResolution: body.targetResolution,
        tileSize: body.tileSize,
        overlap: body.overlap,
        chunkFrames: body.chunkFrames,
        temporalOverlap: body.temporalOverlap,
        steps: body.steps,
        sourceFrames: probe.frames,
      })
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildTileUpscaleWorkflow({
            sourceVideo: inName,
            diffusionModel: cfg.diffusionModel || undefined,
            sourceAudioPath: inPath, // (fix 488) audio for latent branch
            sourceWidth: probe.width,
            sourceHeight: probe.height,
            prompt: promptWithTriggers(userPrompt), // (fix 483) LoRA triggers
            seed: body.seed,
            tileSize: body.tileSize,
            overlap: body.overlap,
            fade: body.fade,
            chunkFrames: body.chunkFrames,
            temporalOverlap: body.temporalOverlap,
            anchorStrength: body.anchorStrength,
            outputSubfolder: '',
            targetResolution: body.targetResolution,
            denoise: body.denoise,
            steps: body.steps,
            syncTiles: body.syncTiles,
            ...(customLoras ? { customLoras } : {}), // (fix 483)
          }),
          [['tu_upscale']],
          tuGeom,
        ),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: userPrompt,
          model_type: 'minimax_h3_tileupscale',
          workflow: 'tile-upscale-MMH3UltimateUpscale',
          generation_mode: 'tileupscale',
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          seed: body.seed ?? -1,
          prompt_source: 'user',
          input_source: true,
          ...tileCommonMeta, // (fix 722) tile params + LoRA
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        tileInfo: tuGeom ?? undefined, // (fix 479)
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
        // (fix 362) Old pattern skipped _tileup1.
        destName = `${stem}_tileup${n++}${ext}`
        destPath = path.join(cfg.inputDir, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }

    let probe: { width: number; height: number; frames: number }
    try {
      probe = await probeVideoFile(destPath)
    } catch (e) {
      await fs.unlink(destPath).catch(() => {})
      return NextResponse.json(
        { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
        { status: 400 },
      )
    }

    // Prompt: user > chain from meta > default
    // (fix 319) readPromptChain instead of readDraftPrompt: for extend-combined
    // inherit ENTIRE chain "source → clips".
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const draftPrompt = userPrompt ? null : readPromptChain(sub, safeName)
    const resolvedPrompt = userPrompt || draftPrompt || undefined
    const promptSource = userPrompt ? 'user' : draftPrompt ? 'draft-meta' : 'default'
    // (fix 319) Image references of source — into result meta (same as
    // generation: [{ type: 'image', path, role }]); empty omitted.
    const tuMetaRefs = readMetaImageRefs(sub, safeName)

    // ─── (fix 381) Lossless branch: source latent from meta ───
    // Target geometry is computed from LATENT CANVAS (it is >= mp4 due to crop
    // in generation): target "short side = targetResolution" must be
    // no smaller than canvas, otherwise internal latent upscaler would get
    // downscaling (prohibited) → fallback to mp4 path.
    const tileTarget = Number(body.targetResolution) || 1080
    let sourceLatent: string | undefined
    let latentW = probe.width
    let latentH = probe.height
    if (tileTarget >= Math.min(latentW, latentH)) {
      const resolved = resolveSourceLatent(sub, safeName, probe, (reason) =>
        console.warn(`[tile-upscale] lossless branch disabled (${safeName}): ${reason}`),
      )
      if (resolved && tileTarget >= Math.min(resolved.width, resolved.height)) {
        sourceLatent = resolved.file
        latentW = resolved.width
        latentH = resolved.height
      }
    }

    // (fix 479) tile geometry for monotonic progress
    // Dimensions: in latent branch — latent canvas, otherwise — mp4 pixels
    const tuSrcW = sourceLatent ? latentW : probe.width
    const tuSrcH = sourceLatent ? latentH : probe.height
    const tuGeom = computeTileGeometry({
      sourceWidth: tuSrcW,
      sourceHeight: tuSrcH,
      targetResolution: body.targetResolution,
      tileSize: body.tileSize,
      overlap: body.overlap,
      chunkFrames: body.chunkFrames,
      temporalOverlap: body.temporalOverlap,
      steps: body.steps,
      sourceFrames: probe.frames,
    })
    const run = await runGeneration(() =>
      submitWorkflowJson(
        buildTileUpscaleWorkflow({
          sourceVideo: destName,
          diffusionModel: cfg.diffusionModel || undefined,
          sourceAudioPath: destPath, // (fix 488) audio for latent branch
          videoFormat: getVideoFormatSettings(), // (fix 386)
          // (fix 381) lossless branch: dimensions = latent canvas, mp4 loaded
          // only first frame + audio; otherwise — as before (pixel path)
          ...(sourceLatent && { sourceLatent, sourceFrames: probe.frames }),
          sourceWidth: tuSrcW,
          sourceHeight: tuSrcH,
          prompt: promptWithTriggers(resolvedPrompt), // (fix 483) LoRA triggers
          seed: body.seed,
          tileSize: body.tileSize,
          overlap: body.overlap,
          fade: body.fade,
          chunkFrames: body.chunkFrames,
          temporalOverlap: body.temporalOverlap,
          anchorStrength: body.anchorStrength,
          outputSubfolder: sub,
          targetResolution: body.targetResolution,
          denoise: body.denoise,
          steps: body.steps,
          syncTiles: body.syncTiles,
          ...(customLoras ? { customLoras } : {}), // (fix 483)
        }),
        [['tu_upscale']],
        tuGeom, // (fix 479)
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
        prompt: resolvedPrompt ?? '',
        model_type: 'minimax_h3_tileupscale',
        workflow: 'tile-upscale-MMH3UltimateUpscale',
        generation_mode: 'tileupscale',
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        seed: body.seed ?? -1,
        prompt_source: promptSource,
        ...tileCommonMeta, // (fix 722) tile params + LoRA
        // (fix 381) lossless mode: upscale started from generation latent
        ...(sourceLatent && { latent_source: sourceLatent }),
        // (fix 319) inherit source references
        ...(tuMetaRefs.length > 0 && {
          references: tuMetaRefs.map((r) => ({ type: 'image', path: r.path, role: r.role })),
        }),
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: destName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      promptSource,
      promptUsed: resolvedPrompt ?? '',
      lossless: !!sourceLatent, // (fix 381)
      tileInfo: tuGeom ?? undefined, // (fix 479)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
