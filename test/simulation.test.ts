import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulationTransport } from '../src/transport/simulation.ts'
import { UnitConverter } from '../src/unit.ts'

async function started() {
  const t = new SimulationTransport()
  await t.start()
  return t
}

test('simulation: 未启动时返回 NOT_CONNECTED', async () => {
  const t = new SimulationTransport()
  const res = await t.send({ op: 'status' })
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error.code, 'NOT_CONNECTED')
})

test('simulation: 绘制直线并返回句柄与长度', async () => {
  const t = await started()
  const res = await t.send({
    op: 'draw',
    items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 3, y: 4 } }],
  })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.handles?.length, 1)
    // 3-4-5 triangle.
    const q = await t.send({ op: 'getEntity', handle: res.handles![0]! })
    assert.equal(q.ok, true)
    if (q.ok) {
      const e = (q.data as { entity: { measure?: { length?: number } } }).entity
      assert.equal(e.measure?.length, 5)
    }
  }
})

test('simulation: 按图层和文字检索图元', async () => {
  const t = await started()
  await t.send({
    op: 'draw',
    items: [
      { kind: 'text', position: { x: 1, y: 1 }, text: '基坑深度 17.2m', layer: 'TEXT' },
      { kind: 'text', position: { x: 2, y: 2 }, text: '冠梁 1100x700', layer: 'TEXT' },
      { kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 }, layer: 'STRUCTURE' },
    ],
  })
  const byText = await t.send({ op: 'queryEntities', textContains: '冠梁' })
  assert.equal(byText.ok, true)
  if (byText.ok) {
    const d = byText.data as { count: number }
    assert.equal(d.count, 1)
  }
  const byLayer = await t.send({ op: 'queryEntities', layer: 'structure' })
  if (byLayer.ok) {
    assert.equal((byLayer.data as { count: number }).count, 1, '图层名应大小写不敏感')
  }
})

test('simulation: limit 截断时给出警告', async () => {
  const t = await started()
  const items = Array.from({ length: 5 }, (_, i) => ({
    kind: 'line' as const,
    start: { x: i, y: 0 },
    end: { x: i, y: 1 },
  }))
  await t.send({ op: 'draw', items })
  const res = await t.send({ op: 'queryEntities', limit: 2 })
  assert.equal(res.ok, true)
  if (res.ok) {
    assert.equal(res.warnings?.length, 1)
    assert.match(res.warnings![0]!, /截断/)
  }
})
