/**
 * (fix 103) Streaming multipart/form-data parser for Next.js API routes.
 *
 * WHY: `req.formData()` (undici) collects the ENTIRE request body into a Blob in RAM
 * (Blob → arrayBuffer() → Buffer — yet another full copy). On multi-gigabyte
 * files this guarantees a Node process OOM: client "loads
 * up to 100%", while the server is already dead — file not written, "model missing".
 *
 * Solution: stream-parse the request body. Headers of the first part are read
 * before transmitting body bytes (filename is known upfront — can reject
 * 400/409 BEFORE writing), then the part body is yielded as a Readable stream, which
 * caller pipes directly to file. Memory is O(chunk), not O(file).
 *
 * Used in: /api/comfy/diffusion-models (models), /api/loras (LoRAs).
 * Similar "manual" logic exists in /api/upscale/upload — if modifying
 * this lib, cross-check both approaches.
 *
 * (fix 105) Fix boundary "leak" into part body:
 * before this fix, bytes already in carry accumulator (e.g. entire tail
 * of file + "\r\n--boundary--\r\n") were drained as is, without searching for
 * delimiter — part body ended up longer than the file, causing corruption.
 * Now both carry draining and new chunk processing go
 * through ONE helper drainCarry(), which always checks for closing
 * delimiter first.
 *
 * (fix 106) Read source — OWN reader of Web stream
 * (req.body.getReader()), NOT Readable.fromWeb(req.body).
 * Reason: `Readable.fromWeb` wraps request body in a Node↔Web adapter
 * on top of Web stream, which Next itself built from IncomingMessage
 * (Readable.toWeb) — double conversion. Under heavy uploads this
 * bridge stumbled under backpressure: server reset socket (ECONNRESET),
 * whereas the same parsing via req.body.getReader() (as in
 * /api/upscale/upload — working 32 GB route) finished successfully. Now
 * source is read using the same method as the working route:
 * reader.read() one chunk at a time, without intermediate Node adapter.
 * Node Readable is still accepted (for tests outside Next) —
 * normalized via Readable.toWeb.
 */
import { Readable, type Readable as NodeReadable } from 'stream'

/** Multipart body validation error — routes return it as 400, not 500. */
export class MultipartParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MultipartParseError'
  }
}

/**
 * (fix 106) Structural type for Web stream: we have req.body (DOM
 * ReadableStream) and Readable.toWeb (stream/web) — formally different types,
 * while all we need is getReader().read().
 */
type WebBody = {
  getReader(): {
    read(): Promise<{ done: boolean; value: unknown }>
    cancel(reason?: unknown): Promise<unknown>
  }
}

/** (fix 106) Accepts both Web stream (Next) and Node Readable (tests). */
export type MultipartSource = WebBody | NodeReadable

function isWebStream(x: unknown): x is WebBody {
  return !!x && typeof (x as WebBody).getReader === 'function'
}

/**
 * First part of multipart/form-data.
 * `stream` — body of the part (without headers and without closing boundary);
 * `cancel()` — abort reading request body (reader.cancel): socket
 * will close, browser will stop sending bytes.
 */
export interface MultipartFilePart {
  /** filename from Content-Disposition (null if part has no filename). */
  filename: string | null
  /** Raw part headers (up to empty line). */
  headers: string
  /** Streaming body of the part. */
  stream: Readable
  /** (fix 106) Cancel reading request body (safe to call twice). */
  cancel: () => void
}

const EMPTY = Buffer.alloc(0)

/** boundary from Content-Type: multipart/form-data; boundary=... */
function getBoundary(contentType: string | null): string | null {
  if (!contentType) return null
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const b = (m?.[1] ?? m?.[2] ?? '').trim()
  return b || null
}

/** filename from part headers (Content-Disposition), unescapes \\X. */
function parseFileName(headers: string): string | null {
  const cd = headers
    .split(/\r?\n/)
    .find((l) => /^content-disposition\s*:/i.test(l))
  if (!cd) return null
  const m = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(cd)
  if (!m) return null
  const name = m[1].replace(/\\(.)/g, '$1').trim()
  return name || null
}

/**
 * Reads the first part of multipart/form-data: headers + (possibly) start
 * of body — and returns part with body stream. Body is NOT loaded into memory
 * as a whole: after return, further reading happens only when someone pipes
 * `part.stream`.
 *
 * @param body — request body: Web ReadableStream (req.body from Next) or
 *              Node Readable (tests; normalized via Readable.toWeb)
 * @param contentType — request Content-Type header
 * @throws MultipartParseError — not multipart / no parts / no filename
 */
export async function readFirstMultipartPart(
  body: MultipartSource,
  contentType: string | null,
): Promise<MultipartFilePart> {
  const boundary = getBoundary(contentType)
  if (!boundary) {
    throw new MultipartParseError('Expected multipart/form-data with boundary')
  }

  const delim = Buffer.from(`\r\n--${boundary}`)

  // (fix 106) Read using OWN Web stream reader — same as
  // /api/upscale/upload (working route). Convert Node Readable to Web
  // (Readable.toWeb — standard direction, rather than inverse fromWeb).
  const webBody: WebBody = isWebStream(body)
    ? body
    : Readable.toWeb(body as NodeReadable)
  const reader = webBody.getReader()
  const readChunk = async (): Promise<Buffer | null> => {
    const { done, value } = await reader.read()
    if (done || value == null) return null
    return Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as Uint8Array)
  }
  let cancelled = false
  const cancel = () => {
    if (cancelled) return
    cancelled = true
    try {
      const p = reader.cancel()
      if (p && typeof p.catch === 'function') void p.catch(() => { /* already closed */ })
    } catch { /* already closed */ }
  }

  // ── 1) first boundary ──
  // Virtual leading CRLF: the first "--boundary" at the very start of the body
  // matches the same delimiter as all subsequent ones.
  let carry = Buffer.from('\r\n')
  for (;;) {
    const i = carry.indexOf(delim)
    if (i >= 0) {
      carry = carry.subarray(i + delim.length)
      break
    }
    const value = await readChunk()
    if (!value) throw new MultipartParseError('Empty request body (no parts)')
    carry = Buffer.concat([carry, Buffer.from(value)])
  }

  // After delimiter: "--" = end of multipart body (no parts were found).
  if (carry.length >= 2 && carry.subarray(0, 2).toString() === '--') {
    throw new MultipartParseError('File part not found')
  }
  if (carry.length >= 2 && carry.subarray(0, 2).toString() === '\r\n') {
    carry = carry.subarray(2)
  }

  // ── 2) part headers (up to empty line) ──
  let headerEnd = -1
  for (;;) {
    headerEnd = carry.indexOf('\r\n\r\n')
    if (headerEnd >= 0) break
    const value = await readChunk()
    if (!value) throw new MultipartParseError('Incomplete multipart part headers')
    carry = Buffer.concat([carry, Buffer.from(value)])
  }
  const headers = carry.subarray(0, headerEnd).toString('utf8')
  carry = carry.subarray(headerEnd + 4)

  const filename = parseFileName(headers)

  // State machine (carry is the same accumulator: after headers it
  // already contains possible beginning of part body).
  let pendingEnd = false // delimiter found, remainder drained — waiting for push(null)
  let finished = false   // stream finished (null pushed)
  let reading = false     // async read from source is in flight
  let destroyed = false   // error — read no more

  // ── 3) part body stream ──
  // (fix 105) Unified helper for BOTH drain paths (carry and new
  // chunk): first look for closing delimiter in accumulated buffer.
  //   - delimiter at index i → push carry[0..i), pendingEnd = true;
  //   - no delimiter → push everything except last (delim-1) bytes
  //     (they may be the beginning of a delimiter split across chunks),
  //     keep tail in carry.
  //     chunks), keep tail in carry.
  // Before fix, path "carry is not empty" pushed entire buffer WITHOUT checking
  // for delimiter — closing "\r\n--boundary--\r\n" leaked into body.
  //
  // drainCarry() return:
  //   - false → backpressure (data in stream internal buffer — consumer
  //     will drain it; do NOT read source anymore);
  //   - true  → either stream finished (push null), or nothing was pushed
  //     (entire buffer is potential delimiter tail); in this case
  //     reading loop must fetch next chunk from source, otherwise
  //     consumer will wait for "readable" forever (event loop empties —
  //     Node process silently exits, upload quietly hangs).
  const drainCarry = (): boolean => {
    if (carry.length === 0) return true
    const i = carry.indexOf(delim)
    if (i >= 0) {
      const chunk = carry.subarray(0, i)
      carry = EMPTY
      pendingEnd = true
      if (chunk.length > 0 && !stream.push(chunk)) return false // backpressure
      stream.push(null)
      finished = true
      return true
    }
    const keep = Math.min(delim.length - 1, carry.length)
    const chunk = carry.subarray(0, carry.length - keep)
    carry = carry.subarray(carry.length - keep)
    if (chunk.length === 0) return true
    return stream.push(chunk) // false → backpressure, carry will wait for read()
  }

  // Read from source until data is pushed, backpressure occurs,
  // or stream is finished. Called from read() and loop continuation.
  const startReading = () => {
    if (reading || finished || destroyed) return
    reading = true
    void (async () => {
      try {
        for (;;) {
          const value = await readChunk()
          if (value == null) {
            // Source exhausted without closing boundary (e.g., client
            // aborted upload) — push whatever was accumulated and finish;
            // already drained data remains valid.
            if (carry.length > 0) {
              const chunk = carry
              carry = EMPTY
              stream.push(chunk)
            }
            finished = true
            stream.push(null)
            return
          }
          // Append chunk to accumulator and drain up to delimiter
          // (or safe prefix) — same logic as in read().
          carry = Buffer.concat([carry, Buffer.from(value)])
          const cont = drainCarry()
          if (finished || destroyed) return
          if (!cont) return // backpressure — read() will continue later
          // true, but not finished: chunk fully went into "tail" — fetch
          // next one (otherwise consumer waits for data forever).
        }
      } catch (err) {
        destroyed = true
        cancel()
        stream.destroy(err instanceof Error ? err : new Error(String(err)))
      } finally {
        reading = false
      }
    })()
  }

  const stream = new Readable({
    read() {
      if (finished || destroyed) return
      if (pendingEnd) {
        // Delimiter found, remainder already pushed — finish stream.
        finished = true
        stream.push(null)
        return
      }
      if (carry.length > 0) {
        // Drain accumulated buffer (WITH delimiter search — fix 105).
        if (!drainCarry()) return // backpressure — continue in read()
        if (finished) return
      }
      // No data to push (carry is empty or only delimiter tail),
      // and stream is not finished — must fetch next chunk from
      // source (fix 105), otherwise "waiting" loop never ends.
      startReading()
    },
  })

  // (fix 106) When part.stream is destroyed (upload cancelled), immediately
  // cancel source as well — otherwise browser would continue sending gigabytes into
  // nowhere.
  stream.on('close', () => {
    destroyed = true
    cancel()
  })

  return { filename, headers, stream, cancel }
}
