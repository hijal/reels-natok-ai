'use client'

/**
 * (fix 65) useVoiceDictation — microphone recording and transcription via
 * STT service (transcribe.cpp) on CPU (tools/stt_server.py).
 *
 * Pipeline: getUserMedia → AudioContext (16 kHz, if supported by browser)
 * → ScriptProcessorNode (capture) → 16-bit PCM WAV (assembled in JS,
 * without external dependencies) → POST /api/stt/transcribe → text.
 *
 * (fix 85) Microphone selection: selectedMicId is stored at module level
 * (shared variable for all hook instances on the page). Set
 * via setSttMicDevice() from settings panel, saved in localStorage.
 */
import { useCallback, useRef, useState } from 'react'

export type VoiceDictationState = 'idle' | 'recording' | 'processing'

export interface VoiceDictationResult {
  /** Recognized text (null on error or empty result). */
  text: string | null
  /** Error text (null on success). */
  error: string | null
}

export interface VoiceDictationApi {
  state: VoiceDictationState
  /** Start recording. Throws Error on failure. */
  start: () => Promise<void>
  /** Stop recording and return result: text and/or error.
   *  We return error by value, not only via state `error` —
   *  closure in click handler doesn't see state set
   *  inside this call (stale closure). */
  stop: () => Promise<VoiceDictationResult>
  /** Cancel recording without transcribing. */
  cancel: () => void
  error: string | null
  clearError: () => void
}

const TARGET_RATE = 16000

/* ── (fix 85) Selected microphone (shared across all hook instances) ──
   undefined = not yet read from localStorage
   null      = system default microphone
   string    = specific deviceId                               */
let _selectedMicId: string | null | undefined = undefined
const LS_KEY = 'stt.micDeviceId'

function _readStoredMic(): string | null {
  if (typeof window === 'undefined') return null
  try { return localStorage.getItem(LS_KEY) } catch { return null }
}

/** Set microphone deviceId (null = system default). */
export function setSttMicDevice(id: string | null): void {
  _selectedMicId = id
  try {
    if (id) localStorage.setItem(LS_KEY, id)
    else localStorage.removeItem(LS_KEY)
  } catch { /* private mode / SSR */ }
}

/** Get selected microphone deviceId (null = default). */
export function getSttMicDevice(): string | null {
  if (_selectedMicId === undefined) {
    _selectedMicId = _readStoredMic()
  }
  return _selectedMicId
}

/** Linear resampling to 16 kHz (input — any sampleRate). */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.max(0, Math.floor(input.length / ratio))
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

/** 44-byte WAV header + 16-bit PCM mono @16 kHz. */
function buildWav16(samples: Float32Array): ArrayBuffer {
  const n = samples.length
  const buf = new ArrayBuffer(44 + n * 2)
  const v = new DataView(buf)
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  v.setUint32(4, 36 + n * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  v.setUint32(16, 16, true)          // fmt chunk size
  v.setUint16(20, 1, true)           // PCM
  v.setUint16(22, 1, true)           // mono
  v.setUint32(24, TARGET_RATE, true) // sample rate
  v.setUint32(28, TARGET_RATE * 2, true) // byte rate
  v.setUint16(32, 2, true)           // block align
  v.setUint16(34, 16, true)          // bits per sample
  writeStr(36, 'data')
  v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) {
    let s = samples[i]
    if (s > 1) s = 1
    else if (s < -1) s = -1
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buf
}

export function useVoiceDictation(): VoiceDictationApi {
  const [state, setState] = useState<VoiceDictationState>('idle')
  const [error, setError] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const procRef = useRef<ScriptProcessorNode | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const rateRef = useRef(TARGET_RATE)
  const startingRef = useRef(false)

  const teardown = useCallback(() => {
    try { procRef.current?.disconnect() } catch { /* already disconnected */ }
    procRef.current = null
    try { void ctxRef.current?.close() } catch { /* already closed */ }
    ctxRef.current = null
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }, [])

  const start = useCallback(async () => {
    if (startingRef.current) return
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error('Voice input unavailable: browser does not grant access to microphone')
    }
    startingRef.current = true
    setError(null)
    try {
      // (fix 85) If specific microphone is selected — specify deviceId.
      // Use `ideal`, not `exact`: if device is disconnected,
      // browser gracefully falls back to another instead of failing with an error.
      const micId = getSttMicDevice()
      const audioConstraints: MediaTrackConstraints = {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      if (micId) {
        audioConstraints.deviceId = { ideal: micId }
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
      streamRef.current = stream
      let ctx: AudioContext
      try {
        ctx = new AudioContext({ sampleRate: TARGET_RATE })
      } catch {
        ctx = new AudioContext() // fallback: we will resample ourselves
      }
      ctxRef.current = ctx
      rateRef.current = ctx.sampleRate
      const source = ctx.createMediaStreamSource(stream)
      const proc = ctx.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      proc.onaudioprocess = (e) => {
        const ch = e.inputBuffer.getChannelData(0)
        chunksRef.current.push(new Float32Array(ch))
      }
      // Closed muted loop: onaudioprocess is required to produce sound,
      // so we route it to muted gain (nothing is audible in speakers).
      const mute = ctx.createGain()
      mute.gain.value = 0
      source.connect(proc)
      proc.connect(mute)
      mute.connect(ctx.destination)
      procRef.current = proc
      setState('recording')
    } catch (err) {
      teardown()
      const name = (err as { name?: string } | null)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new Error('Microphone access denied — please allow microphone in browser settings for this site')
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new Error('Microphone not found — connect an input device')
      }
      throw err instanceof Error ? err : new Error(String(err))
    } finally {
      startingRef.current = false
    }
  }, [teardown])

  const stop = useCallback(async (): Promise<VoiceDictationResult> => {
    const chunks = chunksRef.current
    const rate = rateRef.current
    chunksRef.current = []
    teardown()

    if (chunks.length === 0) {
      setState('idle')
      return { text: null, error: null }
    }
    let total = 0
    for (const c of chunks) total += c.length
    let samples: Float32Array = new Float32Array(total)
    let off = 0
    for (const c of chunks) {
      samples.set(c, off)
      off += c.length
    }
    samples = resampleLinear(samples, rate, TARGET_RATE)

    setState('processing')
    try {
      const r = await fetch('/api/stt/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buildWav16(samples),
      })
      const data: { ok?: boolean; text?: string; error?: string } = await r.json().catch(() => ({}))
      if (!r.ok || !data.ok) {
        const err = data.error || 'Failed to recognize speech (STT service is unavailable)'
        setError(err)
        setState('idle')
        return { text: null, error: err }
      }
      const text = String(data.text ?? '').trim()
      setState('idle')
      if (!text) {
        const err = 'Nothing recognized — try speaking more clearly or closer to the microphone'
        setError(err)
        return { text: null, error: err }
      }
      return { text, error: null }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const e = msg || 'Failed to recognize speech'
      setError(e)
      setState('idle')
      return { text: null, error: e }
    }
  }, [teardown])

  const cancel = useCallback(() => {
    chunksRef.current = []
    teardown()
    setState('idle')
    setError(null)
  }, [teardown])

  const clearError = useCallback(() => setError(null), [])

  return { state, start, stop, cancel, error, clearError }
}