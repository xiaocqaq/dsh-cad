import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CadRequest, CadResponse, CadErr } from '../protocol.ts'
import type { CadTransport } from '../protocol.ts'
import { decodeSexpr, encodeSexpr, fromSexpr, toSexpr } from './sexpr.ts'

export const LISP_PROTOCOL_VERSION = '1'
export const HEARTBEAT_FRESH_MS = 3000

const ASSET_NAME = 'cad-ipc.lsp'
const ERROR_CODES = new Set<CadErr['error']['code']>([
  'BACKEND_UNAVAILABLE',
  'NOT_CONNECTED',
  'TIMEOUT',
  'NO_DOCUMENT',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'UNSUPPORTED',
  'BACKEND_ERROR',
])

export interface LispIpcOptions {
  /** Directory both sides exchange files in. Defaults to %LOCALAPPDATA%\\dsh-cad\\ipc. */
  ipcDir?: string
  requestTimeoutMs: number
  /** Override for the resident dispatcher; defaults to the bundled asset. */
  scriptPath?: string
  heartbeatFreshMs?: number
}

export interface HeartbeatInfo {
  fresh: boolean
  ageMs: number
  version: string
  activeX: boolean
  document: string
}

/**
 * File IPC transport.
 *
 * AutoCAD writes `res-<id>.lsp` after something calls `dsh:tick`. This
 * process never calls SetForegroundWindow. This AutoCAD build has no
 * `vlr-timer-reactor`, so a fresh heartbeat is not assumed to mean a
 * poller is still running. If a nudge is set, each request is followed by
 * that nudge. Without a nudge and without a fresh heartbeat, the call
 * fails with `BACKEND_UNAVAILABLE` and the APPLOAD path.
 */
export class LispIpcTransport implements CadTransport {
  readonly kind = 'lisp-ipc'
  readonly dir: string
  readonly scriptPath: string
  private readonly timeoutMs: number
  private readonly freshMs: number
  private started = false
  private tail: Promise<unknown> = Promise.resolve()
  private nudge: (() => Promise<void>) | null = null

  constructor(options: LispIpcOptions) {
    this.dir = options.ipcDir && options.ipcDir.length > 0 ? options.ipcDir : defaultIpcDir()
    this.scriptPath = resolveAsset(ASSET_NAME, options.scriptPath)
    this.timeoutMs = options.requestTimeoutMs
    this.freshMs = options.heartbeatFreshMs ?? HEARTBEAT_FRESH_MS
  }

  async start(): Promise<void> {
    mkdirSync(this.dir, { recursive: true })
    this.started = true
  }

  async stop(): Promise<void> {
    this.started = false
  }

  async send(request: CadRequest): Promise<CadResponse> {
    if (!this.started) await this.start()
    return this.enqueue(() => this.roundTrip(request))
  }

  describeBackend(): Record<string, unknown> {
    const hb = this.readHeartbeat()
    return {
      ipcDir: this.dir,
      ipcFresh: hb.fresh,
      ipcAgeMs: hb.ageMs,
      ipcVersion: hb.version,
      dispatcherScript: this.scriptPath,
      ipcActiveX: hb.activeX,
      ipcDocument: hb.document,
    }
  }

  heartbeatFresh(): boolean {
    return this.readHeartbeat().fresh
  }

  /** Wake the resident dispatcher after the inbox has been written. */
  setNudge(fn: (() => Promise<void>) | null): void {
    this.nudge = fn
  }

  async waitForReady(timeoutMs: number): Promise<boolean> {
    const since = Date.now() - 1000
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.heartbeatFresh() || this.readySince(since)) return true
      await delay(100)
    }
    return this.heartbeatFresh() || this.readySince(since)
  }

  private readySince(since: number): boolean {
    const path = join(this.dir, 'ready.lsp')
    if (!existsSync(path)) return false
    try {
      return statSync(path).mtimeMs >= since
    } catch {
      return false
    }
  }

  async waitForHeartbeat(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (this.heartbeatFresh()) return true
      await delay(100)
    }
    return this.heartbeatFresh()
  }

  private async roundTrip(request: CadRequest): Promise<CadResponse> {
    const hb = this.readHeartbeat()
    if (hb.version && hb.version !== LISP_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message:
            `调度器协议版本是 ${hb.version}，插件需要 ${LISP_PROTOCOL_VERSION}。请重新 APPLOAD: ${this.scriptPath}`,
        },
      }
    }
    if (!hb.fresh && !this.nudge) {
      return {
        ok: false,
        error: {
          code: 'BACKEND_UNAVAILABLE',
          message:
            `AutoLISP 调度器未在运行。请在 AutoCAD 中 APPLOAD 一次: ${this.scriptPath}` +
            `（或让 transport=auto 通过 COM 加载后用 (dsh:tick) 唤醒）。心跳目录: ${this.dir}`,
        },
      }
    }

    const id = randomBytes(8).toString('hex')
    const inbox = join(this.dir, `req-${id}.lsp`)
    const responsePath = join(this.dir, `res-${id}.lsp`)
    const cancelPath = join(this.dir, `cancel-${id}.lsp`)
    const body = encodeSexpr(toSexpr({ id, ...request })) + '\n'
    try {
      await writeAtomic(inbox, body)
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'BACKEND_ERROR',
          message: `无法写入调度请求: ${err instanceof Error ? err.message : String(err)}`,
        },
      }
    }
    if (this.nudge) {
      try {
        await this.nudge()
      } catch (err) {
        await removeQuiet(inbox)
        return {
          ok: false,
          error: {
            code: 'BACKEND_UNAVAILABLE',
            message: `无法唤醒 AutoLISP 调度器: ${err instanceof Error ? err.message : String(err)}`,
          },
        }
      }
    }

    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const text = await readFile(responsePath, 'utf8')
        await rm(responsePath, { force: true })
        const parsed = parseResponse(text)
        return verifyMutation(request, parsed)
      }
      await delay(50)
    }

    await writeFile(cancelPath, encodeSexpr([['id', id]]) + '\n', 'utf8')
    await removeQuiet(inbox)
    return {
      ok: false,
      error: {
        code: 'TIMEOUT',
        message: `AutoLISP 调度器在 ${this.timeoutMs}ms 内没有响应 ${request.op}`,
      },
    }
  }

  private readHeartbeat(): HeartbeatInfo {
    const path = join(this.dir, 'heartbeat.lsp')
    try {
      const st = statSync(path)
      const ageMs = Math.max(0, Math.round(Date.now() - st.mtimeMs))
      let version = ''
      let activeX = false
      let document = ''
      try {
        const raw = fromSexpr(decodeSexpr(readFileSync(path, 'utf8')))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          const rec = raw as Record<string, unknown>
          version = rec.version == null ? '' : String(rec.version)
          activeX = rec.activeX === 1
          document = rec.document == null ? '' : String(rec.document)
        }
      } catch {
        // A half-written heartbeat still counts as alive via mtime.
      }
      return { fresh: ageMs < this.freshMs, ageMs, version, activeX, document }
    } catch {
      return { fresh: false, ageMs: -1, version: '', activeX: false, document: '' }
    }
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

export function defaultIpcDir(): string {
  const base = process.env.LOCALAPPDATA || process.env.TEMP || process.cwd()
  return join(base, 'dsh-cad', 'ipc')
}

function resolveAsset(name: string, override?: string): string {
  if (override) return override
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(here, '..', '..', 'assets', name),
    join(here, '..', 'assets', name),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return candidates[1]!
}

async function removeQuiet(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // AutoLISP may still have the file open. The dispatcher deletes it later.
  }
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rm(path, { force: true })
  try {
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

function parseResponse(text: string): CadResponse {
  let value: unknown
  try {
    value = fromSexpr(decodeSexpr(text))
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'BACKEND_ERROR',
        message: `调度器响应无法解析: ${err instanceof Error ? err.message : String(err)}`,
      },
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: { code: 'BACKEND_ERROR', message: '调度器响应不是对象' } }
  }
  const rec = value as Record<string, unknown>
  if (rec.ok !== 1) {
    const code = typeof rec.code === 'string' && ERROR_CODES.has(rec.code as CadErr['error']['code'])
      ? rec.code as CadErr['error']['code']
      : 'BACKEND_ERROR'
    return {
      ok: false,
      error: { code, message: typeof rec.message === 'string' ? rec.message : '调度器返回了失败' },
    }
  }
  const response: CadResponse = { ok: true, data: coerceFlags(rec.data ?? {}) }
  if (Array.isArray(rec.handles)) response.handles = rec.handles.map(h => String(h))
  if (Array.isArray(rec.warnings)) response.warnings = rec.warnings.map(w => String(w))
  return response
}

/** Layer flags cross the file as 0/1. The tool schema wants booleans. */
function coerceFlags(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(coerceFlags)
  if (!value || typeof value !== 'object') return value
  const rec = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(rec)) {
    const child = rec[key]
    if ((key === 'on' || key === 'frozen' || key === 'locked') && (child === 0 || child === 1)) {
      out[key] = child === 1
    } else {
      out[key] = coerceFlags(child)
    }
  }
  return out
}

function verifyMutation(request: CadRequest, response: CadResponse): CadResponse {
  if (!response.ok) return response
  const handles = response.handles ?? []
  const warnings = response.warnings ?? []
  const must = request.op === 'draw' || request.op === 'addDimension' || request.op === 'addHatch' || request.op === 'modify'
  if (must && handles.length === 0) {
    return {
      ok: false,
      error: {
        code: 'BACKEND_ERROR',
        message: `${request.op} 报告成功但没有可回读的句柄`,
      },
    }
  }
  if ((request.op === 'transform' || request.op === 'delete') && handles.length === 0 && warnings.length === 0) {
    return {
      ok: false,
      error: {
        code: 'BACKEND_ERROR',
        message: `${request.op} 没有改到任何图元，也没有说明跳过原因`,
      },
    }
  }
  return response
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
