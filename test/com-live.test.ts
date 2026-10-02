import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ComTransport } from '../src/transport/com.ts'
import { CadService } from '../src/service.ts'

/**
 * Real-CAD integration tests.
 *
 * These drive an actual AutoCAD instance over COM. They are skipped unless
 * `DSH_CAD_LIVE=1` is set, because they need a licensed, running AutoCAD and
 * they mutate the active drawing.
 *
 *   1. Start AutoCAD 2026 and open a blank drawing (or a scratch copy).
 *   2. DSH_CAD_LIVE=1 node --test --experimental-strip-types test/com-live.test.ts
 *
 * The drawing is created on the "0" layer and deleted again, so a blank
 * document is enough. Do not point this at a drawing you care about.
 */
const LIVE = process.env.DSH_CAD_LIVE === '1'
const opts = { skip: LIVE ? false : '需要运行中的 AutoCAD(设置 DSH_CAD_LIVE=1)' }

function makeService(unitsPerMeter = 1) {
  const transport = new ComTransport({
    progId: process.env.DSH_CAD_PROGID ?? 'AutoCAD.Application',
    progIdFallbacks: [
      'AutoCAD.Application.25.2',
      'AutoCAD.Application.25.1',
      'AutoCAD.Application.25.0',
    ],
    requestTimeoutMs: 60000,
  })
  return { transport, service: new CadService(transport, unitsPerMeter) }
}

test('COM: 未运行 AutoCAD 时返回结构化错误而非挂死', { timeout: 90000 }, async () => {
  // Uses a ProgID that is registered but never running, so this is safe to
  // execute unconditionally.
  const transport = new ComTransport({
    progId: 'AutoCAD.Application.__dsh_probe__',
    progIdFallbacks: [],
    requestTimeoutMs: 15000,
  })
  const started = Date.now()
  const res = await transport.send({ op: 'status' })
  const elapsed = Date.now() - started

  assert.equal(res.ok, false, '不应在 AutoCAD 缺席时报告成功')
  if (!res.ok) {
    assert.equal(res.error.code, 'BACKEND_UNAVAILABLE')
    assert.match(res.error.message, /AutoCAD/)
  }
  assert.ok(elapsed < 30000, `应在超时前快速失败,实际 ${elapsed}ms`)
  await transport.stop()
})

test('COM: 连接到真实 AutoCAD 并读取状态', opts, async () => {
  const { transport, service } = makeService()
  try {
    const res = await transport.send({ op: 'status' })
    assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error))
    if (res.ok) {
      const d = res.data as { backend?: string; attached?: boolean; document?: { name: string } }
      assert.equal(d.backend, 'com')
      assert.ok(d.document?.name, '应能读到当前图形名')
    }
    assert.equal(service.backend, 'com')
  } finally {
    await transport.stop()
  }
})

test('COM: 真实绘制一条直线并可检索到', opts, async () => {
  const { transport } = makeService()
  try {
    const drawn = await transport.send({
      op: 'draw',
      items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 1000, y: 0 }, layer: 'DSH_CAD_TEST' }],
      undoLabel: 'dsh-plugin-cad live test',
    })
    assert.equal(drawn.ok, true, drawn.ok ? '' : JSON.stringify(drawn.error))
    const handle = drawn.ok ? drawn.handles![0]! : ''

    // The layer is created on demand; a real AutoCAD should report it.
    const layers = await transport.send({ op: 'listLayers' })
    if (layers.ok) {
      const d = layers.data as { layers: { name: string }[] }
      assert.ok(
        d.layers.some(l => l.name === 'DSH_CAD_TEST'),
        '新建的图层应出现在图层列表中',
      )
    }

    // The entity must be findable by layer.
    const found = await transport.send({ op: 'queryEntities', layer: 'DSH_CAD_TEST' })
    assert.equal(found.ok, true)
    if (found.ok) {
      const d = found.data as { count: number }
      assert.ok(d.count >= 1, '应能检索到刚创建的图元')
    }

    // Clean up so the test is repeatable.
    const removed = await transport.send({ op: 'delete', handles: [handle] })
    assert.equal(removed.ok, true)
  } finally {
    await transport.stop()
  }
})

test('COM: 真实平移后包围盒按预期变化', opts, async () => {
  const { transport } = makeService()
  try {
    const drawn = await transport.send({
      op: 'draw',
      items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 500, y: 0 } }],
    })
    assert.equal(drawn.ok, true)
    const handle = drawn.ok ? drawn.handles![0]! : ''

    const moved = await transport.send({
      op: 'transform',
      handles: [handle],
      mode: 'move',
      value: 250,
    })
    assert.equal(moved.ok, true, moved.ok ? '' : JSON.stringify(moved.error))

    const got = await transport.send({ op: 'getEntity', handle })
    assert.equal(got.ok, true)
    if (got.ok) {
      const e = (got.data as { entity: { bbox: { min: { x: number } } } }).entity
      assert.equal(Math.round(e.bbox.min.x), 250, '平移 250 后 min.x 应为 250')
    }

    await transport.send({ op: 'delete', handles: [handle] })
  } finally {
    await transport.stop()
  }
})

test('COM: 查询不存在的句柄返回 NOT_FOUND', opts, async () => {
  const { transport } = makeService()
  try {
    const res = await transport.send({ op: 'getEntity', handle: 'FFFFFFFF' })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.error.code, 'NOT_FOUND')
  } finally {
    await transport.stop()
  }
})

test('COM: 真实创建并清理五种尺寸标注', opts, async () => {
  const { transport } = makeService()
  const handles: string[] = []
  const cases = [
    {
      kind: 'linear' as const,
      points: [{ x: 0, y: 100 }, { x: 100, y: 100 }],
      offset: 20,
    },
    {
      kind: 'aligned' as const,
      points: [{ x: 0, y: 200 }, { x: 100, y: 250 }],
      offset: 20,
    },
    {
      kind: 'angular' as const,
      points: [{ x: 300, y: 100 }, { x: 400, y: 100 }, { x: 300, y: 200 }],
      offset: 20,
    },
    {
      kind: 'radius' as const,
      points: [{ x: 600, y: 100 }, { x: 650, y: 100 }],
      offset: 20,
    },
    {
      kind: 'diameter' as const,
      points: [{ x: 700, y: 50 }, { x: 800, y: 50 }],
      offset: 20,
    },
  ]

  try {
    for (const item of cases) {
      const res = await transport.send({ op: 'addDimension', ...item })
      assert.equal(res.ok, true, `${item.kind}: ${res.ok ? '' : JSON.stringify(res.error)}`)
      if (res.ok) handles.push(...(res.handles ?? []))
    }

    assert.equal(handles.length, cases.length)
    const queried = await transport.send({ op: 'queryEntities', kind: 'dimension' })
    assert.equal(queried.ok, true, queried.ok ? '' : JSON.stringify(queried.error))
    if (queried.ok) {
      assert.ok((queried.data as { count: number }).count >= cases.length)
    }
  } finally {
    if (handles.length > 0) await transport.send({ op: 'delete', handles })
    await transport.stop()
  }
})

test('COM: 真实创建并清理多环填充', opts, async () => {
  const { transport } = makeService()
  let handle = ''
  try {
    const res = await transport.send({
      op: 'addHatch',
      patternName: 'ANSI31',
      patternScale: 10,
      loops: [
        [{ x: 0, y: 400 }, { x: 400, y: 400 }, { x: 400, y: 300 }, { x: 0, y: 300 }],
        [{ x: 100, y: 375 }, { x: 100, y: 325 }, { x: 200, y: 325 }, { x: 200, y: 375 }],
      ],
    })
    assert.equal(res.ok, true, res.ok ? '' : JSON.stringify(res.error))
    if (res.ok) handle = res.handles?.[0] ?? ''
    assert.ok(handle, '填充应返回句柄')

    const entity = await transport.send({ op: 'getEntity', handle })
    assert.equal(entity.ok, true, entity.ok ? '' : JSON.stringify(entity.error))
    if (entity.ok) {
      const measure = (entity.data as { entity: { measure?: { area?: number } } }).entity.measure
      assert.ok(typeof measure?.area === 'number' && measure.area > 0, '填充应有正面积')
    }
  } finally {
    if (handle) await transport.send({ op: 'delete', handles: [handle] })
    await transport.stop()
  }
})
