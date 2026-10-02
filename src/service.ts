import type { CadErr, CadRequest, CadResponse, EntitySummary, Point } from './protocol.ts'
import { UnitConverter } from './unit.ts'
import type { CadTransport } from './protocol.ts'

/** Result of a mutating call, ready to become a tool's canonical value. */
export interface MutationOutcome {
  ok: boolean
  /** Handles created or affected, in backend order. */
  handles: string[]
  warnings: string[]
  /** Human-readable one-line summary. */
  summary: string
  /** Present when the backend reported a structured failure. */
  error?: CadErr['error']
}

/**
 * Unit-aware façade over a {@link CadTransport}.
 *
 * Everything above this class speaks metres; everything below speaks drawing
 * units. Keeping the conversion in one place is what stops the model from
 * mixing a 500 mm offset into a millimetre drawing and silently producing a
 * wrong result.
 */
export class CadService {
  readonly units: UnitConverter
  private readonly transport: CadTransport

  constructor(transport: CadTransport, unitsPerMeter: number) {
    this.transport = transport
    this.units = new UnitConverter(unitsPerMeter)
  }

  get backend(): string {
    return this.transport.kind
  }

  async start(): Promise<void> {
    await this.transport.start()
  }

  async stop(): Promise<void> {
    await this.transport.stop()
  }

  /** Escape hatch for tools that need a raw op (e.g. `cad_run_command`). */
  async raw(request: CadRequest): Promise<CadResponse> {
    return this.transport.send(request)
  }

  /** Convert a tool-level point (metres) into a protocol point (drawing units). */
  private p(p: Point): Point {
    return this.units.pointToDrawing(p)
  }

  /** Attach metre equivalents so the model sees engineering values. */
  describe(entities: EntitySummary[]): EntitySummary[] {
    return entities.map(e => this.units.describeEntity(e))
  }

  /** Normalise a backend response into a {@link MutationOutcome}. */
  static outcome(response: CadResponse, summary: string): MutationOutcome {
    if (!response.ok) {
      return { ok: false, handles: [], warnings: [], summary, error: response.error }
    }
    return {
      ok: true,
      handles: response.handles ?? [],
      warnings: response.warnings ?? [],
      summary,
    }
  }
}
