import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CreateSpec, DrawRequest, Point } from '../protocol.ts'
import { colorSchema, layerSchema, pointSchema } from './shared.ts'
import { mutationOutput, toResult } from './mutation.ts'
import type { ToolDeps } from './cad-status.ts'

/** Metres -> drawing units for one create spec. */
function convertItem(item: CreateSpec, units: ToolDeps['cad']['units']): CreateSpec {
  const p = (pt: Point): Point => units.pointToDrawing(pt)
  switch (item.kind) {
    case 'line':
      return { ...item, start: p(item.start), end: p(item.end) }
    case 'circle':
      return { ...item, center: p(item.center), radius: units.toDrawing(item.radius) }
    case 'arc':
      return { ...item, center: p(item.center), radius: units.toDrawing(item.radius) }
    case 'polyline':
      return { ...item, vertices: item.vertices.map(p) }
    case 'text':
      return {
        ...item,
        position: p(item.position),
        height: item.height === undefined ? undefined : units.toDrawing(item.height),
      }
    case 'mtext':
      return {
        ...item,
        position: p(item.position),
        height: item.height === undefined ? undefined : units.toDrawing(item.height),
        width: item.width === undefined ? undefined : units.toDrawing(item.width),
      }
  }
}

/** `cad_draw` — create primitives in one undoable batch. */
export function createDrawTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_draw',
    description:
      '在当前图纸中批量绘制基本图元(直线/圆/圆弧/多段线/单行文字/多行文字)。' +
      '所有坐标与尺寸一律使用【米】,由插件按图纸单位自动换算,请勿自行换算。' +
      '整批图元构成一个撤销步骤,可一次 Ctrl+Z 全部回退。' +
      '绘制前应先用 cad_query_entities 确认目标区域是否已有同类图元,避免重复绘制。',
    parameters: {
      items: {
        type: 'array',
        required: true,
        description: '待创建的图元列表',
        items: {
          type: 'object',
          additionalProperties: false,
          description: '单个图元,按 kind 提供对应几何参数',
          properties: {
            kind: {
              type: 'string',
              required: true,
              enum: ['line', 'circle', 'arc', 'polyline', 'text', 'mtext'],
              description: '图元类型',
            },
            start: { ...pointSchema, description: 'line: 起点' },
            end: { ...pointSchema, description: 'line: 终点' },
            center: { ...pointSchema, description: 'circle/arc: 圆心' },
            radius: { type: 'number', description: 'circle/arc: 半径(米)' },
            startAngle: { type: 'number', description: 'arc: 起始角(度)' },
            endAngle: { type: 'number', description: 'arc: 终止角(度)' },
            vertices: {
              type: 'array',
              description: 'polyline: 顶点序列',
              items: { ...pointSchema, description: '顶点(米)' },
            },
            closed: { type: 'boolean', description: 'polyline: 是否闭合' },
            position: { ...pointSchema, description: 'text/mtext: 插入点' },
            text: { type: 'string', description: 'text/mtext: 文字内容' },
            height: { type: 'number', description: 'text/mtext: 字高(米)' },
            width: { type: 'number', description: 'mtext: 文字框宽度(米)' },
            rotation: { type: 'number', description: 'text: 旋转角(度)' },
            layer: { ...layerSchema, description: '所属图层' },
            color: { ...colorSchema, description: '颜色' },
          },
        },
      },
      undoLabel: { type: 'string', description: '撤销步骤名称,便于工程师回退' },
    },
    output: mutationOutput(),
    async execute(args) {
      const items: CreateSpec[] = args.items.map((raw) => {
        const base = { layer: raw.layer, color: raw.color }
        switch (raw.kind) {
          case 'line':
            return { kind: 'line', start: raw.start as Point, end: raw.end as Point, ...base }
          case 'circle':
            return { kind: 'circle', center: raw.center as Point, radius: raw.radius as number, ...base }
          case 'arc':
            return {
              kind: 'arc',
              center: raw.center as Point,
              radius: raw.radius as number,
              startAngle: raw.startAngle ?? 0,
              endAngle: raw.endAngle ?? 90,
              ...base,
            }
          case 'polyline':
            return { kind: 'polyline', vertices: (raw.vertices ?? []) as Point[], closed: raw.closed, ...base }
          case 'text':
            return {
              kind: 'text',
              position: raw.position as Point,
              text: raw.text ?? '',
              height: raw.height,
              rotation: raw.rotation,
              ...base,
            }
          case 'mtext':
            return {
              kind: 'mtext',
              position: raw.position as Point,
              text: raw.text ?? '',
              width: raw.width,
              height: raw.height,
              ...base,
            }
        }
      })

      const request: DrawRequest = {
        op: 'draw',
        items: items.map(item => convertItem(item, deps.cad.units)),
        undoLabel: args.undoLabel,
      }
      const res = await deps.cad.raw(request)
      return toResult(res, '绘制图元')
    },
  })
}
