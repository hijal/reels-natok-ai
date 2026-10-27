/**
 * (fix 567) Electron preload bridge types (window.h3desktop from
 * electron/preload.js). In browser fallback the bridge is absent — all fields are optional.
 */
/** (fix 588) Console operation: 'a' — append text, 'r' — write text
 *  from the start of the last line (emulation of \r: ComfyUI/tqdm progress bars). */
export type ConsoleOp = ['a' | 'r', string]

export interface H3DesktopBridge {
  minimize: () => void
  maximizeToggle: () => void
  close: () => void
  console: {
    /** Full accumulated log (ring buffer ~2 MB). */
    get: () => Promise<string>
    /** Subscription to an operations batch; returns unsubscribe function. */
    onAppend: (cb: (ops: ConsoleOp[]) => void) => () => void
    /** Native "Save As" dialog → .txt. */
    save: (text: string) => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
  }
}

declare global {
  interface Window {
    h3desktop?: H3DesktopBridge
  }
}
