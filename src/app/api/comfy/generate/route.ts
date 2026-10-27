import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { submitVideo, uploadImage, uploadExtenderRef, COMFY_URL } from '@/lib/comfy/minimax-h3-client'
import type { ExtenderRefDescriptor } from '@/lib/comfy/minimax-h3-client'
import { setActivePrompt } from '@/lib/comfy/progress-tracker'
import { readStaged, deleteStaged } from '@/lib/staging'
import { recordPendingMeta } from '@/lib/pending-meta'
import { recordInflight } from '@/lib/inflight-journal'
import { loadLoras, listLoraFiles, TURBO_LORA_NAME } from '@/lib/loras-config'
import { getAppConfig } from '@/lib/app-config'
import { sanitizeFolderPath } from '@/lib/gallery-folders' // (fix 495)
import { resolveSourceLatent } from '@/lib/refine-meta' // (fix 420)
import { resolveFfmpeg } from '@/lib/thumb'
import { probeVideoFile } from '@/lib/video-probe'
import { compressRefVideo480 } from '@/lib/ref-video-compress' // (fix 493)
import { runGeneration, assertGenerationAllowed } from '@/lib/vram-arbiter'
import type { MiniMaxH3Params } from '@/lib/comfy/minimax-h3-template'

const execFileAsync = promisify(execFile)

/**
 * POST /api/comfy/generate
 * Body: MiniMaxH3Params (prompt, refImages[], aspectRatio, duration, seed, finalResolution?, lowResMP?, sigmaVariant?)
 * If refImages contains base64 data, uploads them first.
 * Staged reference names (uploaded while ComfyUI was down) are transferred
 * to ComfyUI's input/ here; the response carries `staged_transfers`
 * (stagedName → comfyName) so the client can update its references.
 */
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    // (fix 716) Body limit. Everywhere in the project uploads are streamed with
    // an explicit limit (multipart-stream.ts, 1 GB per upload), but here
    // req.json() buffers the entire body including refImagesBase64 — a client
    // could send hundreds of megabytes and crash the Next.js process with OOM.
    const MAX_BODY_BYTES = 256 * 1024 * 1024
    const declared = Number(req.headers.get('content-length') || 0)
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      return NextResponse.json(
        { error: 'Request body too large (maximum 256 MB). Upload references via /api/comfy/upload.' },
        { status: 413 },
      )
    }
    const body = await req.json() as MiniMaxH3Params & {
      refImagesBase64?: string[]
      extendRefsBase64?: string[]
      /** (fix 385, REVERTED by fix 417; reintroduced by fix 420 in a new
       *  role) extend: original address in output/. Used ONLY
       *  to resolve the pristine source latent for post-assembly of
       *  combined latent (fix 420) — not fed into generation. */
      extendSourceName?: string
      extendSourceSubfolder?: string
    }

    if (!body?.prompt) {
      return NextResponse.json({ error: 'Prompt is required.' }, { status: 400 })
    }
    const cfg = getAppConfig()

    // (fix 91) Project folder — forwarded to VHS filename_prefix
    // ("folder/Minimax_Studio") and sidecar paths. Client sends '' (common)
    // or path to existing folder.
    // (fix 495) Nested folders: multi-level relative path
    // ('a/b'), each segment sanitized, '.'/'..' stripped.
    body.outputSubfolder = sanitizeFolderPath(String(body.outputSubfolder ?? ''))

    // Fast-path 409 (before reference upload): assistant is busy — avoid wasting
    // time on upload and leaving orphaned files in ComfyUI input/.
    // Full check is executed under mutex in runGeneration.
    const quickBlock = assertGenerationAllowed()
    if (quickBlock) {
      return NextResponse.json({ error: quickBlock }, { status: 409 })
    }

    // (fix 587) File names uploaded to ComfyUI input/ during THIS request: if
    // generation is rejected LATER (409/503 under mutex — quick check above does
    // not cover the window between it and runGeneration), delete them without leaving orphans.
    const uploadedThisRequest: string[] = []

    // Upload base64 images if provided
    if (body.refImagesBase64?.length) {
      // (fix 716) Cap on image count: model accepts up to 9
      // image references. Without a limit the client could send
      // thousands of base64 images — each decoded and written to disk.
      const MAX_REF_IMAGES = 9
      if (body.refImagesBase64.length > MAX_REF_IMAGES) {
        return NextResponse.json(
          { error: `Too many references (maximum ${MAX_REF_IMAGES})` },
          { status: 400 },
        )
      }
      for (let i = 0; i < body.refImagesBase64.length; i++) {
        const b64 = body.refImagesBase64[i].replace(/^data:image\/\w+;base64,/, '')
        const buf = Buffer.from(b64, 'base64')
        const ext = body.refImagesBase64[i].includes('/png') ? 'png' : 'jpg'
        const name = `ref_${Date.now()}_${i}.${ext}`
        const uploaded = await uploadImage(buf, name)
        uploadedThisRequest.push(uploaded)
        body.refImages = body.refImages || []
        // (fix 341) push instead of index assignment: staged names already
        // reside in refImages[0..n], and base64 upload overwrote them by index.
        body.refImages.push(uploaded)
      }
    }

    // Transfer staged reference files (uploaded while ComfyUI was down)
    const transfers: Record<string, string> = {}
    const transferStaged = async (name: string) => {
      const staged = await readStaged(name)
      if (staged) {
        const comfyName = await uploadImage(staged, name)
        uploadedThisRequest.push(comfyName)
        transfers[name] = comfyName
        // Delete local copy: client updates paths via
        // staged_transfers, otherwise .local-input/ grows indefinitely and
        // continues shadowing previews (file route checks staging first).
        await deleteStaged(name)
        return comfyName
      }
      return name
    }
    if (body.refImages?.length) {
      for (let i = 0; i < body.refImages.length; i++) {
        body.refImages[i] = await transferStaged(body.refImages[i])
      }
    }
    if (body.refVideos?.length) {
      for (let i = 0; i < body.refVideos.length; i++) {
        body.refVideos[i].path = await transferStaged(body.refVideos[i].path)
      }
    }
    // (fix 493) "Compress video": references with compress flag are resized to
    // 480p (short side, aspect ratio preserved). We swap the path ONLY
    // for submit — original file + compress flag goes into meta (so
    // "Repeat" will restore source and recompress it, while compressed copies
    // are cached — rerun is free).
    let refVideosForSubmit = body.refVideos
    if (body.refVideos?.some((v) => v.compress === true)) {
      refVideosForSubmit = []
      for (const v of body.refVideos) {
        if (v.compress === true) {
          try {
            refVideosForSubmit.push({ ...v, path: await compressRefVideo480(v.path) })
          } catch (e) {
            return NextResponse.json(
              { error: `Compressing video reference "${v.path}": ${e instanceof Error ? e.message : String(e)}` },
              { status: 500 },
            )
          }
        } else {
          refVideosForSubmit.push(v)
        }
      }
    }
    if (body.refAudios?.length) {
      for (let i = 0; i < body.refAudios.length; i++) {
        body.refAudios[i] = await transferStaged(body.refAudios[i])
      }
    }
    // (fix 146) flf mode frames — same staged transfer as references
    if (body.firstFrame) body.firstFrame = await transferStaged(body.firstFrame)
    if (body.lastFrame) body.lastFrame = await transferStaged(body.lastFrame)
    // (fix 164) Video source for extension — staged transfer
    // (fix 421) basename(): if file is not in staging, transferStaged
    // returns raw client name, which is then passed to
    // path.join(input/, ...) — same as basename in outputSubfolder (91).
    if (body.extendSourceVideo) body.extendSourceVideo = path.basename(await transferStaged(body.extendSourceVideo))

    // (fix 212) Extend: target resolution of clips = SOURCE SIZE.
    // Previously default remained (16:9 + finalResolution) — clips were generated
    // in foreign resolution, and at the seam "original → continuation" a scale
    // jump was visible. ffmpeg -i gives exact W×H of source.
    if (body.mode === 'extend' && body.extendSourceVideo) {
      try {
        const srcPath = path.join(cfg.inputDir, body.extendSourceVideo)
        if (fs.existsSync(srcPath)) {
          const ffmpegBin = await resolveFfmpeg()
          if (ffmpegBin) {
            const probe = await execFileAsync(ffmpegBin, ['-hide_banner', '-i', srcPath], { timeout: 15_000 })
              .then(() => '')
              .catch((e: unknown) => ((e as { stderr?: string }).stderr ?? ''))
            // (fix 359) Look for resolution ONLY in video stream line —
            // general /\d+x\d+/ could match size from metadata/tags.
            const videoLine = probe.split('\n').find((l) => /Stream #.*Video:/.test(l)) ?? probe
            const m = /(\d{2,5})x(\d{2,5})/.exec(videoLine)
            if (m) {
              let w = parseInt(m[1], 10)
              let h = parseInt(m[2], 10)
              // (fix 218) SAR≠1: generate in DISPLAY aspect — how file
              // looks upon playback (concat also calculates
              // target by DAR), otherwise clip and source diverge in aspect ratio.
              const sarM = /SAR (\d+):(\d+) DAR (\d+):(\d+)/.exec(probe)
              if (sarM) {
                const sw = parseInt(sarM[1], 10)
                const sh = parseInt(sarM[2], 10)
                if (sw > 0 && sh > 0 && sw !== sh) {
                  w = w * sw
                  h = h * sh
                }
              }
              // even dimensions — yuv420p does not support odd dimensions
              body.targetDimensions = {
                width: 2 * Math.round(w / 2),
                height: 2 * Math.round(h / 2),
              }
            }
          }
        }
      } catch {
        // probe failed — fallback to aspectRatio path as before
      }

      // (fix 254) Actual length of source in frames: tail plan
      // of latent masking chain is clamped to it in builder. Without this,
      // a short source gave a shift of mask preserved zone → "pure noise"
      // at the beginning of the first clip.
      try {
        const srcPath2 = path.join(cfg.inputDir, body.extendSourceVideo)
        if (fs.existsSync(srcPath2)) {
          const pr = await probeVideoFile(srcPath2)
          if (Number.isFinite(pr.frames) && pr.frames > 0) {
            body.extendSourceFrames = pr.frames
          }
          // (fix 420) Resolution of pristine source latent — NOT for
          // generation (seed remains pixel-based, fixes 409/419), but for
          // POST-ASSEMBLY of combined result latent: concat timeline is assembled
          // from latent chunks AFTER samplers and saved to file
          // (lossless refine/upscale of extended video). If latent is missing or
          // does not match mp4 — builder encodes entire source itself (fallback).
          const srcName = typeof body.extendSourceName === 'string' ? path.basename(body.extendSourceName) : ''
          const srcSubRaw = typeof body.extendSourceSubfolder === 'string'
            ? body.extendSourceSubfolder.split(/[\\/]/).filter(Boolean)
            : []
          if (srcName && srcSubRaw.length <= 1 && !srcSubRaw.some((x) => x === '.' || x === '..')) {
            const resolved = resolveSourceLatent(srcSubRaw[0] ?? '', srcName, pr, (reason) =>
              console.warn(`[generate/extend] pristine latent not used (${srcName}): ${reason}`),
            )
            if (resolved) {
              body.extendSourceLatentFile = resolved.file
            }
          }
        }
      } catch {
        // frame probe failed — builder stays on duration plan
      }
    }

    // (fix 161) extend refs: images are uploaded to INTERNAL cache
    // of Extender node via /h3_extender/ref/upload — node expects
    // content-addressed descriptor (id = 64 hex), NOT a file name from
    // ComfyUI input/. Therefore: (1) read staged file locally;
    // (2) upload to node cache;
    // (3) in body.extendRefsDescriptor[] — descriptors (not filenames),
    //     body.extendRefs — keep filenames for metadata ("Repeat").
    // (fix 161) Client may send extendRefsBase64 — array of base64
    // (data-URI), if images are not yet uploaded to staged.
    const extendRefDescriptors: ExtenderRefDescriptor[] = []
    const extendRefsStaged: string[] = []
    if (body.extendRefs?.length) {
      for (const rawName of body.extendRefs) {
        // (fix 421) basename(): name comes from client and goes to
        // path.join(input/, ...) — consistent with other routes.
        const name = path.basename(String(rawName))
        const staged = await readStaged(name)
        if (staged) {
          const desc = await uploadExtenderRef(staged, name)
          extendRefDescriptors.push(desc)
          extendRefsStaged.push(name)
          await deleteStaged(name)
        } else {
          // File already in ComfyUI input/ — read from disk and upload to node cache.
          const filePath = path.join(cfg.inputDir, name)
          if (!fs.existsSync(filePath)) {
            return NextResponse.json(
              { error: `Extension ref "${name}" not found in ComfyUI input/ — remove it from list and upload again.` },
              { status: 400 },
            )
          }
          const buf = fs.readFileSync(filePath)
          const desc = await uploadExtenderRef(buf, name)
          extendRefDescriptors.push(desc)
          extendRefsStaged.push(name)
        }
      }
    }
    if (body.extendRefsBase64?.length) {
      for (let i = 0; i < body.extendRefsBase64.length; i++) {
        const raw = body.extendRefsBase64[i]
        const b64 = raw.replace(/^data:image\/\w+;base64,/, '')
        const buf = Buffer.from(b64, 'base64')
        const ext = raw.includes('/png') ? 'png' : 'jpg'
        const name = `extref_${Date.now()}_${i}.${ext}`
        const desc = await uploadExtenderRef(buf, name)
        extendRefDescriptors.push(desc)
        extendRefsStaged.push(name)
      }
    }
    if (extendRefDescriptors.length > 0) {
      body.extendRefDescriptors = extendRefDescriptors as unknown as Array<Record<string, unknown> & { id: string }>
      if (extendRefsStaged.length > 0) {
        // Update names (staged → comfy) for metadata.
        body.extendRefs = extendRefsStaged.map((n) => transfers[n] ?? n)
      }
    }

    // Custom LoRAs: inject enabled ones from config (fix 44).
    // (fix 89) Verification with disk files: entry in loras.json whose
    // file was deleted manually outside the app is a "ghost", ComfyUI would crash
    // trying to load nonexistent lora. We quietly skip such entries.
    //
    // Built-in turbo LoRA is a normal loras.json entry (enabled by
    // default) and passes through the same customLoras chain. Exception:
    // "Frames" mode (flf) with audio added — there turbo LoRA is skipped
    // (audio guide is more stable without 4-step accelerator). User's regular LoRAs
    // are never filtered.
    const loraFiles = new Set(listLoraFiles())
    const allEntries = loadLoras()
    const flfWithAudio = body.mode === 'flf' && (body.refAudios?.length ?? 0) > 0
    // ref + Audio Guide: like flf+audio, 4-step turbo LoRA interferes with
    // audio guide stability — skip it during such a run.
    const refAudioGuide = body.mode === 'ref' && body.audioGuide === true && (body.refAudios?.length ?? 0) > 0
    const loraEntries = allEntries.filter(
      (e) =>
        e.enabled &&
        loraFiles.has(e.name) &&
        !((flfWithAudio || refAudioGuide) && e.name === TURBO_LORA_NAME),
    )
    // Turbo LoRA is applied via customLoras rather than a dedicated template node;
    // we keep the fields consistent in case other code reads them.
    const turboEntry = allEntries.find((e) => e.name === TURBO_LORA_NAME)
    body.turboLoraEnabled =
      turboEntry?.enabled === true && loraFiles.has(TURBO_LORA_NAME) && !flfWithAudio && !refAudioGuide
    body.turboLoraStrength = turboEntry?.strength ?? 1.0
    // (fix 89) Source prompt WITHOUT triggers — goes into metadata,
    // otherwise "Repeat generation" will append triggers to already appended
    // prompt and they will accumulate with each repeat.
    const promptForMeta = body.prompt
    // (fix 483) Same for extend clips: extension conditioning is built
    // from extendClips[i].prompt (not body.prompt), so triggers are
    // appended to EACH clip. Originals are preserved — clean ones go into meta,
    // otherwise "Repeat" would accumulate triggers in clips.
    const extendClipsForMeta = body.extendClips
    body.customLoras = loraEntries.length > 0
      ? loraEntries.map((e) => ({ name: e.name, strength: e.strength }))
      : undefined
    if (loraEntries.length > 0) {
      // Append trigger words to the prompt (fix 46)
      const triggers = loraEntries
        .map((e) => e.trigger?.trim())
        .filter((t): t is string => !!t)
      if (triggers.length > 0) {
        const suffix = ' ' + triggers.join(', ')
        body.prompt = body.prompt + suffix
        // (fix 483) extend: triggers into prompt of each clip
        if (body.mode === 'extend' && body.extendClips?.length) {
          body.extendClips = body.extendClips.map((c) => ({ ...c, prompt: c.prompt + suffix }))
        }
      }
    }

    // Diffusion model: inject from config if set (fix 45).
    // (fix 89) File could be deleted from disk after selection — check
    // existence, otherwise template crashes on UNETLoader with missing file.
    if (cfg.diffusionModel) {
      const modelPath = path.join(cfg.comfyRoot, 'ComfyUI', 'models', 'diffusion_models', cfg.diffusionModel)
      if (fs.existsSync(modelPath)) {
        body.diffusionModel = cfg.diffusionModel
      }
    }

    // VRAM arbitration: LLM must COMPLETELY leave VRAM before loading MiniMax.
    // Mutex is held on submit as well — race window with chat is eliminated.
    // (fix 493) refVideosForSubmit — with substituted paths of compressed copies.
    const run = await runGeneration(() => submitVideo({ ...body, refVideos: refVideosForSubmit }))
    if (!run.ok) {
      // (fix 587) Rejection AFTER uploading references (409/503 under mutex —
      // LLM chat started between quick check and here) left orphan files in
      // ComfyUI input/. Delete best-effort; only for 409/503: on 500
      // submit could be partially queued, and deletion would break the job.
      if (uploadedThisRequest.length && (run.status === 409 || run.status === 503)) {
        try {
          await fetch(`${COMFY_URL}/upload/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete: uploadedThisRequest }),
          }).catch(() => {})
        } catch { /* best-effort */ }
      }
      return NextResponse.json({ error: run.error }, { status: run.status })
    }
    const result = run.result
    // Set active prompt so KJ preview events can be mapped
    if (result.prompt_id) {
      setActivePrompt(result.prompt_id)
      // Server-side metadata: persist the job params NOW so the sidecar can
      // be written on completion even if the browser tab is closed.
      // (fix 89) prompt without trigger words — see comment above;
      // (fix 483) extend clips to meta — also clean (without triggers)
      recordPendingMeta(result.prompt_id, {
        ...body,
        prompt: promptForMeta,
        ...(extendClipsForMeta ? { extendClips: extendClipsForMeta } : {}),
      })
      // (fix 331) Inflight journal: frontend sent clientToken in POST body —
      // after page reload during this request it will find prompt_id here
      // via GET /api/comfy/inflight and re-attach polling.
      const clientToken = (body as { clientToken?: unknown }).clientToken
      if (typeof clientToken === 'string' && clientToken.length > 0 && clientToken.length <= 100) {
        recordInflight(clientToken, result.prompt_id)
      }
    }
    return NextResponse.json({ ...result, staged_transfers: transfers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
