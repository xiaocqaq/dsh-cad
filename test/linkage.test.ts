import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulationTransport } from '../src/transport/simulation.ts'
import { CadService } from '../src/service.ts'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ToolDeps } from '../src/tools/cad-status.ts'
import { createQueryEntitiesTool } from '../src/tools/cad-query.ts'
import { createDrawTool } from '../src/tools/cad-draw.ts'
import { createBatchTool } from '../src/tools/cad-batch.ts'
import { createTransformTool } from '../src/tools/cad-edit.ts'
import type { MutationResult } from '../src/tools/mutation.ts'

async function harness(unitsPerMeter = 1) {
  const transport = new SimulationTransport()
  const cad = new CadService(transport, unitsPerMeter)
  await cad.start()
  return { cad, deps: { cad, unitsPerMeter } as ToolDeps }
}

function fakeExec() {
  return { signal: new AbortController().signal, callId: 'test', name: 'test' } as never
}

/**
 * `ToolDefinition.execute` is declared to return `unknown` at the registry
 * boundary, so tests go through these typed runners instead of reaching into
 * the definition directly.
 */
async function run<T>(tool: ToolDefinition, args: unknown): Promise<T> {
  return (await tool.execute(args as never, fakeExec())) as T
}

interface Bboxed {
  bbox: { min: { x: number; y: number } }
}
interface QueryResult {
  count: number
  entities: unknown[]
}
interface DrawResult {
  ok: boolean
  count: number
  handles: string[]
  warnings: string[]
}

test('联动改图: dryRun 只定位不修改', async () => {
  const { deps } = await harness()
  const draw = createDrawTool(deps)
  const batch = createBatchTool(deps)
  const query = createQueryEntitiesTool(deps)

  await run<DrawResult>(draw, {
    items: [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, layer: 'STRUCTURE' },
      { kind: 'line', start: { x: 10, y:  0 }, end: { x: 10, y: 5 }, layer: 'STRUCTURE' },
      { kind: 'text', position: { x: 2, y: 2 }, text: 'note', layer: 'TEXT' },
    ],
  })

  const dry = await run<MutationResult>(batch, {
    query: { layer: 'STRUCTURE' },
    mode: 'move',
    value: 0.5,
    dryRun: true,
  })
  assert.equal(dry.ok, true)
  assert.equal(dry.count, 2, 'should only match the 2 STRUCTURE lines')
  assert.match(dry.warnings.join(), /试运行|dryRun/)

  const after = await run<QueryResult>(query, { kind: 'line' })
  const e = (after.entities as Bboxed[])[0]!
  assert.equal(e.bbox.min.x, 0, 'dryRun must not move entities')
})

test('联动改图: 实际批量偏移命中全部目标', async () => {
  const { deps } = await harness()
  const draw = createDrawTool(deps)
  const batch = createBatchTool(deps)
  const query = createQueryEntitiesTool(deps)

  await run<DrawResult>(draw, {
    items: [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, layer: 'STRUCTURE' },
      { kind: 'line', start: { x: 10, y: 0 }, end: { x: 10, y: 5 }, layer: 'STRUCTURE' },
    ],
  })

  const res = await run<MutationResult>(batch, {
    query: { layer: 'STRUCTURE' },
    mode: 'move',
    value: 0.5,
  })
  assert.equal(res.ok, true)
  assert.equal(res.count, 2)

  const after = await run<QueryResult>(query, { kind: 'line' })
  // The two lines start at x=0 and x=10, so both must land 0.5 further right.
  const xs = (after.entities as Bboxed[]).map(e => e.bbox.min.x).sort((a, b) => a - b)
  assert.deepEqual(xs, [0.5, 10.5], 'both lines should shift by exactly 0.5m')
})
test('联动改图: 平移后相对间距保持不变', async () => {
  const { deps } = await harness()
  const draw = createDrawTool(deps)
  const transform = createTransformTool(deps)
  const query = createQueryEntitiesTool(deps)

  const drawn = await run<DrawResult>(draw, {
    items: [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
      { kind: 'line', start: { x: 5, y: 0 }, end: { x: 6, y: 0 } },
    ],
  })
  assert.equal(drawn.handles.length, 2)

  await run<MutationResult>(transform, {
    handles: drawn.handles,
    mode: 'move',
    value: 3,
    valueY: 2,
  })

  const after = await run<QueryResult>(query, { kind: 'line' })
  const xs = (after.entities as Bboxed[]).map(e => e.bbox.min.x).sort((a, b) => a - b)
  assert.equal(xs[0], 3, 'both lines should shift by 3m')
  assert.equal(xs[1]! - xs[0]!, 5, 'relative spacing must be preserved')
})

test('联动改图: 无匹配图元时不产生任何修改', async () => {
  const { deps } = await harness()
  const batch = createBatchTool(deps)
  const res = await run<MutationResult>(batch, {
    query: { layer: 'NOT_EXIST' },
    mode: 'move',
    value: 1,
  })
  assert.equal(res.ok, false)
  assert.equal(res.count, 0)
  assert.deepEqual(res.handles, [])
})

test('联动改图: 毫米制图纸按 500mm 精确偏移', async () => {
  const { deps } = await harness(1000)
  const draw = createDrawTool(deps)
  const transform = createTransformTool(deps)
  const query = createQueryEntitiesTool(deps)

  const drawn = await run<DrawResult>(draw, {
    items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }],
  })

  await run<MutationResult>(transform, {
    handles: drawn.handles,
    mode: 'move',
    value: 0.5,
  })

  const after = await run<QueryResult>(query, { kind: 'line' })
  const e = (after.entities as Bboxed[])[0]!
  assert.equal(e.bbox.min.x, 500, '0.5m in a mm drawing is 500 drawing units')
})