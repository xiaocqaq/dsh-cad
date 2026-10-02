import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = join(ROOT, 'assets', 'cad-bridge.ps1')

/**
 * Regression tests for the bridge's request framing.
 *
 * These run without AutoCAD: the bridge reports `BACKEND_UNAVAILABLE` before it
 * ever needs a live instance, so a *successful* parse is observable as a
 * response that is NOT a JSON parse error. That is enough to prove multi-line
 * requests are buffered and parsed as one document.
 */
const LIVE = process.env.DSH_CAD_LIVE === '1'
const opts = { skip: LIVE ? false : '需要运行中的 AutoCAD(设置 DSH_CAD_LIVE=1)' }

/** Feed `payload` to the bridge and return the parsed response lines. */
async function sendRaw(payload: string): Promise<Array<Record<string, unknown>>> {
  // Feed the payload over stdin rather than through a temp file: the bridge
  // reads stdin line by line, and this avoids cmd.exe quote round-tripping.
  // A non-zero exit is expected here (the probe ProgID is never registered and
  // the bridge exits 1), so only stdout matters. `execFile` has no `input`
  // option, so stdin is written through a spawned process instead.
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', BRIDGE,
        '-ProgId', 'AutoCAD.Application.__probe__',
        '-ProgIdFallbacks', ' ',
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    )
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.on('error', reject)
    child.on('close', () => resolve(out))
    child.stdin.end(payload)
  })
  return stdout
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map((l): Record<string, unknown> => {
      try {
        return JSON.parse(l) as Record<string, unknown>
      } catch {
        return { unparsed: l }
      }
    })
}

test('桥接: 单行 JSON 可解析(不报 JSON 语法错误)', async () => {
  const lines = await sendRaw('{"id":"a","request":{"op":"status"}}\n')
  const errs = lines.filter(l => l.unparsed)
  assert.equal(errs.length, 0, `不应有无法解析的输出行: ${JSON.stringify(errs)}`)
  // The probe ProgID is never registered, so the bridge reports
  // BACKEND_UNAVAILABLE before touching AutoCAD. That is the proof the request
  // was parsed as one document rather than as fragments.
  assert.match(
    JSON.stringify(lines),
    /BACKEND_UNAVAILABLE/,
    '未注册 ProgID 时应给出结构化错误,而不是崩溃或逐行解析失败',
  )
})

test('桥接: 多行美化 JSON 被缓冲为单个请求(回归)', async () => {
  // Previously each line was parsed on its own, producing a stream of
  // "Invalid JSON primitive" errors instead of one request.
  const pretty = `{
  "id": "multiline",
  "request": {
    "op": "draw",
    "items": [
      { "kind": "line", "start": { "x": 0, "y": 0 }, "end": { "x": 1, "y": 0 } }
    ]
  }
}
`
  const lines = await sendRaw(pretty)
  const parsed = lines.filter(l => !l.unparsed)
  assert.ok(parsed.length >= 1, '应至少得到一个结构化响应')

  const texts = lines.map(l => JSON.stringify(l)).join('\n')
  assert.doesNotMatch(texts, /Invalid JSON primitive/, '不应再出现逐行解析错误')
  assert.doesNotMatch(texts, /Invalid array passed in/, '不应再出现被截断的数组')
})

test('桥接: 字符串内的花括号不影响完整性判断(回归)', async () => {
  // A brace inside a JSON string must not be counted towards nesting depth.
  const payload = '{"id":"brace","request":{"op":"draw","items":[{"kind":"text","text":"a { b } c","position":{"x":0,"y":0}}]}}\n'
  const lines = await sendRaw(payload)
  const texts = lines.map(l => JSON.stringify(l)).join('\n')
  assert.doesNotMatch(texts, /Invalid JSON primitive/, '字符串内的花括号不应破坏解析')
  assert.doesNotMatch(texts, /unparsed/, '不应有无法解析的行')
})
