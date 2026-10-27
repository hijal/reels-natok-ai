/**
 * (fix 722) Server startup.
 *
 * Rewrite ComfyUI/extra_model_paths.yaml before backend launch: studio registers
 * its Face Refine detector folder in it (models/ultralytics → category
 * `ultralytics`). ComfyUI reads the file on import, so by the time /object_info
 * is built the category already exists — and the human model appears in
 * the H3FaceTrackCrop combo for fallback_detector.
 */
export async function register() {
  // Keep the import inside the runtime branch so webpack excludes Node-only
  // filesystem code from the Edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { syncExtraModelPathsYaml } = await import('./lib/extra-model-paths')
      syncExtraModelPathsYaml()
    } catch (e) {
      console.error('[startup] extra_model_paths.yaml:', e instanceof Error ? e.message : e)
    }
  }
}
