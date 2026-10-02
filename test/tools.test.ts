import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { SimulationTransport } from '../src/transport/simulation.ts'
import { CadService } from '../src/service.ts'
import type { ToolDeps } from '../src/tools/cad-status.ts'
import { createStatusTool } from '../src/tools/cad-status.ts'
import { createQueryEntitiesTool } from '../src/tools/cad-query.ts'
import { createDrawTool } from '../src/tools/cad-draw.ts'

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
 * `ToolDefinition.execute` returns `unknown` at the registry boundary, so tests
 * go through a typed runner rather than calling the definition directly.
 */
async function run<T>(tool: ToolDefinition, args: unknown = {}): Promise<T> {
  return (await tool.execute(args as never, fakeExec())) as T
}

function textOf(blocks: unknown): string {
  return (blocks as { text?: string }[]).map(b => b.text ?? '').join('\n')
}

interface StatusResult {
  backend: string
  connected: boolean
  unitsPerMeter: number
  message?: string
  [key: string]: unknown
}
interface DrawResult {
  ok: boolean
  count: number
  handles: string[]
  warnings: string[]
}
interface QueryResult {
  count: number
  entities: { handle: string; meters: Record<string, number> }[]
}

test('工具链: 状态工具报告后端与单位比例', async () => {
  const { deps } = await harness(1000)
  const tool = createStatusTool(deps)
  const value = await run<StatusResult>(tool)
  assert.equal(value.connected, true)
  assert.equal(value.unitsPerMeter, 1000)
  // The registry hands `render` a plain JSON value; the cast reflects that the
  // test fixture is JSON-serialisable.
  const text = textOf(tool.output.render({}, value as never))
  assert.match(text, /simulation/)
  assert.match(text, /1 米 = 1000/)
})

test('工具链: 绘制后可通过检索取回句柄(定位闭环)', async () => {
  const { deps } = await harness()
  const draw = createDrawTool(deps)
  const query = createQueryEntitiesTool(deps)

  const drawn = await run<DrawResult>(draw, {
    items: [
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, layer: 'STRUCTURE' },
      { kind: 'circle', center: { x: 5, y: 5 }, radius: 0.5, layer: 'STRUCTURE' },
    ],
    undoLabel: 'test',
  })
  assert.equal(drawn.ok, true)
  assert.equal(drawn.count, 2)

  const found = await run<QueryResult>(query, { layer: 'STRUCTURE' })
  assert.equal(found.count, 2)
  const handles = found.entities.map(e => e.handle)
  for (const h of drawn.handles) {
    assert.ok(handles.includes(h), `drawn handle ${h} should be resolvable`)
  }
})

test('工具链: 毫米制图纸下 17.2m 读回仍是 17.2m', async () => {
  const { deps } = await harness(1000)
  const draw = createDrawTool(deps)
  const query = createQueryEntitiesTool(deps)

  await run<DrawResult>(draw, {
    items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 17.2, y: 0 } }],
  })
  const found = await run<QueryResult>(query, { kind: 'line' })
  // The model asked for 17.2 m; it must read back 17.2 m, not 17200.
  assert.equal(found.entities[0]!.meters.length, 17.2)
})
