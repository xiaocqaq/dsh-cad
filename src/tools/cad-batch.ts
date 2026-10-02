import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EntityKind, QueryEntitiesRequest, RunCommandRequest } from '../protocol.ts'
import { renderError, warningBlock } from './shared.ts'
import { mutationOutput, toResult } from './mutation.ts'
import type { ToolDeps } from './cad-status.ts'
import { pointSchema } from './shared.ts'

/**
 * `cad_batch` — resolve a query and act on the result in one call.
 *
 * Locating entities and then transforming them in separate turns is where the
 * Codex-for-CAD evaluation saw linkage edits drift: the drawing can change
 * between the query and the edit. Doing both against one resolved handle set
 * keeps the "what moved" and "what was targeted" consistent, and returns the
 * full list of affected handles for the change report.
 */
export function createBatchTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_batch',
    description:
      '按条件批量定位图元并立即对其执行同一变换(平移/旋转/缩放),一次完成"定位 + 联动修改"。' +
      '典型场景:查出某图层某区域内与某关键字相关的所有图元,整体外移 500mm。' +
      '返回实际被影响的图元清单与被跳过的对象,便于输出修改说明。',
    parameters: {
      query: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: '图元筛选条件',
        properties: {
          layer: { type: 'string', description: '限定图层' },
          kind: {
            type: 'string',
            enum: [
              'line', 'circle', 'arc', 'polyline', 'text', 'mtext',
              'dimension', 'hatch', 'point', 'ellipse', 'spline', 'block', 'unknown',
            ],
            description: '限定图元类型',
          },
          textContains: { type: 'string', description: '按文字/块名子串过滤' },
          window: {
            type: 'object',
            additionalProperties: false,
            description: '空间范围(米)',
            properties: {
              min: { ...pointSchema, description: '左下角(米)' },
              max: { ...pointSchema, description: '右上角(米)' },
            },
          },
          limit: { type: 'integer', description: '最多处理多少个图元,默认 100' },
        },
      },
      mode: {
        type: 'string',
        required: true,
        enum: ['move', 'rotate', 'scale'],
        description: '对匹配图元执行的变换',
      },
      value: {
        type: 'number',
        required: true,
        description: 'move: X 偏移(米);rotate: 角度(度);scale: 缩放系数',
      },
      valueY: { type: 'number', description: 'move: Y 偏移(米)' },
      center: { ...pointSchema, description: 'rotate/scale 基准点(米)' },
      copy: { type: 'boolean', description: '为 true 时复制副本' },
      dryRun: {
        type: 'boolean',
        description: '为 true 时只定位并返回将受影响的图元,不做任何修改(建议先试运行)',
      },
    },
    output: mutationOutput(),
    async execute(args) {
      const u = deps.cad.units
      const q = args.query
      const request: QueryEntitiesRequest = { op: 'queryEntities', limit: q.limit ?? 100 }
      if (q.layer !== undefined) request.layer = q.layer
      if (q.kind !== undefined) request.kind = q.kind as EntityKind
      if (q.textContains !== undefined) request.textContains = q.textContains
      if (q.window?.min && q.window.max) {
        request.window = {
          min: u.pointToDrawing(q.window.min),
          max: u.pointToDrawing(q.window.max),
        }
      }

      const found = await deps.cad.raw(request)
      if (!found.ok) {
        return { ok: false, count: 0, handles: [], warnings: [], summary: '批量定位并修改', error: found.error }
      }
      const data = found.data as { entities?: { handle: string }[] }
      const entities = data.entities ?? []
      if (!entities.length) {
        return {
          ok: false,
          count: 0,
          handles: [],
          warnings: ['没有匹配到任何图元,未执行任何修改。请放宽筛选条件。'],
          summary: '批量定位并修改',
          error: { code: 'NOT_FOUND', message: '没有匹配到任何图元' },
        }
      }
      const handles = entities.map(e => e.handle)

      if (args.dryRun) {
        return {
          ok: true,
          count: handles.length,
          handles,
          warnings: ['这是试运行(dryRun),未对图纸做任何修改。'],
          summary: `试运行:定位到 ${handles.length} 个图元`,
        }
      }

      const res = await deps.cad.raw({
        op: 'transform',
        handles,
        mode: args.mode,
        value: args.mode === 'move' ? u.toDrawing(args.value) : args.value,
        valueY: args.valueY === undefined ? undefined : u.toDrawing(args.valueY),
        center: args.center ? u.pointToDrawing(args.center) : undefined,
        copy: args.copy,
      })
      const label = { move: '平移', rotate: '旋转', scale: '缩放' }[args.mode]
      return toResult(res, `批量${label}(定位 ${handles.length} 个图元)`)
    },
  })
}

/** `cad_run_command` — escape hatch to native AutoCAD commands. */
export function createRunCommandTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_run_command',
    description:
      '在 AutoCAD 命令行执行一条原生命令(逃生舱)。' +
      '当本插件的工具无法表达某个操作时使用,例如 QLEAVE(清空)、ZOOM、SAVE。' +
      '命令会真实作用于当前图形,请谨慎使用。',
    parameters: {
      command: { type: 'string', required: true, description: 'AutoCAD 命令名,如 ZOOM' },
      args: {
        type: 'array',
        description: '命令参数',
        items: { type: 'string', description: '参数' },
      },
    },
    output: mutationOutput(),
    async execute(args) {
      const request: RunCommandRequest = { op: 'runCommand', command: args.command, args: args.args as string[] }
      const res = await deps.cad.raw(request)
      return toResult(res, `执行命令 ${args.command}`)
    },
  })
}
