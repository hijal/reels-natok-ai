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
  buildFaceRefineWorkflow,
  DEFAULT_FACE_DENOISE,
  DEFAULT_FACE_STEPS,
  type FaceIdentityModel,
  type FacePasteRegion,
  type FaceSelectMode,
  type FaceUndetected,
} from '@/lib/comfy/face-refine-template'
import { recordPendingMetaRaw } from '@/lib/pending-meta'
import { readMetaImageRefs, readPromptChain } from '@/lib/refine-meta'
import { probeVideoFile } from '@/lib/video-probe'
import { getVideoFormatSettings } from '@/lib/video-format-server'
import { resolveFaceDetectors } from '@/lib/comfy/face-detectors'
import { enabledCustomLoras, TURBO_LORA_NAME } from '@/lib/loras-config'

/**
 * POST /api/comfy/face-refine — redraw small faces in finished video
 * (set of ComfyUI-H3-FaceRefine nodes).
 *
 * Body:
 *   sourceFilename/sourceSubfolder — video from gallery (or inputSource — file
 *                                    from disk, already in ComfyUI input/)
 *   prompt?            — caption; by default prompt chain is taken from
 *                        source sidecar (scene and characters remain same)
 *   seed?              — (-1 = random)
 *   canvas?            — H3 canvas, px (512 is 2.25x cheaper than 768). Default 512
 *   denoise?           — base denoise. Default 0.35
 *   steps?             — steps (must match turbo LoRA). Default 4
 *   select?            — subject selection rule
 *   selectIndex?       — face index in rule ranking
 *   facePoint?         — (fix 723) {x, y, frame}: click on face in source preview;
 *                        rule is ignored when this is set
 *   identityReference? — file in input/: "redraw THIS person"
 *   identityModel?     — insightface | clip_vision | ccip
 *   refImages?         — character reference images (files in input/)
 */
export const dynamic = 'force-dynamic'

/**
 * (fix 722) GET — which detectors are actually available. ComfyUI combo
 * values depend on models/ultralytics registration, so hardcoded name
 * face_yolov8m.pt after registration ceases to be valid (becomes
 * bbox\face_yolov8m.pt). Tab queries the list to show the checkbox
 * "distant shots" only when human model is present.
 *
 * (fix 723) Also returns source parameters (width/height/fps/frames) if
 * file is provided: ?input=<name in input/> or ?filename=&subfolder= (output).
 * Tab needs fps to convert preview click timecode into frame number:
 * X/Y in node are FRAME pixels, and frame_index is the frame to measure on.
 */
export async function GET(req: NextRequest) {
  const { detector, fallbackDetector } = await resolveFaceDetectors()
  const q = req.nextUrl.searchParams
  const inputName = q.get('input')
  const filename = q.get('filename')
  if (!inputName && !filename) return NextResponse.json({ detector, fallbackDetector })

  const cfg = getAppConfig()
  let file: string
  if (inputName) {
    file = path.join(cfg.inputDir, path.basename(inputName))
  } else {
    const sub = sanitizeFolderPath(q.get('subfolder') || '')
    file = path.join(cfg.outputDir, sub, path.basename(filename as string))
    const outputRoot = path.resolve(cfg.outputDir)
    if (!path.resolve(file).startsWith(outputRoot + path.sep)) {
      return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
    }
  }
  if (!existsSync(file)) return NextResponse.json({ detector, fallbackDetector, probe: null })
  try {
    return NextResponse.json({ detector, fallbackDetector, probe: await probeVideoFile(file) })
  } catch {
    // Preview will still open: click on it will be calculated using fps=24.
    return NextResponse.json({ detector, fallbackDetector, probe: null })
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      sourceFilename?: string
      sourceSubfolder?: string
      inputSource?: string
      prompt?: string
      seed?: number
      canvas?: number
      denoise?: number
      steps?: number
      sampler?: string
      select?: FaceSelectMode
      selectIndex?: number
      identityReference?: string
      identityModel?: FaceIdentityModel
      identityThreshold?: number
      identityTrack?: boolean
      cropFactor?: number
      confidence?: number
      pasteRegion?: FacePasteRegion
      feather?: number
      colourMatch?: number
      blend?: number
      undetectedFrames?: FaceUndetected
      denoiseSmall?: number
      denoiseLarge?: number
      refImages?: string[]
      refImageSize?: 'match' | 'max'
      /** (fix 722) Person detector on frames where face is not visible. */
      fallback?: boolean
      /** (fix 723) Click on face in preview: frame pixels + its number. */
      facePoint?: { x?: number; y?: number; frame?: number }
    }

    if (!body?.sourceFilename && !body?.inputSource) {
      return NextResponse.json({ error: 'sourceFilename (or inputSource) is required' }, { status: 400 })
    }

    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    const cfg = getAppConfig()

    // ─── Source: file from disk (input/) or copy from gallery ───
    const sub = sanitizeFolderPath(body.sourceSubfolder || '')
    const safeName = path.basename(body.sourceFilename ?? '')
    let inName: string
    let probe: { width: number; height: number; frames: number; durationSec: number }
    let promptSource: 'user' | 'draft-meta' | 'default' = 'user'
    let metaRefs: Array<{ path: string; role: string }> = []

    if (body.inputSource) {
      inName = path.basename(body.inputSource)
      const inPath = path.join(cfg.inputDir, inName)
      if (!existsSync(inPath)) {
        return NextResponse.json({ error: `File not found in input: ${inName}` }, { status: 404 })
      }
      try {
        probe = await probeVideoFile(inPath)
      } catch (e) {
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
    } else {
      const sourcePath = path.join(cfg.outputDir, sub, safeName)
      const outputRoot = path.resolve(cfg.outputDir)
      if (!path.resolve(sourcePath).startsWith(outputRoot + path.sep)) {
        return NextResponse.json({ error: 'Invalid path' }, { status: 400 })
      }
      if (!existsSync(sourcePath)) {
        return NextResponse.json({ error: `File not found: ${safeName}` }, { status: 404 })
      }
      // Copy output → input (without overwriting others' files — suffix on collision).
      await fs.mkdir(cfg.inputDir, { recursive: true })
      inName = safeName
      let destPath = path.join(cfg.inputDir, inName)
      let n = 1
      while (true) {
        try {
          await fs.copyFile(sourcePath, destPath, fs.constants.COPYFILE_EXCL)
          break
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
          const ext = path.extname(safeName)
          const stem = safeName.slice(0, safeName.length - ext.length)
          inName = `${stem}_facerefine${n++}${ext}`
          destPath = path.join(cfg.inputDir, inName)
          if (n > 100) return NextResponse.json({ error: 'Too many duplicates' }, { status: 500 })
        }
      }
      try {
        probe = await probeVideoFile(destPath)
      } catch (e) {
        await fs.unlink(destPath).catch(() => {})
        return NextResponse.json(
          { error: `Failed to read video: ${e instanceof Error ? e.message : String(e)}` },
          { status: 400 },
        )
      }
      // Prompt and references from source sidecar: Face Refine redraws
      // FACE, scene and characters should remain the same.
      const chain = readPromptChain(sub, safeName)
      if (chain && !body.prompt?.trim()) promptSource = 'draft-meta'
      metaRefs = readMetaImageRefs(sub, safeName)
    }

    // ─── Prompt: user > chain from source meta ───
    const userPrompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    const chainPrompt = body.inputSource ? null : readPromptChain(sub, safeName)
    const prompt = userPrompt || chainPrompt || ''
    if (!userPrompt) promptSource = chainPrompt ? 'draft-meta' : 'default'

    // ─── Character references: specified > from source meta ───
    const refImages = (body.refImages ?? []).filter((n) => typeof n === 'string' && n.length > 0)
    const usedRefs = refImages.length > 0
      ? refImages
      : metaRefs.map((r) => r.path)

    // (fix 723) Click point: clamp to real frame — ComfyUI only rejects
    // prompt if value exceeds widget max (16384), and being off
    // by a dozen pixels due to preview scale is harmless.
    const fp = body.facePoint
    const facePoint = fp && Number.isFinite(fp.x) && Number.isFinite(fp.y)
      ? {
          x: Math.max(0, Math.min(Math.max(1, probe.width) - 1, Math.round(fp.x as number))),
          y: Math.max(0, Math.min(Math.max(1, probe.height) - 1, Math.round(fp.y as number))),
          frame: Math.max(0, Math.min(Math.max(0, probe.frames - 1), Math.round(fp.frame ?? 0))),
        }
      : undefined

    // Face reference of "this person" must reside in input/.
    //
    // (fix 723) Click point takes precedence over photo: with identity_reference
    // connected, the node does not look at X/Y at all — in the report this is the line
    // "ignored - identity_reference decides", and in live run this ended up picking the wrong
    // face (match with photo 0.48 passed threshold 0.28). While a face is selected
    // by click, do not pass reference into workflow; in meta it stays flagged,
    // so clearing the point and returning to photo is possible on rerun.
    const identityReference = body.identityReference
      ? path.basename(body.identityReference)
      : undefined
    const identityReferenceForRun = facePoint ? undefined : identityReference
    if (identityReferenceForRun && !existsSync(path.join(cfg.inputDir, identityReferenceForRun))) {
      return NextResponse.json(
        { error: `Face reference not found in input: ${identityReferenceForRun}` },
        { status: 404 },
      )
    }

    const steps = Math.max(1, Math.min(64, Math.round(body.steps ?? DEFAULT_FACE_STEPS)))
    const denoise = Math.max(0.01, Math.min(1, body.denoise ?? DEFAULT_FACE_DENOISE))
    const canvas = Math.max(128, Math.min(1344, Math.round((body.canvas ?? 512) / 32) * 32))
    // RandomNoise requires a non-negative seed: ComfyUI rejects -1.
    // Resolve concrete seed ourselves (same as "Generation" tab) and write it to
    // metadata — otherwise rerun cannot be reproduced.
    const seed = (body.seed ?? -1) < 0 ? Math.floor(Math.random() * 2 ** 31) : (body.seed ?? -1)

    // (fix 722) Fetch detectors from live ComfyUI combo: after registering
    // models/ultralytics directory names come with subfolder (bbox\face_yolov8m.pt),
    // and old value without subfolder would be rejected by prompt validation.
    const detectors = await resolveFaceDetectors()
    const fallbackDetector =
      body.fallback === true && detectors.fallbackDetector ? detectors.fallbackDetector : 'none'
    const fallbackUnavailable = body.fallback === true && !detectors.fallbackDetector

    // Built-in turbo LoRA — ON by default, same as other modes.
    // Default face-refine steps is 4 — tailored for this 4-step LoRA.
    const turboLoraEntry = enabledCustomLoras().find((e) => e.name === TURBO_LORA_NAME)
    const turboLora = turboLoraEntry?.name

    const workflow = buildFaceRefineWorkflow({
      sourceVideo: inName,
      diffusionModel: cfg.diffusionModel || undefined,
      prompt,
      seed,
      canvas,
      denoise,
      steps,
      lora: turboLora,
      loraStrength: turboLoraEntry?.strength,
      sampler: body.sampler,
      select: body.select,
      selectIndex: body.selectIndex,
      facePoint,
      identityReference: identityReferenceForRun,
      identityModel: body.identityModel,
      identityThreshold: body.identityThreshold,
      identityTrack: body.identityTrack,
      cropFactor: body.cropFactor,
      confidence: body.confidence,
      detector: detectors.detector,
      fallbackDetector,
      pasteRegion: body.pasteRegion,
      feather: body.feather,
      colourMatch: body.colourMatch,
      blend: body.blend,
      undetectedFrames: body.undetectedFrames,
      denoiseSmall: body.denoiseSmall,
      denoiseLarge: body.denoiseLarge,
      refImages: usedRefs,
      refImageSize: body.refImageSize,
      // Source dimensions/length — for .latent result sidecar (ceil32 canvas,
      // silence of proper length for silent videos): repeated refine of this video
      // will follow lossless latent path.
      width: probe.width,
      height: probe.height,
      frames: probe.frames,
      outputSubfolder: sub,
      videoFormat: getVideoFormatSettings(),
    })

    const run = await runGeneration(() =>
      submitWorkflowJson(workflow, [['fr_sample']]))
    if (!run.ok) {
      return NextResponse.json({ error: run.error }, { status: run.status })
    }

    if (run.result.prompt_id) {
      setActivePrompt(run.result.prompt_id)
      recordPendingMetaRaw(run.result.prompt_id, {
        prompt,
        model_type: 'minimax_h3_ref2va',
        workflow: 'face-refine-track-crop-stitch',
        generation_mode: 'facerefine',
        source_video: { filename: safeName || inName, subfolder: sub },
        source: { width: probe.width, height: probe.height, frames: probe.frames },
        seed,
        prompt_source: promptSource,
        canvas,
        denoise,
        // Steps — in pass1_steps field (unified sidecar contract: read by
        // "Steps" row in MetaDialog; refine route writes same). Old
        // sidecars with steps field are supported by dialog fallback.
        pass1_steps: steps,
        ...(turboLora && { lora: turboLora }),
        sampler: body.sampler || 'euler',
        select: facePoint ? 'closest_to_xy' : (body.select || 'largest_face'),
        select_index: body.selectIndex ?? 0,
        ...(facePoint && {
          face_point: { x: facePoint.x, y: facePoint.y, frame: facePoint.frame },
        }),
        ...(identityReferenceForRun && { identity_reference: identityReferenceForRun }),
        ...(facePoint && identityReference && { identity_reference_ignored: identityReference }),
        ...(body.identityModel && { identity_model: body.identityModel }),
        crop_factor: body.cropFactor ?? 2.5,
        confidence: body.confidence ?? 0.35,
        detector: detectors.detector,
        ...(fallbackDetector !== 'none' && { fallback_detector: fallbackDetector }),
        paste_region: body.pasteRegion || 'face_only',
        feather: body.feather ?? 6,
        colour_match: body.colourMatch ?? 1,
        blend: body.blend ?? 1,
        undetected_frames: body.undetectedFrames || 'fade_out',
        denoise_multiplier_small_face: body.denoiseSmall ?? 1.0,
        denoise_multiplier_large_face: body.denoiseLarge ?? 0.35,
        ...(usedRefs.length > 0 && {
          references: usedRefs.map((p) => ({
            type: 'image',
            path: p,
            role: metaRefs.find((r) => r.path === p)?.role || '',
          })),
        }),
      })
    }

    return NextResponse.json({
      ...run.result,
      inputName: inName,
      source: { width: probe.width, height: probe.height, frames: probe.frames },
      promptSource,
      detector: detectors.detector,
      fallbackDetector,
      fallbackUnavailable,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[face-refine] ERROR:', msg)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
