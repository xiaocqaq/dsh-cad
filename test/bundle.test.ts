import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

/**
 * Exercises the built bundle rather than the TypeScript sources, so packaging
 * mistakes (wrong entry, missing export, schema that only type-checks) surface
 * here instead of at plugin load time.
 */
const ENTRY = pathToFileURL(join(process.cwd(), 'lib', 'index.js')).href

/**
 * A Schemastery schema is callable: `Config(input)` returns the coerced config
 * with defaults applied, and throws on invalid input. That loud failure is the
 * documented convention — a bad config must break plugin load, not surface
 * later as a confusing runtime error.
 */
type Schema = ((input: unknown) => unknown) & {
  ['~standard']?: { validate: (v: unknown) => { value: unknown } | { issues: unknown[] } }
}

async function loadPlugin() {
  return import(ENTRY) as Promise<{
    name: string
    inject: string[]
    apply: (ctx: unknown, config: unknown) => void
    Config: Schema
  }>
}

test('构建产物可被导入并导出插件入口', async () => {
  const mod = await loadPlugin()
  assert.equal(typeof mod.apply, 'function')
  assert.equal(typeof mod.name, 'string')
  assert.deepEqual(mod.inject, ['tools'])
})

test('配置: 缺省输入会填充默认值', async () => {
  const mod = await loadPlugin()
  const cfg = mod.Config({}) as Record<string, unknown>
  assert.equal(cfg.transport, 'com')
  assert.equal(cfg.progId, 'AutoCAD.Application')
  assert.equal(cfg.unitsPerMeter, 1)
  assert.equal(cfg.requestTimeoutMs, 120000)
  assert.ok(Array.isArray(cfg.progIdFallbacks))
})

test('配置: 非法 transport 在加载期报错', async () => {
  const mod = await loadPlugin()
  assert.throws(() => mod.Config({ transport: 'nope' }))
})

test('配置: 非法 unitsPerMeter 在加载期报错', async () => {
  const mod = await loadPlugin()
  assert.throws(() => mod.Config({ unitsPerMeter: 0 }))
  assert.throws(() => mod.Config({ unitsPerMeter: -5 }))
})

test('配置: 合法值通过并保留', async () => {
  const mod = await loadPlugin()
  const cfg = mod.Config({ transport: 'simulation', unitsPerMeter: 1000 }) as Record<string, unknown>
  assert.equal(cfg.transport, 'simulation')
  assert.equal(cfg.unitsPerMeter, 1000)
})
