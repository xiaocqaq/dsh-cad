import type {
  AddDimensionRequest,
  AddHatchRequest,
  CreateSpec,
  DeleteRequest,
  DocumentInfo,
  DrawRequest,
  EntityHandle,
  EntityKind,
  EntitySummary,
  GetEntityRequest,
  LayerInfo,
  ModifyRequest,
  OpenRequest,
  Point,
  Point3D,
  QueryEntitiesRequest,
  RunCommandRequest,
  SaveAsRequest,
  TransformRequest,
} from '../protocol.ts'

/** Internal entity record; richer than the summary the model sees. */
interface SimEntity {
  handle: EntityHandle
  kind: EntityKind
  layer: string
  color: number
  linetype: string
  text?: string
  /** Geometry parameters, kind-dependent. */
  radius?: number
  height?: number
  rotation?: number
  startAngle?: number
  endAngle?: number
  points?: Point[]
  measure?: { length?: number; radius?: number; area?: number; angle?: number }
}

function toPoint3(p: Point): Point3D {
  return { x: p.x, y: p.y, z: 'z' in p ? p.z : 0 }
}

function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function centroid(points: Point[]): Point {
  const sum = points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 })
  return { x: sum.x / points.length, y: sum.y / points.length }
}

/** Shoelace area; positive for counter-clockwise rings. */
function ringArea(points: Point[]): number {
  let a = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!
    const q = points[(i + 1) % points.length]!
    a += p.x * q.y - q.x * p.y
  }
  return Math.abs(a) / 2
}

function bboxOf(points: Point[]): { min: Point3D; max: Point3D } {
  const xs = points.map(p => p.x)
  const ys = points.map(p => p.y)
  const zs = points.map(p => ('z' in p ? p.z : 0))
  return {
    min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
    max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
  }
}

/**
 * An in-memory drawing that speaks the same operation surface as the COM
 * backend. It exists so every tool, the service layer and the tests can run on
 * a machine with no AutoCAD installed, and so prompt rehearsals never risk a
 * real drawing.
 */
export class SimulatedDocument {
  private entities = new Map<EntityHandle, SimEntity>()
  private counter = 0
  private doc: DocumentInfo = {
    name: 'Drawing1.dwg',
    path: null,
    unitsName: 'Unitless',
    modelSpaceCount: 0,
    activeSpace: 'model',
  }
  private layers = new Map<string, LayerInfo>()
  private commandLog: string[] = []

  constructor() {
    this.layers.set('0', {
      name: '0',
      color: 7,
      linetype: 'Continuous',
      on: true,
      frozen: false,
      locked: false,
      entityCount: 0,
    })
  }

  get document(): DocumentInfo {
    return { ...this.doc, modelSpaceCount: this.entities.size }
  }

  get commands(): readonly string[] {
    return this.commandLog
  }

  private nextHandle(): EntityHandle {
    this.counter += 1
    return `SIM${String(this.counter).padStart(5, '0')}`
  }

  /** Create the layer if absent, mirroring AutoCAD's implicit-layer behaviour. */
  ensureLayer(name: string): void {
    if (this.layers.has(name)) return
    this.layers.set(name, {
      name,
      color: 7,
      linetype: 'Continuous',
      on: true,
      frozen: false,
      locked: false,
      entityCount: 0,
    })
  }

  private recountLayers(): void {
    const counts = new Map<string, number>()
    for (const e of this.entities.values()) {
      counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1)
    }
    for (const [name, info] of this.layers) {
      info.entityCount = counts.get(name) ?? 0
    }
  }

  listLayers(): LayerInfo[] {
    this.recountLayers()
    return [...this.layers.values()]
      .map(l => ({ ...l }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  open(req: OpenRequest): void {
    const name = req.path.split(/[\\/]/).pop() ?? req.path
    this.entities.clear()
    this.counter = 0
    this.doc = { ...this.doc, name, path: req.path }
  }

  saveAs(req: SaveAsRequest): string {
    const name = req.path.split(/[\\/]/).pop() ?? req.path
    this.doc = { ...this.doc, name, path: req.path }
    return req.path
  }

  runCommand(req: RunCommandRequest): string[] {
    const line = [req.command, ...(req.args ?? [])].join(' ')
    this.commandLog.push(line)
    return [line]
  }

  private createEntity(spec: CreateSpec, warnings: string[]): EntityHandle {
    const layer = spec.layer ?? '0'
    this.ensureLayer(layer)
    const handle = this.nextHandle()
    const base: SimEntity = {
      handle,
      kind: spec.kind,
      layer,
      color: spec.color ?? 256, // 256 = ByLayer
      linetype: 'ByLayer',
    }

    switch (spec.kind) {
      case 'line': {
        const len = dist(spec.start, spec.end)
        if (len === 0) warnings.push(`零长度直线已跳过 (${handle})`)
        base.measure = { length: len }
        base.points = [spec.start, spec.end]
        break
      }
      case 'circle': {
        if (spec.radius <= 0) warnings.push(`非正半径圆已跳过 (${handle})`)
        base.measure = { radius: spec.radius }
        base.radius = spec.radius
        base.points = [spec.center]
        break
      }
      case 'arc': {
        if (spec.radius <= 0) warnings.push(`非正半径圆弧已跳过 (${handle})`)
        const sweep = ((spec.endAngle - spec.startAngle) % 360 + 360) % 360
        base.measure = { radius: spec.radius, angle: sweep }
        base.radius = spec.radius
        base.startAngle = spec.startAngle
        base.endAngle = spec.endAngle
        base.points = [spec.center]
        break
      }
      case 'polyline': {
        if (spec.vertices.length < 2) warnings.push(`顶点不足的多段线已跳过 (${handle})`)
        const pts = spec.closed ? [...spec.vertices, spec.vertices[0]!] : spec.vertices
        const length = pts
          .slice(1)
          .reduce((acc: number, p: Point, i: number) => acc + dist(pts[i]!, p), 0)
        base.measure = spec.closed
          ? { length, area: ringArea(spec.vertices) }
          : { length }
        base.points = spec.vertices
        break
      }
      case 'text': {
        base.text = spec.text
        const h = spec.height ?? 2.5
        base.height = h
        base.rotation = spec.rotation ?? 0
        base.measure = { length: spec.text.length * (h * 0.6) }
        base.points = [spec.position]
        break
      }
      case 'mtext': {
        base.text = spec.text
        const h = spec.height ?? 2.5
        const w = spec.width ?? 100
        base.height = h
        const box = [
          spec.position,
          { x: spec.position.x + w, y: spec.position.y },
          { x: spec.position.x + w, y: spec.position.y + h * 4 },
          { x: spec.position.x, y: spec.position.y + h * 4 },
        ]
        base.measure = { length: spec.text.length * (h * 0.6), area: ringArea(box) }
        base.points = [spec.position]
        break
      }
    }

    this.entities.set(handle, base)
    return handle
  }

  draw(req: DrawRequest): { handles: EntityHandle[]; warnings: string[] } {
    const warnings: string[] = []
    const handles = req.items.map((spec: CreateSpec) => this.createEntity(spec, warnings))
    return { handles, warnings }
  }

  query(req: QueryEntitiesRequest): EntitySummary[] {
    const out: EntitySummary[] = []
    for (const e of this.entities.values()) {
      if (req.layer && e.layer.toLowerCase() !== req.layer.toLowerCase()) continue
      if (req.kind && e.kind !== req.kind) continue
      if (req.textContains) {
        const hay = (e.text ?? '').toLowerCase()
        if (!hay.includes(req.textContains.toLowerCase())) continue
      }
      if (req.window) {
        const c = e.points?.length ? centroid(e.points) : undefined
        if (!c) continue
        const { min, max } = req.window
        if (c.x < min.x || c.x > max.x || c.y < min.y || c.y > max.y) continue
      }
      out.push(this.summarize(e))
    }
    return req.limit ? out.slice(0, req.limit) : out
  }

  private summarize(e: SimEntity): EntitySummary {
    const pts = e.points ?? []
    const summary: EntitySummary = {
      handle: e.handle,
      kind: e.kind,
      layer: e.layer,
      bbox: pts.length ? bboxOf(pts) : null,
      color: e.color,
      linetype: e.linetype,
    }
    if (e.measure) summary.measure = { ...e.measure }
    if (e.text !== undefined) summary.text = e.text
    return summary
  }

  getEntity(req: GetEntityRequest): EntitySummary | undefined {
    const e = this.entities.get(req.handle)
    return e ? this.summarize(e) : undefined
  }

  addDimension(req: AddDimensionRequest): { handle: EntityHandle; warnings: string[] } {
    const warnings: string[] = []
    const handle = this.nextHandle()
    this.ensureLayer(req.layer ?? '0')
    const expected = req.kind === 'angular' ? 3 : 2
    if (req.points.length !== expected) {
      const detail = req.kind === 'angular'
        ? '角度标注需要 3 个点(顶点和两条射线端点)'
        : req.kind === 'radius'
          ? '半径标注需要 2 个点(圆心和圆周点)'
          : req.kind === 'diameter'
            ? '直径标注需要 2 个点(直径两端)'
            : '线性/对齐标注需要 2 个点'
      throw new Error(detail)
    }
    const span = dist(req.points[0]!, req.points[1]!)
    const measure = req.kind === 'angular'
      ? { angle: Math.atan2(req.points[2]!.y - req.points[0]!.y, req.points[2]!.x - req.points[0]!.x) - Math.atan2(req.points[1]!.y - req.points[0]!.y, req.points[1]!.x - req.points[0]!.x) }
      : req.kind === 'radius'
        ? { radius: span }
        : { length: req.kind === 'diameter' ? span : span }
    this.entities.set(handle, {
      handle,
      kind: 'dimension',
      layer: req.layer ?? '0',
      color: req.color ?? 256,
      linetype: 'ByLayer',
      text: req.textOverride,
      points: req.points,
      measure,
    })
    return { handle, warnings }
  }

  addHatch(req: AddHatchRequest): { handle: EntityHandle; warnings: string[] } {
    const warnings: string[] = []
    if (req.loops.length === 0) throw new Error('填充至少需要一个闭合边界环')
    for (const loop of req.loops) {
      if (loop.length < 3) throw new Error('填充边界环至少需要 3 个顶点')
    }
    const handle = this.nextHandle()
    this.ensureLayer(req.layer ?? '0')
    const area = req.loops.reduce((acc: number, loop: Point[]) => acc + ringArea(loop), 0)
    if (area === 0) warnings.push('填充边界面积为 0,请检查顶点是否构成闭合环')
    const pts = req.loops.flat()
    this.entities.set(handle, {
      handle,
      kind: 'hatch',
      layer: req.layer ?? '0',
      color: req.color ?? 256,
      linetype: 'ByLayer',
      points: pts,
      measure: { area },
    })
    return { handle, warnings }
  }

  modify(req: ModifyRequest): { handle: EntityHandle; warnings: string[] } {
    const e = this.entities.get(req.handle)
    if (!e) throw new Error(`图元不存在: ${req.handle}`)
    const warnings: string[] = []
    if (req.set.layer) {
      this.ensureLayer(req.set.layer)
      e.layer = req.set.layer
    }
    if (req.set.color !== undefined) e.color = req.set.color
    if (req.set.linetype) e.linetype = req.set.linetype
    if (req.set.text !== undefined) e.text = req.set.text
    if (req.set.height !== undefined) e.height = req.set.height
    if (req.set.rotation !== undefined) e.rotation = req.set.rotation
    if (req.set.radius !== undefined) {
      e.radius = req.set.radius
      if (e.measure) e.measure.radius = req.set.radius
    }
    return { handle: req.handle, warnings }
  }

  transform(req: TransformRequest): { handles: EntityHandle[]; warnings: string[] } {
    const warnings: string[] = []
    const touched: EntityHandle[] = []
    for (const h of req.handles) {
      const src = this.entities.get(h)
      if (!src) {
        warnings.push(`图元不存在,已跳过: ${h}`)
        continue
      }
      if (this.layers.get(src.layer)?.locked) {
        warnings.push(`图层 ${src.layer} 已锁定,已跳过: ${h}`)
        continue
      }
      // Work on a copy so `copy: true` leaves the original untouched.
      const e: SimEntity = req.copy
        ? { ...src, points: src.points ? [...src.points] : undefined, measure: { ...src.measure } }
        : src
      if (!e.points) e.points = []

      if (req.mode === 'move') {
        const dx = req.value
        const dy = req.valueY ?? 0
        e.points = e.points.map(p => ({ ...p, x: p.x + dx, y: p.y + dy }))
      } else if (req.mode === 'rotate') {
        const c = req.center ?? { x: 0, y: 0 }
        const rad = (req.value * Math.PI) / 180
        const cos = Math.cos(rad)
        const sin = Math.sin(rad)
        e.points = e.points.map(p => {
          const dx = p.x - c.x
          const dy = p.y - c.y
          return { ...p, x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos }
        })
        e.rotation = ((e.rotation ?? 0) + req.value) % 360
      } else {
        const c = req.center ?? { x: 0, y: 0 }
        if (req.value <= 0) {
          warnings.push(`非正缩放系数已跳过: ${h}`)
          continue
        }
        e.points = e.points.map(p => ({
          ...p,
          x: c.x + (p.x - c.x) * req.value,
          y: c.y + (p.y - c.y) * req.value,
        }))
        if (e.radius !== undefined) e.radius *= req.value
        if (e.measure?.radius !== undefined) e.measure.radius *= req.value
        if (e.measure?.area !== undefined) e.measure.area *= req.value * req.value
        if (e.measure?.length !== undefined) e.measure.length *= req.value
      }

      if (req.copy) {
        e.handle = this.nextHandle()
        this.entities.set(e.handle, e)
      }
      touched.push(e.handle)
    }
    return { handles: touched, warnings }
  }

  delete(req: DeleteRequest): { handles: EntityHandle[]; warnings: string[] } {
    const warnings: string[] = []
    const removed: EntityHandle[] = []
    for (const h of req.handles) {
      const e = this.entities.get(h)
      if (!e) {
        warnings.push(`图元不存在,已跳过: ${h}`)
        continue
      }
      if (this.layers.get(e.layer)?.locked) {
        warnings.push(`图层 ${e.layer} 已锁定,已跳过: ${h}`)
        continue
      }
      this.entities.delete(h)
      removed.push(h)
    }
    return { handles: removed, warnings }
  }
}
