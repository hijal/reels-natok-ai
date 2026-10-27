/**
 * Application icon generation from public/logo.svg (fix 561).
 *
 *   node scripts/make-icons.mjs
 *
 * Creates:
 *   electron/icons/icon-16/24/32/48/64/128/256/512.png  — PNG set
 *   electron/icons/icon.ico                              — Windows ICO
 *     (container with PNG entries: 16–256 px, valid since Vista)
 *   public/icon-192.png / icon-512.png                   — for PWA manifest
 *
 * Run manually/one-off; artifacts are committed. sharp is already in
 * project dependencies (Next.js image).
 */
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'public', 'logo.svg')
const OUT = join(ROOT, 'electron', 'icons')
mkdirSync(OUT, { recursive: true })

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]

/**
 * SVG → PNG of a given size.
 *
 * (fix 716) Result size is VALIDATED. The density formula is based on
 * viewBox 64px and works ONLY if the SVG does not have explicit width/height:
 * sharp for SVG with specified width/height ignores density, and resize() still
 * "successfully" outputs an image of a different size — without a single error.
 */
async function renderPng(size) {
  const density = Math.round((72 * size) / 64) // viewBox 64px at 72dpi
  const buf = await sharp(SRC, { density }).resize(size, size).png().toBuffer()
  const meta = await sharp(buf).metadata()
  if (meta.width !== size || meta.height !== size) {
    throw new Error(
      `icon-${size}: received size ${meta.width}x${meta.height}, expected ${size}x${size}. ` +
      'Check that public/logo.svg has no explicit width/height (only viewBox needed).',
    )
  }
  return buf
}

const pngs = new Map()
for (const s of SIZES) {
  const buf = await renderPng(s)
  pngs.set(s, buf)
  writeFileSync(join(OUT, `icon-${s}.png`), buf)
  console.log(`[icons] icon-${s}.png (${buf.length} B)`)
}

// PWA icons in public/ (192/512 — manifest standard)
// (fix 587) 192 is RENDERED first, then written: previously a 128-pixel
// buffer was written first (pngs.get(128)), and if renderPng(192) failed,
// public/icon-192.png silently remained with incorrect dimensions.
{
  const buf192 = await renderPng(192)
  pngs.set(192, buf192)
  writeFileSync(join(ROOT, 'public', 'icon-192.png'), buf192)
  writeFileSync(join(OUT, 'icon-192.png'), buf192)
  console.log('[icons] public/icon-192.png')
  writeFileSync(join(ROOT, 'public', 'icon-512.png'), pngs.get(512))
  console.log('[icons] public/icon-512.png')
}

/* ── ICO container with PNG entries ──
 * ICONDIR:  reserved(2)=0, type(2)=1 (icon), count(2)=N
 * ICONDIRENTRY (16 B): width(1), height(1)  (0 = 256), colors(1)=0,
 *  reserved(1)=0, planes(2)=1, bpp(2)=32, size(4), offset(4)
 * Followed sequentially by PNG blobs. Windows reads PNG in ICO since Vista. */
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)

let offset = 6 + icoSizes.length * 16
const entries = []
const blobs = []
for (const s of icoSizes) {
  const png = pngs.get(s)
  const e = Buffer.alloc(16)
  e.writeUInt8(s === 256 ? 0 : s, 0)
  e.writeUInt8(s === 256 ? 0 : s, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png.length
  entries.push(e)
  blobs.push(png)
}
writeFileSync(join(OUT, 'icon.ico'), Buffer.concat([header, ...entries, ...blobs]))
console.log(`[icons] icon.ico (${icoSizes.join('/')} px, PNG-in-ICO)`)
