import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import { existsSync } from 'fs'
import path from 'path'
import { submitWorkflowJson } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders'
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import {
  buildControlNetWorkflow,
  buildControlNetPreprocessWorkflow,
  controlNetFrames,
  controlNetSize,
  type ControlNetType,
} from '@/lib/comfy/controlnet-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readPromptChain, readMetaImageRefs } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { compressRefVideo480 } from '@/lib/ref-video-compress'
import { getVideoFormatSettings } from '@/lib/video-format-server'
import { enabledCustomLoras, loraTriggerSuffix } from '@/lib/loras-config'
import { videoSamplerStages, type MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'

/**
 * POST /api/comfy/controlnet — H3 generation from control video
 * (depth/canny → standard References workflow).
 *
 * Body:
 *   sourceFilename  — file name in ComfyUI output folder (or inputSource)
 *   sourceSubfolder — output subfolder (nested — 'a/b')
 *   inputSource?    — file name already in ComfyUI input/ (disk file)
 *   prompt?         — caption
 *   seed?           — (-1/undefined = random)
 *   duration?       — seconds (default 5; clamped to source length)
 *   targetShortSide?— short side of generation, px (default 720)
 *   controlType?    — 'depth' (default) | 'canny'
 *   refImages?      — reference images (filenames in input/, up to 9)
 *   refImageSize?   — 'match' | 'max' (default 'max', fix 511)
 *   preprocessOnly? — true = map only (depth/canny video without generation)
 *   compress?       — compress control video to 480p (all modes)
 *   pipeline?       — 'draft' | 'full'
 *   lowResMP?       — canvas pass 1 (pipeline='full' only)
 *   firstSamplerSteps? — effective steps pass 1 (SplitSigmas split, default 6)
 *   firstSamplerTotalSteps? — total schedule steps pass 1 (default: = split, "6 of 6")
 *   draftSteps?     — single pass steps (draft, default 4)
 *   pass1Sampler?   — pass 1 sampler (default 'euler')
 *   pass1Scheduler? — pass 1 scheduler (default 'simple')
 *   pass2Sampler?   — pass 2 sampler (default 'euler')
 *   sigmaVariant?   — pass 2 sigma profile (default '3step')
 *
 * Pipeline: copy output → input (or reuse inputSource), ffprobe,
 * build workflow (preprocess + standard references) and dispatch.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      /** (fix 727) Output folder ('' = common). If not set — source folder. */
      outputSubfolder?: string
      inputSource?: string
      prompt?: string
      seed?: number
      duration?: number
      targetShortSide?: number
      controlType?: ControlNetType
      refImages?: string[]
      refImageSize?: 'match' | 'max'
      preprocessOnly?: boolean
      compress?: boolean
      pipeline?: 'draft' | 'full'
      lowResMP?: number
      firstSamplerSteps?: number
      /** Total schedule steps pass 1 (default: = split, "6 of 6"). */
      firstSamplerTotalSteps?: number
      draftSteps?: number
      pass1Sampler?: string
      pass1Scheduler?: string
      pass2Sampler?: string
      sigmaVariant?: string
      // (fix 512) Veda/Sparse/lowVRAM — from app settings
      sparseAttention?: boolean
      sparseTau?: number
      sparseStartPercent?: number
      sparseEndPercent?: number
      sparseMinTokens?: number
      sparseExtraTokens?: number
      vedaAttention?: boolean
      vedaGeneratedSparsity?: string
      vedaReferenceSparsity?: string
      vedaFullAttentionLayers?: string
      vedaFullAttentionSteps?: string
      vedaVerbose?: boolean
      lowVramAttention?: boolean
      chunkFeedForward?: boolean
      chunkFFChunks?: number
      chunkFFThreshold?: number
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (or inputSource) is required' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // Custom LoRAs from settings
    const customLoraEntries = enabledCustomLoras()
    const customLoras = customLoraEntries.length > 0
      ? customLoraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    const loraSuffix = loraTriggerSuffix(customLoraEntries)
    const promptWithTriggers = (p: string | undefined): string | undefined => {
      if (!loraSuffix) return p
      const base = (p ?? '').trim()
      return base ? `${base} ${loraSuffix}` : loraSuffix
    }

    const controlType: ControlNetType = body.controlType === 'canny' ? 'canny' : (body.controlType === 'direct' ? 'direct' : (body.controlType === 'pose' ? 'pose' : 'depth')) // (fix 512)
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''

    // (fix 722) ControlNet pipeline parameters into sidecar. Previously
    // ControlNet generation metadata only included resolution/frames/mode —
    // neither steps, nor samplers, nor attention settings, nor actually applied
    // LoRAs. From the result sidecar it was impossible to tell how it was computed.
    const cnPipeline = body.pipeline === 'full' ? 'full' : 'draft'
    const cnCommonMeta = {
      pipeline: cnPipeline,
      pass1_steps: body.firstSamplerSteps ?? 6,
      pass1_total_steps: body.firstSamplerTotalSteps ?? body.firstSamplerSteps ?? 6,
      pass2_steps: { '3step': 3, '4step': 4, '5step': 5, '6step': 6, '7step': 7 }[body.sigmaVariant || '3step'] ?? 3,
      sigma_variant: body.sigmaVariant || '3step',
      pass1_sampler: body.pass1Sampler || 'euler',
      pass1_scheduler: body.pass1Scheduler || 'simple',
      pass2_sampler: body.pass2Sampler || 'euler',
      ...(cnPipeline === 'draft' && { draft_steps: body.draftSteps ?? 4 }),
      low_res_mp: body.lowResMP ?? 0.2,
      sparse_attention: body.sparseAttention === true,
      ...(body.sparseAttention === true && {
        sparse_tau: body.sparseTau ?? 1.3,
        sparse_start_percent: body.sparseStartPercent ?? 0.2,
        sparse_end_percent: body.sparseEndPercent ?? 1.0,
        sparse_min_tokens: body.sparseMinTokens ?? 12288,
        sparse_extra_tokens: body.sparseExtraTokens ?? 256,
      }),
      veda_attention: body.vedaAttention === true,
      ...(body.vedaAttention === true && {
        veda_generated_sparsity: body.vedaGeneratedSparsity ?? '90%',
        veda_reference_sparsity: body.vedaReferenceSparsity ?? '90%',
        veda_full_attention_layers: body.vedaFullAttentionLayers ?? '',
        veda_full_attention_steps: body.vedaFullAttentionSteps ?? '',
        veda_verbose: body.vedaVerbose === true,
      }),
      low_vram_attention: body.lowVramAttention !== false,
      chunk_feed_forward: body.chunkFeedForward !== false,
      ...(body.chunkFeedForward !== false && {
        chunk_ff_chunks: body.chunkFFChunks ?? 2,
        chunk_ff_threshold: body.chunkFFThreshold ?? 4096,
      }),
      ...(customLoras ? { lora: customLoras.map((l) => l.name).join(', ') } : {}),
    }

    // Reference images: basename + check existence in input/
    const refImages: string[] = []
    for (const raw of (body.refImages ?? []).slice(0, 9)) {
      const name = path.basename(String(raw ?? ''))
      if (!name) continue
      if (!existsSync(path.join(cfg.inputDir, name))) {
        return NextResponse.json({ error: `Reference not found in input: ${name}` }, { status: 404 })
      }
      refImages.push(name)
    }

    const submit = async (opts: {
      inputName: string
      inputPath: string
      gallerySub: string | null
      galleryName: string | null
      /** (fix 727) Where to place result; null — source folder. */
      outSub?: string | null
    }) => {
      // Compress video (if requested)
      let inputName = opts.inputName
      let inputPath = opts.inputPath
      if (body.compress) {
        try {
          inputName = await compressRefVideo480(opts.inputName)
          inputPath = path.join(cfg.inputDir, inputName)
        } catch (e) {
          return {
            run: {
              ok: false as const,
              error: `Failed to compress video: ${e instanceof Error ? e.message : String(e)}`,
              status: 500,
            },
          }
        }
      }

      let probe: { width: number; height: number; frames: number }
      try {
        probe = await probeVideoFile(inputPath)
      } catch (e) {
        return {
          run: {
            ok: false as const,
            error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}`,
            status: 400,
          },
        }
      }

      const preprocessOnly = body.preprocessOnly === true
      const frames = preprocessOnly
        ? Math.max(1, Math.min(Math.round((body.duration ?? 5) * 24), probe.frames))
        : controlNetFrames(body.duration ?? 5, probe.frames)
      const size = controlNetSize(probe.width, probe.height, body.targetShortSide ?? 720)

      // Prompt: user > chain from source meta (gallery)
      const draftPrompt = !userPrompt && opts.galleryName
        ? readPromptChain(opts.gallerySub ?? '', opts.galleryName)
        : null
      const resolvedPrompt = userPrompt || draftPrompt || undefined
      const promptSource = userPrompt ? 'user' : draftPrompt ? 'draft-meta' : 'default'

      let workflow: Record<string, unknown>
      let stages: string[][]
      // (fix 716) Temporary reference map prefix — unique per task.
      const cnRefPrefix = `Minimax_Studio_cnref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      if (preprocessOnly) {
        // "Map" mode: preprocessing only
        workflow = buildControlNetPreprocessWorkflow({
          sourceVideo: inputName,
          sourceWidth: probe.width,
          sourceHeight: probe.height,
          sourceFrames: probe.frames,
          controlType,
          duration: body.duration,
          targetShortSide: body.targetShortSide,
          outputSubfolder: opts.outSub ?? opts.gallerySub ?? '',
          videoFormat: getVideoFormatSettings(),
        })
        stages = [] // (fix 520) VHS_VideoCombine does not send progress events — meaningless stage, do not register tracker
      } else {
        // Generation mode: preprocessing + standard References
        workflow = buildControlNetWorkflow({
          sourceVideo: inputName,
          diffusionModel: cfg.diffusionModel || undefined,
          sourceWidth: probe.width,
          sourceHeight: probe.height,
          sourceFrames: probe.frames,
          controlType,
          duration: body.duration,
          targetShortSide: body.targetShortSide,
          // (fix 716) Unique prefix for temporary reference map:
          // cleanup will delete only maps for THIS job (parallel
          // ControlNet tasks no longer lose their maps).
          cnRefPrefix: cnRefPrefix,
          prompt: promptWithTriggers(resolvedPrompt),
          seed: body.seed,
          refImages: refImages.length > 0 ? refImages : undefined,
          refImageSize: body.refImageSize,
          pipeline: body.pipeline === 'full' ? 'full' : 'draft',
          lowResMP: body.lowResMP,
          firstSamplerSteps: body.firstSamplerSteps,
          // Total schedule steps pass 1 (default: = split, "6 of 6").
          firstSamplerTotalSteps: body.firstSamplerTotalSteps ?? body.firstSamplerSteps ?? 6,
          draftSteps: body.draftSteps,
          pass1Sampler: body.pass1Sampler,
          pass1Scheduler: body.pass1Scheduler,
          pass2Sampler: body.pass2Sampler,
          sigmaVariant: body.sigmaVariant,
          customLoras,
          outputSubfolder: opts.outSub ?? opts.gallerySub ?? '',
          videoFormat: getVideoFormatSettings(),
          // (fix 512) Veda/Sparse/lowVRAM — same as "Generation" tab
          sparseAttention: body.sparseAttention,
          sparseTau: body.sparseTau,
          sparseStartPercent: body.sparseStartPercent,
          sparseEndPercent: body.sparseEndPercent,
          sparseMinTokens: body.sparseMinTokens,
          sparseExtraTokens: body.sparseExtraTokens,
          vedaAttention: body.vedaAttention,
          vedaGeneratedSparsity: body.vedaGeneratedSparsity,
          vedaReferenceSparsity: body.vedaReferenceSparsity,
          vedaFullAttentionLayers: body.vedaFullAttentionLayers,
          vedaFullAttentionSteps: body.vedaFullAttentionSteps,
          vedaVerbose: body.vedaVerbose,
          lowVramAttention: body.lowVramAttention,
          chunkFeedForward: body.chunkFeedForward,
          chunkFFChunks: body.chunkFFChunks,
          chunkFFThreshold: body.chunkFFThreshold,
        })
        // Progress stages — same as standard ref workflow
        const stdParams: MiniMaxH3Params = {
          mode: 'ref',
          pipeline: body.pipeline === 'full' ? 'full' : 'draft',
          prompt: '',
          refImages: [],
          aspectRatio: '16:9',
          duration: 5,
          seed: 0,
        }
        stages = videoSamplerStages(stdParams)
      }

      const run = await runGeneration(() =>
        submitWorkflowJson(workflow, stages.length > 0 ? stages : undefined),
      )
      if (!run.ok) {
        return { run }
      }
      if (run.result.prompt_id) {
        setActivePrompt(run.result.prompt_id)
        const cnMetaRefs = opts.galleryName
          ? readMetaImageRefs(opts.gallerySub ?? '', opts.galleryName)
          : []
        const metaRefs = refImages.length > 0
          ? refImages.map((n) => ({ type: 'image', path: n, role: '' }))
          : cnMetaRefs.map((r) => ({ type: 'image', path: r.path, role: r.role }))

        if (preprocessOnly) {
          recordPendingMetaRaw(run.result.prompt_id, {
            prompt: '',
            model_type: 'minimax_h3_controlnet',
            workflow: 'controlnet-preprocess',
            generation_mode: 'controlnet',
            preprocess_only: true,
            // (fix 716) Temporary map prefix — for pinpoint cleanup.
            cn_ref_prefix: cnRefPrefix,
            control_type: controlType,
            resolution: `${size.width}x${size.height}`,
            video_length: frames,
            duration_seconds: frames / 24,
            fps: 24,
            ...cnCommonMeta, // (fix 722) pipeline parameters
            source_video: opts.galleryName
              ? { filename: opts.galleryName, subfolder: opts.gallerySub ?? '' }
              : { filename: opts.inputName, subfolder: 'input' },
            source: { width: probe.width, height: probe.height, frames: probe.frames },
            ...(opts.galleryName ? {} : { input_source: true }),
          })
          return {
            run,
            response: {
              ...run.result,
              inputName: opts.inputName,
              inputSource: !opts.galleryName,
              source: { width: probe.width, height: probe.height, frames: probe.frames },
              effectiveFrames: frames,
              targetSize: size,
              preprocessOnly: true,
            },
          }
        }

        recordPendingMetaRaw(run.result.prompt_id, {
          prompt: resolvedPrompt ?? '',
          model_type: 'minimax_h3_ref2va',
          workflow: 'controlnet-std-refs',
          generation_mode: 'controlnet',
          // (fix 716) Temporary map prefix — for pinpoint cleanup.
          cn_ref_prefix: cnRefPrefix,
          resolution: `${size.width}x${size.height}`,
          video_length: frames,
          duration_seconds: frames / 24,
          fps: 24,
          control_type: controlType,
          target_short_side: body.targetShortSide ?? 720,
          minimax_h3_reference_detail: body.refImageSize ?? 'match',
          ...cnCommonMeta, // (fix 722) pipeline parameters
          ...(body.compress === true && { compress_source: true }),
          source_video: opts.galleryName
            ? { filename: opts.galleryName, subfolder: opts.gallerySub ?? '' }
            : { filename: opts.inputName, subfolder: 'input' },
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          seed: body.seed ?? -1,
          prompt_source: promptSource,
          ...(opts.galleryName ? {} : { input_source: true }),
          references: metaRefs,
        })
      }
      return {
        run,
        response: {
          ...run.result,
          inputName: opts.inputName,
          inputSource: !opts.galleryName,
          source: { width: probe.width, height: probe.height, frames: probe.frames },
          effectiveFrames: frames,
          targetSize: size,
          promptSource,
          promptUsed: resolvedPrompt ?? '',
        },
      }
    }

    // (fix 727) Result folder: selected in UI (can be '' — common)
    // takes priority over source folder; not specified — place next to source.
    const outSub = typeof body.outputSubfolder === 'string'
      ? sanitizeFolderPath(body.outputSubfolder)
      : null

    // ─── File from disk (inputSource) ───
    if (body.inputSource) {
      const inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `File not found in input: ${inName}` }, { status: 404 })
      }
      const r = await submit({ inputName: inName, inputPath: inPath, gallerySub: null, galleryName: null, outSub: outSub ?? '' })
      if ('response' in r && r.response) return NextResponse.json(r.response)
      return NextResponse.json({ error: r.run.error }, { status: r.run.status })
    }

    // ─── File from gallery (output) ───
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')
    const sourcePath = path.join(cfg.outputDir, sub, safeName)
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
        await fs.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        const ext = path.extname(safeName)
        const stem = safeName.slice(0, safeName.length - ext.length)
        destName = `${stem}_cn${n++}${ext}`
        destPath = path.join(cfg.inputDir, destName)
        if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
      }
    }

    const r = await submit({ inputName: destName, inputPath: destPath, gallerySub: sub, galleryName: safeName, outSub: outSub ?? sub })
    if ('response' in r && r.response) return NextResponse.json(r.response)
    await fs.unlink(destPath).catch(() => {})
    return NextResponse.json({ error: r.run.error }, { status: r.run.status })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
