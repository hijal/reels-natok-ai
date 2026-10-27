/**
 * refine-sigmas — Refine schedule (sigma ladder).
 *
 * (fix 723) Extracted from refine-template.ts into a module without imports: the
 * Refine tab needs to display actual sigmas and set the preset "as Pass 2", and
 * pulling the entire workflow template (95 KB) into the client bundle for a single line
 * is unnecessary.
 */

/** Starting sigma of Pass 2 two-pass generation (ManualSigmas). */
export const REFINE_PASS2_SIGMA = 0.9035

/** Steps count in Pass 2 two-pass generation. */
export const REFINE_PASS2_STEPS = 3

/** Refine sigma ladder = Pass 2 ladder in generation (SIGMA_VARIANTS). */
const SIGMA_LADDERS: Record<number, string> = {
  3: '0.9035, 0.6316, 0.3158, 0.0000',
  4: '0.9035, 0.8000, 0.6316, 0.3158, 0.0000',
  5: '0.9231, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  6: '0.9412, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
  7: '0.9500, 0.9280, 0.9100, 0.8780, 0.8000, 0.6316, 0.3158, 0.0000',
}

/**
 * Ladder adjusted for starting sigma: the Pass 2 base schedule is
 * scaled by the factor sigmaStart / 0.9035.
 *
 * This way "strength" remains a single number and does not break familiar steps: at 0.9 the ladder
 * is almost equal to Pass 2, at 0.6 — noticeably softer. Setting higher than 0.9035 here makes
 * no sense (that's already Pass 2), and below ~0.6 begins an area where "strength" changes not
 * the repaint depth, but simply weakens all steps.
 */
export function refineSigmaLadder(steps: number, sigmaStart?: number): string {
  const base = SIGMA_LADDERS[Math.round(steps)] ?? SIGMA_LADDERS[3]
  if (!sigmaStart || !(sigmaStart > 0)) return base
  const first = parseFloat(base.split(',')[0])
  const k = Math.min(0.95, Math.max(0.1, sigmaStart)) / first
  return base
    .split(',')
    .map((s, i, arr) => (i === arr.length - 1 ? '0.0000' : (parseFloat(s) * k).toFixed(4)))
    .join(', ')
}
