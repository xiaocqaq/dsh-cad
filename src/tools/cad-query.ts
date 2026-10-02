import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EntitySummary, QueryEntitiesRequest } from '../protocol.ts'
import { pointSchema } from './shared.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_query_entities` — locate entities before modifying them. */
export function createQueryEntitiesTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_query_entities',
    description:
      '按图层、图元类型、文字内容或空间范围检索图元,返回图元句柄(handle)、包围盒及长度/半径/面积。' +
      '任何修改类操作之前都必须先用本工具定位到具体图元并确认 handle,不要凭猜测直接修改。' +
      '每条结果的 meters 字段是换算后的工程米制值(长度m/半径m/面积m²),' +
      '可直接用于核对尺寸,从而避免图纸无比例尺时把量取尺寸误当成真实尺寸。',
    parameters: {
      layer: { type: 'string', description: '限定图层名(不区分大小写)' },
      kind: {
        type: 'string',
        enum: [
          'line', 'circle', 'arc', 'polyline', 'text', 'mtext',
          'dimension', 'hatch', 'point', 'ellipse', 'spline', 'block', 'unknown',
        ],
        description: '限定图元类型',
      },
      textContains: { type: 'string', description: '按文字内容或块名的子串过滤' },
      window: {
        type: 'object',
        additionalProperties: false,
        description: '空间范围过滤(单位:米)',
        properties: {
          min: { ...pointSchema, description: '范围左下角(米)' },
          max: { ...pointSchema, description: '范围右上角(米)' },
        },
      },
      limit: { type: 'integer', description: '最多返回多少个图元,默认 100' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer', description: '匹配到的图元数量' },
          truncated: { type: 'boolean', description: '结果是否因 limit 被截断' },
          entities: {
            type: 'array',
            description: '图元摘要列表',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                handle: { type: 'string' },
                kind: { type: 'string' },
                layer: { type: 'string' },
                bbox: { type: 'json', description: '包围盒(图纸单位)' },
                measure: { type: 'json', description: '长度/半径/面积(图纸单位)' },
                meters: { type: 'json', description: '换算后的米制度量' },
                text: { type: 'string' },
                color: { type: 'integer' },
                linetype: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.count) {
          return [{
            type: 'text',
            text: '未找到匹配的图元。请放宽过滤条件,或先用 cad_list_layers 确认图层名是否正确。',
          }]
        }
        const rows = (value.entities as Record<string, unknown>[]).map(e => {
          const m = (e.meters ?? {}) as Record<string, number>
          const bits = [`handle=${e.handle}`, String(e.kind), `图层=${e.layer}`]
          if (typeof m.length === 'number') bits.push(`长 ${m.length}m`)
          if (typeof m.radius === 'number') bits.push(`半径 ${m.radius}m`)
          if (typeof m.area === 'number') bits.push(`面积 ${m.area}m²`)
          if (typeof e.text === 'string') bits.push(`"${e.text}"`)
          return `- ${bits.join(' | ')}`
        })
        const tail = value.truncated
          ? '\n注意: 结果已达 limit 上限,可能还有更多图元未显示。'
          : ''
        return [{
          type: 'text',
          text: `找到 ${value.count} 个图元(尺寸已换算为米):\n${rows.join('\n')}${tail}`,
        }]
      },
    },
    async execute(args) {
      const request: QueryEntitiesRequest = { op: 'queryEntities', limit: args.limit ?? 100 }
      if (args.layer !== undefined) request.layer = args.layer
      if (args.kind !== undefined) request.kind = args.kind
      if (args.textContains !== undefined) request.textContains = args.textContains
      if (args.window?.min && args.window.max) {
        request.window = {
          min: deps.cad.units.pointToDrawing(args.window.min),
          max: deps.cad.units.pointToDrawing(args.window.max),
        }
      }
      const res = await deps.cad.raw(request)
      if (!res.ok) return { count: 0, truncated: false, entities: [] }
      const data = res.data as { entities?: EntitySummary[] }
      const entities = deps.cad.describe(data.entities ?? [])
      return {
        count: entities.length,
        truncated: Boolean(res.warnings?.length),
        entities,
      }
    },
  })
}
