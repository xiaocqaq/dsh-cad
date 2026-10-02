import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SimulationTransport } from '../src/transport/simulation.ts'
import { UnitConverter } from '../src/unit.ts'

test('单位换算: 米制图纸 (1 m = 1 unit)', () => {
  const u = new UnitConverter(1)
  assert.equal(u.toDrawing(17.2), 17.2)
  assert.equal(u.toMeters(17.2), 17.2)
})

test('单位换算: 毫米制图纸 (1 m = 1000 units)', () => {
  const u = new UnitConverter(1000)
  assert.equal(u.toDrawing(0.5), 500)
  assert.equal(u.toMeters(500), 0.5)
})

test('单位换算: 拒绝非法比例', () => {
  assert.throws(() => new UnitConverter(0))
  assert.throws(() => new UnitConverter(-1))
  assert.throws(() => new UnitConverter(Number.NaN))
})

test('单位换算: 点坐标往返一致', () => {
  const u = new UnitConverter(1000)
  const p = u.pointToDrawing({ x: 1.5, y: -2.25 })
  assert.deepEqual(p, { x: 1500, y: -2250 })
})

test('单位换算: 报告中的 500mm 偏移场景(毫米制图纸)', () => {
  // The evaluation report recorded an agent producing a wrong 500mm offset.
  // With an explicit scale the same intent must be exact.
  const u = new UnitConverter(1000)
  const moved = u.toDrawing(0.5)
  assert.equal(moved, 500)
  assert.equal(u.toMeters(moved), 0.5)
})

test('describeEntity 同时给出米制与图纸单位', () => {
  const u = new UnitConverter(1000)
  const out = u.describeEntity({
    handle: 'H1',
    kind: 'line',
    layer: '0',
    bbox: null,
    measure: { length: 17200 },
  })
  assert.equal(out.meters.length, 17.2)
})

test('round 消除浮点噪声', () => {
  assert.equal(UnitConverter.round(0.1 + 0.2), 0.3)
  assert.equal(UnitConverter.round(1.0000000000000002), 1)
})

test('simulation: 平移按图纸单位生效', async () => {
  const t = new SimulationTransport()
  await t.start()
  const draw = await t.send({
    op: 'draw',
    items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 } }],
  })
  assert.equal(draw.ok, true)
  const handle = draw.ok ? draw.handles![0]! : ''

  // In a metre-based drawing, 5 m right == 5 units right.
  const moved = await t.send({ op: 'transform', handles: [handle], mode: 'move', value: 5 })
  assert.equal(moved.ok, true)

  const after = await t.send({ op: 'getEntity', handle })
  if (after.ok) {
    const e = (after.data as { entity: { bbox: { min: { x: number } } } }).entity
    assert.equal(e.bbox.min.x, 5)
  }
})

test('simulation: 不存在的句柄返回 NOT_FOUND', async () => {
  const t = new SimulationTransport()
  await t.start()
  const res = await t.send({ op: 'getEntity', handle: 'NOPE' })
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error.code, 'NOT_FOUND')
})

test('simulation: 删除后查询不到', async () => {
  const t = new SimulationTransport()
  await t.start()
  const draw = await t.send({
    op: 'draw',
    items: [{ kind: 'circle', center: { x: 0, y: 0 }, radius: 1 }],
  })
  const handle = draw.ok ? draw.handles![0]! : ''
  const del = await t.send({ op: 'delete', handles: [handle] })
  assert.equal(del.ok, true)
  if (del.ok) assert.deepEqual(del.handles, [handle])
  const after = await t.send({ op: 'getEntity', handle })
  assert.equal(after.ok, false)
})

test('simulation: 尺寸标注至少需要两个点', async () => {
  const t = new SimulationTransport()
  await t.start()
  const res = await t.send({ op: 'addDimension', kind: 'linear', points: [{ x: 0, y: 0 }] })
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.error.code, 'INVALID_ARGUMENT')
})

test('simulation: 复制变换不影响原图元', async () => {
  const t = new SimulationTransport()
  await t.start()
  const draw = await t.send({
    op: 'draw',
    items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
  })
  const handle = draw.ok ? draw.handles![0]! : ''
  const copied = await t.send({
    op: 'transform',
    handles: [handle],
    mode: 'move',
    value: 10,
    copy: true,
  })
  assert.equal(copied.ok, true)
  if (copied.ok) {
    assert.notEqual(copied.handles![0], handle)
    // Original must not have moved.
    const orig = await t.send({ op: 'getEntity', handle })
    if (orig.ok) {
      const e = (orig.data as { entity: { bbox: { min: { x: number } } } }).entity
      assert.equal(e.bbox.min.x, 0)
    }
  }
})

test('simulation: 填充面积按鞋带公式计算', async () => {
  const t = new SimulationTransport()
  await t.start()
  const res = await t.send({
    op: 'addHatch',
    loops: [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]],
  })
  assert.equal(res.ok, true)
  if (res.ok) {
    const handle = res.handles![0]!
    const got = await t.send({ op: 'getEntity', handle })
    if (got.ok) {
      const e = (got.data as { entity: { measure?: { area?: number } } }).entity
      assert.equal(e.measure?.area, 100)
    }
  }
})
