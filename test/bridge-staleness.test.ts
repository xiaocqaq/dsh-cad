import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ComTransport } from '../src/transport/com.ts'

/**
 * Regression test for bridge-script staleness.
 *
 * Windows PowerShell loads the whole script into memory at startup and never
 * re-reads it, so a long-lived bridge child keeps executing whatever code was
 * on disk when it spawned. A plugin upgrade therefore stayed invisible until
 * the host restarted, and the symptom was indistinguishable from the new build
 * being broken: calls failed with errors that matched the *old* source.
 *
 * The fake bridge below needs no AutoCAD — it only speaks the stdio protocol —
 * so this test runs everywhere.
 */
const fakeBridge = (version: string): string => `$ErrorActionPreference = 'Stop'
$version = '${version}'
[Console]::Out.WriteLine('{"ready":true}')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim().Length -eq 0) { continue }
  $req = $line | ConvertFrom-Json
  $body = '{"ok":true,"data":{"version":"' + $version + '"}}'
  [Console]::Out.WriteLine('{"id":"' + $req.id + '","response":' + $body + '}')
  [Console]::Out.Flush()
}
`

/** Read the version the live bridge process reports. */
async function versionOf(transport: ComTransport): Promise<string> {
  const res = await transport.send({ op: 'status' })
  assert.equal(res.ok, true, `调用应成功: ${JSON.stringify(res)}`)
  if (!res.ok) throw new Error('unreachable')
  return (res.data as { version: string }).version
}

test('桥接: 脚本在磁盘上更新后自动重启子进程(回归)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cad-bridge-'))
  const script = join(dir, 'fake-bridge.ps1')
  writeFileSync(script, fakeBridge('v1'), 'utf8')

  const transport = new ComTransport({
    progId: 'AutoCAD.Application.__probe__',
    progIdFallbacks: [],
    requestTimeoutMs: 30_000,
    scriptPath: script,
  })

  try {
    assert.equal(await versionOf(transport), 'v1', '首次调用应加载磁盘上的当前版本')

    // Simulate an in-place plugin upgrade. The running child still holds v1;
    // without the restart the next call would keep answering v1.
    writeFileSync(script, fakeBridge('v2'), 'utf8')
    const future = new Date(Date.now() + 2000)
    utimesSync(script, future, future)

    assert.equal(
      await versionOf(transport),
      'v2',
      '脚本更新后桥接进程应重启并加载新版本,而不是继续跑内存里的旧代码',
    )
    // The restarted child must stay addressable: a stale exit handler clearing
    // shared state would break every subsequent call.
    assert.equal(await versionOf(transport), 'v2', '重启后桥接应保持可用')
  } finally {
    await transport.stop()
  }
})

test('桥接: 脚本未变时不重启(避免无谓抖动)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cad-bridge-'))
  const script = join(dir, 'fake-bridge.ps1')
  writeFileSync(script, fakeBridge('v1'), 'utf8')

  const transport = new ComTransport({
    progId: 'AutoCAD.Application.__probe__',
    progIdFallbacks: [],
    requestTimeoutMs: 30_000,
    scriptPath: script,
  })

  try {
    assert.equal(await versionOf(transport), 'v1')
    const first = transport.describeBackend().bridgeLoadedAt
    assert.ok(first, '桥接运行后应报告已加载的脚本版本')
    // Same file, same stamp: the child must be reused rather than respawned.
    assert.equal(await versionOf(transport), 'v1')
    assert.equal(
      transport.describeBackend().bridgeLoadedAt,
      first,
      '脚本未变更时不应重启桥接进程',
    )
  } finally {
    await transport.stop()
  }
})
