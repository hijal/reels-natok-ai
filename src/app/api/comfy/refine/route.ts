import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitRefine, submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import { refineDimensions, buildChunkedRefineWorkflow, planChunkWindows, refineChunkStages } from '@/lib/comfy/refine-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readPromptChainParts, readMetaImageRefs, resolveSourceLatent } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server' // (fix 386)
import { enabledCustomLoras, loraTriggerSuffix } from '@/lib/loras-config' // (fix 483)

/**
 * POST /api/comfy/refine — generative v2v upscale of finished video
 * (latent Pass 2 scheme: VAEEncode of source → LatentUpscaler3D →
 * short run along sigma ladder Pass 2).
 *
 * Body:
 *   sourceFilename  — file name in ComfyUI output folder (shared gallery)
 *   sourceSubfolder — output subfolder ('' = root)
 *   target          — 'same' | 'x2' | 720 | 1080 (target short side;
 *                     'x2' = doubling resolution — latent x2 recipe)
 *   prompt?         — caption (default: enhance prompt)
 *   seed?           — (-1/undefined = random)
 *   steps?          — sigma ladder: 3 (default) | 4 | 5 | 6 | 7 steps
 *   sigmaStart?     — sigma_start of ladder (0.1–0.95, "how much noise to remove";
 *                     undefined = reference ladder)
 *   ("By parts" mode, chunk parameters):
 *   skipFrames?     — skip first N frames (chunk start)
 *   frameCap?       — load N frames (chunk length)
 *   chunkJob?       — chunk job: output without audio, prefix refinepart
 *   inputName?      — reuse file already copied to input (starting from 2nd chunk)
 *   sourceWidth?/sourceHeight? — dimensions when reusing inputName (no ffprobe)
 *
 * Pipeline: copy output → input (or reuse), ffprobe (W/H), assemble workflow
 * (buildRefineWorkflow) and submit via shared VRAM arbiter.
 */
export const dynamic = 'force-dynamic'

/** (fix 318) references into sidecar — same format written by generation
 *  (pending-meta.ts bodyToMetaParams): [{ type: 'image', path, role }]. */
function metaRefsForSidecar(refs: Array<{ path: string; role: string }>) {
  return refs.map((r) => ({ type: 'image', path: r.path, role: r.role }))
}

/** (fix 494) Megapixels → short side (even), preserving
 *  source aspect ratio. Cap 2160 = 4K short side. */
function targetFromMp(srcW: number, srcH: number, mp: number): number {
  const clampMp = Math.min(8.3, Math.max(0.05, mp))
  const scale = Math.sqrt((clampMp * 1e6) / (srcW * srcH))
  const short = Math.min(srcW, srcH) * scale
  return Math.min(2160, Math.max(144, 2 * Math.round(short / 2)))
}

/** (fix 494) Effective target: targetMp overrides target. */
function effectiveTarget(
  body: { target?: 'same' | 'x2' | number; targetMp?: number },
  srcW: number,
  srcH: number,
): 'same' | 'x2' | number {
  if (typeof body.targetMp === 'number' && Number.isFinite(body.targetMp) && body.targetMp > 0) {
    return targetFromMp(srcW, srcH, body.targetMp)
  }
  return body.target === 'same' || body.target === 'x2' || typeof body.target === 'number'
    ? body.target
    : 'same'
}

export async function POST(req: NextRequest) {
  // (fix 716) copiedPath lifted out of try — outer catch must have
  // the ability to delete fresh copy in input/ if something failed BEFORE submitting
  // the task to ComfyUI. Previously the variable lived inside try, and orphaned copies
  // (and each refine run copies source to input/) accumulated.
  let copiedPath: string | null = null
  let submitted = false
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      target?: 'same' | 'x2' | number
      prompt?: string
      seed?: number
      steps?: number
      /** sigma_start of ladder (0.1–0.95) — slider "how much noise to remove". */
      sigmaStart?: number
      skipFrames?: number
      frameCap?: number
      chunkJob?: boolean
      inputName?: string
      sourceWidth?: number
      sourceHeight?: number
      /** (fix 253) 'chunks' — unified latent-masked workflow. */
      mode?: 'whole' | 'chunks'
      chunkSeconds?: number
      /** (fix 265) Name of file already residing in ComfyUI input/ (file from disk,
          uploaded via /api/comfy/upload). This file is treated as source,
          not a copy from output. */
      inputSource?: string
      /** (fix 317) Reference size mode ('match' | 'max', default 'max'). */
      refImageSize?: 'match' | 'max'
      /** (fix 408) Veda Sparse Attention + node settings. */
      vedaAttention?: boolean
      vedaGeneratedSparsity?: string
      vedaReferenceSparsity?: string
      vedaFullAttentionLayers?: string
      vedaFullAttentionSteps?: string
      vedaVerbose?: boolean
      /** (fix 466) Sol-Attn + node settings (toggle from app settings). */
      sparseAttention?: boolean
      sparseTau?: number
      sparseStartPercent?: number
      sparseEndPercent?: number
      sparseMinTokens?: number
      sparseExtraTokens?: number
      /** (fix 492) Mux original track of source instead of
       *  regenerated audio (checkbox in Refine tab). */
      keepOriginalAudio?: boolean
      /** (fix 494) "Free resolution": target in megapixels (up to 4K =
       *  8.3 MP). Overrides target — conversion to short side happens here,
       *  based on real source dimensions (latent canvas in lossless branch). */
      targetMp?: number
      /** (fix 509) User reference images (file names in
       *  input/, up to 8) — for sources from disk (inputSource) that
       *  lack .meta.json with references. Occupy slots <Picture 1..N>,
       *  first frame of source is added last, as usual. */
      refImages?: string[]
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (or inputSource) is required' }, { status: 400 })
    }

    // Fast-path 409 (same as in /api/comfy/generate): assistant busy — don't waste
    // time on copying and probing the file.
    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // (fix 483) LoRA from settings — same as in /api/comfy/generate: model
    // receives them via customLoras chain (turbo lora is normal entry, ON by
    // default), trigger words via conditioning prompt suffix (promptSuffix).
    // In meta the prompt is written WITHOUT triggers — "Retry" will add them again
    // based on current list, otherwise they would accumulate (fix 89).
    const customLoraEntries = enabledCustomLoras()
    const customLoras = customLoraEntries.length > 0
      ? customLoraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    const loraSuffix = loraTriggerSuffix(customLoraEntries)
    const loraParams = {
      ...(customLoras ? { customLoras } : {}),
      ...(loraSuffix ? { promptSuffix: loraSuffix } : {}),
    }

    // (fix 492) Original audio without regeneration — checkbox in Refine tab
    const keepAudio = body.keepOriginalAudio === true
    const keepAudioParam = keepAudio ? { keepOriginalAudio: true } : {}

    // (fix 317) Reference size mode: validation, default 'max'
    // (user requirement — more precise identity).
    const refImageSize: 'match' | 'max' = body.refImageSize === 'match' ? 'match' : 'max'

    // (fix 408) Veda Sparse Attention: toggle + node parameters (format validation
    // in refine-template via clampVedaSparsity/sanitizeVedaIndexList).
    const veda = body.vedaAttention === true
      ? {
          vedaAttention: true as const,
          vedaGeneratedSparsity: body.vedaGeneratedSparsity,
          vedaReferenceSparsity: body.vedaReferenceSparsity,
          vedaFullAttentionLayers: body.vedaFullAttentionLayers,
          vedaFullAttentionSteps: body.vedaFullAttentionSteps,
          vedaVerbose: body.vedaVerbose === true,
        }
      : {}
    // Same into sidecar meta so "Retry" restores settings.
    const vedaMeta = body.vedaAttention === true
      ? {
          veda_attention: true,
          veda_generated_sparsity: body.vedaGeneratedSparsity ?? '90%',
          veda_reference_sparsity: body.vedaReferenceSparsity ?? '90%',
          veda_full_attention_layers: body.vedaFullAttentionLayers ?? '',
          veda_full_attention_steps: body.vedaFullAttentionSteps ?? '',
          veda_verbose: body.vedaVerbose === true,
        }
      : {}

    // (fix 466) Sol-Attn: toggle + node parameters (previously in refine workflow
    // Sol-Attn was never passed — route did not forward sparseAttention).
    const sparse = body.sparseAttention === true
      ? {
          sparseAttention: true as const,
          sparseTau: body.sparseTau,
          sparseStartPercent: body.sparseStartPercent,
          sparseEndPercent: body.sparseEndPercent,
          sparseMinTokens: body.sparseMinTokens,
          sparseExtraTokens: body.sparseExtraTokens,
        }
      : {}

    // (fix 722) Sol-Attn — into sidecar. Previously Sol-Attn settings went
    // only to workflow, and metadata only received veda_* — "Retry"
    // lost half the attention settings, and from metadata it was impossible to tell
    // how exactly the clip was processed.
    const sparseMeta = body.sparseAttention === true
      ? {
          sparse_attention: true,
          sparse_tau: body.sparseTau ?? 1.3,
          sparse_start_percent: body.sparseStartPercent ?? 0.2,
          sparse_end_percent: body.sparseEndPercent ?? 1.0,
          sparse_min_tokens: body.sparseMinTokens ?? 12288,
          sparse_extra_tokens: body.sparseExtraTokens ?? 256,
        }
      : {}
    // (fix 722) Actually applied custom LoRAs — same as in /api/comfy/generate
    // (handled there by bodyToMetaParams). Here route knows the list itself.
    const loraMeta = customLoras
      ? { lora: customLoras.map((l) => l.name).join(', ') }
      : {}
    // (fix 722) Common refine sidecar fields. Previously refine metadata
    // LACKED pipeline, steps, sampler, and attention settings — from sidecar
    // one could not tell how the clip was processed. Values match
    // refine-template.ts: sampler euler (res_multistep on "lightweight" 2-step
    // pass), LowVRAMAttention + ChunkFeedForward always enabled.
    const refineCommonMeta = {
      pipeline: 'full',
      pass1_steps: body.steps ?? 3,
      pass1_sampler: body.steps === 2 ? 'res_multistep' : 'euler',
      pass1_scheduler: body.steps === 2 ? 'simple' : 'manual-sigmas',
      low_vram_attention: true,
      chunk_feed_forward: true,
      ...sparseMeta,
      ...loraMeta,
    }

    // ─── Copy output → input (without overwriting others' files — suffix on collision) ───
    // (fix 495) Nested folders: subfolder — multi-level relative
    // path ('a/b'); '.'/'..' segments are dropped (fixes 317/338).
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')

    // (fix 265) Source already in ComfyUI input/ (file from disk, uploaded
    // via /api/comfy/upload) — work with it directly, without copies from output.
    // Prompt taken only from user prompt (disk file has no sidecar).
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `File not found in input: ${inName}` }, { status: 404 })
      }
      const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
      // (fix 509) User references: disk file has no
      // .meta.json — images are uploaded by client to input/ and passed to
      // conditioning (slots <Picture 1..N>, first frame is last).
      const userRefImages: Array<{ path: string; role: string }> = []
      for (const raw of (body.refImages ?? []).slice(0, 8)) {
        const name = path.basename(String(raw ?? ''))
        if (!name) continue
        if (!existsSync(path.join(cfg.inputDir, name))) {
          return NextResponse.json({ error: `Reference not found in input: ${name}` }, { status: 404 })
        }
        userRefImages.push({ path: name, role: '' })
      }
      // (fix 265, fix) File already in input/ — probe dimensions/frames and
      // proceed along common path (whole / chunks) with real dims.
      let probe: { width: number; height: number; frames: number }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
      // (fix 265) Proceed along common path: destName = inName, no copies made.
      // (fix 494) Target: number/preset from body.target, or MP (targetMp)
      // (fix 587) Validation of numeric target — same as in gallery
      // branch below: junk (5 / 99999) built workflow with meaningless canvas.
      if (
        typeof body.target === 'number' &&
        (!Number.isFinite(body.target) || body.target < 144 || body.target > 2160)
      ) {
        return NextResponse.json({ error: 'Invalid target resolution' }, { status: 400 })
      }
      const target: 'same' | 'x2' | number = effectiveTarget(body, probe.width, probe.height)
      const dims = refineDimensions(probe.width, probe.height, target)
      const srcW = probe.width
      const srcH = probe.height
      // (fix 318) Best-effort: file from disk might be a copy from gallery —
      // look for sidecar by its name in output root and inherit image references
      // into result meta (anchors for repeated refine). In conditioning, inputSource
      // branch does not supply refs (behavior unchanged).
      const inMetaRefs = readMetaImageRefs('', inName).filter((r) => existsSync(path.join(cfg.inputDir, r.path)))

      // "By parts" mode — same workflow as gallery path.
      if (body.mode === 'chunks') {
        const windows = planChunkWindows(probe.frames, Number(body.chunkSeconds) || 5)
        const run = await runGeneration(() =>
          submitWorkflowJson(
            buildChunkedRefineWorkflow({
              sourceVideo: inName,
              diffusionModel: cfg.diffusionModel || undefined,
              sourceWidth: srcW,
              sourceHeight: srcH,
              sourceFrames: probe.frames,
              targetShortSide: target,
              chunkSeconds: Number(body.chunkSeconds) || 5,
              prompt: userPrompt,
              seed: body.seed,
              steps: body.steps,
              sigmaStart: body.sigmaStart,
              refImageSize, // (fix 317)
              outputSubfolder: '',
              ...veda, // (fix 408)
              ...sparse, // (fix 466)
              ...loraParams, // (fix 483)
              ...keepAudioParam, // (fix 492)
              // (fix 509) References from user (file from disk)
              ...(userRefImages.length > 0 && { refImages: userRefImages }),
            }),
            refineChunkStages(probe.frames, Number(body.chunkSeconds) || 5),
          ),
        )
        if (!run.ok) {
          return NextResponse.json({ error: run.error }, { status: run.status })
        }
        if (run.result.prompt_id) {
          setActivePrompt(run.result.prompt_id)
          recordPendingMetaRaw(run.result.prompt_id, {
            prompt: userPrompt,
            model_type: 'minimax_h3_ref2va',
            workflow: 'refine-chunks-latent-chain',
            generation_mode: 'refine',
            refine_mode: 'chunks',
            source_video: { filename: inName, subfolder: 'input' },
            source: { width: srcW, height: srcH, frames: probe.frames },
            target: target === 'same' ? 'same' : target,
            steps: body.steps ?? 3,
            sigma_start: body.sigmaStart,
            seed: body.seed ?? -1,
            chunks: windows.length,
            chunk_seconds: Number(body.chunkSeconds) || 5,
            prompt_source: 'user',
            input_source: true,
            minimax_h3_reference_detail: refImageSize, // (fix 317)
            ...refineCommonMeta, // (fix 722) pipeline/steps/sampler/LoRA/attention
            ...vedaMeta, // (fix 408)
            ...(keepAudio && { keep_original_audio: true }), // (fix 492)
            // (fix 318) source references — anchors for repeated refine;
            // (fix 509) priority — references supplied by user.
            ...(userRefImages.length > 0
              ? { references: metaRefsForSidecar(userRefImages) }
              : inMetaRefs.length > 0 && { references: metaRefsForSidecar(inMetaRefs) }),
          })
        }
        return NextResponse.json({
          ...run.result,
          inputName: inName,
          inputSource: true,
          chunks: windows.length,
          source: { width: srcW, height: srcH, frames: probe.frames },
          targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
          promptSource: 'user',
        })
      }

      // "Whole" mode
      const run = await runGeneration(() =>
        submitRefine({
          sourceVideo: inName,
          diffusionModel: cfg.diffusionModel || undefined,
          sourceWidth: srcW,
          sourceHeight: srcH,
          targetShortSide: target,
          prompt: userPrompt,
          seed: body.seed,
          steps: body.steps,
          sigmaStart: body.sigmaStart,
          refImageSize, // (fix 317)
          ...veda, // (fix 408)
          ...sparse, // (fix 466)
          ...loraParams, // (fix 483)
          ...keepAudioParam, // (fix 492)
          // (fix 509) References from user (file from disk)
          ...(userRefImages.length > 0 && { refImages: userRefImages }),
        }),
      )
      if (!run.ok) {
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: userPrompt,
          model_type: 'minimax_h3_ref2va',
          workflow: 'refine-v2v-latent-upscaler',
          generation_mode: 'refine',
          refine_mode: 'whole',
          source_video: { filename: inName, subfolder: 'input' },
          source: { width: srcW, height: srcH, frames: probe.frames },
          target: target === 'same' ? 'same' : target,
          steps: body.steps ?? 3,
          sigma_start: body.sigmaStart,
          seed: body.seed ?? -1,
          first_frame_ref: true,
          prompt_source: 'user',
          input_source: true,
          minimax_h3_reference_detail: refImageSize, // (fix 317)
          ...refineCommonMeta, // (fix 722) pipeline/steps/sampler/LoRA/attention
          ...vedaMeta, // (fix 408)
          ...(keepAudio && { keep_original_audio: true }), // (fix 492)
          // (fix 318) source references — anchors for repeated refine;
          // (fix 509) priority — references supplied by user.
          ...(userRefImages.length > 0
            ? { references: metaRefsForSidecar(userRefImages) }
            : inMetaRefs.length > 0 && { references: metaRefsForSidecar(inMetaRefs) }),
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: inName,
        inputSource: true,
        source: { width: srcW, height: srcH, frames: probe.frames },
        targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
        promptSource: 'user',
      })
    }

    const sourcePath = path.join(cfg.outputDir, sub, safeName)
    if (!existsSync(sourcePath)) {
      return NextResponse.json({ error: `File not found: ${safeName}` }, { status: 404 })
    }

    // ─── Copy output → input (without overwriting others' files — suffix on
    // collision). "By parts" mode starting from 2nd chunk reuses already copied
    // file (inputName + dimensions from plan) — without repeated copy and probe. ───
    const reuseName =
      body.inputName && existsSync(path.join(cfg.inputDir, path.basename(body.inputName)))
        ? path.basename(body.inputName)
        : null
    let destName: string
    let probe: { width: number; height: number; frames: number }
    // Freshly copied file path (for rollback on error); null on reuse.
    // (fix 716) Declared above — in outer scope, so outer catch
    // can remove copy on failure before submitting task.
    // copiedPath = null
    if (reuseName && body.sourceWidth && body.sourceHeight) {
      // (fix 345) Reuse branch blindly trusted client dimensions:
      // 0/NaN/negative went into refineDimensions / chunk plan.
      const sw = Number(body.sourceWidth)
      const sh = Number(body.sourceHeight)
      if (!Number.isFinite(sw) || !Number.isFinite(sh) || sw <= 0 || sh <= 0) {
        return NextResponse.json({ error: 'Invalid sourceWidth/sourceHeight' }, { status: 400 })
      }
      // (fix 345) "By parts" mode is planned by frames — on reuse their
      // number is unknown (probe.frames = 0) → plan would be empty/corrupt.
      if (body.mode === 'chunks') {
        return NextResponse.json(
          { error: '"By parts" mode with inputName reuse requires a fresh copy (no frame count)' },
          { status: 400 },
        )
      }
      destName = reuseName
      probe = { width: sw, height: sh, frames: 0 }
    } else {
      await fs.mkdir(cfg.inputDir, { recursive: true })
      destName = safeName
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
          // (fix 362) Old `${n++ > 1 ? n : ''}` gave first collision
          // a name without number and skipped _refine1 → _refine3.
          destName = `${stem}_refine${n++}${ext}`
          destPath = path.join(cfg.inputDir, destName)
          if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
        }
      }
      copiedPath = destPath

      // ─── Probe source ───
      try {
        probe = await probeVideoFile(destPath)
      } catch (e) {
        await fs.unlink(destPath).catch(() => {})
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
    }

    // ─── Target ───
    const target: 'same' | 'x2' | number =
      body.target === 'same' || body.target === 'x2' || typeof body.target === 'number'
        ? body.target
        : 'same'
    if (typeof target === 'number' && (!Number.isFinite(target) || target < 144 || target > 2160)) {
      if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
      return NextResponse.json({ error: 'Invalid target resolution' }, { status: 400 })
    }

    // ─── Prompt: user > chain from source meta > default ───
    // (fix 310, replaces layout of fix 309) References: images from source
    // meta occupy <Picture 1..k> (original order of original
    // generation), first frame is last (<Picture k+1>; see fix 315 in
    // refine-template.ts). Without meta refs first frame = <Picture 1>.
    // (fix 318) readPromptChain instead of readDraftPrompt: for extend-combined
    // inherit ENTIRE chain "source → clips", for regular meta — as before.
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const draftPrompt = userPrompt ? null : readPromptChain(sub, safeName)
    const resolvedPrompt = userPrompt || draftPrompt || undefined
    const promptSource: string = userPrompt ? 'user' : draftPrompt ? 'draft-meta' : 'default'
    // (fix 311) Image references from source .meta.json with roles
    // (imageIntent) → <Picture 1..k>.
    // Graceful fallback: only files that actually exist in input/.
    const allMetaRefs = readMetaImageRefs(sub, safeName)
    const metaRefImages = allMetaRefs.filter((r) => existsSync(path.join(cfg.inputDir, r.path)))
    if (allMetaRefs.length !== metaRefImages.length) {
      console.warn(`[refine] ${allMetaRefs.length - metaRefImages.length} ref(s) from meta missing in input/ — skipping`)
    }

    // ─── (fixes 376→382) Lossless branch: source latent from meta ───
    // Works for BOTH modes ("Whole" and "By parts", fix 382). Does not work:
    // legacy chunk (chunkJob/skipFrames/frameCap) and reuse without fresh probe.
    // Target geometry is computed from LATENT CANVAS (>= mp4 due to generation crop,
    // always /32): conditioning and latent seed guaranteed to match
    // (ceil32 of mp4 could differ from free-MP generator canvas).
    // Target smaller than canvas → internal upscaler would get downscaling
    // (prohibited) → fallback to mp4 path (it resizes pixels before encode).
    const latentEligible =
      !body.chunkJob && !body.skipFrames && !body.frameCap && probe.frames > 0
    let sourceLatent: string | undefined
    let srcW = probe.width
    let srcH = probe.height
    if (latentEligible) {
      const resolved = resolveSourceLatent(sub, safeName, probe, (reason) =>
        console.warn(`[refine] mp4 path (${safeName}): latent not picked up — ${reason}`),
      )
      if (resolved) {
        // (fix 587) Guard checks EFFECTIVE target (accounting for targetMp):
        // previously compared with body.target, while workflow received targetEff from
        // targetMp — small targetMp passed guard and requested latent
        // upscaler to DOWNSCALE canvas (prohibited case, failing job).
        const dLat = refineDimensions(
          resolved.width,
          resolved.height,
          effectiveTarget(body, resolved.width, resolved.height),
        )
        if (dLat.genW < resolved.width || dLat.genH < resolved.height) {
          console.warn(
            `[refine] mp4 path (${safeName}): latent not picked up — target smaller than latent canvas ` +
            `${resolved.width}×${resolved.height}`,
          )
        } else {
          sourceLatent = resolved.file
          srcW = resolved.width
          srcH = resolved.height
          // (fix 421) Explicit mark in server console: which branch is running
          console.log(`[refine] LATENT ✓ (${safeName}): ${resolved.file} — lossless branch, without source VAEEncode`)
        }
      }
    }
    // (fix 494) Free resolution (MP) — from REAL canvas: in
    // lossless branch this is latent canvas (srcW/srcH already substituted above).
    const targetEff = typeof body.targetMp === 'number' && Number.isFinite(body.targetMp) && body.targetMp > 0
      ? targetFromMp(srcW, srcH, body.targetMp)
      : target
    const dims = refineDimensions(srcW, srcH, targetEff)

    // ─── (fix 253) "By parts" mode: ONE workflow with chunk chain
    // (latent masking) — plan on server, client awaits single job and
    // stitches with hard concatenation. (fix 315) Image refs from meta
    // are passed as identity anchor across all windows (<Picture 1..k>). ───
    if (body.mode === 'chunks') {
      const windows = planChunkWindows(probe.frames, Number(body.chunkSeconds) || 5)
      // Scene prompt — only first element of chain (source prompt):
      // builder gives it to window 0, windows 1+ proceed with anchor ref captions without
      // scene text — chain prompt describes scenes absent in later
      // windows and confused model. Result meta receives full chain.
      const chainParts = userPrompt ? null : readPromptChainParts(sub, safeName)
      const firstChainPrompt = userPrompt || chainParts?.[0] || undefined
      const run = await runGeneration(() =>
        submitWorkflowJson(
          buildChunkedRefineWorkflow({
            sourceVideo: destName,
            diffusionModel: cfg.diffusionModel || undefined,
            videoFormat: getVideoFormatSettings(), // (fix 386)
            // (fix 382) lossless branch "By parts": windows cut by tokens
            // from saved latent; dimensions = latent canvas
            ...(sourceLatent && { sourceLatent }),
            sourceWidth: srcW,
            sourceHeight: srcH,
            sourceFrames: probe.frames,
            targetShortSide: targetEff,
            chunkSeconds: Number(body.chunkSeconds) || 5,
            // <Picture N> tags of meta prompt preserved by sanitizeDraftPrompt
            // (fix 310) and valid: builder (fix 315) maintains original
            // numbering; slot captions added by builder (fix 316).
            prompt: firstChainPrompt,
            seed: body.seed,
            steps: body.steps,
            sigmaStart: body.sigmaStart,
            outputSubfolder: sub,
            refImageSize, // (fix 317)
            ...veda, // (fix 408)
            ...sparse, // (fix 466)
            ...loraParams, // (fix 483)
            ...keepAudioParam, // (fix 492)
            // (fix 311) Image refs from source meta (with roles)
            ...(metaRefImages.length > 0 && { refImages: metaRefImages }),
          }),
          // (fix 255) stages = chain windows → progress 0–100 by chunks
          refineChunkStages(probe.frames, Number(body.chunkSeconds) || 5),
        ),
      )
      if (!run.ok) {
        // (fix 344) Rollback fresh copy in input/ — otherwise orphaned file.
        if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
        return NextResponse.json({ error: run.error }, { status: run.status })
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        // (fix 260) Chunk metadata: /api/comfy/status on 'done'
        // finalizes sidecars even without browser. Source — original from
        // gallery from which refine was made.
        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: resolvedPrompt ?? '',
          model_type: 'minimax_h3_ref2va',
          workflow: 'refine-chunks-latent-chain',
          generation_mode: 'refine',
          refine_mode: 'chunks',
          source_video: { filename: safeName, subfolder: sub },
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          target: targetEff === 'same' ? 'same' : targetEff,
          steps: body.steps ?? 3,
          sigma_start: body.sigmaStart,
          seed: body.seed ?? -1,
          chunks: windows.length,
          chunk_seconds: Number(body.chunkSeconds) || 5,
          prompt_source: promptSource,
          minimax_h3_reference_detail: refImageSize, // (fix 317)
          ...refineCommonMeta, // (fix 722) pipeline/steps/sampler/LoRA/attention
          ...vedaMeta, // (fix 408)
          ...(keepAudio && { keep_original_audio: true }), // (fix 492)
          // (fix 305) number of image refs from meta
          ...(metaRefImages.length > 0 && { meta_ref_count: metaRefImages.length }),
          // (fix 318) and references themselves — anchors for repeated refine
          ...(metaRefImages.length > 0 && { references: metaRefsForSidecar(metaRefImages) }),
          // (fix 382) lossless mode "By parts"
          ...(sourceLatent && { latent_source: sourceLatent }),
        })
      }
      return NextResponse.json({
        ...run.result,
        inputName: destName,
        chunks: windows.length,
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
        promptSource,
        promptUsed: resolvedPrompt ?? '',
        lossless: !!sourceLatent, // (fix 382)
      })
    }

    // ─── Assembly + dispatch ───
    const run = await runGeneration(() =>
      submitRefine({
        sourceVideo: destName,
        diffusionModel: cfg.diffusionModel || undefined,
        // (fix 376) lossless branch: pristine generation latent;
        // (fix 382) dimensions = latent canvas (geometry of entire branch based on it)
        ...(sourceLatent && { sourceLatent, sourceFrames: probe.frames }),
        sourceWidth: srcW,
        sourceHeight: srcH,
        targetShortSide: targetEff,
        prompt: resolvedPrompt,
        seed: body.seed,
        steps: body.steps,
        sigmaStart: body.sigmaStart,
        skipFrames: body.skipFrames,
        frameCap: body.frameCap,
        chunkJob: body.chunkJob,
        refImageSize, // (fix 317)
        ...veda, // (fix 408)
        ...sparse, // (fix 466)
        ...loraParams, // (fix 483)
        ...keepAudioParam, // (fix 492)
        // (fix 366) Result into original folder (same as "By parts" mode);
        // source from output root → sub='' → shared folder, as before.
        outputSubfolder: sub,
        // (fix 311) Image refs from source meta (with roles)
        ...(metaRefImages.length > 0 && { refImages: metaRefImages }),
      }),
    )
    if (!run.ok) {
      // (fix 344) Rollback fresh copy in input/ — otherwise orphaned file.
      if (copiedPath) await fs.unlink(copiedPath).catch(() => {})
      copiedPath = null
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    // (fix 716) Task dispatched to ComfyUI — copy is no longer "orphaned".
    submitted = true
    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      // (fix 260) Metadata of "Whole" refine: finalized by status
      // route on 'done' (works even with closed browser).
      recordPendingMetaRaw(run.result.prompt_id, {
        prompt: resolvedPrompt ?? '',
        model_type: 'minimax_h3_ref2va',
        workflow: 'refine-v2v-latent-upscaler',
        generation_mode: 'refine',
        refine_mode: 'whole',
        source_video: { filename: safeName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        target: targetEff === 'same' ? 'same' : targetEff,
        steps: body.steps ?? 3,
        sigma_start: body.sigmaStart,
        seed: body.seed ?? -1,
        first_frame_ref: true,
        // (fix 309) number of image refs from meta
        ...(metaRefImages.length > 0 && { meta_ref_count: metaRefImages.length }),
        // (fix 318) and references themselves — anchors for repeated refine
        ...(metaRefImages.length > 0 && { references: metaRefsForSidecar(metaRefImages) }),
        // (fix 376) lossless mode: refine started from generation latent
        ...(sourceLatent && { latent_source: sourceLatent }),
        prompt_source: promptSource,
        minimax_h3_reference_detail: refImageSize, // (fix 317)
        ...refineCommonMeta, // (fix 722) pipeline/steps/sampler/LoRA/attention
        ...vedaMeta, // (fix 408)
        ...(keepAudio && { keep_original_audio: true }), // (fix 492)
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: destName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      targetDims: { genW: dims.genW, genH: dims.genH, outW: dims.outW, outH: dims.outH },
      promptSource,
      promptUsed: resolvedPrompt ?? '',
      lossless: !!sourceLatent, // (fix 376)
    })
  } catch (err) {
    // (fix 716) Remove orphaned copy in input/ if task was never
    // dispatched to ComfyUI.
    if (copiedPath && !submitted) {
      await fs.unlink(copiedPath).catch(() => {})
      copiedPath = null
    }
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
