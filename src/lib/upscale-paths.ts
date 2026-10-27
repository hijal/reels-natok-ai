/**
 * (fix 716) Allowed local file roots for the Upscale tab.
 *
 * Moved to a separate module rather than api/upscale/file/route.ts: route.ts
 * files in Next.js App Router can only export handlers and configuration —
 * any other export breaks the build.
 */
import path from 'path'
import { getAppConfig } from '@/lib/app-config'

/** Roots from which upscale can read and write files. */
export function upscaleAllowedRoots(): string[] {
  return [
    // (fix 74.2) main results are written to the shared ComfyUI output folder
    path.resolve(getAppConfig().outputDir),
    path.resolve(process.cwd(), 'data', 'upscale-output'),
    path.resolve(process.cwd(), 'data', 'upscale-input'),
    path.resolve(process.cwd(), 'upscale', 'outputs'),
  ]
}
