/**
 * (fix 392) Shared LatentCut helper with chunking under ComfyUI limit.
 *
 * ComfyUI validates LatentCut inputs: index/amount <= MAX_RESOLUTION
 * (16384, comfy_extras/nodes_latent.py:186-187) — exceeding rejects
 * the ENTIRE prompt on submit (HTTP 400). For long sources, audio steps
 * (5/3 per frame) hit the limit at ~6.8 min, video tokens — at ~39 min.
 *
 * chainLatentCut returns a reference [nodeId, 0] to the node equivalent
 * to LatentCut(samples, dim, index, amount): when exceeding the limit,
 * the range [index, index+amount) is split into windows along boundaries
 * that are multiples of MAX (each window is a LatentCut from the SOURCE +
 * head/tail cropping), and pieces are joined by LatentConcat along the same dim.
 * Clamping to the actual source length is preserved (LatentCut clamps, short
 * chunks are simply concatenated).
 *
 * base — base node id; during chunking, suffixes _w/_h/_t/_cat make
 * the id unique within the prompt (base must be unique to the caller).
 */

export const LATENT_CUT_MAX = 16_384

export type LatentRef = [string, number]

export function chainLatentCut(
  nodes: Record<string, unknown>,
  base: string,
  samples: LatentRef,
  dim: 'x' | 'y' | 't',
  index: number,
  amount: number,
  title: string,
): LatentRef {
  const idx = Math.max(0, Math.round(index))
  const amt = Math.max(1, Math.round(amount))
  if (idx <= LATENT_CUT_MAX && amt <= LATENT_CUT_MAX) {
    nodes[base] = {
      inputs: { samples, dim, index: idx, amount: amt },
      class_type: 'LatentCut',
      _meta: { title },
    }
    return [base, 0]
  }
  const end = idx + amt
  const pieces: LatentRef[] = []
  let part = 0
  for (let c0 = Math.floor(idx / LATENT_CUT_MAX) * LATENT_CUT_MAX; c0 < end; c0 += LATENT_CUT_MAX) {
    const h = Math.max(idx, c0)
    const e = Math.min(end, c0 + LATENT_CUT_MAX)
    const wid = `${base}_w${part}`
    nodes[wid] = {
      inputs: { samples, dim, index: c0, amount: LATENT_CUT_MAX },
      class_type: 'LatentCut',
      _meta: { title: `${title} — window ${part + 1}` },
    }
    let cur: LatentRef = [wid, 0]
    if (h > c0) {
      const hid = `${base}_h${part}`
      nodes[hid] = {
        inputs: { samples: cur, dim, index: h - c0, amount: LATENT_CUT_MAX },
        class_type: 'LatentCut',
        _meta: { title: `${title} — window head crop ${part + 1}` },
      }
      cur = [hid, 0]
    }
    const tid = `${base}_t${part}`
    nodes[tid] = {
      inputs: { samples: cur, dim, index: 0, amount: e - h },
      class_type: 'LatentCut',
      _meta: { title: `${title} — chunk ${part + 1} (${e - h})` },
    }
    pieces.push([tid, 0])
    part++
  }
  let acc = pieces[0]
  for (let i = 1; i < pieces.length; i++) {
    const cid = `${base}_cat${i}`
    nodes[cid] = {
      inputs: { samples1: acc, samples2: pieces[i], dim },
      class_type: 'LatentConcat',
      _meta: { title: `${title} — pieces concat` },
    }
    acc = [cid, 0]
  }
  return acc
}
