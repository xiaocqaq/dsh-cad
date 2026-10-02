import type { EntitySummary, Point } from './protocol.ts'

/**
 * Unit conversion between metres (what the model speaks) and drawing units
 * (what AutoCAD stores).
 *
 * The Codex-for-CAD evaluation recorded a concrete failure of exactly this
 * kind: an offset of "500mm" was measured off the drawing with no scale bar,
 * producing a wrong result. Keeping every tool input in metres and converting
 * in one audited place removes the whole class of error, and returning both
 * representations lets the model verify its own arithmetic against the drawing.
 */
export class UnitConverter {
  /** Drawing units per metre. */
  readonly unitsPerMeter: number

  constructor(unitsPerMeter: number) {
    if (!Number.isFinite(unitsPerMeter) || unitsPerMeter <= 0) {
      throw new Error(`unitsPerMeter 必须是正数,收到: ${unitsPerMeter}`)
    }
    this.unitsPerMeter = unitsPerMeter
  }

  /** Engineering metres -> drawing units. */
  toDrawing(meters: number): number {
    return meters * this.unitsPerMeter
  }

  /** Drawing units -> engineering metres. */
  toMeters(units: number): number {
    return units / this.unitsPerMeter
  }

  pointToDrawing(p: Point): Point {
    const out: Point = { x: this.toDrawing(p.x), y: this.toDrawing(p.y) }
    if ('z' in p) return { ...out, z: this.toDrawing(p.z) }
    return out
  }

  pointsToDrawing(points: readonly Point[]): Point[] {
    return points.map(p => this.pointToDrawing(p))
  }

  /** Round for display without introducing float noise like 1.0000000000000002. */
  static round(value: number, digits = 6): number {
    const f = 10 ** digits
    return Math.round(value * f) / f
  }

  /**
   * Attach metre equivalents to an entity summary so the model always sees the
   * engineering value next to the raw drawing value.
   */
  describeEntity(e: EntitySummary): EntitySummary & { meters: Record<string, number> } {
    const meters: Record<string, number> = {}
    if (e.measure?.length !== undefined) meters.length = UnitConverter.round(this.toMeters(e.measure.length))
    if (e.measure?.radius !== undefined) meters.radius = UnitConverter.round(this.toMeters(e.measure.radius))
    if (e.measure?.area !== undefined) meters.area = UnitConverter.round(this.toMeters(e.measure.area))
    return { ...e, meters }
  }
}
