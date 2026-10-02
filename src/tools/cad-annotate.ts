import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { AddDimensionRequest, AddHatchRequest, Point } from '../protocol.ts'
import { colorSchema, layerSchema, pointSchema } from './shared.ts'
import { mutationOutput, toResult } from './mutation.ts'
import type { ToolDeps } from './cad-status.ts'

/** `cad_add_dimension` — real dimension objects, not drawn approximations. */
export function createDimensionTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_add_dimension',
    description:
      '在图纸中添加尺寸标注对象(线性/对齐/角度/半径/直径)。' +
      '请使用真正的标注对象而不是手工画线,以保证标注值随图元变化自动更新。' +
      '所有坐标与尺寸使用【米】。线性/对齐/角度需要 2~3 个点,半径/直径需要 1 个点。',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['linear', 'aligned', 'angular', 'radius', 'diameter'],
        description: '标注类型',
      },
      points: {
        type: 'array',
        required: true,
        description: '标注点集:linear/aligned 2 点,angular 3 点,radius/diameter 1 点',
        items: { ...pointSchema, description: '标注点(米)' },
      },
      offset: { type: 'number', description: '尺寸线相对测量点的偏移(米),用于避免压线' },
      textOverride: { type: 'string', description: '自定义标注文字(留空则显示实测值)' },
      layer: { ...layerSchema, description: '所属图层' },
      color: { ...colorSchema, description: '颜色' },
    },
    output: mutationOutput(),
    async execute(args) {
      const u = deps.cad.units
      const request: AddDimensionRequest = {
        op: 'addDimension',
        kind: args.kind,
        points: (args.points as Point[]).map(p => u.pointToDrawing(p)),
        offset: args.offset === undefined ? undefined : u.toDrawing(args.offset),
        textOverride: args.textOverride,
        layer: args.layer,
        color: args.color,
      }
      return toResult(await deps.cad.raw(request), '添加尺寸标注')
    },
  })
}

/** `cad_add_hatch` — closed-region fill for soil strata and poche. */
export function createHatchTool(deps: ToolDeps): ToolDefinition {
  return defineTool({
    name: 'cad_add_hatch',
    description:
      '在指定的闭合边界内填充图案(用于土层剖面、混凝土剖面等)。' +
      '每个边界环至少需要 3 个顶点,坐标使用【米】。',
    parameters: {
      loops: {
        type: 'array',
        required: true,
        description: '边界环列表,每个环是一组闭合顶点',
        items: {
          type: 'array',
          description: '一个闭合边界环',
          items: { ...pointSchema, description: '顶点(米)' },
        },
      },
      patternName: { type: 'string', description: '图案名,如 ANSI31;纯色填充用 SOLID' },
      patternScale: { type: 'number', description: '图案比例(仅对非实心图案有效)' },
      layer: { ...layerSchema, description: '所属图层' },
      color: { ...colorSchema, description: '颜色' },
    },
    output: mutationOutput(),
    async execute(args) {
      const u = deps.cad.units
      const request: AddHatchRequest = {
        op: 'addHatch',
        loops: (args.loops as Point[][]).map(loop => loop.map(p => u.pointToDrawing(p))),
        patternName: args.patternName,
        patternScale: args.patternScale,
        layer: args.layer,
        color: args.color,
      }
      return toResult(await deps.cad.raw(request), '添加填充图案')
    },
  })
}
