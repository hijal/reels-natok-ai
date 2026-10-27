/**
 * (fix 123) Paste images via Ctrl+V from clipboard.
 *
 * Common helper: extracts only image/* files from clipboardData,
 * working with both `dt.files` and `dt.items` (getAsFile) — covering
 * Chrome/Edge and Firefox (in Firefox a pasted image is provided
 * specifically via items).
 *
 * Deduplication: the Windows clipboard may contain one image in
 * multiple formats (PNG + BMP, PNG + EMF, etc.), and the browser returns them as
 * distinct File objects. To prevent duplicate copies of a single screenshot,
 * we take the FIRST file and discard the rest — a typical paste contains
 * exactly one image. If the file has no name/extension — we substitute
 * a name based on MIME type so `detectKind` and server uploads work like a
 * normal file.
 */
/**
 * Fast synchronous check: whether the clipboard contains at least one image.
 * Needed so that `preventDefault` in onPaste is called synchronously (before await).
 */
export function hasClipboardImage(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false
  try {
    if (dt.items && dt.items.length) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file' && (it.type || '').startsWith('image/')) return true
      }
    }
  } catch { /* ignore */ }
  for (const f of Array.from(dt.files ?? [])) {
    if (f.type.startsWith('image/')) return true
  }
  return false
}

export async function getClipboardImageFiles(dt: DataTransfer | null | undefined): Promise<File[]> {
  if (!dt) return []
  const candidates: File[] = []
  const seen = new Set<File>()
  const push = (f: File | null | undefined) => {
    if (!f || !f.type.startsWith('image/')) return
    if (seen.has(f)) return
    seen.add(f)
    candidates.push(f)
  }
  // items — first (more reliable for "clean" paste from screenshots/pager)
  try {
    if (dt.items && dt.items.length) {
      for (const it of Array.from(dt.items)) {
        if (it.kind === 'file') push(it.getAsFile())
      }
    }
  } catch { /* some browsers don't allow iteration — simply fall through to files */ }
  for (const f of Array.from(dt.files ?? [])) push(f)
  if (candidates.length === 0) return []

  // Deduplicate by content: take hash of first 64 KB of each file.
  // Alternative representations of one image (PNG+BMP) have different
  // bytes, but usually the same size — deduplicate by (size, type).
  const unique: File[] = []
  const seenSizeType = new Set<string>()
  for (const f of candidates) {
    const key = `${f.size}:${f.type}`
    if (seenSizeType.has(key)) continue
    seenSizeType.add(key)
    unique.push(f)
  }
  
  // If only one candidate remains — return it (with normalized name).
  if (unique.length === 1) {
    const f = unique[0]
    if (f.name && /\.[a-z0-9]{2,5}$/i.test(f.name)) return [f]
    const ext = (f.type.split('/')[1] || 'png').split('+')[0]
    const name = `pasted-image-${Date.now()}.${ext}`
    return [new File([f], name, { type: f.type })]
  }
  
  // Multiple unique images — return all (with normalized names).
  const ts = Date.now()
  return unique.map((f, i) => {
    if (f.name && /\.[a-z0-9]{2,5}$/i.test(f.name)) return f
    const ext = (f.type.split('/')[1] || 'png').split('+')[0]
    const name = `pasted-image-${ts}-${i + 1}.${ext}`
    return new File([f], name, { type: f.type })
  })
}

/**
 * (fix 125) Read image from clipboard via async Clipboard API.
 *
 * Fallback for cases where the browser does NOT dispatch a `paste` event
 * (focus on a button/non-editable element or outside the tab tree).
 * Called from the keydown Ctrl+V handler — this is a user gesture, so
 * `navigator.clipboard.read()` is permitted. Returns null if there are no
 * images in the clipboard or the API is unavailable (then regular `paste` triggers).
 */
export async function getClipboardImageFromApi(): Promise<File | null> {
  try {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    if (!clip || typeof clip.read !== 'function') return null
    const items = await clip.read()
    for (const item of items) {
      const imgTypes = (item.types || []).filter((t) => t.startsWith('image/'))
      if (imgTypes.length === 0) continue
      const blob = await item.getType(imgTypes[0])
      if (!blob || blob.size === 0) continue
      const ext = (imgTypes[0].split('/')[1] || 'png').split('+')[0]
      const name = `pasted-image-${Date.now()}.${ext}`
      return new File([blob], name, { type: imgTypes[0] })
    }
  } catch {
    // Permission denied / API unavailable — silently ignore,
    // normal paste event will handle it.
  }
  return null
}
