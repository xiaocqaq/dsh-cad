import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { EntitySummary, Point } from '../protocol.ts'
import { pointSchema } from './shared.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_measure` — convert between drawing units and engineering metres. */
export function createMeasureTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_measure',
    description:
      '测量距离或两点间长度,输入点坐标(米),返回图纸单位长度与米制长度。' +
      '当图纸没有明确比例尺时,不要凭肉眼量取尺寸当作真实尺寸,' +
      '应先用本工具确认图纸单位比例,再据此换算。',
    parameters: {
      a: { ...pointSchema, required: true, description: '起点(米)' },
      b: { ...pointSchema, required: true, description: '终点(米)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          distanceMeters: { type: 'number', description: '两点间距离(米)' },
          distanceDrawingUnits: { type: 'number', description: '两点间距离(图纸单位)' },
          unitsPerMeter: { type: 'number', description: '当前图纸单位比例' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `距离: ${value.distanceMeters} 米 (${value.distanceDrawingUnits} 图纸单位)`,
          `单位比例: 1 米 = ${value.unitsPerMeter} 图纸单位`,
        ].join('\n'),
      }],
    },
    async execute(args) {
      const u = deps.cad.units
      const a = args.a as Point
      const b = args.b as Point
      const meters = Math.hypot(b.x - a.x, b.y - a.y)
      return {
        distanceMeters: Math.round(meters * 1e6) / 1e6,
        distanceDrawingUnits: Math.round(u.toDrawing(meters) * 1e6) / 1e6,
        unitsPerMeter: u.unitsPerMeter,
      }
    },
  })
}

/** `cad_get_entity` — full detail for one handle. */
export function createGetEntityTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_get_entity',
    description:
      '获取单个图元的完整信息(图层、几何度量、包围盒、文字内容),' +
      '尺寸同时给出图纸单位与米制值。在修改某个图元之前可调用本工具确认其当前状态。',
    parameters: {
      handle: { type: 'string', required: true, description: '图元句柄' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', description: '是否找到该图元' },
          entity: { type: 'json', description: '图元详情(含 meters 米制度量)' },
        },
      },
      render: (_args, value) => {
        if (!value.found || !value.entity) {
          return [{ type: 'text', text: '未找到该图元。请先用 cad_query_entities 检索。' }]
        }
        const e = value.entity as Record<string, unknown>
        const m = (e.meters ?? {}) as Record<string, number>
        const lines = [
          `句柄: ${e.handle}`,
          `类型: ${e.kind}`,
          `图层: ${e.layer}`,
        ]
        if (typeof m.length === 'number') lines.push(`长度: ${m.length} 米`)
        if (typeof m.radius === 'number') lines.push(`半径: ${m.radius} 米`)
        if (typeof m.area === 'number') lines.push(`面积: ${m.area} 平方米`)
        if (typeof e.text === 'string') lines.push(`文字: "${e.text}"`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const res = await deps.cad.raw({ op: 'getEntity', handle: args.handle })
      if (!res.ok) return { found: false }
      const data = res.data as { entity?: EntitySummary }
      if (!data.entity) return { found: false }
      return { found: true, entity: deps.cad.units.describeEntity(data.entity) as unknown as Record<string, never> }
    },
  })
}
