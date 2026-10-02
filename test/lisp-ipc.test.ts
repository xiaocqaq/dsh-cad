import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AutoTransport } from '../src/transport/auto.ts'
import { LispIpcTransport } from '../src/transport/lisp-ipc.ts'
import { decodeSexpr, encodeSexpr, fromSexpr, toSexpr } from '../src/transport/sexpr.ts'

test('sexpr 往返中文、引号、换行和空数组', () => {
  const value = { text: '中文"\n', warnings: [] as string[], n: 1.5, missing: undefined }
  const encoded = encodeSexpr(toSexpr(value))
  assert.match(encoded, /\\U\+4E2D/)
  assert.equal(encoded.includes('\n'), false)
  assert.deepEqual(fromSexpr(decodeSexpr(encoded)), { text: '中文"\n', warnings: [], n: 1.5 })
})

test('调度器未运行时返回 BACKEND_UNAVAILABLE 并给出 APPLOAD 路径', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 500 })
  try {
    const res = await lisp.send({ op: 'status' })
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.error.code, 'BACKEND_UNAVAILABLE')
    assert.match(res.error.message, /APPLOAD/)
    assert.match(res.error.message, /cad-ipc\.lsp/)
  } finally {
    await lisp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('没有心跳时，唤醒函数被调用后仍能完成往返', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 2000 })
  let nudged = 0
  lisp.setNudge(async () => {
    nudged += 1
  })
  const pending = serve(dir, () => ({ ok: 1, data: { backend: 'lisp-ipc' }, handles: [], warnings: [] }))
  try {
    const res = await lisp.send({ op: 'status' })
    await pending
    assert.equal(nudged, 1)
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.equal((res.data as { backend: string }).backend, 'lisp-ipc')
  } finally {
    await lisp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('心跳新鲜时完成一次状态往返，并把图层 0/1 收成布尔', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 2000 })
  const pending = serve(dir, () => ({
    ok: 1,
    data: { layers: [{ name: '0', on: 1, frozen: 0, locked: 0, entityCount: 2 }] },
    handles: [],
    warnings: [],
  }))
  try {
    await writeHeartbeat(dir)
    const res = await lisp.send({ op: 'listLayers' })
    await pending
    assert.equal(res.ok, true)
    if (!res.ok) return
    const layers = (res.data as { layers: Array<{ on: boolean; frozen: boolean }> }).layers
    assert.equal(layers[0]?.on, true)
    assert.equal(layers[0]?.frozen, false)
  } finally {
    await lisp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('创建成功但没有句柄时拒绝，而不是当成画完了', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 2000 })
  const pending = serve(dir, () => ({ ok: 1, data: { count: 1 } }))
  try {
    await writeHeartbeat(dir)
    const res = await lisp.send({
      op: 'draw',
      items: [{ kind: 'line', start: { x: 0, y: 0 }, end: { x: 1, y: 0 } }],
    })
    await pending
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.error.code, 'BACKEND_ERROR')
    assert.match(res.error.message, /句柄/)
  } finally {
    await lisp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('调度器不应答时返回 TIMEOUT', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 300 })
  try {
    await writeHeartbeat(dir)
    const res = await lisp.send({ op: 'status' })
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.error.code, 'TIMEOUT')
  } finally {
    await lisp.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('心跳已在时 auto 不启动 COM', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ipc-'))
  const lisp = new LispIpcTransport({ ipcDir: dir, requestTimeoutMs: 1000 })
  let called = false
  const auto = new AutoTransport({
    lisp,
    createCom: () => {
      called = true
      throw new Error('不应创建 COM')
    },
  })
  try {
    await writeHeartbeat(dir)
    await auto.start()
    assert.equal(called, false)
    assert.equal(auto.kind, 'lisp-ipc')
    const diag = auto.describeBackend()
    assert.equal(diag.selected, 'lisp-ipc')
    assert.equal(diag.degraded, '')
  } finally {
    await auto.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

async function writeHeartbeat(dir: string): Promise<void> {
  await writeFile(
    join(dir, 'heartbeat.lsp'),
    '(("version" "1") ("activeX" 1) ("document" "t.dwg"))\n',
    'utf8',
  )
}

async function serve(
  dir: string,
  reply: (req: Record<string, unknown>) => unknown,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 3000) {
    const names = await readdir(dir)
    const req = names.find(name => name.startsWith('req-') && name.endsWith('.lsp'))
    if (req) {
      const inbox = join(dir, req)
      const text = await readFile(inbox, 'utf8')
      const form = fromSexpr(decodeSexpr(text)) as Record<string, unknown>
      await rm(inbox, { force: true })
      await writeFile(join(dir, `res-${String(form.id)}.lsp`), `${encodeSexpr(toSexpr(reply(form)))}\n`, 'utf8')
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('测试调度器没有看到 inbox.lsp')
}
