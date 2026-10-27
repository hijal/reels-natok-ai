/**
 * Model registry — defines all required models with their download URLs
 * and target paths relative to the ComfyUI root.
 */

export interface ModelDef {
  id: string
  label: string
  /** Relative path from ComfyUI root (e.g. "diffusion_models/xxx.safetensors") */
  relPath: string
  /** Direct download URL */
  url: string
  /**
   * Exact file size in BYTES.
   *
   * IMPORTANT: this is exactly the `content-length` value returned by the server
   * (verified via HEAD request), not a rounded "N GB". The size is needed for
   * two checks in model-downloader.ts:
   *   • sizeOk()      — file is considered downloaded if it differs from
   *                      expected by no more than ±10%;
   *   • doDownload()  — file is considered incomplete with completion < 0.9.
   *
   * Previously this had `gb(N)` = N × 2³⁰ (binary GB), while sizes were
   * transcribed from the HuggingFace UI, where GB are decimal (10⁹). The 7.4%
   * difference ate the margin: for `llm_assistant_q5` only 1.1 pp was left to the 0.9 threshold,
   * and a fully downloaded file could be declared incomplete.
   * Now expected == actual byte-for-byte size.
   */
  sizeBytes: number
  /** Human-readable size */
  sizeLabel: string
  /** (fix 269) Category for grouping in UI */
  category: 'diffusion' | 'text_encoder' | 'vae' | 'lora' | 'upscaler' | 'preview' | 'llm' | 'fps' | 'veda' | 'preprocessor' | 'face'
  /** (fix 138 / Bonsai / 269) Where to place the file: 'comfy' (by default —
   *  ComfyUI/models/<relPath>), 'bonsai' (<bonsai_dir>/<relPath>) or
   *  'custom' (<baseDir>/<relPath> — arbitrary directory, e.g.
   *  custom node model folder). */
  target?: 'comfy' | 'bonsai' | 'custom'
  /** (fix 269) Absolute root directory when target='custom'. */
  baseDir?: string
  /** (fix 138 / Bonsai) URL points to a ZIP: after downloading extract
   *  ONLY these files (recursive archive search) into relPath directory. */
  extractFiles?: string[]
  /** (fix 138) Optional model: panel shows it, but "Download all"
   *  does NOT download it (no extra gigabytes without user's consent). */
  optional?: boolean
}

export const MODELS: ModelDef[] = [
  {
    id: 'diffusion',
    // (fix 293) Primary model — switched back (was better in quality).
    // Kijai/MiniMax-H3-experimental. 4-step generation (FastH3 VSA DataFree), ~22.9 GB.
    label: 'Diffusion Model (FastH3 VSA DataFree 4-step INT8 ConvRot)',
    relPath: 'diffusion_models/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-experimental/resolve/main/minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors?download=true',
    sizeBytes: 22898594920,
    sizeLabel: '~22.9 GB',
    category: 'diffusion',
  },
  {
    id: 'text_encoder',
    label: 'Text Encoder (Qwen3VL 32B NVFP4)',
    relPath: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors?download=true',
    sizeBytes: 15687142551,
    sizeLabel: '~15.7 GB',
    category: 'text_encoder',
  },
  {
    id: 'vae_video',
    label: 'Video VAE (INT8 ConvRot)',
    relPath: 'vae/minimax_h3_video_vae_int8_convrot.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_video_vae_int8_convrot.safetensors?download=true',
    sizeBytes: 2811065184,
    sizeLabel: '~2.8 GB',
    category: 'vae',
  },
  {
    id: 'vae_audio',
    label: 'Audio VAE (FP32)',
    relPath: 'vae/minimax_h3_audio_vae_fp32.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/vae/minimax_h3_audio_vae_fp32.safetensors?download=true',
    sizeBytes: 605254808,
    sizeLabel: '~0.6 GB',
    category: 'vae',
  },
  {
    id: 'lora_turbo',
    label: 'Turbo LoRA (4-step v0.1)',
    relPath: 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    url: 'https://huggingface.co/Comfy-Org/MiniMax-H3/resolve/main/loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors?download=true',
    sizeBytes: 1956193000,
    sizeLabel: '~1.8 GB',
    category: 'lora',
    // Required: enabled by default in all modes (except "Frames" with
    // audio), so "Download all" pulls it along with base models,
    // and yellow banner "models not downloaded" requires it on par with them.
  },
  {
    id: 'upscaler',
    label: 'Latent Upscaler 3D (FP16)',
    relPath: 'latent_upscale_models/minimax_h3_latent_upscaler_3d_fp16.safetensors',
    url: 'https://huggingface.co/LBH-123-AI/Minimax_h3_latent_Upscaler/resolve/main/minimax_h3_latent_upscaler_3d_conv_v1/minimax_h3_latent_upscaler_3d_conv_v1_fp16.safetensors?download=true',
    sizeBytes: 690592672,
    sizeLabel: '~691 MB',
    category: 'upscaler',
  },
  {
    id: 'tae_preview',
    label: 'TAE Preview Decoder (taeh3)',
    relPath: 'vae_approx/taeh3.safetensors',
    url: 'https://huggingface.co/Kijai/MiniMax-H3-TAE/resolve/main/vae_approx/taeh3.safetensors?download=true',
    sizeBytes: 9791388,
    sizeLabel: '~9.8 MB',
    category: 'preview',
  },
  {
    id: 'llm_assistant',
    label: 'Assistant — Gemma 4 12B (Q4_K_M, omni)',
    relPath: 'llm/gemma-4-12b-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q4_K_M.gguf?download=true',
    sizeBytes: 7121861440,
    sizeLabel: '~7.1 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q3',
    label: 'Assistant — Gemma 4 12B (Q3_K_M, lightweight, ~8 GB VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q3_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q3_K_M.gguf?download=true',
    sizeBytes: 5693872960,
    sizeLabel: '~5.7 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_q5',
    label: 'Assistant — Gemma 4 12B (Q5_K_M, high quality, ~12 GB VRAM)',
    relPath: 'llm/gemma-4-12b-it-Q5_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/gemma-4-12b-it-Q5_K_M.gguf?download=true',
    sizeBytes: 8413576000,
    sizeLabel: '~8.4 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_mmproj',
    label: 'Vision Projector (mmproj BF16) — for LLM vision',
    relPath: 'llm/mmproj-BF16.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12b-it-GGUF/resolve/main/mmproj-BF16.gguf?download=true',
    sizeBytes: 175115840,
    sizeLabel: '~175 MB',
    category: 'llm',
  },
  // ── Qwen3.5 9B (fix 52) — alternative LLM for weaker machines: ──
  // multimodal (image + video), ~5.7 GB Q4 vs 7.1 for Gemma 12B,
  // hybrid Gated DeltaNet → more economical KV cache. Requires modern llama.cpp
  // (qwen35 architecture) — user tests on their hardware.
  // Files in subfolder llm/qwen3.5-9b/ to avoid conflicting with Gemma.
  {
    id: 'llm_assistant_qwen',
    label: 'Assistant — Qwen3.5 9B (Q4_K_M, vision, lightweight VRAM)',
    relPath: 'llm/qwen3.5-9b/Qwen3.5-9B-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf?download=true',
    sizeBytes: 5680522464,
    sizeLabel: '~5.7 GB',
    category: 'llm',
  },
  {
    id: 'llm_assistant_qwen_mmproj',
    label: 'Vision Projector (Qwen3.5 mmproj F16) — vision for Qwen3.5 9B',
    relPath: 'llm/qwen3.5-9b/mmproj-F16.gguf',
    url: 'https://huggingface.co/unsloth/Qwen3.5-9B-GGUF/resolve/main/mmproj-F16.gguf?download=true',
    sizeBytes: 918166080,
    sizeLabel: '~918 MB',
    category: 'llm',
  },
  // ── (fix 138) Bonsai 2 27B — ternary LLM assistant on llama.cpp fork
  // (PrismML). Engine and models live in <bonsai_dir> (by default
  // <project>/Bonsai_2_27B), NOT in ComfyUI models. Exact engine version
  // matched for model quants (prism-b10709-9a9394a, CUDA 12.4).
  {
    id: 'bonsai_engine_bin',
    label: 'Bonsai: llama-server engine (PrismML b10709, binaries)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/llama-prism-b10709-9a9394a-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 253442371,
    sizeLabel: '~242 MB',
    category: 'llm',
    extractFiles: [
      'llama-server.exe',
      'llama-server-impl.dll',
      'llama-common.dll',
      'llama.dll',
      'mtmd.dll',
      'ggml.dll',
      'ggml-base.dll',
      'ggml-cpu.dll',
      'ggml-cuda.dll',
      'ggml-rpc.dll',
    ],
  },
  {
    id: 'bonsai_engine_cudart',
    label: 'Bonsai: engine — CUDA DLL (cublas/cudart 12.4)',
    relPath: 'llama.cpp/',
    target: 'bonsai',
    url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b10709-9a9394a/cudart-llama-bin-win-cuda-12.4-x64.zip',
    sizeBytes: 391443627,
    sizeLabel: '~373 MB',
    category: 'llm',
    extractFiles: ['cublas64_12.dll', 'cublasLt64_12.dll', 'cudart64_12.dll'],
  },
  {
    id: 'bonsai_model',
    label: 'Bonsai 2 27B — model (PQ2_0, ternary, vision)',
    relPath: 'models/Ternary-Bonsai-2-27B-PQ2_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PQ2_0.gguf?download=true',
    sizeBytes: 7206168928,
    sizeLabel: '~7.2 GB',
    category: 'llm',
  },
  {
    id: 'bonsai_mmproj',
    label: 'Bonsai 2 27B — Vision Projector (mmproj Q8_0)',
    relPath: 'models/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf?download=true',
    sizeBytes: 629246976,
    sizeLabel: '~630 MB',
    category: 'llm',
  },
  // ── (fix 269) FPS (frame interpolation, VFI) — "FPS" tab. ──
  // Package Fannovel16/ComfyUI-Frame-Interpolation searches models NOT in
  // ComfyUI/models, but in its folder custom_nodes/.../ckpts/<type>/<file>
  // (ckpts_path from config.yaml). Hence target='custom' + baseDir.
  // One model per mode (user decision): RIFE → rife49.pth,
  // FILM → film_net_fp32.pt. Downloaded in Settings → Models, not during
  // first generation run (package will download on run as fallback).
  {
    id: 'fps_rife',
    label: 'FPS RIFE VFI — rife49.pth',
    relPath: 'rife/rife49.pth',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation/ckpts',
    url: 'https://huggingface.co/marduk191/rife/resolve/main/rife49.pth',
    sizeBytes: 21345274,
    sizeLabel: '~21.3 MB',
    category: 'fps',
  },
  {
    id: 'fps_film',
    label: 'FPS FILM VFI — film_net_fp32.pt',
    relPath: 'film/film_net_fp32.pt',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/ComfyUI-Frame-Interpolation/ckpts',
    url: 'https://github.com/dajes/frame-interpolation-pytorch/releases/download/v1.0.0/film_net_fp32.pt',
    sizeBytes: 137905674,
    sizeLabel: '~132 MB',
    category: 'fps',
  },
  // ── (fix 301) Veda Sparse Attention — sparsification predictor. ──
  // Trained predictor (Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview)
  // for VedaSparseAttention node. File resides in ComfyUI/models/veda/.
  // Optional: needed ONLY if user enabled Veda in settings.
  {
    id: 'veda_predictor',
    label: 'Veda Sparse Attention — predictor (FP8)',
    relPath: 'veda/minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors',
    url: 'https://huggingface.co/Veda-Sparse/Minimax-H3-T2VA-Veda-8NFE-600Step-Preview/resolve/main/minimax_h3_t2va_veda_8nfe_600step_preview_fp8.safetensors?download=true',
    sizeBytes: 275415648,
    sizeLabel: '~275 MB',
    category: 'veda',
    optional: true,
  },
  // Depth preprocessor for "ControlNet" tab (Depth Anything V2 Small).
  // Node comfyui_controlnet_aux looks for it in ITS OWN ckpts/<repo>/<file> folder
  // (custom_hf_download), NOT in ComfyUI/models — hence target='custom'.
  {
    id: 'depth_anything_v2_vits',
    label: 'Depth Anything V2 Small (depth preprocessor)',
    relPath: 'depth_anything_v2_vits.pth',
    target: 'custom',
    baseDir: 'ComfyUI/custom_nodes/comfyui_controlnet_aux/ckpts/depth-anything/Depth-Anything-V2-Small',
    url: 'https://huggingface.co/depth-anything/Depth-Anything-V2-Small/resolve/main/depth_anything_v2_vits.pth?download=true',
    sizeBytes: 99218434,
    sizeLabel: '~99 MB',
    category: 'preprocessor',
    optional: true,
  },
  // ── (fix 722) Face Refine — face detectors for "Face Refine" tab. ──
  // Package ComfyUI-H3-FaceRefine searches detection models in models/ultralytics/bbox
  // (fallback inside node if folder is not registered in ComfyUI as
  // category). face_yolov8m — face detector, person_yolov8m-seg — whole person
  // (fallback detector for wide shots where face is not visible).
  {
    id: 'face_yolov8m',
    label: 'Face Refine — face detector (face_yolov8m)',
    relPath: 'ultralytics/bbox/face_yolov8m.pt',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/main/face_yolov8m.pt',
    sizeBytes: 52026019,
    sizeLabel: '~50 MB',
    category: 'face',
    optional: true,
  },
  {
    id: 'person_yolov8m_seg',
    label: 'Face Refine — person detector (person_yolov8m-seg)',
    relPath: 'ultralytics/segm/person_yolov8m-seg.pt',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/main/person_yolov8m-seg.pt',
    sizeBytes: 54827683,
    sizeLabel: '~52 MB',
    category: 'face',
    optional: true,
  },
  {
    id: 'bonsai_model_light',
    label: 'Bonsai 2 27B — model (PTQ1_0, lightest, ~6 GB, for ≤8 GB cards)',
    relPath: 'models/Ternary-Bonsai-2-27B-PTQ1_0.gguf',
    target: 'bonsai',
    url: 'https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf/resolve/main/Ternary-Bonsai-2-27B-PTQ1_0.gguf?download=true',
    // (fix 169) Actual size PTQ1_0 = 5.95 GB (HuggingFace model card).
    // Was 595 MB → failed modelExists(); was 6.2 → failed
    // final validation in doDownload (5.95/6.2 = 0.91, but with rounding
    // error HuggingFace sometimes serves slightly less → <0.9 → error).
    sizeBytes: 5946648928,
    sizeLabel: '~5.95 GB',
    category: 'llm',
    // Optional: downloaded manually only; runner picks it up if
    // primary PQ2_0 is not downloaded, but PTQ1_0 exists.
    optional: true,
  },
]

/** Group by category for UI display */
export const MODEL_CATEGORIES: { key: ModelDef['category']; label: string }[] = [
  { key: 'diffusion', label: 'Diffusion Model' },
  { key: 'text_encoder', label: 'Text Encoder' },
  { key: 'vae', label: 'VAE' },
  { key: 'lora', label: 'LoRA' },
  { key: 'upscaler', label: 'Upscaler' },
  { key: 'preview', label: 'Preview' },
  { key: 'llm', label: 'LLM Assistant' },
  // (fix 269) FPS (frame interpolation)
  { key: 'fps', label: 'FPS (VFI)' },
  // (fix 301) Veda Sparse Attention predictor
  { key: 'veda', label: 'Veda Attention' },
  // Preprocessors (depth/canny for ControlNet tab)
  { key: 'preprocessor', label: 'Preprocessors' },
  // (fix 722) Face/person detectors for Face Refine tab
  { key: 'face', label: 'Face Refine (detectors)' },
]
