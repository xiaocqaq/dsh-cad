import type { CadRequest, CadResponse, CadTransport } from '../protocol.ts'
import { SimulatedDocument } from './sim-document.ts'

/**
 * Serves the full operation surface from an in-memory drawing.
 *
 * Used for wiring checks, CI, and prompt rehearsal on machines without
 * AutoCAD. It is a real implementation of {@link CadTransport}, not a stub:
 * every tool runs against it unchanged.
 */
export class SimulationTransport implements CadTransport {
  readonly kind = 'simulation'
  private doc = new SimulatedDocument()
  private running = false

  async start(): Promise<void> {
    this.running = true
  }

  async stop(): Promise<void> {
    this.running = false
  }

  /** Escape hatch for tests and debugging. */
  get document(): SimulatedDocument {
    return this.doc
  }

  async send(request: CadRequest): Promise<CadResponse> {
    if (!this.running) {
      return {
        ok: false,
        error: { code: 'NOT_CONNECTED', message: '仿真后端尚未启动' },
      }
    }
    try {
      switch (request.op) {
        case 'status':
          return { ok: true, data: { backend: this.kind, document: this.doc.document } }
        case 'open':
          this.doc.open(request)
          return { ok: true, data: { document: this.doc.document } }
        case 'saveAs':
          return { ok: true, data: { path: this.doc.saveAs(request) } }
        case 'listLayers':
          return { ok: true, data: { layers: this.doc.listLayers() } }
        case 'queryEntities': {
          const entities = this.doc.query(request)
          return {
            ok: true,
            data: { count: entities.length, entities },
            warnings: request.limit && entities.length === request.limit
              ? [`结果已截断至 limit=${request.limit},可能还有更多图元未显示`]
              : undefined,
          }
        }
        case 'getEntity': {
          const entity = this.doc.getEntity(request)
          if (!entity) {
            return {
              ok: false,
              error: { code: 'NOT_FOUND', message: `图元不存在: ${request.handle}` },
            }
          }
          return { ok: true, data: { entity } }
        }
        case 'draw': {
          const { handles, warnings } = this.doc.draw(request)
          return { ok: true, data: { count: handles.length }, handles, warnings }
        }
        case 'addDimension': {
          const { handle, warnings } = this.doc.addDimension(request)
          return { ok: true, data: { count: 1 }, handles: [handle], warnings }
        }
        case 'addHatch': {
          const { handle, warnings } = this.doc.addHatch(request)
          return { ok: true, data: { count: 1 }, handles: [handle], warnings }
        }
        case 'modify': {
          const { handle, warnings } = this.doc.modify(request)
          return { ok: true, data: { count: 1 }, handles: [handle], warnings }
        }
        case 'transform': {
          const { handles, warnings } = this.doc.transform(request)
          return { ok: true, data: { count: handles.length }, handles, warnings }
        }
        case 'delete': {
          const { handles, warnings } = this.doc.delete(request)
          return { ok: true, data: { count: handles.length }, handles, warnings }
        }
        case 'runCommand':
          return { ok: true, data: { executed: this.doc.runCommand(request) } }
      }
    } catch (err) {
      return {
        ok: false,
        error: {
          code: 'INVALID_ARGUMENT',
          message: err instanceof Error ? err.message : String(err),
        },
      }
    }
  }
}
