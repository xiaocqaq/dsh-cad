/**
 * Wire protocol between the plugin and an AutoCAD backend.
 *
 * One JSON object per line, UTF-8, `\n`-delimited in both directions (the same
 * stdio discipline the Harness ACP driver uses). The transport owns framing;
 * everything above this file only ever sees parsed values.
 */

/**
 * A point in drawing units.
 *
 * The index signature is what makes these assignable to `JsonValue`, which the
 * tool schema DSL requires of any canonical output value.
 */
export interface Point2D {
  x: number
  y: number
  [key: string]: number
}

export interface Point3D extends Point2D {
  z: number
}

export type Point = Point2D | Point3D

/** ACI (AutoCAD Color Index) colour. */
export type ColorIndex = number

/** Common entity kinds the plugin can create or match on. */
export const ENTITY_KINDS = [
  'line',
  'circle',
  'arc',
  'polyline',
  'text',
  'mtext',
  'dimension',
  'hatch',
  'point',
  'ellipse',
  'spline',
  'block',
  'unknown',
] as const

export type EntityKind = (typeof ENTITY_KINDS)[number]

/** Identifier assigned by the backend; stable for the lifetime of a document. */
export type EntityHandle = string

export interface EntitySummary {
  handle: EntityHandle
  kind: EntityKind
  layer: string
  /** Bounding box in drawing units; `null` when the entity has no extent. */
  bbox: { min: Point3D; max: Point3D } | null
  /** Length for linear kinds, radius for circular kinds, area for closed regions. */
  measure?: { length?: number; radius?: number; area?: number; angle?: number }
  /** Text content for text/mtext kinds, or a block name. */
  text?: string
  color?: ColorIndex
  linetype?: string
  [key: string]: unknown
}

export interface LayerInfo {
  name: string
  color: ColorIndex
  linetype: string
  on: boolean
  frozen: boolean
  locked: boolean
  entityCount: number
}

export interface DocumentInfo {
  name: string
  path: string | null
  unitsName: string
  /** Entities in model space, as reported by the backend. */
  modelSpaceCount: number
  activeSpace: 'model' | 'paper'
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface StatusRequest {
  op: 'status'
}

export interface OpenRequest {
  op: 'open'
  path: string
}

export interface SaveAsRequest {
  op: 'saveAs'
  path: string
}

export interface ListLayersRequest {
  op: 'listLayers'
}

export interface QueryEntitiesRequest {
  op: 'queryEntities'
  layer?: string
  kind?: EntityKind
  /** Substring match against text/mtext content and block names. */
  textContains?: string
  /** Restrict to entities whose centre falls inside this window (drawing units). */
  window?: { min: Point2D; max: Point2D }
  limit?: number
}

export interface GetEntityRequest {
  op: 'getEntity'
  handle: EntityHandle
}

/** A single primitive to create. Exactly one geometry field per variant. */
export type CreateSpec =
  | { kind: 'line'; start: Point; end: Point; layer?: string; color?: ColorIndex }
  | { kind: 'circle'; center: Point; radius: number; layer?: string; color?: ColorIndex }
  | {
      kind: 'arc'
      center: Point
      radius: number
      /** Degrees, counter-clockwise, 0 = +X axis. */
      startAngle: number
      endAngle: number
      layer?: string
      color?: ColorIndex
    }
  | {
      kind: 'polyline'
      vertices: Point[]
      closed?: boolean
      layer?: string
      color?: ColorIndex
    }
  | {
      kind: 'text'
      position: Point
      text: string
      height?: number
      rotation?: number
      layer?: string
      color?: ColorIndex
    }
  | {
      kind: 'mtext'
      position: Point
      text: string
      width?: number
      height?: number
      layer?: string
      color?: ColorIndex
    }

export interface DrawRequest {
  op: 'draw'
  items: CreateSpec[]
  /** Undo group label; lets the engineer revert one logical step. */
  undoLabel?: string
}

export interface AddDimensionRequest {
  op: 'addDimension'
  kind: 'linear' | 'aligned' | 'angular' | 'radius' | 'diameter'
  /**
   * Linear/aligned: extension points; angular: vertex + two ray endpoints;
   * radius: center + point on circle; diameter: opposite points on diameter.
   */
  points: Point[]
  /** Dimension line offset from the measured points, in drawing units. */
  offset?: number
  textOverride?: string
  layer?: string
  color?: ColorIndex
}

export interface AddHatchRequest {
  op: 'addHatch'
  /** Closed boundary loops, in drawing units. */
  loops: Point[][]
  patternName?: string
  /** 0-100; used only for non-solid patterns. */
  patternScale?: number
  layer?: string
  color?: ColorIndex
}

export interface ModifyRequest {
  op: 'modify'
  handle: EntityHandle
  /** Only the fields present are changed; everything else is preserved. */
  set: {
    layer?: string
    color?: ColorIndex
    linetype?: string
    text?: string
    height?: number
    rotation?: number
    radius?: number
  }
}

export interface TransformRequest {
  op: 'transform'
  handles: EntityHandle[]
  /** 'move' translates; 'rotate' spins about `center`; 'scale' is about `center`. */
  mode: 'move' | 'rotate' | 'scale'
  /** Translation for 'move', rotation in degrees for 'rotate', factor for 'scale'. */
  value: number
  /** Second component: dy for 'move'. Ignored otherwise. */
  valueY?: number
  /** Rotation pivot / scale centre, in drawing units. */
  center?: Point
  copy?: boolean
}

export interface DeleteRequest {
  op: 'delete'
  handles: EntityHandle[]
}

export interface RunCommandRequest {
  op: 'runCommand'
  command: string
  /** Tokens appended after the command name. */
  args?: string[]
}

/* ------------------------------------------------------------------ */
/* Responses                                                           */
/* ------------------------------------------------------------------ */

export interface CadOk<T = unknown> {
  ok: true
  data: T
  /** Entities created or changed, with handles assigned by the backend. */
  handles?: EntityHandle[]
  /** Non-fatal notes: skipped objects, clamps, anything the caller should know. */
  warnings?: string[]
}

export interface CadErr {
  ok: false
  error: {
    /** Stable, machine-readable discriminator. */
    code:
      | 'BACKEND_UNAVAILABLE'
      | 'NOT_CONNECTED'
      | 'TIMEOUT'
      | 'NO_DOCUMENT'
      | 'NOT_FOUND'
      | 'INVALID_ARGUMENT'
      | 'UNSUPPORTED'
      | 'BACKEND_ERROR'
    message: string
    details?: string
  }
}

export type CadResponse<T = unknown> = CadOk<T> | CadErr

/* ------------------------------------------------------------------ */
/* Envelope                                                            */
/* ------------------------------------------------------------------ */

/** Correlates a response with its request. */
export interface RequestEnvelope {
  id: string
  request: CadRequest
}

export interface ResponseEnvelope {
  id: string
  response: CadResponse
}

/** Every backend transport implements this. */
export interface CadTransport {
  /** Human-readable backend name, surfaced by `cad_status`. */
  readonly kind: string
  /** Begin accepting work. Must be idempotent. */
  start(): Promise<void>
  /** Round-trip one request. Rejects only on transport failure, never on a
   *  well-formed `CadErr` — callers branch on the envelope instead. */
  send(request: CadRequest): Promise<CadResponse>
  /** Release the backend. Must be idempotent. */
  stop(): Promise<void>
}


/** Discriminated union of every backend operation. */
export type CadRequest =
  | StatusRequest
  | OpenRequest
  | SaveAsRequest
  | ListLayersRequest
  | QueryEntitiesRequest
  | GetEntityRequest
  | DrawRequest
  | AddDimensionRequest
  | AddHatchRequest
  | ModifyRequest
  | TransformRequest
  | DeleteRequest
  | RunCommandRequest
