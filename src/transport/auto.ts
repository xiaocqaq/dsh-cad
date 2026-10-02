import type { CadRequest, CadResponse } from '../protocol.ts'
import type { CadTransport } from '../protocol.ts'
import type { LispIpcTransport } from './lisp-ipc.ts'

export interface AutoTransportOptions {
  lisp: LispIpcTransport
  /** Built only when the resident dispatcher is not already running. */
  createCom: () => CadTransport
  /** Wait this long after the one-time load command for a heartbeat. */
  bootstrapTimeoutMs?: number
}

/**
 * Prefer the resident AutoLISP dispatcher. COM is used only to load that
 * dispatcher, or as a degraded backend when the load does not take.
 *
 * A missing capability stays a structured error. This class does not invent
 * a result, and it does not call SetForegroundWindow.
 */
export class AutoTransport implements CadTransport {
  private readonly lisp: LispIpcTransport
  private readonly createCom: () => CadTransport
  private readonly bootstrapTimeoutMs: number
  private com: CadTransport | null = null
  private selected: CadTransport
  private degraded = ''
  private bootstrapped = false

  constructor(options: AutoTransportOptions) {
    this.lisp = options.lisp
    this.createCom = options.createCom
    this.bootstrapTimeoutMs = options.bootstrapTimeoutMs ?? 8000
    this.selected = options.lisp
  }

  get kind(): string {
    return this.selected.kind
  }

  async start(): Promise<void> {
    await this.lisp.start()
    if (this.lisp.heartbeatFresh()) {
      this.selected = this.lisp
      this.degraded = ''
      return
    }
    try {
      const com = this.createCom()
      await com.start()
      this.com = com
    } catch (err) {
      this.selected = this.lisp
      this.degraded = err instanceof Error ? err.message : String(err)
      return
    }
    this.lisp.setNudge(async () => {
      if (!this.com) return
      await this.com.send({ op: 'runCommand', command: '(dsh:tick-now)' })
    })
    const loaded = await this.loadDispatcher()
    if (loaded) {
      this.selected = this.lisp
      this.bootstrapped = true
      this.degraded = this.lisp.heartbeatFresh()
        ? ''
        : '这台 AutoCAD 没有定时器反应器。图元数据走 File IPC，每次请求用一次 (dsh:tick-now) 唤醒，不抢焦点。'
      return
    }
    this.selected = this.com
    this.degraded = '已尝试加载 AutoLISP 调度器，但未写出 ready.lsp，继续使用 COM'
  }

  async stop(): Promise<void> {
    await this.lisp.stop()
    if (this.com) await this.com.stop()
  }

  async send(request: CadRequest): Promise<CadResponse> {
    return this.selected.send(request)
  }

  describeBackend(): Record<string, unknown> {
    return {
      ...(this.com?.describeBackend?.() ?? {}),
      ...this.lisp.describeBackend(),
      selected: this.selected.kind,
      degraded: this.degraded,
      bootstrapped: this.bootstrapped,
    }
  }

  private async loadDispatcher(): Promise<boolean> {
    if (!this.com) return false
    const dir = this.lisp.dir.replace(/\\/g, '/')
    const script = this.lisp.scriptPath.replace(/\\/g, '/')
    const form = `(progn (setq dsh:ipc-dir "${dir}/") (load "${script}"))`
    const res = await this.com.send({ op: 'runCommand', command: form })
    if (!res.ok) return false
    return this.lisp.waitForReady(this.bootstrapTimeoutMs)
  }
}
