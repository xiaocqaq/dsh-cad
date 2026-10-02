import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { CadTransport } from './protocol.ts'
import { CadService } from './service.ts'
import { AutoTransport } from './transport/auto.ts'
import { ComTransport } from './transport/com.ts'
import { LispIpcTransport } from './transport/lisp-ipc.ts'
import { SimulationTransport } from './transport/simulation.ts'
import { createStatusTool, type ToolDeps } from './tools/cad-status.ts'
import { createListLayersTool } from './tools/cad-layers.ts'
import { createQueryEntitiesTool } from './tools/cad-query.ts'
import { createDrawTool } from './tools/cad-draw.ts'
import { createDimensionTool, createHatchTool } from './tools/cad-annotate.ts'
import { createDeleteTool, createModifyTool, createTransformTool } from './tools/cad-edit.ts'
import { createGetEntityTool, createMeasureTool } from './tools/cad-measure.ts'
import { createBatchTool, createRunCommandTool } from './tools/cad-batch.ts'
import { createOpenTool, createSaveAsTool } from './tools/cad-document.ts'

export const name = 'dsh-plugin-cad'
export const inject = ['tools']

export interface Config {
  /**
   * `auto` prefers the resident AutoLISP dispatcher and uses COM only to load
   * it, or when that load does not take. `lisp` never falls back. `com` is the
   * previous path. `simulation` runs in memory.
   */
  transport: 'auto' | 'lisp' | 'com' | 'simulation'
  /** File-IPC directory. Empty uses %LOCALAPPDATA%\\dsh-cad\\ipc. */
  ipcDir: string
  /** Primary COM ProgID; probed first. */
  progId: string
  /** Additional ProgIDs to try when the primary is not registered. */
  progIdFallbacks: string[]
  /** Drawing units per metre. 1 for metre drawings, 1000 for millimetre. */
  unitsPerMeter: number
  /** Hard ceiling on one bridge round-trip, in milliseconds. */
  requestTimeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  transport: Schema.union(['auto', 'lisp', 'com', 'simulation']).default('auto'),
  ipcDir: Schema.string().default(''),
  progId: Schema.string().default('AutoCAD.Application'),
  progIdFallbacks: Schema.array(Schema.string()).default([
    'AutoCAD.Application.25.2',
    'AutoCAD.Application.25.1',
    'AutoCAD.Application.25.0',
    'AutoCAD.Application.24.3',
  ]),
  // Constrained in the schema, not just validated in UnitConverter: a bad unit
  // scale must fail loudly at plugin load, not silently corrupt every offset.
  unitsPerMeter: Schema.number().min(1).default(1),
  requestTimeoutMs: Schema.number().min(1000).default(120000),
})

function createTransport(config: Config): CadTransport {
  if (config.transport === 'simulation') return new SimulationTransport()
  const comOpts = {
    progId: config.progId,
    progIdFallbacks: config.progIdFallbacks,
    requestTimeoutMs: config.requestTimeoutMs,
  }
  if (config.transport === 'com') return new ComTransport(comOpts)
  const lisp = new LispIpcTransport({
    ipcDir: config.ipcDir || undefined,
    requestTimeoutMs: config.requestTimeoutMs,
  })
  if (config.transport === 'lisp') return lisp
  return new AutoTransport({ lisp, createCom: () => new ComTransport(comOpts) })
}

export function apply(ctx: Context, config: Config): void {
  const service = new CadService(createTransport(config), config.unitsPerMeter)
  const deps: ToolDeps = { cad: service, unitsPerMeter: config.unitsPerMeter }

  // Register tools first so they exist regardless of backend state, then try
  // to connect. A missing AutoCAD surfaces through `cad_status` with a
  // recovery hint instead of breaking plugin load.
  const tools = [
    createStatusTool(deps),
    createOpenTool(deps),
    createSaveAsTool(deps),
    createListLayersTool(deps),
    createQueryEntitiesTool(deps),
    createGetEntityTool(deps),
    createMeasureTool(deps),
    createDrawTool(deps),
    createDimensionTool(deps),
    createHatchTool(deps),
    createModifyTool(deps),
    createTransformTool(deps),
    createDeleteTool(deps),
    createBatchTool(deps),
    createRunCommandTool(deps),
  ]
  for (const tool of tools) {
    ctx.tools.register(tool)
  }

  // Effect bodies must return a disposer; these run in reverse order on unload,
  // so the bridge is stopped after the tools are unregistered.
  ctx.effect(async () => {
    try {
      await service.start()
      ctx.logger.info(
        '[dsh-plugin-cad] backend ready: %s (1m = %d units)',
        service.backend,
        config.unitsPerMeter,
      )
    } catch (err) {
      ctx.logger.warn(
        '[dsh-plugin-cad] backend not ready: %s',
        err instanceof Error ? err.message : String(err),
      )
    }
    return () => service.stop()
  }, 'dsh-plugin-cad:backend')
}
