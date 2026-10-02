import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CadRequest, CadResponse, CadTransport } from '../protocol.ts'

export interface ComTransportOptions {
  /** Primary COM ProgID. */
  progId: string
  /** Probed in order when the primary is not registered. */
  progIdFallbacks: readonly string[]
  requestTimeoutMs: number
  /** PowerShell executable. Windows PowerShell 5.1 ships with the OS. */
  powershell?: string
  /** Override for the bridge script; defaults to the bundled asset. */
  scriptPath?: string
}

interface Pending {
  resolve: (r: CadResponse) => void
  timer: NodeJS.Timeout
}

/** Identity of the bridge script on disk, used to detect a plugin upgrade. */
interface ScriptStamp {
  path: string
  mtimeMs: number
  size: number
}

const BRIDGE_RELATIVE = join('assets', 'cad-bridge.ps1')

/**
 * Drives a running AutoCAD through its COM API.
 *
 * AutoCAD registers itself as an automation server, so the plugin can attach to
 * the engineer's open session with nothing installed inside AutoCAD and no
 * compiled DLL. A long-lived PowerShell child process holds the COM reference
 * and answers newline-delimited JSON on stdio; keeping one process alive
 * matters because attaching and detaching per call would be slow and would
 * churn the document's modified flag.
 */
export class ComTransport implements CadTransport {
  readonly kind = 'com'
  private child: ReturnType<typeof spawn> | null = null
  private ready: Promise<void> | null = null
  private readonly pending = new Map<string, Pending>()
  private seq = 0
  private stopped = false
  private readonly options: ComTransportOptions
  /** Stamp of the bridge script the live child loaded; null while none runs. */
  private loadedStamp: ScriptStamp | null = null

  constructor(options: ComTransportOptions) {
    this.options = options
  }

  private resolveScript(): string {
    if (this.options.scriptPath) return this.options.scriptPath
    // The bridge sits in `assets/` at the package root, but this module lives in
    // `src/transport/` during development and in `lib/` once built, so probe
    // both roots rather than assuming one layout.
    const here = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      join(here, '..', '..', BRIDGE_RELATIVE), // src/transport -> <root>/assets
      join(here, '..', BRIDGE_RELATIVE), // lib -> <root>/assets
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
    // Fall back to the built layout so the error names the expected path.
    return candidates[1]!
  }

  private stampOf(script: string): ScriptStamp | null {
    try {
      const s = statSync(script)
      return { path: script, mtimeMs: s.mtimeMs, size: s.size }
    } catch {
      return null
    }
  }

  /**
   * Restart the child when the bridge script on disk has changed.
   *
   * Windows PowerShell reads the whole script into memory at startup and never
   * re-reads it, so a plugin upgrade would otherwise keep executing the old
   * bridge for as long as the process lives. That failure is silent and is
   * indistinguishable from the new code being broken. One `statSync` per
   * request is cheap, and restarting here makes an upgrade take effect without
   * restarting the host.
   */
  private restartIfScriptChanged(): void {
    const child = this.child
    const loaded = this.loadedStamp
    if (!child || !loaded) return
    // Never tear down a process with work in flight; the next call re-checks.
    if (this.pending.size > 0) return
    const current = this.stampOf(this.resolveScript())
    if (!current) return
    if (
      current.path === loaded.path &&
      current.mtimeMs === loaded.mtimeMs &&
      current.size === loaded.size
    ) {
      return
    }
    this.loadedStamp = null
    this.child = null
    this.ready = null
    // The exit handler clears the remaining state and fails nothing, because
    // `pending` is empty by the guard above.
    if (child.exitCode === null) child.kill()
  }

  /** Diagnostics surfaced by `cad_status`. */
  describeBackend(): Record<string, unknown> {
    return {
      bridgeScript: this.resolveScript(),
      // The script's mtime is the version the live child is running, which is
      // what a stale-process diagnosis needs to compare against the package.
      bridgeLoadedAt: this.loadedStamp ? new Date(this.loadedStamp.mtimeMs).toISOString() : null,
      bridgeRunning: this.child !== null && this.child.exitCode === null,
    }
  }

  async start(): Promise<void> {
    if (this.ready) return this.ready
    this.stopped = false
    this.ready = this.spawnBridge()
    return this.ready
  }

  private spawnBridge(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ps = this.options.powershell ?? 'powershell.exe'
      const script = this.resolveScript()
      this.loadedStamp = this.stampOf(script)
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        '-ProgId', this.options.progId,
        '-ProgIdFallbacks', this.options.progIdFallbacks.join(','),
      ]
      const child = spawn(ps, args, { stdio: ['pipe', 'pipe', 'pipe'] })
      this.child = child

      let settled = false
      let stderr = ''

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        // Keep the tail: PowerShell writes COM diagnostics here.
        stderr = (stderr + chunk).slice(-4000)
      })

      const rl = createInterface({ input: child.stdout! })
      rl.on('line', (line: string) => {
        const text = line.trim()
        if (!text) return
        let parsed: { id?: string; ready?: boolean; error?: string; response?: CadResponse }
        try {
          parsed = JSON.parse(text)
        } catch {
          return
        }
        if (parsed.ready) {
          if (!settled) {
            settled = true
            resolve()
          }
          return
        }
        if (parsed.error && !parsed.id) {
          if (!settled) {
            settled = true
            reject(new Error(parsed.error))
          }
          return
        }
        if (parsed.id && parsed.response) {
          const p = this.pending.get(parsed.id)
          if (p) {
            clearTimeout(p.timer)
            this.pending.delete(parsed.id)
            p.resolve(parsed.response)
          }
        }
      })

      child.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          reject(new Error(`无法启动 PowerShell 桥接进程: ${err.message}`))
        }
      })

      child.on('exit', (code: number | null) => {
        const err = new Error(
          `CAD 桥接进程已退出 (code=${code ?? 'null'})。${stderr ? `\n${stderr}` : ''}`,
        )
        // A restart can replace this child before its exit is delivered, and the
        // old process must not then clear the new one's state or fail its
        // in-flight requests.
        if (this.child === child) {
          this.child = null
          this.ready = null
          this.loadedStamp = null
          // Fail every in-flight request instead of leaving callers hanging.
          for (const [id, p] of this.pending) {
            clearTimeout(p.timer)
            this.pending.delete(id)
            p.resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: err.message } })
          }
        }
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
  }

  async send(request: CadRequest): Promise<CadResponse> {
    if (this.stopped) {
      return { ok: false, error: { code: 'NOT_CONNECTED', message: '桥接已停止' } }
    }
    try {
      this.restartIfScriptChanged()
      await this.start()
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
    const child = this.child
    if (!child?.stdin || child.stdin.destroyed) {
      return { ok: false, error: { code: 'NOT_CONNECTED', message: '桥接进程不可用' } }
    }

    this.seq += 1
    const id = `r${this.seq}`
    return new Promise<CadResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          error: {
            code: 'TIMEOUT',
            message: `CAD 操作超过 ${this.options.requestTimeoutMs}ms 未返回`,
          },
        })
      }, this.options.requestTimeoutMs)
      this.pending.set(id, { resolve, timer })
      child.stdin!.write(`${JSON.stringify({ id, request })}\n`)
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    const child = this.child
    this.child = null
    this.ready = null
    this.loadedStamp = null
    // Detaching the child here means its exit handler no longer owns `pending`,
    // so fail the in-flight requests explicitly rather than leaving them to time
    // out.
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      this.pending.delete(id)
      p.resolve({ ok: false, error: { code: 'NOT_CONNECTED', message: '桥接已停止' } })
    }
    if (!child || child.exitCode !== null) return
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.stdin?.end()
      // Do not hang disposal on an unresponsive bridge.
      const t = setTimeout(() => {
        child.kill()
        resolve()
      }, 2000)
      t.unref?.()
    })
  }
}
